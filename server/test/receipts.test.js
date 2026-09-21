import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * Money recorded against a payment stage (#27).
 *
 * The stage total is computed from the ledger, so a correction has to be a
 * row in it. Writing the figure over the top looked right until the next
 * receipt recomputed the total and the correction vanished.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;

describe('recording money against a stage', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let db;
  let app;
  let agent;
  let dbName;

  before(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    dbName = `receipts_suite_${process.pid}_${Date.now()}`;
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();

    const u = new URL(ADMIN_URL);
    u.pathname = `/${dbName}`;

    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const dbDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');

    db = new pg.Client({ connectionString: u.toString() });
    await db.connect();
    await db.query(readFileSync(join(dbDir, 'schema.sql'), 'utf8'));
    await db.query(readFileSync(join(dbDir, 'views.sql'), 'utf8'));

    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = u.toString();
    process.env.AUTH_MODE = 'shared';
    process.env.AUTH_USERNAME = 'admin';
    process.env.AUTH_PASSWORD = 'a-good-long-test-password';
    process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-to-pass';
    process.env.EMAIL_MODE = 'log';

    ({ default: app } = await import('../src/app.js'));
    agent = request.agent(app);
    await agent.post('/api/auth/login').send({ username: 'admin', password: 'a-good-long-test-password' }).expect(200);
  });

  after(async () => {
    const { pool } = await import('../src/db.js');
    await pool.end().catch(() => {});
    await db?.end().catch(() => {});
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  });

  async function invoicedStage() {
    const created = await agent.post('/api/quotations')
      .send({ client_name: `Receipts ${Date.now()}${Math.random()}`, service_quoted: 'Audit', quotation_date: '2026-09-21', quotation_value: 100000 })
      .expect(201);
    const q = created.body.data;
    const poNumber = `RCPT-${Date.now()}${Math.floor(Math.random() * 1000)}`;
    await agent.post(`/api/quotations/${encodeURIComponent(q.quotation_no)}/register`)
      .send({ po_number: poNumber, po_date: '2026-09-21', po_value: 100000, project: { client_name: q.client_name } })
      .expect(201);
    const { body } = await agent.get(`/api/purchase-orders/${encodeURIComponent(poNumber)}/full`).expect(200);
    const stage = body.data.payment_stages[0];
    await agent.post(`/api/payment-stages/${stage.id}/invoice`)
      .send({ invoice_no: `RI-${Date.now()}${Math.floor(Math.random() * 1000)}`, invoice_date: '2026-09-21' }).expect(200);
    return stage.id;
  }

  const received = async (id) => {
    const { body } = await agent.get(`/api/payment-stages/${id}`).expect(200);
    return Number(body.data.amount_received);
  };

  test('a correction downward survives the next receipt', async () => {
    const id = await invoicedStage();
    await agent.post(`/api/payment-stages/${id}/payment`).send({ mode: 'add', amount_received: 50000, payment_received_date: '2026-09-21' }).expect(200);
    assert.equal(await received(id), 50000);

    // Someone typed 50,000 where 40,000 arrived, and corrects the total.
    await agent.post(`/api/payment-stages/${id}/payment`).send({ mode: 'set', amount_received: 40000, payment_received_date: '2026-09-21' }).expect(200);
    assert.equal(await received(id), 40000);

    // The next genuine receipt recomputes the total from the ledger. Before,
    // the correction lived outside the ledger and vanished here.
    await agent.post(`/api/payment-stages/${id}/payment`).send({ mode: 'add', amount_received: 10000, payment_received_date: '2026-09-22' }).expect(200);
    assert.equal(await received(id), 50000, '40,000 corrected plus 10,000 received');
  });

  test('the adjustment is a row anyone can see, not a silent edit', async () => {
    const id = await invoicedStage();
    await agent.post(`/api/payment-stages/${id}/payment`).send({ mode: 'add', amount_received: 30000, payment_received_date: '2026-09-21' }).expect(200);
    await agent.post(`/api/payment-stages/${id}/payment`).send({ mode: 'set', amount_received: 20000, payment_received_date: '2026-09-21' }).expect(200);

    const { rows } = await db.query('SELECT amount, notes FROM payments WHERE stage_id = $1 ORDER BY id', [id]);
    assert.equal(rows.length, 2);
    assert.equal(Number(rows[1].amount), -10000);
    assert.match(rows[1].notes, /total set to 20000/);
  });
});
