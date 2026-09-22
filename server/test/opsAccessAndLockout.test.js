import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * Two findings from the review of batch 6, both about a door that opens for
 * somebody it should not (#38, #34).
 *
 * /metrics and the deep health check read the session cookie and nothing
 * else. A cookie is signed for twelve hours, so an account deactivated or
 * demoted an hour ago still held a good one — and the deep check names the
 * migrations applied, where the backups go and which jobs are failing.
 *
 * The sign-in lockout counted failures per IP address. Behind a proxy every
 * request carries the proxy's address, so ten bad guesses from anywhere on
 * the internet locked out everybody, including people typing the right
 * password.
 *
 * Database mode, because that is the only mode with two kinds of user.
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const PASSWORD = 'a-good-long-test-password';

describe('who may read the operational endpoints, and who gets locked out', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let dbUrl;
  let db;
  let app;
  let pool;
  let createUser;
  let resetLimiter;
  let admin;
  let sales;

  const signIn = async (email, password = PASSWORD) => {
    resetLimiter();
    return request(app).post('/api/auth/login').send({ email, password });
  };

  before(async () => {
    const owner = new pg.Client({ connectionString: ADMIN_URL });
    await owner.connect();
    const name = `opsaccess_suite_${process.pid}_${Date.now()}`;
    await owner.query(`CREATE DATABASE ${name}`);
    await owner.end();

    const u = new URL(ADMIN_URL);
    u.pathname = `/${name}`;
    dbUrl = u.toString();

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
    process.env.AUTH_MODE = 'database';
    process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-to-pass';
    process.env.EMAIL_MODE = 'log';
    delete process.env.METRICS_TOKEN;

    ({ default: app } = await import('../src/app.js'));
    ({ pool } = await import('../src/db.js'));
    ({ createUser } = await import('../src/lib/users.js'));

    const { loginLimiter } = await import('../src/auth/routes.js');
    resetLimiter = () => {
      for (const ip of ['::ffff:127.0.0.1', '127.0.0.1', '::1']) {
        try { loginLimiter.resetKey(ip); } catch { /* not a key this store knows */ }
      }
    };

    const a = await createUser({ name: 'Ops Admin', email: 'ops-admin@example.com', password: PASSWORD, role: 'admin' }, db);
    const s = await createUser({ name: 'Ops Sales', email: 'ops-sales@example.com', password: PASSWORD, role: 'sales' }, db);
    admin = { user: a, cookie: (await signIn(a.email)).headers['set-cookie'] };
    sales = { user: s, cookie: (await signIn(s.email)).headers['set-cookie'] };
  });

  after(async () => {
    await pool?.end();
    await db?.end();
    const owner = new pg.Client({ connectionString: ADMIN_URL });
    await owner.connect();
    await owner.query(`DROP DATABASE IF EXISTS ${new URL(dbUrl).pathname.slice(1)} WITH (FORCE)`);
    await owner.end();
  });

  test('/metrics answers an admin, and nobody else', async () => {
    await request(app).get('/metrics').expect(401);
    await request(app).get('/metrics').set('Cookie', sales.cookie).expect(401);
    const ok = await request(app).get('/metrics').set('Cookie', admin.cookie).expect(200);
    assert.match(ok.text, /# HELP/, 'and it really is the metrics');
  });

  test('the deep health check is for admins; a sales user is told so', async () => {
    await request(app).get('/api/health?deep=1').expect(401);
    await request(app).get('/api/health?deep=1').set('Cookie', sales.cookie).expect(403);
    const seen = await request(app).get('/api/health?deep=1').set('Cookie', admin.cookie);
    assert.ok([200, 503].includes(seen.status), `an admin should be answered, got ${seen.status}`);
    assert.ok(seen.body.checks, 'and it is the detailed answer');
    // The plain check stays public, because the platform polls it.
    await request(app).get('/api/health').expect(200);
  });

  test('a cookie outlives the account it was signed for, and stops working anyway', async () => {
    await db.query('UPDATE users SET active = false WHERE id = $1', [admin.user.id]);
    await request(app).get('/metrics').set('Cookie', admin.cookie).expect(401);
    await request(app).get('/api/health?deep=1').set('Cookie', admin.cookie).expect(401);
    await db.query('UPDATE users SET active = true WHERE id = $1', [admin.user.id]);
  });

  test('a demoted admin loses both at once, without signing out', async () => {
    await db.query(`UPDATE users SET role = 'sales' WHERE id = $1`, [admin.user.id]);
    await request(app).get('/metrics').set('Cookie', admin.cookie).expect(401);
    await request(app).get('/api/health?deep=1').set('Cookie', admin.cookie).expect(403);
    await db.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [admin.user.id]);
    await request(app).get('/metrics').set('Cookie', admin.cookie).expect(200);
  });

  describe('the sign-in lockout', () => {
    const LIMIT = 3;

    before(async () => {
      await db.query(`UPDATE settings SET value = $1 WHERE key = 'signin_lockout_failures'`, [String(LIMIT)]);
      await db.query('DELETE FROM auth_events');
    });

    test('locking one account does not lock the person at the next desk', async () => {
      for (let i = 0; i < LIMIT; i += 1) {
        const r = await signIn(sales.user.email, 'not-the-password');
        assert.equal(r.status, 401, `attempt ${i + 1} should be a plain refusal`);
      }
      const locked = await signIn(sales.user.email, 'not-the-password');
      assert.equal(locked.status, 429, 'the account being guessed at is locked');

      // The same address — behind a proxy it is the only address there is.
      const colleague = await signIn(admin.user.email, 'also-wrong');
      assert.equal(colleague.status, 401, 'a colleague is refused, not locked out');
      const rightPassword = await signIn(admin.user.email);
      assert.equal(rightPassword.status, 200, 'and can still sign in');
    });

    test('a correct password clears the count, so the next slip starts from zero', async () => {
      await db.query('DELETE FROM auth_events');
      for (let i = 0; i < LIMIT - 1; i += 1) await signIn(sales.user.email, 'not-the-password');
      assert.equal((await signIn(sales.user.email)).status, 200, 'the right password, before the limit');
      for (let i = 0; i < LIMIT; i += 1) {
        // Without the clear, the second of these would already be a 429.
        assert.equal((await signIn(sales.user.email, 'not-the-password')).status, 401, `failure ${i + 1} after signing in should be a plain refusal`);
      }
      assert.equal((await signIn(sales.user.email, 'not-the-password')).status, 429, 'and the count starts again from that sign-in');
    });
  });
});
