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

describe('annual sales targets', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
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
    const name = `targets_${process.pid}_${Date.now()}`;
    await root.query(`CREATE DATABASE ${name}`);
    await root.end();

    const u = new URL(ADMIN_URL);
    u.pathname = `/${name}`;
    dbUrl = u.toString();

    db = new pg.Client({ connectionString: dbUrl });
    await db.connect();
    await db.query(readFileSync(join(DB_DIR, 'schema.sql'), 'utf8'));
    await db.query(readFileSync(join(DB_DIR, 'views.sql'), 'utf8'));

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

  async function setUp() {
    await db.query('DELETE FROM sales_targets');
    await db.query('DELETE FROM activity_log');
    await db.query('DELETE FROM users');

    const mk = async (over) => createUser({ password: PASSWORD, ...over }, db);
    const a = await mk({ name: 'Alice Admin', email: 'alice@example.com', role: 'admin' });
    const s1 = await mk({ name: 'Sam Sales', email: 'sam@example.com', role: 'sales' });
    const s2 = await mk({ name: 'Bea Sales', email: 'bea@example.com', role: 'sales' });

    admin = { user: a, cookie: await signIn(a.email) };
    salesA = { user: s1, cookie: await signIn(s1.email) };
    salesB = { user: s2, cookie: await signIn(s2.email) };
  }

  test('admin can create and update a monetary annual sales target', async () => {
    await setUp();

    // 1. Create target
    const resCreate = await request(app)
      .put(`/api/kpis/users/${salesA.user.id}/targets/order_intake_value`)
      .set('Cookie', admin.cookie)
      .send({
        calendar_year: 2026,
        target_value: 5000000,
        unit: 'currency',
        currency: 'INR',
      });

    assert.equal(resCreate.status, 201, JSON.stringify(resCreate.body));
    assert.equal(resCreate.body.data.salesperson_user_id, salesA.user.id);
    assert.equal(resCreate.body.data.calendar_year, 2026);
    assert.equal(resCreate.body.data.metric, 'order_intake_value');
    assert.equal(resCreate.body.data.target_value, 5000000);
    assert.equal(resCreate.body.data.currency, 'INR');

    // Verify activity_log was recorded atomically
    const { rows: logsCreate } = await db.query(
      "SELECT * FROM activity_log WHERE entity_type = 'sales_targets' AND action = 'target.created'"
    );
    assert.equal(logsCreate.length, 1);
    assert.equal(logsCreate[0].actor_user_id, admin.user.id);
    assert.equal(logsCreate[0].metadata.new_target_value, 5000000);

    // 2. Update existing target (idempotent upsert)
    const resUpdate = await request(app)
      .put(`/api/kpis/users/${salesA.user.id}/targets/order_intake_value`)
      .set('Cookie', admin.cookie)
      .send({
        calendar_year: 2026,
        target_value: 6500000,
        unit: 'currency',
        currency: 'INR',
      });

    assert.equal(resUpdate.status, 200, JSON.stringify(resUpdate.body));
    assert.equal(resUpdate.body.data.id, resCreate.body.data.id);
    assert.equal(resUpdate.body.data.target_value, 6500000);

    // Verify activity_log recorded update with previous value
    const { rows: logsUpdate } = await db.query(
      "SELECT * FROM activity_log WHERE entity_type = 'sales_targets' AND action = 'target.updated'"
    );
    assert.equal(logsUpdate.length, 1);
    assert.equal(logsUpdate[0].metadata.previous_target_value, 5000000);
    assert.equal(logsUpdate[0].metadata.new_target_value, 6500000);
  });

  test('count targets require whole integers and forbid currency', async () => {
    await setUp();

    // Rejects fractional count
    const resFraction = await request(app)
      .put(`/api/kpis/users/${salesA.user.id}/targets/won_quotations_count`)
      .set('Cookie', admin.cookie)
      .send({
        calendar_year: 2026,
        target_value: 12.5,
        unit: 'count',
      });
    assert.equal(resFraction.status, 422);

    // Rejects currency on count target
    const resCurr = await request(app)
      .put(`/api/kpis/users/${salesA.user.id}/targets/won_quotations_count`)
      .set('Cookie', admin.cookie)
      .send({
        calendar_year: 2026,
        target_value: 12,
        unit: 'count',
        currency: 'INR',
      });
    assert.equal(resCurr.status, 422);

    // Valid count target
    const resValid = await request(app)
      .put(`/api/kpis/users/${salesA.user.id}/targets/won_quotations_count`)
      .set('Cookie', admin.cookie)
      .send({
        calendar_year: 2026,
        target_value: 20,
        unit: 'count',
      });
    assert.equal(resValid.status, 201);
    assert.equal(resValid.body.data.target_value, 20);
    assert.equal(resValid.body.data.currency, null);
  });

  test('unique index prevents duplicate count targets when currency is null', async () => {
    await setUp();

    // Create count target
    await request(app)
      .put(`/api/kpis/users/${salesA.user.id}/targets/won_quotations_count`)
      .set('Cookie', admin.cookie)
      .send({
        calendar_year: 2026,
        target_value: 15,
        unit: 'count',
      });

    // Check directly in database that only 1 row exists
    const { rows: targets } = await db.query(
      'SELECT id, target_value FROM sales_targets WHERE salesperson_user_id = $1 AND calendar_year = 2026 AND metric = $2',
      [salesA.user.id, 'won_quotations_count']
    );
    assert.equal(targets.length, 1);
    assert.equal(Number(targets[0].target_value), 15);

    // Attempting a second raw insert with currency NULL violates unique index
    await assert.rejects(async () => {
      await db.query(
        `INSERT INTO sales_targets (salesperson_user_id, calendar_year, metric, target_value, unit, currency)
         VALUES ($1, 2026, 'won_quotations_count', 25, 'count', NULL)`,
        [salesA.user.id]
      );
    }, /sales_targets_unique_idx/);
  });

  test('monetary targets require explicit currency and reject negative amounts', async () => {
    await setUp();

    // Rejects missing currency
    const resNoCurr = await request(app)
      .put(`/api/kpis/users/${salesA.user.id}/targets/order_intake_value`)
      .set('Cookie', admin.cookie)
      .send({
        calendar_year: 2026,
        target_value: 100000,
        unit: 'currency',
      });
    assert.equal(resNoCurr.status, 422);

    // Rejects negative value
    const resNeg = await request(app)
      .put(`/api/kpis/users/${salesA.user.id}/targets/order_intake_value`)
      .set('Cookie', admin.cookie)
      .send({
        calendar_year: 2026,
        target_value: -5000,
        unit: 'currency',
        currency: 'INR',
      });
    assert.equal(resNeg.status, 422);
  });

  test('sales users cannot create or update targets', async () => {
    await setUp();

    const res = await request(app)
      .put(`/api/kpis/users/${salesA.user.id}/targets/won_quotations_count`)
      .set('Cookie', salesA.cookie)
      .send({
        calendar_year: 2026,
        target_value: 50,
        unit: 'count',
      });
    assert.equal(res.status, 403);
  });

  test('sales users can read only their own targets; cannot read other sales users targets', async () => {
    await setUp();

    // Admin sets target for Sales A and Sales B
    await request(app)
      .put(`/api/kpis/users/${salesA.user.id}/targets/won_quotations_count`)
      .set('Cookie', admin.cookie)
      .send({ calendar_year: 2026, target_value: 10, unit: 'count' });

    await request(app)
      .put(`/api/kpis/users/${salesB.user.id}/targets/won_quotations_count`)
      .set('Cookie', admin.cookie)
      .send({ calendar_year: 2026, target_value: 20, unit: 'count' });

    // Sales A requests targets without param -> gets Sales A's target only
    const resA = await request(app)
      .get('/api/kpis/targets?year=2026')
      .set('Cookie', salesA.cookie);
    assert.equal(resA.status, 200);
    assert.equal(resA.body.data.length, 1);
    assert.equal(resA.body.data[0].salesperson_user_id, salesA.user.id);

    // Sales A attempts to request Sales B's targets -> 403 Forbidden
    const resForbidden = await request(app)
      .get(`/api/kpis/targets?year=2026&salesperson_user_id=${salesB.user.id}`)
      .set('Cookie', salesA.cookie);
    assert.equal(resForbidden.status, 403);

    // Admin requests targets -> sees both
    const resAdmin = await request(app)
      .get('/api/kpis/targets?year=2026')
      .set('Cookie', admin.cookie);
    assert.equal(resAdmin.status, 200);
    assert.equal(resAdmin.body.data.length, 2);
  });

  test('historical targets remain available when salesperson is deactivated; deletion is restricted', async () => {
    await setUp();

    // Set target for Sales B
    await request(app)
      .put(`/api/kpis/users/${salesB.user.id}/targets/won_quotations_count`)
      .set('Cookie', admin.cookie)
      .send({ calendar_year: 2026, target_value: 30, unit: 'count' });

    // Deactivate Sales B
    await db.query('UPDATE users SET active = false WHERE id = $1', [salesB.user.id]);

    // Admin can still list targets and sees Sales B's target
    const resDeact = await request(app)
      .get(`/api/kpis/targets?year=2026&salesperson_user_id=${salesB.user.id}`)
      .set('Cookie', admin.cookie);
    assert.equal(resDeact.status, 200);
    assert.equal(resDeact.body.data.length, 1);
    assert.equal(resDeact.body.data[0].salesperson_active, false);

    // Hard deletion of user with targets is prevented by ON DELETE RESTRICT foreign key
    await assert.rejects(async () => {
      await db.query('DELETE FROM users WHERE id = $1', [salesB.user.id]);
    }, /sales_targets_salesperson_user_id_fkey/);
  });
});
