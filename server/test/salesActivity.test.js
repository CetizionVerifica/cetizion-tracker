import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * The sales workflow in the activity log (#18 §3).
 *
 * §3 asks for the log to be written by "the save hooks and workflow routes
 * (create, update, status change, owner change, convert, invoice,
 * payment)". Phase 1.5 delivered the table and the admin events, ownership
 * added the owner changes; these are the rest.
 *
 * Two things are worth proving beyond "a row appears". First that the actor
 * comes from the session and cannot be set from the body — an audit trail
 * whose author is whatever the caller typed is fiction, which is exactly
 * what #85 found on expense claims. Second that the log is *quiet*: a save
 * that changed nothing, or changed only a phone number, writes nothing. A
 * timeline of fifty "Ramesh saved this" rows hides the one that mattered.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const PASSWORD = 'a-good-long-test-password';
const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
const WON = 'Won - PO Received';

describe('the sales workflow, logged', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let dbUrl; let db; let app; let pool; let createUser;
  let admin; let sales;

  before(async () => {
    const root = new pg.Client({ connectionString: ADMIN_URL });
    await root.connect();
    const name = `salesact_${process.pid}_${Date.now()}`;
    await root.query(`CREATE DATABASE ${name}`);
    await root.end();
    const u = new URL(ADMIN_URL);
    u.pathname = `/${name}`;
    dbUrl = u.toString();

    db = new pg.Client({ connectionString: dbUrl });
    await db.connect();
    await db.query(readFileSync(join(DB_DIR, 'schema.sql'), 'utf8'));
    await db.query(readFileSync(join(DB_DIR, 'views.sql'), 'utf8'));

    Object.assign(process.env, {
      SKIP_DOTENV: '1', NODE_ENV: 'test', DATABASE_URL: dbUrl,
      AUTH_MODE: 'database', SESSION_SECRET: 'test-secret-that-is-long-enough-to-pass', EMAIL_MODE: 'log',
    });
    ({ default: app } = await import('../src/app.js'));
    ({ pool } = await import('../src/db.js'));
    ({ createUser } = await import('../src/lib/users.js'));
  });

  after(async () => {
    await pool?.end();
    await db?.end();
    const root = new pg.Client({ connectionString: ADMIN_URL });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${new URL(dbUrl).pathname.slice(1)} WITH (FORCE)`);
    await root.end();
  });

  const signIn = async (email) => {
    const res = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.headers['set-cookie'];
  };

  async function setUp() {
    for (const t of ['activity_log', 'auth_events', 'payments', 'payment_stages',
      'purchase_orders', 'quotations', 'enquiries', 'projects', 'users']) {
      await db.query(`DELETE FROM ${t}`);
    }
    const mk = async (over) => createUser({ password: PASSWORD, ...over }, db);
    const a = await mk({ name: 'Alice Admin', email: 'alice@example.com', role: 'admin' });
    const s = await mk({ name: 'Sam Sales', email: 'sam@example.com', role: 'sales' });
    admin = { user: a, cookie: await signIn(a.email) };
    sales = { user: s, cookie: await signIn(s.email) };
    await db.query('DELETE FROM activity_log');
  }

  const events = async (action = null) => {
    const { rows } = action
      ? await db.query('SELECT * FROM activity_log WHERE action = $1 ORDER BY id', [action])
      : await db.query('SELECT * FROM activity_log ORDER BY id');
    return rows;
  };

  const newQuotation = async (who, over = {}) => {
    const res = await request(app).post('/api/quotations').set('Cookie', who.cookie)
      .send({ client_name: 'A Client', quotation_date: '2026-03-01', quotation_value: 100000, currency: 'INR', ...over });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.data;
  };

  // ------------------------------------------------------------- creating

  test('creating a quotation is recorded, against the account that did it', async () => {
    await setUp();
    const q = await newQuotation(sales);

    const [row] = await events('quotation.created');
    assert.ok(row, 'a create is an act worth recording');
    assert.equal(row.entity_type, 'quotation');
    assert.equal(row.entity_id, q.quotation_no, 'named the way a person would look it up');
    assert.equal(row.actor_user_id, sales.user.id, 'the actor is the session, not the body');
    assert.equal(row.actor_type, 'user');
    assert.equal(row.metadata.owner_user_id, sales.user.id);
  });

  test('the actor cannot be set from the request body', async () => {
    await setUp();
    await newQuotation(sales, { created_by: 'Alice Admin', sales_person: 'Somebody Else' });

    const [row] = await events('quotation.created');
    assert.equal(row.actor_user_id, sales.user.id, 'an audit trail the caller can author is fiction');
    assert.equal(row.metadata.actor_name, 'Sam Sales');
  });

  // ------------------------------------------------------- status changes

  test('a status change is its own event, with what it moved between', async () => {
    await setUp();
    const q = await newQuotation(sales);

    const res = await request(app).patch(`/api/quotations/${q.id}`)
      .set('Cookie', sales.cookie).send({ status: WON });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const [row] = await events('quotation.status_changed');
    assert.ok(row, 'the event a timeline, a KPI and a handover argument all look for');
    assert.equal(row.metadata.from, 'Submitted');
    assert.equal(row.metadata.to, WON);
    assert.ok(row.metadata.won_at, 'and it carries the date 064 derived, so the two cannot disagree');
  });

  test('an enquiry decision is recorded the same way', async () => {
    await setUp();
    // #24 will not let a lead leave New without a source, or become
    // Unqualified without a reason. Both are the enquiry's own rules, not
    // this change's, so the test supplies them rather than working round.
    // Both catalogues ship seeded with the schema, so take what is there
    // rather than inserting a name that already exists.
    const pick = async (table) => (
      await db.query(`SELECT id FROM ${table} ORDER BY id LIMIT 1`)).rows[0];
    const src = await pick('lead_sources');
    const why = await pick('lost_reasons');
    assert.ok(src && why, 'the seeded catalogues are what #24 validates against');

    const res = await request(app).post('/api/enquiries').set('Cookie', sales.cookie)
      .send({ client_name: 'A Client', enquiry_date: '2026-02-01', source_id: src.id });
    assert.equal(res.status, 201, JSON.stringify(res.body));

    const patched = await request(app).patch(`/api/enquiries/${res.body.data.id}`)
      .set('Cookie', sales.cookie)
      .send({ status: 'Unqualified', unqualified_reason_id: why.id });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));

    const [row] = await events('enquiry.status_changed');
    assert.equal(row.metadata.to, 'Unqualified');
    assert.ok(row.metadata.decided_at);
  });

  // ------------------------------------------------------------ the edits

  test('a meaningful edit is recorded with what it changed from', async () => {
    await setUp();
    const q = await newQuotation(sales);

    await request(app).patch(`/api/quotations/${q.id}`)
      .set('Cookie', sales.cookie).send({ quotation_value: 40000 }).expect(200);

    const [row] = await events('quotation.updated');
    assert.ok(row, 'who dropped the price by 60% is what this is for');
    assert.equal(Number(row.metadata.changes.quotation_value.from), 100000);
    assert.equal(Number(row.metadata.changes.quotation_value.to), 40000);
  });

  test('a save that changes nothing meaningful writes nothing', async () => {
    await setUp();
    const q = await newQuotation(sales);
    await db.query('DELETE FROM activity_log');

    // A field nobody audits, and then the same value it already had.
    await request(app).patch(`/api/quotations/${q.id}`)
      .set('Cookie', sales.cookie).send({ contact_person: 'Someone' }).expect(200);
    await request(app).patch(`/api/quotations/${q.id}`)
      .set('Cookie', sales.cookie).send({ quotation_value: 100000 }).expect(200);

    assert.deepEqual(await events(), [],
      'fifty rows saying "Sam saved this" hide the one save that mattered');
  });

  test('a status change and an edit in one save are two rows, not one', async () => {
    await setUp();
    const q = await newQuotation(sales);

    await request(app).patch(`/api/quotations/${q.id}`)
      .set('Cookie', sales.cookie).send({ status: WON, quotation_value: 150000 }).expect(200);

    assert.equal((await events('quotation.status_changed')).length, 1);
    assert.equal((await events('quotation.updated')).length, 1);
  });

  // -------------------------------------------------------- the workflow

  test('converting a won quotation is recorded against the quotation', async () => {
    await setUp();
    const q = await newQuotation(sales);
    await request(app).patch(`/api/quotations/${q.id}`)
      .set('Cookie', sales.cookie).send({ status: WON }).expect(200);

    const res = await request(app).post(`/api/quotations/${q.id}/convert`)
      .set('Cookie', sales.cookie).send({});
    assert.equal(res.status, 201, JSON.stringify(res.body));

    const [row] = await events('quotation.converted');
    assert.ok(row, 'what became of this deal is followed forward from the quotation');
    assert.equal(row.entity_id, q.quotation_no);
    assert.equal(row.metadata.linked_to_existing, false);
    assert.ok(row.metadata.project_id);
    assert.equal(row.actor_user_id, sales.user.id);
  });

  test('invoicing and receipting a stage are recorded, with the money', async () => {
    await setUp();
    const q = await newQuotation(sales);
    await request(app).patch(`/api/quotations/${q.id}`)
      .set('Cookie', sales.cookie).send({ status: WON }).expect(200);
    const conv = await request(app).post(`/api/quotations/${q.id}/convert`)
      .set('Cookie', sales.cookie).send({}).expect(201);
    const projectId = conv.body.data.project.project_id;

    await db.query(
      `INSERT INTO purchase_orders (po_number, project_id, po_date, po_value, quotation_no)
       VALUES ('PO-1', $1, '2026-04-01', 100000, $2)`, [projectId, q.quotation_no]);
    const { rows: [stage] } = await db.query(
      `INSERT INTO payment_stages (po_number, stage_no, stage_name, trigger_event, stage_percent)
       VALUES ('PO-1', 1, 'Advance', 'On PO Registration', 1) RETURNING id`);
    await db.query('DELETE FROM activity_log');

    await request(app).post(`/api/payment-stages/${stage.id}/invoice`)
      .set('Cookie', sales.cookie).send({ invoice_date: '2026-04-05' }).expect(200);
    const [inv] = await events('stage.invoiced');
    assert.ok(inv, 'when we invoiced an order is an audit question');
    assert.equal(inv.metadata.po_number, 'PO-1');
    assert.equal(inv.metadata.invoice_date, '2026-04-05');

    await request(app).post(`/api/payment-stages/${stage.id}/payment`)
      .set('Cookie', sales.cookie)
      .send({ amount_received: 60000, payment_received_date: '2026-05-01' }).expect(200);
    const [pay] = await events('payment.recorded');
    assert.ok(pay, 'money arriving is the other half');
    assert.equal(Number(pay.metadata.amount), 60000);
    assert.equal(pay.metadata.adjustment, false);
    assert.equal(pay.actor_user_id, sales.user.id);
  });

  test('a correction that reduces a total is recorded as an adjustment', async () => {
    await setUp();
    await db.query(
      `INSERT INTO projects (project_id, client_name) VALUES ('PRJ-X', 'A Client')`);
    await db.query(
      `INSERT INTO purchase_orders (po_number, project_id, po_date, po_value)
       VALUES ('PO-X', 'PRJ-X', '2026-04-01', 100000)`);
    const { rows: [stage] } = await db.query(
      `INSERT INTO payment_stages (po_number, stage_no, stage_name, trigger_event, stage_percent)
       VALUES ('PO-X', 1, 'Advance', 'On PO Registration', 1) RETURNING id`);

    await request(app).post(`/api/payment-stages/${stage.id}/payment`)
      .set('Cookie', admin.cookie).send({ amount_received: 80000 }).expect(200);
    await db.query('DELETE FROM activity_log');

    await request(app).post(`/api/payment-stages/${stage.id}/payment`)
      .set('Cookie', admin.cookie).send({ amount_received: 50000, mode: 'set' }).expect(200);

    const [row] = await events('payment.recorded');
    assert.ok(row, 'who reduced this by three lakh is exactly what an audit trail on money is for');
    assert.equal(row.metadata.adjustment, true);
    assert.equal(Number(row.metadata.amount), -30000);
  });

  // -------------------------------------------------------- the timeline

  test('the record timeline shows the acts and the handovers, to whoever may read it', async () => {
    await setUp();
    const q = await newQuotation(sales);
    await request(app).patch(`/api/quotations/${q.id}`)
      .set('Cookie', sales.cookie).send({ status: WON }).expect(200);
    await request(app).patch(`/api/quotations/${q.id}/owner`)
      .set('Cookie', admin.cookie)
      .send({ expected_owner_user_id: sales.user.id, new_owner_user_id: null, reason: 'Sam has left' })
      .expect(200);

    const res = await request(app)
      .get(`/api/timeline?entity=quotation&id=${encodeURIComponent(q.quotation_no)}`)
      .set('Cookie', admin.cookie);
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const kinds = res.body.data.map((i) => i.kind);
    assert.ok(kinds.includes('activity'), 'the acts belong on the record they happened to');
    assert.ok(kinds.includes('handover'), 'and so does who it changed hands between');

    const moved = res.body.data.find((i) => i.action === 'quotation.status_changed');
    assert.equal(moved.title, `Moved to ${WON}`, 'a sentence, not metadata for the reader to parse');
    assert.equal(moved.by, 'Sam Sales');

    const handover = res.body.data.find((i) => i.kind === 'handover');
    assert.match(handover.title, /Sam Sales → nobody/);
    assert.equal(handover.detail, 'Sam has left');
  });

  test('the timeline is still one gate: a sales user gets 404, not a filtered list', async () => {
    await setUp();
    const q = await newQuotation(admin);            // admin-created: unowned
    const res = await request(app)
      .get(`/api/timeline?entity=quotation&id=${encodeURIComponent(q.quotation_no)}`)
      .set('Cookie', sales.cookie);
    assert.equal(res.status, 404, 'an unowned record is admin-only, and so is its history');
  });

  // --------------------------------------------------------- the sessions

  test('a sign-in records which account it resolved to, not just the typed name', async () => {
    await setUp();
    await db.query('DELETE FROM auth_events');
    await signIn(sales.user.email);

    const { rows } = await db.query('SELECT * FROM auth_events WHERE ok ORDER BY id DESC LIMIT 1');
    assert.equal(rows[0].user_id, sales.user.id, '"every session this person opened" needs an id');
  });

  test('a failed sign-in is recorded without inventing an account for it', async () => {
    await setUp();
    await db.query('DELETE FROM auth_events');
    await request(app).post('/api/auth/login')
      .send({ email: sales.user.email, password: 'not-the-password' }).expect(401);

    const { rows } = await db.query('SELECT * FROM auth_events ORDER BY id DESC LIMIT 1');
    assert.equal(rows[0].ok, false);
    assert.equal(rows[0].user_id, null, 'nobody knows who a wrong password belongs to');
  });

  test('a sign-out is an event, so a session has an end as well as a start', async () => {
    await setUp();
    const cookie = await signIn(sales.user.email);
    await db.query('DELETE FROM auth_events');

    await request(app).post('/api/auth/logout').set('Cookie', cookie).expect(204);

    const { rows } = await db.query('SELECT * FROM auth_events ORDER BY id DESC LIMIT 1');
    assert.equal(rows[0].reason, 'signed out');
    assert.equal(rows[0].user_id, sales.user.id);
    assert.equal(rows[0].ok, true, 'signing out is not a failed sign-in, and must not count as one');
  });
});
