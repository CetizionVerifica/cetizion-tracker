import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * What the client was billed for a trip, read through (#214 §5.1, §5.3, §4).
 *
 * Three things are held in place here.
 *
 * **Nothing is stored.** `v_trip_billing` reads the invoice, what has been
 * received against it and whether it is late from the payment stage every
 * time. A receipt added anywhere else changes a trip's billing by itself,
 * and the suite proves that by adding one and re-reading the trip.
 *
 * **The travel desk sees one slice of the sales side and no more.** The
 * invoice a trip is billed on: number, date, amount, received, when,
 * status, PDF. Not the payment-stage list, not an ordinary PO stage, not a
 * travel invoice nobody has linked a trip to, and not a single receipt row.
 * Every one of those is asserted as a refusal rather than assumed.
 *
 * **Trips billed before travel invoices existed.** `billed_stage_id` could
 * once name any stage. Such a trip is not billed on a travel invoice, so it
 * reads `not_billed` and carries no figures — and says so with
 * `billed_on_po_stage` instead of being quietly counted as billed.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
const PASSWORD = 'a-good-long-test-password';

describe('trip billing read-through (#214)', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  const NAME = `rt_${process.pid}_${Date.now()}`;
  let db; let app; let admin; let sales; let hr; let anonymous;
  /** the real user ids, so an ownership scope in a test is a real person. */
  const userId = {};
  /** document ids, by what they hang off. */
  const doc = {};

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
    for (const [role, email] of [['admin', 'ada@example.com'], ['sales', 'sam@example.com'], ['hr', 'hema@example.com']]) {
      userId[role] = (await createUser({ name: role, email, password: PASSWORD, role }, db)).id;
    }
    admin = await signIn('ada@example.com');
    sales = await signIn('sam@example.com');
    hr = await signIn('hema@example.com');
    anonymous = request(app);

    const document = async (key) => (await db.query(
      `INSERT INTO documents (storage_key, file_name, content_type, size_bytes)
            VALUES ($1, $1 || '.pdf', 'application/pdf', 100) RETURNING id`, [key])).rows[0].id;
    for (const key of ['rt-paid', 'rt-unlinked', 'rt-postage', 'rt-po', 'rt-quotation']) doc[key] = await document(key);

    await db.query(`INSERT INTO companies (name) VALUES ('Honor Labs')`);
    await db.query(
      `INSERT INTO projects (project_id, client_name, primary_service, owner_user_id)
            VALUES ('RT-PRJ', 'Honor Labs', 'Testing', $1), ('RT-PRJ-ONLY', 'Honor Labs', 'Testing', $1)`,
      [userId.sales]);
    await db.query(
      `INSERT INTO purchase_orders (po_number, project_id, po_value, po_date, payment_terms_days, document_id)
            VALUES ('RT-PO', 'RT-PRJ', 1000000, CURRENT_DATE - 60, 30, $1)`, [doc['rt-po']]);
    await db.query(`INSERT INTO quotations (quotation_no, client_name, document_id, owner_user_id)
                         VALUES ('RT-Q', 'Honor Labs', $1, $2)`, [doc['rt-quotation'], userId.sales]);
    // An ordinary share of the PO, carrying a PDF of its own.
    await db.query(
      `INSERT INTO payment_stages (po_number, stage_no, stage_name, stage_percent, invoice_no, invoice_date, document_id)
            VALUES ('RT-PO', 1, 'Advance (100%)', 1, 'CVPL/RT/PO', CURRENT_DATE - 50, $1)`, [doc['rt-postage']]);

    /** A travel invoice, and the trip it bills. */
    // `dated` is a SQL date expression, interpolated rather than bound: it
    // has to be evaluated by the server so the fixtures age relative to
    // today, and every value passed is a literal written here.
    const travelInvoice = async ({ ref, project, po = null, amount, days = 30, dated, documentId = null }) =>
      (await db.query(
        `INSERT INTO payment_stages (kind, project_id, po_number, stage_name, trigger_event, amount, invoice_no, invoice_date, credit_days, document_id)
              VALUES ('travel', $1, $2, 'Travel invoice', 'Manual', $3, $4, ${dated}, $5, $6) RETURNING id`,
        [project, po, amount, ref, days, documentId])).rows[0].id;
    const trip = async (travelId, { po = null, project = null, cancelled = false, chargeable = true } = {}) => {
      if (!chargeable) {
        await db.query(`INSERT INTO travel_logs (travel_id, employee_name) VALUES ($1, 'Internal')`, [travelId]);
        return;
      }
      await db.query(
        `INSERT INTO travel_logs (travel_id, employee_name, po_number, project_id, cancelled, travel_start_date, travel_end_date)
              VALUES ($1, 'Asha', $2, $3, $4, CURRENT_DATE - 20, CURRENT_DATE - 18)`,
        [travelId, po, project, cancelled]);
    };
    const bill = (travelId, stageId) =>
      db.query('UPDATE travel_logs SET billed_stage_id = $1 WHERE travel_id = $2', [stageId, travelId]);
    const receipt = (stageId, amount, on) =>
      db.query(`INSERT INTO payments (stage_id, amount, received_on, mode) VALUES ($1,$2,$3,'bank_transfer')`, [stageId, amount, on]);

    // paid — on a project with no PO, with a PDF
    const paid = await travelInvoice({ ref: 'CVPL/RT/PAID', project: 'RT-PRJ-ONLY', amount: 37500, dated: 'CURRENT_DATE - 10', documentId: doc['rt-paid'] });
    await trip('RT-PAID', { project: 'RT-PRJ-ONLY' }); await bill('RT-PAID', paid);
    await receipt(paid, 37500, new Date().toISOString().slice(0, 10));

    // partly paid — on the PO
    const partly = await travelInvoice({ ref: 'CVPL/RT/PARTLY', project: 'RT-PRJ', po: 'RT-PO', amount: 50000, dated: 'CURRENT_DATE - 5' });
    await trip('RT-PARTLY', { po: 'RT-PO' }); await bill('RT-PARTLY', partly);
    await receipt(partly, 20000, new Date().toISOString().slice(0, 10));

    // overdue — raised 45 days ago on 30-day terms
    const overdue = await travelInvoice({ ref: 'CVPL/RT/OVERDUE', project: 'RT-PRJ-ONLY', amount: 10000, dated: 'CURRENT_DATE - 45' });
    await trip('RT-OVERDUE', { project: 'RT-PRJ-ONLY' }); await bill('RT-OVERDUE', overdue);

    // due — raised today
    const due = await travelInvoice({ ref: 'CVPL/RT/DUE', project: 'RT-PRJ-ONLY', amount: 5000, dated: 'CURRENT_DATE' });
    await trip('RT-DUE', { project: 'RT-PRJ-ONLY' }); await bill('RT-DUE', due);

    // chargeable, on no invoice
    await trip('RT-NOTBILLED', { project: 'RT-PRJ-ONLY' });
    // not chargeable at all
    await trip('RT-INTERNAL', { chargeable: false });
    // cancelled, but already billed
    const cancelledInv = await travelInvoice({ ref: 'CVPL/RT/CANX', project: 'RT-PRJ-ONLY', amount: 1000, dated: 'CURRENT_DATE - 2' });
    await trip('RT-CANCELLED', { project: 'RT-PRJ-ONLY', cancelled: true }); await bill('RT-CANCELLED', cancelledInv);

    // a travel invoice with a PDF that NO trip points at
    doc.unlinkedStage = await travelInvoice({ ref: 'CVPL/RT/UNLINKED', project: 'RT-PRJ-ONLY', amount: 999, dated: 'CURRENT_DATE', documentId: doc['rt-unlinked'] });

    // and a trip billed the old way, on the ordinary stage, set behind the
    // trigger's back exactly as a pre-097 row would have been
    await trip('RT-LEGACY', { po: 'RT-PO' });
    await db.query('ALTER TABLE travel_logs DISABLE TRIGGER travel_logs_rules');
    await db.query(`UPDATE travel_logs SET billed_stage_id =
                      (SELECT id FROM payment_stages WHERE invoice_no = 'CVPL/RT/PO')
                    WHERE travel_id = 'RT-LEGACY'`);
    await db.query('ALTER TABLE travel_logs ENABLE TRIGGER travel_logs_rules');
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

  const billing = async (travelId) => (await db.query(
    'SELECT * FROM v_trip_billing WHERE travel_id = $1', [travelId])).rows[0];

  // ------------------------------------------------------- v_trip_billing

  test('every billing_status the view can reach, from the stage it reads', async () => {
    const expected = {
      'RT-PAID': 'paid',
      'RT-PARTLY': 'partly_paid',
      'RT-OVERDUE': 'overdue',
      'RT-DUE': 'due',
      'RT-NOTBILLED': 'not_billed',
      'RT-INTERNAL': 'not_chargeable',
    };
    for (const [travelId, status] of Object.entries(expected)) {
      const row = await billing(travelId);
      assert.equal(row.billing_status, status, travelId);
    }
  });

  test('a project-only travel invoice reads back in full', async () => {
    const row = await billing('RT-PAID');
    assert.equal(row.po_number, null, 'no PO at all');
    assert.equal(row.project_id, 'RT-PRJ-ONLY');
    assert.equal(row.client_name, 'Honor Labs');
    assert.equal(row.invoice_no, 'CVPL/RT/PAID');
    assert.equal(Number(row.invoice_amount), 37500, 'its own printed total');
    assert.equal(Number(row.amount_received), 37500);
    assert.ok(row.payment_received_date, 'and when');
    assert.equal(row.stage_status, 'Paid');
    assert.equal(row.invoice_document_id, doc['rt-paid']);
    assert.equal(row.chargeable, true);
    assert.equal(row.cancelled, false);
    assert.equal(row.days_overdue, 0);
    assert.equal(row.billed_on_po_stage, false);
  });

  test('a PO travel invoice reads back with its PO', async () => {
    const row = await billing('RT-PARTLY');
    assert.equal(row.po_number, 'RT-PO');
    assert.equal(row.project_id, 'RT-PRJ');
    assert.equal(Number(row.invoice_amount), 50000);
    assert.equal(Number(row.amount_received), 20000);
    assert.equal(row.billing_status, 'partly_paid');
  });

  test('an overdue invoice counts its days late', async () => {
    const row = await billing('RT-OVERDUE');
    assert.equal(row.billing_status, 'overdue');
    assert.equal(row.days_overdue, 15, '45 days old on 30-day terms');
  });

  test('a chargeable trip on no invoice carries no figures', async () => {
    const row = await billing('RT-NOTBILLED');
    assert.equal(row.billing_status, 'not_billed');
    for (const field of ['stage_id', 'invoice_no', 'invoice_date', 'invoice_amount', 'amount_received', 'invoice_document_id']) {
      assert.equal(row[field], null, field);
    }
    assert.equal(row.days_overdue, 0);
  });

  test('a non-chargeable trip reads not_chargeable, never not_billed', async () => {
    const row = await billing('RT-INTERNAL');
    assert.equal(row.billing_status, 'not_chargeable');
    assert.equal(row.chargeable, false);
  });

  test('cancelling a trip does not unbill it', async () => {
    const row = await billing('RT-CANCELLED');
    assert.equal(row.cancelled, true);
    assert.equal(row.invoice_no, 'CVPL/RT/CANX', 'the invoice was raised and still has to be collected');
    assert.ok(['due', 'partly_paid', 'paid', 'overdue'].includes(row.billing_status), row.billing_status);
  });

  test('a trip billed the old way on an ordinary stage is not counted as billed', async () => {
    const row = await billing('RT-LEGACY');
    assert.equal(row.billing_status, 'not_billed',
      'an ordinary share of the PO does not bill a trip, so nothing downstream may read it as billed');
    assert.equal(row.stage_id, null, 'and it exposes no invoice figures');
    assert.equal(row.invoice_no, null);
    assert.equal(row.invoice_document_id, null);
    assert.equal(row.billed_on_po_stage, true, 'but it says the link is there to be looked at');
  });

  test('nothing is stored: a receipt added elsewhere changes the trip', async () => {
    const before = await billing('RT-DUE');
    assert.equal(before.billing_status, 'due');
    const { rows: [s] } = await db.query(`SELECT id FROM payment_stages WHERE invoice_no = 'CVPL/RT/DUE'`);
    await db.query(`INSERT INTO payments (stage_id, amount, received_on, mode) VALUES ($1, 5000, CURRENT_DATE, 'bank_transfer')`, [s.id]);
    const after = await billing('RT-DUE');
    assert.equal(after.billing_status, 'paid', 'read through, not copied onto the trip');
    assert.equal(Number(after.amount_received), 5000);
    // Put it back, so the other tests read what they seeded.
    await db.query('DELETE FROM payments WHERE stage_id = $1', [s.id]);
    assert.equal((await billing('RT-DUE')).billing_status, 'due');
  });

  test('one row per trip, no more and no fewer', async () => {
    const { rows: [n] } = await db.query(
      `SELECT (SELECT count(*) FROM travel_logs)::int AS trips, (SELECT count(*) FROM v_trip_billing)::int AS rows`);
    assert.equal(n.rows, n.trips);
  });

  // ------------------------------------------------- the billing block

  test('the trip reply carries the billing block, for every role', async () => {
    for (const who of [admin, sales, hr]) {
      const res = await who.get('/api/travel-logs/RT-PAID/full');
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const b = res.body.data.billing;
      assert.ok(b, 'the block is there');
      assert.equal(b.invoice_no, 'CVPL/RT/PAID');
      assert.equal(Number(b.invoice_amount), 37500);
      assert.equal(Number(b.amount_received), 37500);
      assert.equal(b.billing_status, 'paid');
      assert.equal(b.invoice_document_id, doc['rt-paid']);
    }
  });

  test('the block carries exactly the columns the travel desk may see', async () => {
    const res = await hr.get('/api/travel-logs/RT-PARTLY/full').expect(200);
    assert.deepEqual(Object.keys(res.body.data.billing).sort(), [
      'amount_received', 'billed_on_po_stage', 'billing_status', 'cancelled', 'chargeable',
      'days_overdue', 'invoice_amount', 'invoice_date', 'invoice_document_id', 'invoice_no',
      'payment_received_date', 'stage_id', 'stage_status',
    ], 'the shape is the whole of the slice; a column added here is a decision');
  });

  test('and nothing of the sales side beyond it', async () => {
    const res = await hr.get('/api/travel-logs/RT-PARTLY/full').expect(200);
    const body = JSON.stringify(res.body);
    for (const leak of ['stage_percent', 'po_value', 'terms_days', 'reminder_level', 'on_hold',
      'hold_reason', 'promise_to_pay_date', 'tds_amount', 'quotation_no', 'margin']) {
      assert.equal(body.includes(leak), false, `${leak} reached the travel desk`);
    }
    assert.equal(res.body.data.payments, undefined, 'no receipt rows');
  });

  test('a trip nobody billed still answers, with the block saying so', async () => {
    const res = await hr.get('/api/travel-logs/RT-NOTBILLED/full').expect(200);
    assert.equal(res.body.data.billing.billing_status, 'not_billed');
    assert.equal(res.body.data.billing.invoice_no, null);
  });

  test('nobody signed in reaches the trip at all', async () => {
    await anonymous.get('/api/travel-logs/RT-PAID/full').expect(401);
  });

  // ------------------------------------------------------- HR's limits

  test('the travel desk still gets no generic payment-stage access', async () => {
    for (const [method, path] of [
      ['get', '/api/payment-stages'], ['post', '/api/payment-stages'],
      ['get', '/api/payment-stages?kind=travel'],
      ['get', '/api/payments'], ['post', '/api/payments'],
      ['get', '/api/quotations'], ['get', '/api/purchase-orders'],
      ['get', '/api/dashboard/collections'],
    ]) {
      const res = await hr[method](path).send({});
      assert.equal(res.status, 403, `${method} ${path} answered ${res.status} to HR`);
    }
  });

  test('the travel desk cannot edit the invoice it can read', async () => {
    const { rows: [s] } = await db.query(`SELECT id FROM payment_stages WHERE invoice_no = 'CVPL/RT/PAID'`);
    for (const [method, path] of [
      ['patch', `/api/payment-stages/${s.id}`],
      ['delete', `/api/payment-stages/${s.id}`],
      ['post', `/api/payment-stages/${s.id}/payment`],
      ['post', `/api/payment-stages/${s.id}/invoice`],
      ['post', '/api/travel-invoices'],
    ]) {
      const res = await hr[method](path).send({ amount: 1 });
      assert.equal(res.status, 403, `${method} ${path} answered ${res.status} to HR`);
    }
    const { rows: [after] } = await db.query('SELECT amount FROM payment_stages WHERE id = $1', [s.id]);
    assert.equal(Number(after.amount), 37500, 'and the figure did not move');
  });

  test('admin and sales keep everything they had', async () => {
    for (const who of [admin, sales]) {
      assert.equal((await who.get('/api/payment-stages')).status, 200);
      assert.equal((await who.get('/api/travel-logs/RT-PAID/full')).status, 200);
    }
  });

  // --------------------------------------------------- the invoice PDF

  test('the travel desk opens a linked travel invoice PDF and nothing else', async () => {
    const { assertDocumentReadable } = await import('../src/lib/documents.js');
    const HR = { unrestricted: false, ownerId: 99, hr: true };
    const SALES = { unrestricted: false, ownerId: userId.sales };
    const ADMIN = { unrestricted: true, ownerId: null };

    // The one it may: a travel invoice a trip is billed on.
    await assertDocumentReadable(HR, doc['rt-paid']);

    const refused = async (id, why) => assert.rejects(
      () => assertDocumentReadable(HR, id), (err) => err.status === 404, why);
    await refused(doc['rt-unlinked'], 'a travel invoice no trip points at');
    await refused(doc['rt-postage'], 'an ordinary PO stage\'s invoice');
    await refused(doc['rt-po'], 'the PO itself');
    await refused(doc['rt-quotation'], 'a quotation');

    // Admin reads everything, as before; the salesperson who owns the
    // records reads theirs, as before.
    for (const id of Object.values(doc).filter((v) => typeof v === 'number')) {
      await assertDocumentReadable(ADMIN, id);
    }
    await assertDocumentReadable(SALES, doc['rt-quotation']);
  });

  test('unbilling a trip closes its invoice PDF to the travel desk again', async () => {
    const { assertDocumentReadable } = await import('../src/lib/documents.js');
    const HR = { unrestricted: false, ownerId: 99, hr: true };
    await db.query(`UPDATE travel_logs SET billed_stage_id = NULL WHERE travel_id = 'RT-PAID'`);
    await assert.rejects(() => assertDocumentReadable(HR, doc['rt-paid']),
      (err) => err.status === 404, 'the clause reads the link, not a copy of it');
    // Put it back for anything after this.
    const { rows: [s] } = await db.query(`SELECT id FROM payment_stages WHERE invoice_no = 'CVPL/RT/PAID'`);
    await db.query(`UPDATE travel_logs SET billed_stage_id = $1 WHERE travel_id = 'RT-PAID'`, [s.id]);
    await assertDocumentReadable(HR, doc['rt-paid']);
  });
});
