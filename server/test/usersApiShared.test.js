import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * The Users API while the tracker is still on the shared password (#18
 * Phase 1B-B).
 *
 * This is the whole point of running two modes at once. Switching
 * AUTH_MODE=database is only safe once real accounts exist and at least one
 * of them can administer — and the only person who can create them before
 * the switch is whoever is signed in now, with the shared password. If
 * managing database users needed database mode, there would be no way in
 * to the mode you are trying to reach.
 *
 * So: shared admin signs in, creates the accounts, confirms an active
 * admin exists, and only then is the cutover a safe thing to do.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const PASSWORD = 'a-good-long-test-password';

describe('the Users API in shared mode', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let dbUrl;
  let db;
  let app;
  let pool;
  let cookie;

  before(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    const name = `usersshared_suite_${process.pid}_${Date.now()}`;
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();

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
    // The default, spelled out: this file is about the mode nobody has left yet.
    process.env.AUTH_MODE = 'shared';
    process.env.AUTH_USERNAME = 'shared-admin';
    process.env.AUTH_PASSWORD = 'the-shared-password-in-env';
    process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-to-pass';

    ({ default: app } = await import('../src/app.js'));
    ({ pool } = await import('../src/db.js'));

    const signIn = await request(app).post('/api/auth/login')
      .send({ username: 'shared-admin', password: 'the-shared-password-in-env' });
    assert.equal(signIn.status, 200, 'the shared password still signs in');
    cookie = signIn.headers['set-cookie'];
  });

  after(async () => {
    await pool?.end();
    await db?.end();
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${new URL(dbUrl).pathname.slice(1)} WITH (FORCE)`);
    await admin.end();
  });

  const clean = () => db.query('DELETE FROM users');

  test('the shared admin may reach Users management', async () => {
    await clean();

    const res = await request(app).get('/api/users').set('Cookie', cookie);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data, [], 'no accounts yet, which is the starting point');
  });

  test('the whole preparation for a cutover, in order', async () => {
    await clean();
    const { findActiveAdmin } = await import('../src/lib/users.js');
    const { assertAuthReady, AuthReadinessError } = await import('../src/auth/readiness.js');

    // Nobody could sign in if the mode were switched now.
    assert.equal(await findActiveAdmin(db), null);
    await assert.rejects(
      assertAuthReady({ db, mode: 'database', log: () => {} }),
      AuthReadinessError,
      'switching now would lock everybody out'
    );

    // The shared admin creates the real accounts.
    const madeAdmin = await request(app).post('/api/users').set('Cookie', cookie)
      .send({ name: 'Alice', email: 'alice@example.com', role: 'admin', password: PASSWORD });
    assert.equal(madeAdmin.status, 201);
    assert.equal(madeAdmin.body.data.role, 'admin');

    const madeSales = await request(app).post('/api/users').set('Cookie', cookie)
      .send({ name: 'Sam', email: 'sam@example.com', role: 'sales', password: PASSWORD });
    assert.equal(madeSales.status, 201);

    // Now the readiness check passes, so the cutover is a safe thing to do.
    const ready = await assertAuthReady({ db, mode: 'database', log: () => {} });
    assert.deepEqual(ready, { mode: 'database', checked: true, adminId: madeAdmin.body.data.id });
  });

  test('the accounts it creates cannot be used to sign in until the mode changes', async () => {
    await clean();
    await request(app).post('/api/users').set('Cookie', cookie)
      .send({ name: 'Alice', email: 'alice@example.com', role: 'admin', password: PASSWORD });

    // Still shared mode: a real account is not a second way in.
    const asDatabaseUser = await request(app).post('/api/auth/login')
      .send({ username: 'alice@example.com', password: PASSWORD });
    assert.equal(asDatabaseUser.status, 401);
    assert.equal(asDatabaseUser.headers['set-cookie'], undefined);
  });

  test('the last-admin guard applies here too', async () => {
    await clean();
    const created = await request(app).post('/api/users').set('Cookie', cookie)
      .send({ name: 'Alice', email: 'alice@example.com', role: 'admin', password: PASSWORD });

    const res = await request(app).patch(`/api/users/${created.body.data.id}`).set('Cookie', cookie)
      .send({ active: false });

    // Even though the shared password would still get somebody in, the
    // users table is not allowed to reach a state the cutover could not
    // survive.
    assert.equal(res.status, 409);
  });

  test('the shared sign-in itself is untouched', async () => {
    const me = await request(app).get('/api/auth/me').set('Cookie', cookie);

    assert.equal(me.status, 200);
    assert.deepEqual(Object.keys(me.body.data).sort(), ['expires_at', 'username']);
    assert.equal(me.body.data.username, 'shared-admin');
  });

  test('the public auth config says which field the form should ask for', async () => {
    const res = await request(app).get('/api/auth/config');

    assert.equal(res.status, 200, 'readable without signing in');
    // Shared mode has one account and no per-person row to attach an
    // identity to, so provider sign-in is never offered in it.
    assert.deepEqual(res.body.data, { mode: 'shared', providers: [] });
    // Nothing else: not the shared username, not a bootstrap address.
    const text = JSON.stringify(res.body);
    assert.ok(!text.includes('shared-admin'), text);
    assert.ok(!text.includes('the-shared-password-in-env'), text);
    assert.ok(!/secret|password|AUTH_/i.test(text), text);
  });
});
