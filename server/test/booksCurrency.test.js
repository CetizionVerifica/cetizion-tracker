import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * Applying a payment read from the books (#48), and the currency of it.
 *
 * acceptBooks took the books entry's amount and wrote it against the
 * invoice stage without reading either currency, so a receipt of 10,000
 * dollars would have been recorded as 10,000 rupees. The feature is off by
 * default, which is why this was not a live problem — and why it is worth
 * fixing before anyone turns it on.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;

describe('applying a payment from the books', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let db;
  let app;
  let agent;
  let dbName;
  let acceptBooks;
  let stageId;

  before(async () => {
    const owner = new pg.Client({ connectionString: ADMIN_URL });
    await owner.connect();
    dbName = `books_suite_${process.pid}_${Date.now()}`;
    await owner.query(`CREATE DATABASE ${dbName}`);
    await owner.end();

    const u = new URL(ADMIN_URL);
    u.pathname = `/${dbName}`;
    const dbUrl = u.toString();

    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const dbDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');

    db = new pg.Client({ connectionString: dbUrl });
    await db.connect();
    await db.query(readFileSync(join(dbDir, 'schema.sql'), 'utf8'));
    await db.query(readFileSync(join(dbDir, 'views.sql'), 'utf8'));

    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = dbUrl;
    process.env.AUTH_MODE = 'shared';
    process.env.AUTH_USERNAME = 'admin';
    process.env.AUTH_PASSWORD = 'a-good-long-test-password';
    process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-to-pass';
    process.env.EMAIL_MODE = 'log';

    ({ default: app } = await import('../src/app.js'));
    ({ acceptBooks } = await import('../src/lib/accounting/books.js'));
    agent = request.agent(app);
    await agent.post('/api/auth/login').send({ username: 'admin', password: 'a-good-long-test-password' }).expect(200);

    // A dollar project, so the stage carries a currency that is not the
    // default one.
    const { body: q } = await agent.post('/api/quotations')
      .send({ client_name: `Books currency ${Date.now()}`, service_quoted: 'Audit', quotation_date: '2026-09-22', quotation_value: 10000, currency: 'USD' })
      .expect(201);
    const poNumber = `BOOKS-${Date.now()}`;
    await agent.post(`/api/quotations/${encodeURIComponent(q.data.quotation_no)}/register`)
      .send({ po_number: poNumber, po_date: '2026-09-22', po_value: 10000, project: { client_name: q.data.client_name } })
      .expect(201);
    const { body: full } = await agent.get(`/api/purchase-orders/${encodeURIComponent(poNumber)}/full`).expect(200);
    stageId = full.data.payment_stages[0].id;

    const { rows: [stage] } = await db.query('SELECT currency FROM v_payment_stages WHERE id = $1', [stageId]);
    assert.equal(stage.currency, 'USD', 'the fixture only means anything if the stage really is in dollars');
  });

  after(async () => {
    const { pool } = await import('../src/db.js');
    await pool.end().catch(() => {});
    await db?.end().catch(() => {});
    const owner = new pg.Client({ connectionString: ADMIN_URL });
    await owner.connect();
    await owner.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await owner.end();
  });

  /** A receipt sitting in the books, and the reconciliation row for it. */
  async function receiptInBooks(currency, amount) {
    const { rows: [entry] } = await db.query(
      `INSERT INTO books_entries (source, kind, books_id, number, entry_date, total_amount, tds_amount, currency)
       VALUES ('file', 'payment', $1, $1, '2026-09-22', $2, 0, $3) RETURNING id`,
      [`books-${currency}-${Date.now()}${Math.random()}`, amount, currency]);
    const { rows: [item] } = await db.query(
      `INSERT INTO reconciliation_items (kind, match_key, stage_id, books_entry_id, status)
       VALUES ('payment', $1, $2, $3, 'missing_in_tracker') RETURNING id`,
      [`key-${entry.id}`, stageId, entry.id]);
    return item.id;
  }

  const received = async () => Number((await db.query('SELECT COALESCE(SUM(amount), 0) AS n FROM payments WHERE stage_id = $1', [stageId])).rows[0].n);

  test('a receipt in another currency is refused, not taken at face value', async () => {
    const item = await receiptInBooks('INR', 10000);
    await assert.rejects(
      acceptBooks(item, 'tester'),
      (err) => {
        assert.match(err.message, /INR.*USD|in INR/, err.message);
        assert.equal(err.status, 422);
        return true;
      },
    );
    assert.equal(await received(), 0, 'and nothing is written');
  });

  test('a receipt in the stage’s own currency is applied', async () => {
    const item = await receiptInBooks('USD', 4000);
    const out = await acceptBooks(item, 'tester');
    assert.ok(out.applied.some((a) => a.payment_id), JSON.stringify(out));
    assert.equal(await received(), 4000);
  });
});
