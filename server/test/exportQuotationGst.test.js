import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import request from 'supertest';

/**
 * An export quotation (not in INR) is zero-rated: its stored totals carry
 * no GST, whatever rate its lines show, so the PDF, the acceptance page,
 * the email and the PO pre-filled from it agree with the GST breakdown.
 *
 * Nothing from the application is imported at the top of this file: doing
 * that connects the shared pool to whatever DATABASE_URL happens to be set,
 * and this suite builds its own database.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;

describe('an export quotation stores no GST', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let db;
  let app;
  let agent;
  let dbName;

  before(async () => {
    const owner = new pg.Client({ connectionString: ADMIN_URL });
    await owner.connect();
    dbName = `xgst_suite_${process.pid}_${Date.now()}`;
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

  /** A quotation in this currency with one line of 10,000 at 18% GST. */
  async function quotationIn(currency) {
    const { body } = await agent.post('/api/quotations')
      .send({ client_name: `Export Client ${currency} ${Date.now()}`, service_quoted: 'Audit', quotation_date: '2026-09-23', currency })
      .expect(201);
    await agent.post('/api/quotation-lines')
      .send({ quotation_id: body.data.id, description: 'Audit', qty: 1, rate: 10000, gst_rate: 18 }).expect(201);
    return body.data;
  }

  const totals = async (id) => (await db.query(
    `SELECT currency, subtotal::float AS subtotal, tax_total::float AS tax_total, total::float AS total,
            quotation_value::float AS quotation_value FROM quotations WHERE id = $1`, [id])).rows[0];

  test('a USD quotation is zero-rated: tax 0, total 10,000', async () => {
    const q = await quotationIn('USD');
    assert.deepEqual(await totals(q.id), { currency: 'USD', subtotal: 10000, tax_total: 0, total: 10000, quotation_value: 10000 });

    // The screen's breakdown and the stored totals agree.
    const { body } = await agent.get(`/api/quotations/${encodeURIComponent(q.quotation_no)}/full`).expect(200);
    assert.equal(body.data.gst.zero_rated, true);
    assert.equal(body.data.gst.tax_total, 0);
    assert.equal(Number(body.data.tax_total), 0);
    assert.equal(Number(body.data.total), 10000);
  });

  test('an INR quotation still adds GST: 11,800', async () => {
    const q = await quotationIn('INR');
    assert.deepEqual(await totals(q.id), { currency: 'INR', subtotal: 10000, tax_total: 1800, total: 11800, quotation_value: 11800 });
  });

  test('changing the currency recomputes the totals', async () => {
    const q = await quotationIn('INR');
    await agent.patch(`/api/quotations/${q.id}`).send({ currency: 'USD' }).expect(200);
    assert.deepEqual(await totals(q.id), { currency: 'USD', subtotal: 10000, tax_total: 0, total: 10000, quotation_value: 10000 });

    await agent.patch(`/api/quotations/${q.id}`).send({ currency: 'INR' }).expect(200);
    assert.deepEqual(await totals(q.id), { currency: 'INR', subtotal: 10000, tax_total: 1800, total: 11800, quotation_value: 11800 });
  });

  test('the quotation PDF prints a total that agrees with its tax line', async () => {
    const q = await quotationIn('USD');
    const { body } = await agent.get(`/api/quotations/${encodeURIComponent(q.quotation_no)}/full`).expect(200);
    const { quotationDocument } = await import('../src/lib/quotationPdf.js');
    const doc = JSON.stringify(quotationDocument({ ...body.data, settings: {} }).content);
    assert.doesNotMatch(doc, /11,800/);
    assert.match(doc, /10,000/);
    // The line says 0% too, not its own 18%, and the tax row says why.
    assert.doesNotMatch(doc, /18%/);
    assert.match(doc, /"text":"0%"/);
    assert.match(doc, /Zero-rated \(export\)/);
  });

  test('the acceptance page is given 0% lines for an export', async () => {
    const q = await quotationIn('USD');
    const { body } = await agent.post(`/api/quotations/${encodeURIComponent(q.quotation_no)}/acceptance-link`).send({ email: false }).expect(201);
    const token = body.data.url.split('/accept/')[1];
    const { body: seen } = await request(app).get(`/api/public/accept/${token}`).expect(200);
    assert.deepEqual(seen.data.quotation.lines.map((l) => Number(l.gst_rate)), [0]);
    assert.equal(Number(seen.data.quotation.total), 10000);
  });

  test('a revision read from email keeps the printed totals it sets with a new currency', async () => {
    // autoQuotation revise(): the lines go, then one UPDATE sets the currency and the printed totals.
    const q = await quotationIn('USD');
    await db.query('DELETE FROM quotation_lines WHERE quotation_id = $1', [q.id]);
    await db.query(`UPDATE quotations SET currency = 'EUR', subtotal = 500, tax_total = 0, total = 500, quotation_value = 500 WHERE id = $1`, [q.id]);
    assert.deepEqual(await totals(q.id), { currency: 'EUR', subtotal: 500, tax_total: 0, total: 500, quotation_value: 500 });
  });
});
