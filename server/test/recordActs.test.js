import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * Who did what to the sales records (mis-report-sender-plan.md §B3.2): a
 * record created or changed through a form, a stage move, an invoice and a
 * payment each leave an activity row naming the person, in the transaction
 * of the change; a completed task names who completed it; a stage move
 * names who moved it. A write with no person behind it names nobody.
 *
 * In AUTH_MODE=database, so the actor is a real account.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const PASSWORD = 'a-good-long-test-password';
const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
const NAME = `record_acts_${process.pid}`;

describe('who did what to the sales records', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let db; let pool; let app;
  let sam;

  const as = (method, path) => request(app)[method](path).set('Cookie', sam.cookie);
  const acts = async (action, entityId) => (await db.query(
    `SELECT actor_user_id, actor_type, action, entity_type, entity_id, metadata FROM activity_log
      WHERE action = $1 AND ($2::text IS NULL OR entity_id = $2) ORDER BY id`, [action, entityId ?? null])).rows;
  const stage = async (name) => (await db.query('SELECT id FROM pipeline_stages WHERE name = $1', [name])).rows[0].id;

  before(async () => {
    const root = new pg.Client({ connectionString: ADMIN_URL });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`);
    await root.query(`CREATE DATABASE ${NAME}`);
    await root.end();
    const url = new URL(ADMIN_URL); url.pathname = `/${NAME}`;
    db = new pg.Client({ connectionString: url.toString() });
    await db.connect();
    for (const f of ['schema.sql', 'views.sql', 'seed.sql']) await db.query(readFileSync(join(DB_DIR, f), 'utf8'));

    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = url.toString();
    process.env.AUTH_MODE = 'database';
    process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-to-pass';
    process.env.EMAIL_MODE = 'log';
    delete process.env.OPENROUTER_API_KEY;

    ({ default: app } = await import('../src/app.js'));
    ({ pool } = await import('../src/db.js'));
    (await import('../src/lib/ai.js')).aiConfig.enabled = false;
    const { createUser } = await import('../src/lib/users.js');
    const { loginLimiter } = await import('../src/auth/routes.js');

    const user = await createUser({ name: 'Sam Sales', email: 'sam@example.com', password: PASSWORD, role: 'sales' }, db);
    for (const ip of ['::ffff:127.0.0.1', '127.0.0.1', '::1']) { try { loginLimiter.resetKey(ip); } catch { /* unknown key */ } }
    const res = await request(app).post('/api/auth/login').send({ email: user.email, password: PASSWORD });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    sam = { user, cookie: res.headers['set-cookie'] };
  });

  after(async () => {
    await pool?.end();
    await db?.end();
  });

  test('a company and an enquiry created through the form name who typed them', async () => {
    const company = await as('post', '/api/companies').send({ name: 'Infra Ltd', city: 'Pune' }).expect(201);
    const [created] = await acts('record.created', String(company.body.data.id));
    assert.equal(created.actor_user_id, sam.user.id);
    assert.equal(created.actor_type, 'user');
    assert.equal(created.entity_type, 'company');
    assert.equal(created.metadata.name, 'Infra Ltd');
    assert.equal(created.metadata.actor_name, 'Sam Sales');

    const enquiry = await as('post', '/api/enquiries').send({ client_name: 'Infra Ltd', enquiry_date: '2026-10-06', service: 'EcoVadis' }).expect(201);
    const no = enquiry.body.data.enquiry_no;
    const [e] = await acts('record.created', no);
    assert.equal(e.entity_type, 'enquiry');
    assert.equal(e.metadata.client_name, 'Infra Ltd');
  });

  test('an edit records only the fields that changed, and a save that changed nothing records nothing', async () => {
    const { body } = await as('post', '/api/enquiries').send({ client_name: 'Delta Corp', enquiry_date: '2026-10-06', service: 'Audit' }).expect(201);
    const no = body.data.enquiry_no;
    await as('patch', `/api/enquiries/${encodeURIComponent(no)}`).send({ service: 'Audit and training', notes: 'Asked for two dates' }).expect(200);
    const [updated] = await acts('record.updated', no);
    assert.deepEqual(updated.metadata.changes.service, { from: 'Audit', to: 'Audit and training' });
    assert.equal(updated.metadata.changes.notes.to, 'Asked for two dates');
    assert.equal(updated.actor_user_id, sam.user.id);

    await as('patch', `/api/enquiries/${encodeURIComponent(no)}`).send({ service: 'Audit and training' }).expect(200);
    assert.equal((await acts('record.updated', no)).length, 1);
  });

  test('a stage move names who moved it, in the history and in the log', async () => {
    const { body } = await as('post', '/api/quotations').send({ client_name: 'Infra Ltd', service_quoted: 'EcoVadis', quotation_date: '2026-10-06' }).expect(201);
    const no = body.data.quotation_no;
    const [created] = await acts('record.created', no);
    assert.equal(created.entity_type, 'quotation');

    await as('post', `/api/pipeline/${encodeURIComponent(no)}/move`).send({ stage_id: await stage('Negotiation') }).expect(200);
    const [move] = await acts('quotation.stage_changed', no);
    assert.equal(move.actor_user_id, sam.user.id);
    assert.equal(move.metadata.to, 'Negotiation');
    assert.equal(move.metadata.client_name, 'Infra Ltd');
    const { rows: [h] } = await db.query(
      'SELECT changed_by_user_id FROM quotation_stage_history WHERE quotation_id = $1 ORDER BY id DESC LIMIT 1', [body.data.id]);
    assert.equal(h.changed_by_user_id, sam.user.id);

    // A status set on the form moves the stage too: the move is its own row,
    // and the stage fields are not repeated as an edit.
    await as('patch', `/api/quotations/${encodeURIComponent(no)}`).send({ status: 'On Hold' }).expect(200);
    const moves = await acts('quotation.stage_changed', no);
    assert.equal(moves.length, 2);
    assert.equal(moves[1].metadata.from, 'Negotiation');
    assert.ok(!(await acts('record.updated', no)).some((r) => r.metadata.changes?.status), 'status left out of the edit row');
  });

  test('a move with nobody behind it names nobody', async () => {
    const { body } = await as('post', '/api/quotations').send({ client_name: 'Job Co', service_quoted: 'Audit', quotation_date: '2026-10-06' }).expect(201);
    await db.query('UPDATE quotations SET stage_id = $2 WHERE id = $1', [body.data.id, await stage('Negotiation')]);
    const { rows: [h] } = await db.query('SELECT changed_by_user_id FROM quotation_stage_history WHERE quotation_id = $1', [body.data.id]);
    assert.equal(h.changed_by_user_id, null);
    assert.equal((await acts('quotation.stage_changed', body.data.quotation_no)).length, 0);
  });

  test('a task marked done names who completed it, and reopening clears it', async () => {
    const { body } = await as('post', '/api/tasks').send({ entity: 'company', entity_id: 'x', title: 'Call Mr Shah' }).expect(201);
    await as('patch', `/api/tasks/${body.data.id}`).send({ status: 'done' }).expect(200);
    let { rows: [t] } = await db.query('SELECT completed_by, completed_at FROM tasks WHERE id = $1', [body.data.id]);
    assert.equal(t.completed_by, 'Sam Sales');
    assert.ok(t.completed_at);

    await as('patch', `/api/tasks/${body.data.id}`).send({ status: 'todo' }).expect(200);
    ({ rows: [t] } = await db.query('SELECT completed_by FROM tasks WHERE id = $1', [body.data.id]));
    assert.equal(t.completed_by, null);

    // Done by a job: nobody in particular.
    await db.query(`UPDATE tasks SET status = 'done' WHERE id = $1`, [body.data.id]);
    ({ rows: [t] } = await db.query('SELECT completed_by FROM tasks WHERE id = $1', [body.data.id]));
    assert.equal(t.completed_by, null);
  });

  test('a PO registered, its invoice raised and its payment recorded each name the person', async () => {
    const { body: q } = await as('post', '/api/quotations').send({ client_name: 'Infra Ltd', service_quoted: 'EcoVadis', quotation_date: '2026-10-01' }).expect(201);
    await as('post', '/api/quotation-lines').send({ quotation_id: q.data.id, description: 'EcoVadis assessment', qty: 1, rate: 100000, gst_rate: 18 }).expect(201);
    await as('post', `/api/quotations/${encodeURIComponent(q.data.quotation_no)}/register`).send({
      po_number: 'PO-ACTS-1', po_date: '2026-10-02', payment_terms_days: 30,
      stages: [{ stage_name: 'Advance', trigger_event: 'On PO Registration', percent: 50 }, { stage_name: 'Delivery', trigger_event: 'On Delivery', percent: 50 }],
    }).expect(201);

    const [po] = await acts('record.created', 'PO-ACTS-1');
    assert.equal(po.entity_type, 'purchase_order');
    assert.equal(po.actor_user_id, sam.user.id);
    assert.equal(po.metadata.quotation_no, q.data.quotation_no);
    assert.equal(po.metadata.stages.length, 2);
    const won = await acts('quotation.stage_changed', q.data.quotation_no);
    assert.equal(won.length, 1, 'the move to won');
    assert.ok((await db.query(`SELECT 1 FROM activity_log WHERE action = 'record.created' AND entity_type = 'project'`)).rowCount, 'the project made for it');

    const { rows: [first] } = await db.query(`SELECT id FROM payment_stages WHERE po_number = 'PO-ACTS-1' ORDER BY stage_no LIMIT 1`);
    await as('post', `/api/payment-stages/${first.id}/invoice`).send({ invoice_no: 'INV-ACTS-1', invoice_date: '2026-10-03' }).expect(200);
    const [invoice] = await acts('invoice.raised', String(first.id));
    assert.equal(invoice.actor_user_id, sam.user.id);
    assert.equal(invoice.metadata.invoice_no, 'INV-ACTS-1');
    assert.equal(invoice.metadata.po_number, 'PO-ACTS-1');

    await as('post', `/api/payment-stages/${first.id}/payment`).send({ amount_received: 25000, payment_received_date: '2026-10-05', mode: 'add' }).expect(200);
    const [paid] = await acts('payment.recorded', String(first.id));
    assert.equal(paid.actor_user_id, sam.user.id);
    assert.equal(paid.metadata.amount, 25000);
    assert.equal(paid.metadata.invoice_no, 'INV-ACTS-1');
  });

  test('an invoice number typed on the stage form is an invoice raised, not an edit', async () => {
    const { rows: [s] } = await db.query(`SELECT id FROM payment_stages WHERE po_number = 'PO-ACTS-1' AND invoice_no IS NULL LIMIT 1`);
    await as('patch', `/api/payment-stages/${s.id}`).send({ invoice_no: 'INV-ACTS-2', invoice_date: '2026-10-04', remarks: 'Sent by courier' }).expect(200);
    const [invoice] = await acts('invoice.raised', String(s.id));
    assert.equal(invoice.metadata.invoice_no, 'INV-ACTS-2');
    const [edit] = await acts('record.updated', String(s.id));
    assert.deepEqual(Object.keys(edit.metadata.changes), ['remarks']);
  });
});
