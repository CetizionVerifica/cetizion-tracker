import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, beforeEach, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * POST /api/travel-invoices — raising the invoice that bills a trip (#214 §5.2).
 *
 * Creating the invoice and saying which trips it carries is one act, so it
 * is one transaction: a trip that may not go on the invoice means no
 * invoice at all. Every refusal below is followed by a check that no
 * payment stage was written and no trip was linked, because a half-raised
 * invoice is the failure nobody would notice until the GST return.
 *
 * Who: admin and sales, who own the PO side of a trip. HR runs the travel
 * desk and may not raise a client invoice — refused by hrGate, which also
 * keeps every generic payment-stage route closed to them.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
const PASSWORD = 'a-good-long-test-password';

describe('raising a travel invoice (#214)', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  const NAME = `ti_api_${process.pid}_${Date.now()}`;
  let db; let app; let admin; let sales; let other; let hr; let anonymous; let docId;

  before(async () => {
    const root = new pg.Client({ connectionString: ADMIN_URL });
    await root.connect();
    await root.query(`CREATE DATABASE ${NAME}`);
    await root.end();
    const url = new URL(ADMIN_URL); url.pathname = `/${NAME}`;
    db = new pg.Client({ connectionString: url.toString() });
    await db.connect();
    for (const f of ['schema.sql', 'views.sql']) await db.query(readFileSync(join(DB_DIR, f), 'utf8'));

    Object.assign(process.env, {
      NODE_ENV: 'test', DATABASE_URL: url.toString(), AUTH_MODE: 'database', EMAIL_MODE: 'log',
      SESSION_SECRET: 'test-secret-that-is-long-enough-to-pass',
    });
    ({ default: app } = await import('../src/app.js'));
    const { createUser } = await import('../src/lib/users.js');
    const signIn = async (email) => {
      const agent = request.agent(app);
      await agent.post('/api/auth/login').send({ email, password: PASSWORD }).expect(200);
      return agent;
    };
    const ids = {};
    for (const [role, email] of [['admin', 'ada@example.com'], ['sales', 'sam@example.com'],
      ['sales', 'sid@example.com'], ['hr', 'hema@example.com']]) {
      const u = await createUser({ name: email.split('@')[0], email, password: PASSWORD, role }, db);
      ids[email] = u.id;
    }
    admin = await signIn('ada@example.com');
    sales = await signIn('sam@example.com');
    other = await signIn('sid@example.com');
    hr = await signIn('hema@example.com');
    anonymous = request(app);

    // Sam's project, with a PO and a 50/50 split; Sid's project, to prove
    // a salesperson cannot raise an invoice on somebody else's.
    await db.query(`INSERT INTO companies (name) VALUES ('Honor Labs'), ('Rival Co')`);
    await db.query(
      `INSERT INTO projects (project_id, client_name, primary_service, owner_user_id)
            VALUES ('API-PRJ', 'Honor Labs', 'Testing', $1),
                   ('API-PRJ-ONLY', 'Honor Labs', 'Testing', $1),
                   ('API-RIVAL', 'Rival Co', 'Testing', $2)`,
      [ids['sam@example.com'], ids['sid@example.com']]);
    await db.query(`INSERT INTO purchase_orders (po_number, project_id, po_value, po_date, payment_terms_days)
                         VALUES ('API-PO', 'API-PRJ', 1000000, CURRENT_DATE - 30, 30),
                                ('API-RIVAL-PO', 'API-RIVAL', 200000, CURRENT_DATE - 30, 30)`);
    await db.query(`INSERT INTO payment_stages (po_number, stage_no, stage_name, trigger_event, stage_percent)
                         VALUES ('API-PO', 1, 'Advance (50%)', 'On PO Registration', 0.5),
                                ('API-PO', 2, 'On delivery (50%)', 'On Delivery', 0.5)`);
    ({ rows: [{ id: docId }] } = await db.query(
      `INSERT INTO documents (storage_key, file_name, content_type, size_bytes)
            VALUES ('ti/invoice', 'travel-invoice.pdf', 'application/pdf', 1024) RETURNING id`));
  });

  after(async () => {
    const { pool } = await import('../src/db.js');
    await pool.end().catch(() => {});
    await db?.end().catch(() => {});
    const root = new pg.Client({ connectionString: ADMIN_URL });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`);
    await root.end();
  });

  /** Fresh trips before each test, so "nothing was linked" is a real claim. */
  beforeEach(async () => {
    await db.query(`DELETE FROM payment_stages WHERE kind = 'travel'`);
    await db.query(`DELETE FROM travel_logs WHERE travel_id LIKE 'API-%'`);
    await db.query(`DELETE FROM activity_log WHERE entity_type IN ('travel_log', 'payment_stage')`);
    await db.query(
      `INSERT INTO travel_logs (travel_id, employee_name, po_number, project_id, destination, travel_start_date, travel_end_date)
            VALUES ('API-TRV-PO',   'Asha',  'API-PO', NULL, 'Hyderabad', CURRENT_DATE - 20, CURRENT_DATE - 18),
                   ('API-TRV-PO2',  'Vijay', 'API-PO', NULL, 'Chennai',   CURRENT_DATE - 15, CURRENT_DATE - 14),
                   ('API-TRV-PRJ',  'Meena', NULL, 'API-PRJ-ONLY', 'Pune', CURRENT_DATE - 10, CURRENT_DATE - 9),
                   ('API-TRV-RIVAL','Rival', 'API-RIVAL-PO', NULL, 'Delhi', CURRENT_DATE - 10, CURRENT_DATE - 9)`);
    // A trip nobody can bill: not chargeable, because it is on nothing.
    await db.query(`INSERT INTO travel_logs (travel_id, employee_name) VALUES ('API-TRV-NC', 'Nobody')`);
    // And a cancelled one on the right project.
    await db.query(`INSERT INTO travel_logs (travel_id, employee_name, project_id, cancelled)
                         VALUES ('API-TRV-CANX', 'Gone', 'API-PRJ-ONLY', true)`);
  });

  const raise = (who, body) => who.post('/api/travel-invoices').send(body);
  const today = () => new Date().toISOString().slice(0, 10);
  const base = (over = {}) => ({
    project_id: 'API-PRJ-ONLY', invoice_no: `TI/${Math.random().toString(36).slice(2, 8)}`,
    invoice_date: today(), amount: 37500, credit_days: 30, travel_ids: ['API-TRV-PRJ'], ...over,
  });

  const stages = async () => (await db.query(
    `SELECT count(*)::int AS n FROM payment_stages WHERE kind = 'travel'`)).rows[0].n;
  const linked = async () => (await db.query(
    `SELECT travel_id FROM travel_logs WHERE billed_stage_id IS NOT NULL ORDER BY travel_id`)).rows.map((r) => r.travel_id);

  // --------------------------------------------------------- the happy path

  test('an administrator raises a project-only travel invoice and bills a trip', async () => {
    const res = await raise(admin, base({ invoice_no: 'TI/ADMIN/1', document_id: docId, remarks: 'Sept travel' }));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.kind, 'travel');
    assert.equal(res.body.data.project_id, 'API-PRJ-ONLY');
    assert.equal(res.body.data.po_number, null);
    assert.equal(Number(res.body.data.stage_amount), 37500, 'its own printed total');
    assert.equal(res.body.data.stage_percent, null);
    assert.equal(res.body.data.document_id, docId);
    assert.deepEqual(res.body.meta.travel_ids, ['API-TRV-PRJ']);
    assert.deepEqual(await linked(), ['API-TRV-PRJ']);
  });

  test('a sales user raises one on their own project, on a PO, carrying two trips', async () => {
    const res = await raise(sales, base({
      project_id: 'API-PRJ', po_number: 'API-PO', invoice_no: 'TI/SALES/1',
      amount: 52000, travel_ids: ['API-TRV-PO', 'API-TRV-PO2'],
    }));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.po_number, 'API-PO');
    assert.equal(res.body.data.project_id, 'API-PRJ', 'filled from the PO');
    assert.deepEqual(await linked(), ['API-TRV-PO', 'API-TRV-PO2']);
    // And the PO's own split is untouched.
    const { rows: [po] } = await db.query(
      `SELECT stage_count, stages_percent_total, travel_invoice_count, travel_invoiced
         FROM v_purchase_orders WHERE po_number = 'API-PO'`);
    assert.equal(Number(po.stage_count), 2);
    assert.equal(Number(po.stages_percent_total), 1);
    assert.equal(Number(po.travel_invoice_count), 1);
    assert.equal(Number(po.travel_invoiced), 52000);
  });

  test('an invoice may be raised with no trips, to be linked from the trip later', async () => {
    const res = await raise(admin, base({ invoice_no: 'TI/EMPTY/1', travel_ids: [] }));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual(res.body.meta.travel_ids, []);
    assert.deepEqual(await linked(), []);
  });

  test('both the invoice and each trip it billed are audited', async () => {
    await raise(admin, base({ invoice_no: 'TI/AUDIT/1', travel_ids: ['API-TRV-PRJ'] })).expect(201);
    const { rows: invoice } = await db.query(
      `SELECT metadata FROM activity_log WHERE action = 'invoice.raised' AND entity_type = 'payment_stage'
                AND metadata->>'kind' = 'travel'`);
    assert.equal(invoice.length, 1);
    assert.equal(invoice[0].metadata.invoice_no, 'TI/AUDIT/1');
    assert.equal(Number(invoice[0].metadata.amount), 37500);
    assert.equal(invoice[0].metadata.project_id, 'API-PRJ-ONLY');
    assert.deepEqual(invoice[0].metadata.travel_ids, ['API-TRV-PRJ']);

    const { rows: trip } = await db.query(
      `SELECT entity_id, metadata FROM activity_log WHERE action = 'travel_log.billed_stage_set'`);
    assert.equal(trip.length, 1, 'one per trip, under the same action the trip page writes');
    assert.equal(trip[0].entity_id, 'API-TRV-PRJ');
    assert.equal(trip[0].metadata.invoice_no, 'TI/AUDIT/1');
    assert.equal(trip[0].metadata.raised_with_invoice, true);
  });

  // ----------------------------------------------------------- who may do it

  test('HR cannot raise a travel invoice, and gets no payment-stage door either', async () => {
    const res = await raise(hr, base({ invoice_no: 'TI/HR/1' }));
    assert.equal(res.status, 403, 'raising a client invoice is not the travel desk\'s work (#214 §9.3)');
    assert.equal(await stages(), 0);
    // And the generic route stays shut, so nothing was opened sideways.
    for (const [method, path] of [['get', '/api/payment-stages'], ['post', '/api/payment-stages']]) {
      const r = await hr[method](path).send({});
      assert.equal(r.status, 403, `${method} ${path}`);
    }
  });

  test('nobody signed in is refused with 401', async () => {
    const res = await raise(anonymous, base({ invoice_no: 'TI/ANON/1' }));
    assert.equal(res.status, 401);
    assert.equal(await stages(), 0);
  });

  test('a sales user cannot raise one on somebody else\'s project', async () => {
    const res = await raise(other, base({ project_id: 'API-PRJ-ONLY', invoice_no: 'TI/OTHER/1', travel_ids: [] }));
    assert.equal(res.status, 404, 'a project they do not own reads as one that is not there');
    assert.equal(await stages(), 0);
  });

  test('an administrator may raise one on any project', async () => {
    const res = await raise(admin, base({ project_id: 'API-RIVAL', po_number: 'API-RIVAL-PO', invoice_no: 'TI/ADMIN/RIVAL', travel_ids: [] }));
    assert.equal(res.status, 201, JSON.stringify(res.body));
  });

  // ------------------------------------------------------- all or nothing

  test('a trip that may not go on the invoice means no invoice at all', async () => {
    const cases = [
      ['a trip on another project', ['API-TRV-PRJ', 'API-TRV-RIVAL'], /belongs to project API-RIVAL/],
      ['a trip that is not chargeable', ['API-TRV-PRJ', 'API-TRV-NC'], /not a chargeable trip/],
      ['a cancelled trip', ['API-TRV-PRJ', 'API-TRV-CANX'], /cancelled/],
      ['a trip that does not exist', ['API-TRV-PRJ', 'API-TRV-NOPE'], /No trip with id/],
    ];
    for (const [why, travel_ids, message] of cases) {
      const res = await raise(admin, base({ invoice_no: `TI/BAD/${travel_ids.length}`, travel_ids }));
      assert.ok(res.status === 422 || res.status === 404, `${why}: answered ${res.status}`);
      assert.match(JSON.stringify(res.body), message, why);
      assert.equal(await stages(), 0, `${why}: no invoice was created`);
      assert.deepEqual(await linked(), [], `${why}: and the good trip was not linked`);
    }
  });

  test('a trip already billed is never silently moved', async () => {
    await raise(admin, base({ invoice_no: 'TI/FIRST/1', travel_ids: ['API-TRV-PRJ'] })).expect(201);
    const res = await raise(admin, base({ invoice_no: 'TI/SECOND/1', travel_ids: ['API-TRV-PRJ'] }));
    assert.equal(res.status, 422, JSON.stringify(res.body));
    assert.match(res.body.error.message, /already billed on another invoice/);
    assert.equal(await stages(), 1, 'the second invoice was not created');
    const { rows: [t] } = await db.query(
      `SELECT s.invoice_no FROM travel_logs t JOIN payment_stages s ON s.id = t.billed_stage_id WHERE t.travel_id = 'API-TRV-PRJ'`);
    assert.equal(t.invoice_no, 'TI/FIRST/1', 'and the trip is still on the first');
  });

  test('a PO that is not the project\'s is refused before anything is written', async () => {
    const res = await raise(admin, base({ project_id: 'API-PRJ-ONLY', po_number: 'API-PO', invoice_no: 'TI/MIX/1', travel_ids: [] }));
    assert.equal(res.status, 422, JSON.stringify(res.body));
    assert.match(JSON.stringify(res.body), /belongs to project API-PRJ/);
    assert.equal(await stages(), 0);
  });

  test('a reused invoice number is refused and nothing is left behind', async () => {
    await raise(admin, base({ invoice_no: 'TI/DUP/1', travel_ids: [] })).expect(201);
    const res = await raise(admin, base({ invoice_no: 'TI/DUP/1', travel_ids: ['API-TRV-PRJ'] }));
    assert.ok(res.status >= 400 && res.status < 500, `answered ${res.status}`);
    assert.equal(await stages(), 1);
    assert.deepEqual(await linked(), [], 'the trip in the refused request was not linked');
  });

  test('the request itself is validated', async () => {
    const bad = [
      ['no project', { project_id: '' }],
      ['no invoice number', { invoice_no: '' }],
      ['no amount', { amount: null }],
      ['a zero amount', { amount: 0 }],
      ['a negative amount', { amount: -100 }],
      ['a malformed date', { invoice_date: '12-10-2026' }],
    ];
    for (const [why, over] of bad) {
      const res = await raise(admin, base({ ...over, travel_ids: [] }));
      assert.equal(res.status, 422, `${why}: answered ${res.status} ${JSON.stringify(res.body)}`);
      assert.equal(await stages(), 0, why);
    }
  });

  // ------------------------------------------- the trip page links it later

  test('the billed-stage route accepts a travel invoice and refuses an ordinary stage', async () => {
    const res = await raise(admin, base({ invoice_no: 'TI/LINK/1', travel_ids: [] }));
    const travelStageId = res.body.data.id;
    const { rows: [poStage] } = await db.query(
      `SELECT id FROM payment_stages WHERE po_number = 'API-PO' AND stage_no = 1`);

    const ok = await admin.post('/api/travel-logs/API-TRV-PRJ/billed-stage').send({ billed_stage_id: travelStageId });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(await linked(), ['API-TRV-PRJ']);

    const refused = await admin.post('/api/travel-logs/API-TRV-PRJ/billed-stage').send({ billed_stage_id: poStage.id });
    assert.ok(refused.status >= 400, `an ordinary PO stage answered ${refused.status}`);
    assert.match(JSON.stringify(refused.body), /not on an ordinary PO payment stage/,
      'and says so in words rather than as a constraint violation');

    const cleared = await admin.post('/api/travel-logs/API-TRV-PRJ/billed-stage').send({ billed_stage_id: null });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
    assert.deepEqual(await linked(), []);
  });

  test('the billed-stage route is still closed to HR, as #221 left it', async () => {
    const res = await hr.post('/api/travel-logs/API-TRV-PRJ/billed-stage').send({ billed_stage_id: null });
    assert.equal(res.status, 403);
  });

  // -------------------------------------- the salesperson can read it back

  test('the salesperson who owns the project can list their project-only travel invoice', async () => {
    await raise(sales, base({ project_id: 'API-PRJ-ONLY', invoice_no: 'TI/READ/1', travel_ids: [] })).expect(201);
    const mine = await sales.get('/api/payment-stages?project_id=API-PRJ-ONLY');
    assert.equal(mine.status, 200, JSON.stringify(mine.body));
    const found = (mine.body.data ?? []).filter((s) => s.invoice_no === 'TI/READ/1');
    assert.equal(found.length, 1,
      'a travel invoice with no PO still has to be reachable by whoever owns its project — '
      + 'via_po alone would have failed closed and hidden it');
    // And not by a salesperson who owns neither.
    const theirs = await other.get('/api/payment-stages?project_id=API-PRJ-ONLY');
    assert.equal((theirs.body.data ?? []).filter((s) => s.invoice_no === 'TI/READ/1').length, 0);
  });

  test('a receipt against a project-only travel invoice is reachable by its owner', async () => {
    const res = await raise(sales, base({ project_id: 'API-PRJ-ONLY', invoice_no: 'TI/RCPT/1', amount: 10000, travel_ids: [] }));
    const stageId = res.body.data.id;
    const paid = await sales.post(`/api/payment-stages/${stageId}/payment`)
      .send({ amount_received: 4000, payment_received_date: today() });
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    const { rows: [v] } = await db.query('SELECT amount_received, stage_status FROM v_payment_stages WHERE id = $1', [stageId]);
    assert.equal(Number(v.amount_received), 4000);
    assert.equal(v.stage_status, 'Partially Paid');
  });
});
