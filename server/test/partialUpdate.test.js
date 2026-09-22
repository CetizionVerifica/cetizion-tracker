import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test, { after, before, describe } from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import request from 'supertest';

/**
 * An edit writes only the fields it was sent.
 *
 * Several schemas give a field a .default() for creates — a PO's value is 0,
 * its terms 30 days, a quotation starts "Submitted". zod 4 applies those
 * defaults inside .partial() as well, so without a guard every PATCH would
 * quietly reset them: correct a PO's remarks and its value becomes 0.
 *
 * Needs Postgres: set TEST_DATABASE_URL to run.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');

describe('PATCH keeps fields it was not sent', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let dbName;
  let dbUrl;
  let app;
  let pool;
  let cookie;

  const one = async (sql, params = []) => (await pool.query(sql, params)).rows[0];

  const patch = (path, body) => request(app).patch(path).set('Cookie', cookie).send(body);

  before(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    dbName = `partial_update_${process.pid}_${Date.now()}`;
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();

    const url = new URL(ADMIN_URL);
    url.pathname = `/${dbName}`;
    dbUrl = url.toString();

    const client = new pg.Client({ connectionString: dbUrl });
    await client.connect();
    await client.query(readFileSync(join(DB_DIR, 'schema.sql'), 'utf8'));
    await client.query(readFileSync(join(DB_DIR, 'views.sql'), 'utf8'));
    await client.end();

    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = dbUrl;
    process.env.AUTH_USERNAME = 'tester';
    process.env.AUTH_PASSWORD = 'a-good-long-test-password';
    process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-to-pass';

    ({ default: app } = await import('../src/app.js'));
    ({ pool } = await import('../src/db.js'));

    const signIn = await request(app)
      .post('/api/auth/login')
      .send({ username: 'tester', password: 'a-good-long-test-password' });
    cookie = signIn.headers['set-cookie'];

    await pool.query(
      `INSERT INTO projects (project_id, client_name) VALUES ('PRJ-2026-001', 'Hindalco Ltd')`
    );
    await pool.query(
      `INSERT INTO quotations (id, quotation_no, client_name, currency, status)
       VALUES (1, 'CTZ/QT/2026/001', 'Hindalco Ltd', 'USD', 'Won - PO Received')`
    );
    await pool.query(
      `INSERT INTO purchase_orders (id, po_number, project_id, po_value, currency, payment_terms_days)
       VALUES (1, 'PO-7781', 'PRJ-2026-001', 450000, 'USD', 45)`
    );
    await pool.query(
      `INSERT INTO payment_stages (id, po_number, stage_no, stage_name, trigger_event, stage_percent, amount_received)
       VALUES (1, 'PO-7781', 1, 'Advance', 'On Delivery', 0.4, 180000)`
    );
  });

  after(async () => {
    await pool?.end();
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  });

  test('editing a PO\'s remarks leaves its value, currency and terms alone', async () => {
    const response = await patch('/api/purchase-orders/1', { remarks: 'Revised scope' });
    assert.equal(response.status, 200);

    const po = await one('SELECT remarks, po_value, currency, payment_terms_days FROM purchase_orders WHERE id = 1');
    assert.equal(po.remarks, 'Revised scope');
    assert.equal(Number(po.po_value), 450000);
    assert.equal(po.currency, 'USD');
    assert.equal(po.payment_terms_days, 45);
  });

  test('editing a payment stage\'s name leaves the money received alone', async () => {
    const response = await patch('/api/payment-stages/1', { stage_name: 'Advance payment' });
    assert.equal(response.status, 200);

    const stage = await one('SELECT stage_name, trigger_event, amount_received FROM payment_stages WHERE id = 1');
    assert.equal(stage.stage_name, 'Advance payment');
    assert.equal(stage.trigger_event, 'On Delivery');
    assert.equal(Number(stage.amount_received), 180000);
  });

  test('editing a won quotation\'s remarks does not send it back to Submitted', async () => {
    const response = await patch('/api/quotations/1', { remarks: 'Client asked for a copy' });
    assert.equal(response.status, 200);

    const quotation = await one('SELECT status, currency FROM quotations WHERE id = 1');
    assert.equal(quotation.status, 'Won - PO Received');
    assert.equal(quotation.currency, 'USD');
  });
});
