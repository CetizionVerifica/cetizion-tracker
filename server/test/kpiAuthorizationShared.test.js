import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * KPI Authorization & Parity in Shared Mode (#18 Phase 4).
 *
 * Proves that:
 * 1. Shared admin cannot access /me (no specific user identity) and receives 400.
 * 2. Shared admin can view team-wide KPI report (/team) with full visibility.
 * 3. Shared admin can view any salesperson's KPI report (/users/:userId).
 * 4. Shared admin can list and manage annual sales targets (/targets and PUT /users/:userId/targets/:metric).
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');

describe('KPI authorization in shared mode', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let dbUrl;
  let db;
  let app;
  let pool;
  let sharedCookie;
  let salesUser;

  before(async () => {
    const root = new pg.Client({ connectionString: ADMIN_URL });
    await root.connect();
    const name = `kpi_shared_${process.pid}_${Date.now()}`;
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
    process.env.AUTH_MODE = 'shared';
    process.env.AUTH_USERNAME = 'shared-admin';
    process.env.AUTH_PASSWORD = 'the-shared-password-in-env';
    process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-to-pass';

    ({ default: app } = await import('../src/app.js'));
    ({ pool } = await import('../src/db.js'));

    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ username: 'shared-admin', password: 'the-shared-password-in-env' });
    assert.equal(loginRes.status, 200, 'shared admin signs in');
    sharedCookie = loginRes.headers['set-cookie'];

    // Create a sales user in the database
    const { rows: [u1] } = await db.query(
      `INSERT INTO users (name, email, password_hash, role, active)
       VALUES ('Sam Sales', 'sam@example.com', 'x', 'sales', true) RETURNING id`
    );
    salesUser = u1;
  });

  after(async () => {
    await pool?.end();
    await db?.end();
    const root = new pg.Client({ connectionString: ADMIN_URL });
    await root.connect();
    const name = new URL(dbUrl).pathname.slice(1);
    await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await root.end();
  });

  test('shared admin receives 400 on /me with explanatory message', async () => {
    const res = await request(app)
      .get('/api/kpis/me?period=calendar-year&on=2026-06-01')
      .set('Cookie', sharedCookie);
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /shared administrator/i);
  });

  test('shared admin can view /team report and individual /users/:id report', async () => {
    const resTeam = await request(app)
      .get('/api/kpis/team?period=calendar-year&on=2026-06-01')
      .set('Cookie', sharedCookie);
    assert.equal(resTeam.status, 200);
    assert.equal(resTeam.body.data.period.from, '2026-01-01');
    assert.equal(resTeam.body.data.period.to, '2027-01-01');
    assert.ok(Array.isArray(resTeam.body.data.people));

    const resUser = await request(app)
      .get(`/api/kpis/users/${salesUser.id}?period=calendar-year&on=2026-06-01`)
      .set('Cookie', sharedCookie);
    assert.equal(resUser.status, 200);
    assert.equal(resUser.body.data.user.id, salesUser.id);
  });

  test('shared admin can view and update targets with audit trail', async () => {
    const resTargets = await request(app)
      .get('/api/kpis/targets?period=calendar-year&on=2026-06-01')
      .set('Cookie', sharedCookie);
    assert.equal(resTargets.status, 200);

    const resPut = await request(app)
      .put(`/api/kpis/users/${salesUser.id}/targets/won_quotations_count`)
      .set('Cookie', sharedCookie)
      .send({
        period: { preset: 'calendar-year', anchor: '2026-06-01' },
        target_value: 25,
        unit: 'count',
      });
    assert.equal(resPut.status, 201, JSON.stringify(resPut.body));
    assert.equal(resPut.body.data.target_value, 25);

    // Verify activity log record has actor_type 'shared_admin'
    const { rows: logs } = await db.query(
      "SELECT action, actor_type, metadata FROM activity_log WHERE entity_type = 'sales_targets'"
    );
    assert.equal(logs.length, 1);
    assert.equal(logs[0].action, 'target.created');
    assert.equal(logs[0].actor_type, 'shared_admin');
    assert.equal(logs[0].metadata.new_target_value, 25);
  });
});
