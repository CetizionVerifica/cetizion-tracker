import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import request from 'supertest';

/**
 * A real quotation reporting its own GST split (#23).
 *
 * Nothing from the application is imported at the top of this file: doing
 * that connects the shared pool to whatever DATABASE_URL happens to be set,
 * and this suite builds its own database.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;

describe('a real quotation reports its own split', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let db;
  let app;
  let agent;
  let dbName;

  before(async () => {
    const owner = new pg.Client({ connectionString: ADMIN_URL });
    await owner.connect();
    dbName = `qgst_suite_${process.pid}_${Date.now()}`;
    await owner.query(`CREATE DATABASE ${dbName}`);
    await owner.end();

    const u = new URL(ADMIN_URL);
    u.pathname = `/${dbName}`;
    const dbUrl = u.toString();

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
    // Nothing uploaded from a test: set empty, not deleted, or dotenv refills it from .env.
    process.env.CLOUDINARY_CLOUD_NAME = '';

    ({ default: app } = await import('../src/app.js'));
    agent = request.agent(app);
    await agent.post('/api/auth/login').send({ username: 'admin', password: 'a-good-long-test-password' }).expect(200);

    // We are registered in Maharashtra (27).
    await db.query(`UPDATE settings SET value = '27' WHERE key = 'company_state_code'`);
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

  /**
   * A quotation for a client in one state, with two GST rates on it.
   *
   * The company is made by the link trigger from the client name, so the
   * GSTIN goes on afterwards — which is also how it happens in life: the
   * company appears with the first quotation and accounts fill the GSTIN in
   * later.
   */
  async function quotationFor(gstin, name) {
    const { body } = await agent.post('/api/quotations')
      .send({ client_name: name, service_quoted: 'Audit', quotation_date: '2026-09-23' })
      .expect(201);
    if (gstin) {
      const { rowCount } = await db.query('UPDATE companies SET gstin = $2 WHERE id = (SELECT company_id FROM quotations WHERE id = $1)', [body.data.id, gstin]);
      assert.equal(rowCount, 1, 'the fixture must reach the same database the app writes to');
    }
    for (const l of [{ description: 'Audit', rate: 100000, gst_rate: 18 }, { description: 'Reimbursables', rate: 10000, gst_rate: 5 }]) {
      await agent.post('/api/quotation-lines').send({ quotation_id: body.data.id, qty: 1, ...l }).expect(201);
    }
    const { body: full } = await agent.get(`/api/quotations/${encodeURIComponent(body.data.quotation_no)}/full`).expect(200);
    return full.data;
  }

  test('a Maharashtra client is CGST and SGST', async () => {
    // 27 = Maharashtra, the state we are registered in.
    const q = await quotationFor('27AAPFU0939F1ZV', `Maharashtra Metals ${Date.now()}`);
    assert.equal(q.gst.intra, true, JSON.stringify(q.gst));
    assert.equal(q.gst.cgst, 9250);
    assert.equal(q.gst.sgst, 9250);
    assert.equal(q.gst.igst, 0);
    assert.equal(Number(q.tax_total), q.gst.tax_total, 'the split adds up to the figure already stored');
    assert.deepEqual(q.gst.problems, []);
  });

  test('a client in another state is IGST', async () => {
    // 29 = Karnataka.
    const q = await quotationFor('29AAPFU0939F1ZP', `Karnataka Castings ${Date.now()}`);
    assert.equal(q.gst.intra, false, JSON.stringify(q.gst));
    assert.equal(q.gst.igst, 18500);
    assert.equal(q.gst.cgst + q.gst.sgst, 0);
    assert.equal(Number(q.tax_total), q.gst.tax_total);
  });

  test('with no GSTIN, the place of supply typed on the quotation decides it', async () => {
    const q = await quotationFor(null, `No GSTIN Ltd ${Date.now()}`);
    assert.match(q.gst.problems.join(' '), /place of supply/i, 'and it says so while there is neither');

    await db.query(`UPDATE quotations SET place_of_supply_state = '27-Maharashtra' WHERE id = $1`, [q.id]);
    const { body } = await agent.get(`/api/quotations/${encodeURIComponent(q.quotation_no)}/full`).expect(200);
    assert.equal(body.data.gst.intra, true);
    assert.equal(body.data.gst.cgst, 9250);
    assert.deepEqual(body.data.gst.problems, []);
  });

  test('every quotation from before line items gets one, and keeps its value (#23)', async () => {
    await db.query(`INSERT INTO services (name, sac_code, gst_rate) VALUES ('Legacy Audit', '998311', 18) ON CONFLICT (name) DO UPDATE SET sac_code = '998311'`);
    const { rows: made } = await db.query(
      `INSERT INTO quotations (quotation_no, client_name, service_quoted, quotation_date, quotation_value, status)
       VALUES ('CTZ/QT/2025/901', 'Old Valued Ltd', 'Legacy Audit', '2025-06-01', 250000, 'Won - PO Received'),
              ('CTZ/QT/2025/902', 'Old Unpriced Ltd', NULL, '2025-06-02', NULL, 'Lost')
       RETURNING id, quotation_no`);
    const events = async () => Number((await db.query('SELECT COUNT(*) FROM webhook_events')).rows[0].count);
    const before = await events();

    const migration = readFileSync(new URL('../db/migrations/052_quotation_line_backfill.sql', import.meta.url), 'utf8');
    await db.query(migration);
    await db.query(migration);

    const { rows } = await db.query(
      `SELECT q.quotation_no, q.quotation_value::float AS value, q.subtotal::float AS subtotal, q.total::float AS total,
              count(l.id)::int AS lines, max(l.description) AS description, max(l.rate)::float AS rate, max(s.sac_code) AS sac
         FROM quotations q LEFT JOIN quotation_lines l ON l.quotation_id = q.id LEFT JOIN services s ON s.id = l.service_id
        WHERE q.id = ANY($1) GROUP BY q.id ORDER BY q.quotation_no`, [made.map((m) => m.id)]);
    assert.deepEqual(rows, [
      { quotation_no: 'CTZ/QT/2025/901', value: 250000, subtotal: 250000, total: 250000, lines: 1, description: 'Legacy Audit', rate: 250000, sac: '998311' },
      { quotation_no: 'CTZ/QT/2025/902', value: null, subtotal: null, total: null, lines: 1, description: 'Services as quoted', rate: 0, sac: null },
    ]);
    assert.equal(await events(), before, 'a backfill is not news: no webhook fires');

    // Editing the line later recomputes from the same figure, not 18% more.
    await db.query(`UPDATE quotation_lines SET qty = 1 WHERE quotation_id = $1`, [made[0].id]);
    const { rows: [q] } = await db.query('SELECT quotation_value::float AS value FROM quotations WHERE id = $1', [made[0].id]);
    assert.equal(q.value, 250000);
  });

  test('a line prints its SAC code, and sending keeps working without file storage (#23)', async () => {
    const { quotationDocument } = await import('../src/lib/quotationPdf.js');
    const doc = quotationDocument({
      quotation_no: 'CTZ/QT/2026/950', revision: 0, client_name: 'SAC Ltd', currency: 'INR', settings: {},
      lines: [{ description: 'Audit', qty: 1, rate: 1000, gst_rate: 18, discount_percent: 0, amount: 1000, sac_code: '998311' }],
      subtotal: 1000, tax_total: 180, total: 1180, gst: null,
    });
    assert.match(JSON.stringify(doc.content), /SAC 998311/);

    const { body } = await agent.post('/api/quotations')
      .send({ client_name: `Sent Copy ${Date.now()}`, service_quoted: 'Audit', quotation_date: '2026-09-23' }).expect(201);
    const sent = await agent.post(`/api/quotations/${encodeURIComponent(body.data.quotation_no)}/send`).send({ email: false });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.ok(sent.body.data.sent_at);
    assert.equal(sent.body.data.document_id, null, 'no file storage configured here, so nothing to keep');
  });
});
