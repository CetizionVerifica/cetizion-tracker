import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * A project's margin (#39), against two mistakes that both made it wrong.
 *
 *   Revenue included GST. A PO's value is the quotation's total, GST in;
 *   that GST is collected for the government and is not the business's to
 *   earn. Revenue is the PO value before GST (po_gst_split, as the portal
 *   splits it). Costs are kept as they were paid.
 *
 *   A manual cost in a foreign currency was joined to EVERY stored rate for
 *   its currency, so it was counted once per rate: the nightly rates job
 *   adds a row every working day, so the cost grew every day. It is
 *   converted at the rate in force on the day it was incurred, as a PO is.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;

describe('project margin', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let db; let agent; let dbName; let projectId;

  before(async () => {
    const owner = new pg.Client({ connectionString: ADMIN_URL });
    await owner.connect();
    dbName = `margin_suite_${process.pid}_${Date.now()}`;
    await owner.query(`CREATE DATABASE ${dbName}`);
    await owner.end();
    const u = new URL(ADMIN_URL); u.pathname = `/${dbName}`;

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
    process.env.CLOUDINARY_CLOUD_NAME = '';
    const { default: app } = await import('../src/app.js');
    agent = request.agent(app);
    await agent.post('/api/auth/login').send({ username: 'admin', password: 'a-good-long-test-password' }).expect(200);

    // A ₹1,00,000 service at 18%: the PO is ₹1,18,000, GST in.
    const { body: q } = await agent.post('/api/quotations')
      .send({ client_name: `Margin client ${Date.now()}`, service_quoted: 'Audit', quotation_date: '2026-06-01' }).expect(201);
    await agent.post('/api/quotation-lines').send({ quotation_id: q.data.id, description: 'Audit', qty: 1, rate: 100000, gst_rate: 18 }).expect(201);
    const poNumber = `MRG-${Date.now()}`;
    await agent.post(`/api/quotations/${encodeURIComponent(q.data.quotation_no)}/register`)
      .send({ po_number: poNumber, po_date: '2026-06-01', po_value: 118000, project: { client_name: q.data.client_name } }).expect(201);
    const { body: full } = await agent.get(`/api/purchase-orders/${encodeURIComponent(poNumber)}/full`).expect(200);
    projectId = full.data.purchase_order.project_id;

    // Three USD rates, as the daily feed leaves them: before, on and after the cost.
    await db.query(`INSERT INTO exchange_rates (from_currency, rate, effective_from) VALUES ('USD', 80, '2026-01-01'), ('USD', 85, '2026-06-01'), ('USD', 90, '2026-09-01')`);
    await db.query(
      `INSERT INTO project_costs (project_id, description, amount, currency, incurred_on, status)
       VALUES ($1, 'Lab test abroad', 100, 'USD', '2026-07-15', 'paid')`, [projectId]);
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

  const row = async () => (await db.query('SELECT * FROM v_project_profitability WHERE project_id = $1', [projectId])).rows[0];

  test('revenue is the PO value before GST', async () => {
    const p = await row();
    assert.equal(Number(p.revenue), 100000, '₹1,18,000 with 18% GST in is ₹1,00,000 of revenue');
  });

  test('a foreign-currency cost is counted once, at the rate on the day it was incurred', async () => {
    const p = await row();
    assert.equal(Number(p.other_paid), 8500, '$100 at 85, the rate in force on 15 Jul, not 80 + 85 + 90');
    assert.equal(Number(p.total_cost), 8500);
    assert.equal(Number(p.margin), 91500);
    assert.equal(Number(p.margin_percent), 91.5);
    assert.equal(Number(p.cost_gaps), 0);
  });

  test('another day of rates does not change a cost already incurred', async () => {
    await db.query(`INSERT INTO exchange_rates (from_currency, rate, effective_from) VALUES ('USD', 99, '2026-10-01')`);
    assert.equal(Number((await row()).other_paid), 8500);
  });

  test('a cost from before any rate existed is a gap, not zero and not today\'s rate', async () => {
    await db.query(
      `INSERT INTO project_costs (project_id, description, amount, currency, incurred_on, status)
       VALUES ($1, 'Old bill', 50, 'USD', '2025-12-01', 'committed')`, [projectId]);
    const p = await row();
    assert.equal(Number(p.cost_gaps), 1);
    assert.equal(Number(p.other_committed), 0);
  });

  test('a cost with no date keeps the rate of the day it was entered', async () => {
    await db.query(
      `INSERT INTO project_costs (project_id, description, amount, currency, incurred_on, status, created_at)
       VALUES ($1, 'Undated bill', 10, 'USD', NULL, 'paid', '2026-06-15')`, [projectId]);
    const before = Number((await row()).other_paid);
    assert.equal(before, 8500 + 850, '$10 at 85, the rate on the day it was entered');
    await db.query(`INSERT INTO exchange_rates (from_currency, rate, effective_from) VALUES ('USD', 101, CURRENT_DATE)`);
    assert.equal(Number((await row()).other_paid), before, 'a new day of rates does not move it');
  });

  test('the project page agrees with the totals, line by line', async () => {
    const { body } = await agent.get(`/api/profitability/projects/${encodeURIComponent(projectId)}`).expect(200);
    assert.equal(Number(body.data.revenue), 100000);
    const lab = body.data.lines.find((l) => l.description === 'Lab test abroad');
    assert.equal(Number(lab.amount_inr), 8500, 'the line shows the same rupees the total counts');
    assert.equal(lab.gap, null);
    const old = body.data.lines.find((l) => l.description === 'Old bill');
    assert.match(old.gap, /USD/, 'the line the total leaves out says why');
  });
});
