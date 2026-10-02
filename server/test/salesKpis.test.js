import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const PASSWORD = 'a-good-long-test-password';
const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');

describe('sales KPI engine and financial attribution', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let dbUrl;
  let db;
  let app;
  let pool;
  let createUser;
  let admin;
  let salesA;
  let salesB;

  before(async () => {
    const root = new pg.Client({ connectionString: ADMIN_URL });
    await root.connect();
    const name = `kpis_${process.pid}_${Date.now()}`;
    await root.query(`CREATE DATABASE ${name}`);
    await root.end();

    const u = new URL(ADMIN_URL);
    u.pathname = `/${name}`;
    dbUrl = u.toString();

    db = new pg.Client({ connectionString: dbUrl });
    await db.connect();
    await db.query(readFileSync(join(DB_DIR, 'schema.sql'), 'utf8'));
    await db.query(readFileSync(join(DB_DIR, 'views.sql'), 'utf8'));

    // Insert sample exchange rates
    await db.query(`
      INSERT INTO exchange_rates (from_currency, to_currency, rate, effective_from)
      VALUES
        ('USD', 'INR', 85.0, '2025-01-01'),
        ('USD', 'INR', 86.0, '2026-01-01'),
        ('EUR', 'INR', 92.0, '2026-01-01')
      ON CONFLICT DO NOTHING;
    `);

    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = dbUrl;
    process.env.AUTH_MODE = 'database';
    process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-to-pass';
    process.env.EMAIL_MODE = 'log';

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

  /**
   * The PO that makes a won quotation order intake (salesKpis.js
   * creditedOrders): on a project of its own with no originator, so the
   * credit follows the quotation's.
   */
  async function orderFor(quotationNo, poDate, value, { cancelled = false } = {}) {
    const project = `P-${quotationNo}`;
    await db.query('INSERT INTO projects (project_id, client_name) VALUES ($1, $2)', [project, 'Order Corp']);
    await db.query(
      `INSERT INTO purchase_orders (po_number, project_id, quotation_no, po_date, po_value, currency, cancelled)
       VALUES ($1, $2, $3, $4, $5, 'INR', $6)`,
      [`PO-${quotationNo}`, project, quotationNo, poDate, value, cancelled]
    );
  }

  async function setUp() {
    await db.query('DELETE FROM sales_targets');
    await db.query('DELETE FROM activity_log');
    await db.query('DELETE FROM ownership_history');
    await db.query('DELETE FROM payment_stages');
    await db.query('DELETE FROM purchase_orders');
    await db.query('DELETE FROM quotations');
    await db.query('DELETE FROM enquiries');
    await db.query('DELETE FROM projects');
    await db.query('DELETE FROM companies');
    await db.query('DELETE FROM users');

    const mk = async (over) => createUser({ password: PASSWORD, ...over }, db);
    const a = await mk({ name: 'Alice Admin', email: 'alice@example.com', role: 'admin' });
    const s1 = await mk({ name: 'Sam Sales', email: 'sam@example.com', role: 'sales' });
    const s2 = await mk({ name: 'Bea Sales', email: 'bea@example.com', role: 'sales' });

    admin = { user: a, cookie: await signIn(a.email) };
    salesA = { user: s1, cookie: await signIn(s1.email) };
    salesB = { user: s2, cookie: await signIn(s2.email) };
  }

  test('originating salesperson is captured at creation by sales rep and is immutable', async () => {
    await setUp();

    // Sales A creates a quotation via API
    const resCreate = await request(app)
      .post('/api/quotations')
      .set('Cookie', salesA.cookie)
      .send({
        quotation_no: 'CTZ/QT/2026/001',
        client_name: 'Acme Corp',
        quotation_date: '2026-02-01',
        quotation_value: 100000,
        currency: 'INR',
        status: 'Submitted',
      });
    assert.equal(resCreate.status, 201, JSON.stringify(resCreate.body));

    const { rows: [q] } = await db.query(
      'SELECT owner_user_id, originating_user_id, originating_user_snapshot_id, originating_user_name FROM quotations WHERE quotation_no = $1',
      ['CTZ/QT/2026/001']
    );
    assert.equal(q.owner_user_id, salesA.user.id);
    assert.equal(q.originating_user_id, salesA.user.id);
    assert.equal(q.originating_user_snapshot_id, salesA.user.id);
    assert.equal(q.originating_user_name, 'Sam Sales');

    // Admin creates an unassigned quotation via API -> origin is null
    const resAdmin = await request(app)
      .post('/api/quotations')
      .set('Cookie', admin.cookie)
      .send({
        quotation_no: 'CTZ/QT/2026/002',
        client_name: 'Beta Inc',
        quotation_date: '2026-02-02',
        quotation_value: 200000,
        currency: 'INR',
        status: 'Submitted',
      });
    assert.equal(resAdmin.status, 201);

    const { rows: [qAdmin] } = await db.query(
      'SELECT owner_user_id, originating_user_id FROM quotations WHERE quotation_no = $1',
      ['CTZ/QT/2026/002']
    );
    assert.equal(qAdmin.owner_user_id, null);
    assert.equal(qAdmin.originating_user_id, null);
  });

  test('initial administrative assignment updates owner_user_id only; originating_user_id remains null', async () => {
    await setUp();

    // Insert unassigned quotation directly (legacy / admin created)
    await db.query(`
      INSERT INTO quotations (quotation_no, client_name, quotation_date, quotation_value, currency, status, owner_user_id, originating_user_id)
      VALUES ('CTZ/QT/2026/010', 'Legacy Corp', '2026-03-01', 500000, 'INR', 'Submitted', NULL, NULL)
    `);

    // Admin assigns to Sales A
    const resAssign = await request(app)
      .patch(`/api/quotations/${encodeURIComponent('CTZ/QT/2026/010')}/owner`)
      .set('Cookie', admin.cookie)
      .send({
        new_owner_user_id: salesA.user.id,
        expected_owner_user_id: null,
        reason: 'Initial assignment to territory rep',
      });
    assert.equal(resAssign.status, 200, JSON.stringify(resAssign.body));

    const { rows: [q] } = await db.query(
      'SELECT owner_user_id, originating_user_id FROM quotations WHERE quotation_no = $1',
      ['CTZ/QT/2026/010']
    );
    // owner_user_id is updated to Sales A
    assert.equal(q.owner_user_id, salesA.user.id);
    // originating_user_id MUST REMAIN NULL (Safeguard 1)
    assert.equal(q.originating_user_id, null);

    // In KPI report for Sales A:
    // Workload (Category A) shows 1 open quotation
    // Historical created (Category B) is 0 because Sales A did not originate it!
    const resKpi = await request(app)
      .get('/api/kpis/me?year=2026')
      .set('Cookie', salesA.cookie);
    assert.equal(resKpi.status, 200);
    assert.equal(resKpi.body.data.current_workload.open_quotations, 1);
    assert.equal(resKpi.body.data.historical_cohort_performance.quotations_created, 0);
  });

  test('reassignment preserves original salesperson historical win credit while moving current pipeline responsibility', async () => {
    await setUp();

    // 1. Sales A originates quotation in Jan 2026
    await db.query(`
      INSERT INTO quotations (quotation_no, client_name, quotation_date, quotation_value, currency, status, owner_user_id, originating_user_id, originating_user_snapshot_id, originating_user_name)
      VALUES ('CTZ/QT/2026/020', 'Won Corp', '2026-01-15', 300000, 'INR', 'Won - PO Received', $1, $1, $1, 'Sam Sales')
    `, [salesA.user.id]);

    // 2. Admin reassigns quotation to Sales B in March 2026
    const resReassign = await request(app)
      .patch(`/api/quotations/${encodeURIComponent('CTZ/QT/2026/020')}/owner`)
      .set('Cookie', admin.cookie)
      .send({
        new_owner_user_id: salesB.user.id,
        expected_owner_user_id: salesA.user.id,
        reason: 'Sales territory handover',
      });
    assert.equal(resReassign.status, 200);

    // Verify database state: owner is Sales B, originator remains Sales A
    const { rows: [q] } = await db.query(
      'SELECT owner_user_id, originating_user_id, originating_user_snapshot_id FROM quotations WHERE quotation_no = $1',
      ['CTZ/QT/2026/020']
    );
    assert.equal(q.owner_user_id, salesB.user.id);
    assert.equal(q.originating_user_id, salesA.user.id);
    assert.equal(q.originating_user_snapshot_id, salesA.user.id);

    // Check Sales A's KPIs:
    // Historical cohort won deal remains credited to Sales A (Category B & C)
    const resKpiA = await request(app)
      .get('/api/kpis/me?year=2026')
      .set('Cookie', salesA.cookie);
    assert.equal(resKpiA.status, 200);
    assert.equal(resKpiA.body.data.historical_cohort_performance.quotations_cohort_won, 1);
    // Won, but no PO yet: no order intake. The PO arrives, and it is A's.
    assert.equal(resKpiA.body.data.financial_performance.order_intake_inr, 0);
    await orderFor('CTZ/QT/2026/020', '2026-02-10', 300000);
    const withPo = await request(app).get('/api/kpis/me?year=2026').set('Cookie', salesA.cookie);
    assert.equal(withPo.body.data.financial_performance.order_intake_inr, 300000);
    assert.equal(withPo.body.data.financial_performance.order_intake_orders, 1);

    // Check Sales B's KPIs:
    // Sales B has 0 cohort won deals
    const resKpiB = await request(app)
      .get('/api/kpis/me?year=2026')
      .set('Cookie', salesB.cookie);
    assert.equal(resKpiB.status, 200);
    assert.equal(resKpiB.body.data.historical_cohort_performance.quotations_cohort_won, 0);
    assert.equal(resKpiB.body.data.financial_performance.order_intake_inr, 0);
  });

  test('year boundary handling: Jan 1 inclusive, Dec 31 inclusive, following Jan 1 exclusive', async () => {
    await setUp();

    // Insert quotations on boundary dates for Sales A
    await db.query(`
      INSERT INTO quotations (quotation_no, client_name, quotation_date, quotation_value, currency, status, owner_user_id, originating_user_id, originating_user_snapshot_id, originating_user_name)
      VALUES
        ('QT-2025-DEC', 'Prior Corp', '2025-12-31', 100000, 'INR', 'Won - PO Received', $1, $1, $1, 'Sam Sales'),
        ('QT-2026-JAN', 'Jan Corp',   '2026-01-01', 100000, 'INR', 'Won - PO Received', $1, $1, $1, 'Sam Sales'),
        ('QT-2026-DEC', 'Dec Corp',   '2026-12-31', 100000, 'INR', 'Won - PO Received', $1, $1, $1, 'Sam Sales'),
        ('QT-2027-JAN', 'Next Corp',  '2027-01-01', 100000, 'INR', 'Won - PO Received', $1, $1, $1, 'Sam Sales')
    `, [salesA.user.id]);
    // Intake follows the PO date: each order dated like its quotation.
    for (const [no, day] of [['QT-2025-DEC', '2025-12-31'], ['QT-2026-JAN', '2026-01-01'], ['QT-2026-DEC', '2026-12-31'], ['QT-2027-JAN', '2027-01-01']]) {
      await orderFor(no, day, 100000);
    }

    const res2026 = await request(app)
      .get('/api/kpis/me?year=2026')
      .set('Cookie', salesA.cookie);
    assert.equal(res2026.status, 200);
    // Only 2026-01-01 and 2026-12-31 count in 2026
    assert.equal(res2026.body.data.historical_cohort_performance.quotations_cohort_won, 2);
    assert.equal(res2026.body.data.financial_performance.order_intake_inr, 200000);
  });

  test('zero-denominator win rates safely return null without throwing errors', async () => {
    await setUp();

    // Rep with 0 closed quotations (open quotations only)
    await db.query(`
      INSERT INTO quotations (quotation_no, client_name, quotation_date, quotation_value, currency, status, owner_user_id, originating_user_id, originating_user_snapshot_id, originating_user_name)
      VALUES ('QT-OPEN', 'Open Corp', '2026-04-01', 100000, 'INR', 'Submitted', $1, $1, $1, 'Sam Sales')
    `, [salesA.user.id]);

    const res = await request(app)
      .get('/api/kpis/me?year=2026')
      .set('Cookie', salesA.cookie);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.historical_cohort_performance.quotations_cohort_won, 0);
    assert.equal(res.body.data.historical_cohort_performance.quotations_cohort_lost, 0);
    assert.equal(res.body.data.historical_cohort_performance.cohort_win_rate_percentage, null);
  });

  test('origin snapshot preserves identity when user account is deleted', async () => {
    await setUp();

    // Sales A originates a won quotation
    await db.query(`
      INSERT INTO quotations (quotation_no, client_name, quotation_date, quotation_value, currency, status, owner_user_id, originating_user_id, originating_user_snapshot_id, originating_user_name)
      VALUES ('QT-DELETE', 'Snap Corp', '2026-05-01', 400000, 'INR', 'Won - PO Received', $1, $1, $1, 'Sam Sales')
    `, [salesA.user.id]);

    await orderFor('QT-DELETE', '2026-05-10', 400000);
    // A cancelled order is no order intake for anyone.
    await db.query(`
      INSERT INTO quotations (quotation_no, client_name, quotation_date, quotation_value, currency, status, owner_user_id, originating_user_id, originating_user_snapshot_id, originating_user_name)
      VALUES ('QT-CANCELLED', 'Snap Corp', '2026-05-01', 900000, 'INR', 'Won - PO Received', $1, $1, $1, 'Sam Sales')
    `, [salesA.user.id]);
    await orderFor('QT-CANCELLED', '2026-05-11', 900000, { cancelled: true });

    // Hard delete Sales A (without targets so delete passes)
    await db.query('DELETE FROM users WHERE id = $1', [salesA.user.id]);

    // Check DB record: originating_user_id is null via ON DELETE SET NULL, but snapshot_id and name remain
    const { rows: [q] } = await db.query(
      'SELECT originating_user_id, originating_user_snapshot_id, originating_user_name FROM quotations WHERE quotation_no = $1',
      ['QT-DELETE']
    );
    assert.equal(q.originating_user_id, null);
    assert.equal(q.originating_user_snapshot_id, salesA.user.id);
    assert.equal(q.originating_user_name, 'Sam Sales');

    // Admin query for Sales A's historical performance using snapshot ID
    const res = await request(app)
      .get(`/api/kpis/users/${salesA.user.id}?year=2026`)
      .set('Cookie', admin.cookie);
    // User row was deleted, so GET /users/:id correctly returns 404 for deleted user account
    assert.equal(res.status, 404);

    // But in team summary, team attributed intake still counts it under attributed (because snapshot is intact)
    const resTeam = await request(app)
      .get('/api/kpis/team?year=2026')
      .set('Cookie', admin.cookie);
    assert.equal(resTeam.status, 200);
    assert.equal(resTeam.body.data.team_order_intake_summary.attributed_orders, 1);
    assert.equal(resTeam.body.data.team_order_intake_summary.attributed_intake_value_inr, 400000);
    assert.equal(resTeam.body.data.team_order_intake_summary.total_orders, 1);
  });

  test('conflicting PO origins are flagged and left unresolved to prevent arbitrary attribution', async () => {
    await setUp();

    // 1. Create project originated by Sales B
    await db.query(`
      INSERT INTO projects (project_id, client_name, owner_user_id, originating_user_id, originating_user_snapshot_id, originating_user_name)
      VALUES ('PRJ-2026-099', 'Conflict Corp', $1, $1, $1, 'Bea Sales')
    `, [salesB.user.id]);

    // 2. Create quotation originated by Sales A
    await db.query(`
      INSERT INTO quotations (quotation_no, client_name, project_id, quotation_date, quotation_value, currency, status, owner_user_id, originating_user_id, originating_user_snapshot_id, originating_user_name)
      VALUES ('QT-CONFLICT', 'Conflict Corp', 'PRJ-2026-099', '2026-06-01', 500000, 'INR', 'Won - PO Received', $1, $1, $1, 'Sam Sales')
    `, [salesA.user.id]);

    // 3. Create PO linked to both PRJ-2026-099 and QT-CONFLICT
    await db.query(`
      INSERT INTO purchase_orders (po_number, project_id, quotation_no, po_date, po_value, currency)
      VALUES ('PO-CONFLICT-01', 'PRJ-2026-099', 'QT-CONFLICT', '2026-06-15', 500000, 'INR')
    `);

    // Team KPI endpoint detects and reports the conflict
    const resTeam = await request(app)
      .get('/api/kpis/team?year=2026')
      .set('Cookie', admin.cookie);
    assert.equal(resTeam.status, 200);
    assert.equal(resTeam.body.data.origin_conflict_deals.length, 1);
    const conflict = resTeam.body.data.origin_conflict_deals[0];
    assert.equal(conflict.po_number, 'PO-CONFLICT-01');
    assert.equal(conflict.quotation_origin_user_id, salesA.user.id);
    assert.equal(conflict.project_origin_user_id, salesB.user.id);
    assert.equal(conflict.resolution_status, 'unresolved_conflict');

    // And its value is credited to nobody: unattributed for the team, in neither rep's intake.
    assert.equal(resTeam.body.data.team_order_intake_summary.unattributed_orders, 1);
    assert.equal(resTeam.body.data.team_order_intake_summary.unattributed_intake_value_inr, 500000);
    const intakeOf = (user) => resTeam.body.data.salespeople
      .find((p) => p.salesperson.id === user.user.id).financial_performance.order_intake_inr;
    assert.deepEqual([intakeOf(salesA), intakeOf(salesB)], [0, 0]);
  });

  /**
   * An enquiry is open in four statuses since #24 — New, Contacted,
   * Qualified and Nurture — so ENQUIRY_STATUS.open is a list, and the KPI
   * has to count every one of them.
   *
   * The failure this guards against is silent: interpolating the list into
   * the SQL gives `status = 'New,Contacted,Qualified,Nurture'`, which equals
   * no status at all, so open_enquiries reads 0 for everybody and looks like
   * a quiet week rather than a bug.
   */
  test('open_enquiries counts every open status, not just one', async () => {
    await setUp();

    const OPEN = ['New', 'Contacted', 'Qualified', 'Nurture'];
    let n = 0;
    for (const status of OPEN) {
      n += 1;
      await db.query(
        `INSERT INTO enquiries (enquiry_no, client_name, enquiry_date, status, owner_user_id)
         VALUES ($1, $2, '2026-03-01', $3, $4)`,
        [`CTZ/ENQ/2026/${String(n).padStart(3, '0')}`, `Open ${status}`, status, salesA.user.id]
      );
    }
    // Closed states, and another user's open one: neither counts.
    await db.query(
      `INSERT INTO enquiries (enquiry_no, client_name, enquiry_date, status, owner_user_id)
       VALUES ('CTZ/ENQ/2026/090', 'Converted co', '2026-03-01', 'Converted',   $1),
              ('CTZ/ENQ/2026/091', 'Unqualified co', '2026-03-01', 'Unqualified', $1),
              ('CTZ/ENQ/2026/092', 'Bea open', '2026-03-01', 'Qualified', $2)`,
      [salesA.user.id, salesB.user.id]
    );

    const res = await request(app).get('/api/kpis/me?year=2026').set('Cookie', salesA.cookie);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(
      res.body.data.current_workload.open_enquiries, OPEN.length,
      'all four open statuses, and only this owner\'s'
    );

    // And one at a time, so a list that silently collapsed to its first
    // element would still be caught.
    for (const status of OPEN) {
      await db.query(`DELETE FROM enquiries`);
      await db.query(
        `INSERT INTO enquiries (enquiry_no, client_name, enquiry_date, status, owner_user_id)
         VALUES ('CTZ/ENQ/2026/100', 'Only one', '2026-03-01', $1, $2)`,
        [status, salesA.user.id]
      );
      const one = await request(app).get('/api/kpis/me?year=2026').set('Cookie', salesA.cookie);
      assert.equal(one.body.data.current_workload.open_enquiries, 1, `status ${status} counts as open`);
    }
  });

  test('collections KPI is reported as unavailable with explicit data integrity notice', async () => {
    await setUp();

    const res = await request(app)
      .get('/api/kpis/me?year=2026')
      .set('Cookie', salesA.cookie);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.financial_performance.collections.status, 'unavailable');
    assert.equal(res.body.data.financial_performance.collections.value, null);
    assert.match(res.body.data.financial_performance.collections.reason, /Accurate annual collections require receipt-event data/);
  });
});
