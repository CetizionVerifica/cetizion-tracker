import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * How a PO's value is shared over its services when the quotation's lines
 * carry different GST rates.
 *
 * The PO value includes GST and a quotation line does not, so each line is
 * grossed up by its own rate before the PO value is shared out. An export
 * (non-INR) order is zero-rated: grossing its lines up by 18% and 5% shared
 * the PO value by the wrong weights, so a 1,00,000 + 10,000 USD order was
 * split 1,01,011.67 / 8,988.33 instead of 1,00,000 / 10,000. The report's
 * service split used the same weights.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');

describe('the service split of an export order', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let db; let agent; let dbName;

  before(async () => {
    const owner = new pg.Client({ connectionString: ADMIN_URL });
    await owner.connect();
    dbName = `export_split_${process.pid}_${Date.now()}`;
    await owner.query(`CREATE DATABASE ${dbName}`);
    await owner.end();
    const u = new URL(ADMIN_URL); u.pathname = `/${dbName}`;
    db = new pg.Client({ connectionString: u.toString() });
    await db.connect();
    for (const f of ['schema.sql', 'views.sql']) await db.query(readFileSync(join(DB_DIR, f), 'utf8'));

    Object.assign(process.env, {
      NODE_ENV: 'test', DATABASE_URL: u.toString(), AUTH_MODE: 'shared', AUTH_USERNAME: 'admin',
      AUTH_PASSWORD: 'a-good-long-test-password', SESSION_SECRET: 'test-secret-that-is-long-enough-to-pass',
      EMAIL_MODE: 'log', CLOUDINARY_CLOUD_NAME: '',
    });
    const { default: app } = await import('../src/app.js');
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

  /** A quotation in `currency` with an audit at 18% and reimbursables at 5%, registered at `poValue`. */
  async function registered(currency, poValue) {
    const name = `Split ${currency} ${Date.now()}`;
    const { body: q } = await agent.post('/api/quotations')
      .send({ client_name: name, service_quoted: 'Audit', quotation_date: '2026-10-01', currency }).expect(201);
    for (const line of [{ description: 'Audit', rate: 100000, gst_rate: 18 }, { description: 'Reimbursables', rate: 10000, gst_rate: 5 }]) {
      await agent.post('/api/quotation-lines').send({ quotation_id: q.data.id, qty: 1, ...line }).expect(201);
    }
    const poNumber = `SPLIT-${currency}-${Date.now()}`;
    await agent.post(`/api/quotations/${encodeURIComponent(q.data.quotation_no)}/register`)
      .send({ po_number: poNumber, po_date: '2026-10-02', po_value: poValue, currency, project: { client_name: name } })
      .expect(201);
    const { rows } = await db.query('SELECT service, service_value::float8 AS value FROM po_services WHERE po_number = $1 ORDER BY id', [poNumber]);
    return rows;
  }

  test('an export order is shared by the lines as they are, with no GST', async () => {
    const services = await registered('USD', 110000);
    assert.deepEqual(services.map((s) => [s.service, s.value]), [['Audit', 100000], ['Reimbursables', 10000]]);
  });

  test('a rupee order still grosses each line up by its own rate', async () => {
    const services = await registered('INR', 128500);
    assert.deepEqual(services.map((s) => [s.service, s.value]), [['Audit', 118000], ['Reimbursables', 10500]]);
  });

  test('the report’s service split weighs export lines without GST too', async () => {
    // An EcoVadis line at 18% and an HSE line at 5%, on a USD order of 1,10,000.
    const name = `Report split ${Date.now()}`;
    const { body: q } = await agent.post('/api/quotations')
      .send({ client_name: name, service_quoted: 'Assessment', quotation_date: '2026-10-01', currency: 'USD' }).expect(201);
    for (const line of [{ description: 'EcoVadis assessment', rate: 100000, gst_rate: 18 }, { description: 'HSE audit', rate: 10000, gst_rate: 5 }]) {
      await agent.post('/api/quotation-lines').send({ quotation_id: q.data.id, qty: 1, ...line }).expect(201);
    }
    const poNumber = `REPORT-USD-${Date.now()}`;
    await agent.post(`/api/quotations/${encodeURIComponent(q.data.quotation_no)}/register`)
      .send({ po_number: poNumber, po_date: '2026-10-02', po_value: 110000, currency: 'USD', project: { client_name: name } })
      .expect(201);
    // Without a recorded split the report shares the PO out by the quotation's lines.
    await db.query('DELETE FROM po_services WHERE po_number = $1', [poNumber]);
    await db.query(`INSERT INTO exchange_rates (from_currency, rate, effective_from) VALUES ('USD', 80, '2026-01-01')`);

    const { salesReport } = await import('../src/lib/reportDefinitions.js');
    const report = await salesReport({ from: '2026-10-01', to: '2026-10-31' }, { today: '2026-10-31' });
    const byLine = Object.fromEntries(report.services.rows.map((r) => [r.line, r.value_inr]));
    // 1,10,000 USD at 80 is 88,00,000: shared 1,00,000 : 10,000, not 1,18,000 : 10,500.
    assert.equal(byLine.EcoVadis, 8000000);
    assert.equal(byLine.HSE, 800000);
  });
});
