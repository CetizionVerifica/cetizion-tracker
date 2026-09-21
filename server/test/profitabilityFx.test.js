import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import request from 'supertest';

/**
 * Profitability in a currency that is not rupees (#39, #61).
 *
 * The view and the route both converted through `settings` keys matching
 * `fx_rate_%`. Migration 013 retired those keys and `lookups.js` refuses to
 * set them, so the rate was always null: every foreign project reported its
 * real costs against no revenue at all, and a 10,000 dollar job with a
 * 50,000 rupee vendor bill came out as a 50,000 rupee loss. It was not even
 * flagged as low margin, because that test needs revenue above zero.
 *
 * The other half is where the view is created. views.sql is run as one
 * multi-statement query, and the COMMIT sat above v_project_profitability,
 * so every redeploy had a window with the view missing.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;

test('views.sql commits once, at the end, so no view is created outside the transaction', () => {
  const sql = readFileSync(new URL('../db/views.sql', import.meta.url), 'utf8');
  const statements = sql.replace(/--[^\n]*/g, '');
  assert.equal((statements.match(/^\s*COMMIT\s*;/gm) || []).length, 1, 'one COMMIT only');
  assert.match(statements.trimEnd(), /COMMIT\s*;$/, 'and it is the last statement in the file');
  // The one that was left outside, named so a future move is caught here.
  const commitAt = statements.search(/^\s*COMMIT\s*;/m);
  assert.ok(statements.indexOf('v_project_profitability') < commitAt, 'v_project_profitability is created inside the transaction');
});

describe('profitability in a foreign currency', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let db;
  let app;
  let agent;
  let dbName;
  let projectId;

  before(async () => {
    const owner = new pg.Client({ connectionString: ADMIN_URL });
    await owner.connect();
    dbName = `fx_suite_${process.pid}_${Date.now()}`;
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

    ({ default: app } = await import('../src/app.js'));
    agent = request.agent(app);
    await agent.post('/api/auth/login').send({ username: 'admin', password: 'a-good-long-test-password' }).expect(200);

    // The rate the sales report and the PDF use, in force from before the PO.
    await db.query(`INSERT INTO exchange_rates (from_currency, to_currency, rate, effective_from) VALUES ('USD', 'INR', 95.54, '2026-01-01')`);

    const { body: q } = await agent.post('/api/quotations')
      .send({ client_name: `FX project ${Date.now()}`, service_quoted: 'Audit', quotation_date: '2026-09-22', quotation_value: 10000, currency: 'USD' })
      .expect(201);
    const poNumber = `FX-${Date.now()}`;
    await agent.post(`/api/quotations/${encodeURIComponent(q.data.quotation_no)}/register`)
      .send({ po_number: poNumber, po_date: '2026-09-22', po_value: 10000, project: { client_name: q.data.client_name } })
      .expect(201);
    const { body: full } = await agent.get(`/api/purchase-orders/${encodeURIComponent(poNumber)}/full`).expect(200);
    projectId = full.data.purchase_order.project_id;

    // A real rupee cost against the dollar revenue.
    await db.query(
      `INSERT INTO project_costs (project_id, description, amount, currency, incurred_on, status)
       VALUES ($1, 'Auditor travel', 50000, 'INR', '2026-09-22', 'paid')`, [projectId]);
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

  test('a dollar PO is revenue at the rate in force on its own date', async () => {
    const { rows: [p] } = await db.query('SELECT revenue, total_cost, margin, revenue_gaps, low_margin FROM v_project_profitability WHERE project_id = $1', [projectId]);
    assert.equal(Number(p.revenue), 955400, '10,000 USD at 95.54');
    assert.equal(Number(p.total_cost), 50000);
    assert.equal(Number(p.margin), 905400, 'and the margin is what is left, not a loss');
    assert.equal(Number(p.revenue_gaps), 0, 'nothing is counted as missing a rate');
    assert.equal(p.low_margin, false);
  });

  test('the rate follows the date, so a PO before a rate change keeps the old one', async () => {
    await db.query(`INSERT INTO exchange_rates (from_currency, to_currency, rate, effective_from) VALUES ('USD', 'INR', 120.00, '2027-01-01')`);
    const { rows: [p] } = await db.query('SELECT revenue FROM v_project_profitability WHERE project_id = $1', [projectId]);
    assert.equal(Number(p.revenue), 955400, 'a rate set for next year does not restate this year');
  });

  test('the page agrees with the view, and no cost is labelled as missing a rate', async () => {
    const { body } = await agent.get(`/api/profitability/projects/${encodeURIComponent(projectId)}`).expect(200);
    assert.equal(Number(body.data.revenue), 955400);
    const complaints = body.data.lines.filter((l) => l.gap);
    assert.deepEqual(complaints, [], `no line should complain about a rate: ${JSON.stringify(complaints)}`);
  });

  test('a currency with no rate anywhere is reported as a gap, not as zero', async () => {
    await db.query(
      `INSERT INTO project_costs (project_id, description, amount, currency, incurred_on, status)
       VALUES ($1, 'A bill in euros', 400, 'EUR', '2026-09-22', 'paid')`, [projectId]);
    const { body } = await agent.get(`/api/profitability/projects/${encodeURIComponent(projectId)}`).expect(200);
    const euro = body.data.lines.find((l) => l.currency === 'EUR');
    assert.match(euro.gap, /EUR/, 'it says which rate is missing rather than counting the cost as nothing');
  });
});
