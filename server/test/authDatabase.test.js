import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

// session.js reads no environment, so it is safe to import up here.
// middleware.js is NOT: it pulls in auth/config.js, which reads AUTH_MODE
// once at import — before `before()` could set it. It is imported below.
import { sharedPayload, signSession } from '../src/auth/session.js';

/**
 * Signing in against the users table (#18 Phase 1B-A).
 *
 * The whole file runs with AUTH_MODE=database. Node gives each test file
 * its own process, so pinning the mode here does not disturb auth.test.js,
 * which proves the shared mode still works in its own process.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const SECRET = 'test-secret-that-is-long-enough-to-pass';
const PASSWORD = 'a-good-long-test-password';

describe('database mode', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, async () => {
  let dbUrl;
  let db;
  let app;
  let pool;
  let createUser;
  let requireAdmin;
  let requireRole;
  let resetLimiter;

  before(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    const name = `authdb_suite_${process.pid}_${Date.now()}`;
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

    // Set before importing anything that reads the environment.
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = dbUrl;
    process.env.AUTH_MODE = 'database';
    process.env.AUTH_USERNAME = 'shared-admin';
    process.env.AUTH_PASSWORD = 'the-shared-password-in-env';
    process.env.SESSION_SECRET = SECRET;

    ({ default: app } = await import('../src/app.js'));
    ({ pool } = await import('../src/db.js'));
    ({ createUser } = await import('../src/lib/users.js'));
    ({ requireAdmin, requireRole } = await import('../src/auth/middleware.js'));

    const { loginLimiter } = await import('../src/auth/routes.js');
    // Ten failed sign-ins in fifteen minutes is the real limit, and this
    // file deliberately fails more than that. Clearing it between tests
    // keeps each one honest; authRateLimit.test.js proves the limit works.
    resetLimiter = () => {
      for (const ip of ['::ffff:127.0.0.1', '127.0.0.1', '::1']) {
        try { loginLimiter.resetKey(ip); } catch { /* not a key this store knows */ }
      }
    };
  });

  after(async () => {
    await pool?.end();
    await db?.end();
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${new URL(dbUrl).pathname.slice(1)} WITH (FORCE)`);
    await admin.end();
  });

  const clean = async () => {
    resetLimiter();
    await db.query('DELETE FROM users');
  };
  const login = (body) => request(app).post('/api/auth/login').send(body);
  const cookieOf = (res) => res.headers['set-cookie'];
  const row = async (id) => (await db.query('SELECT * FROM users WHERE id = $1', [id])).rows[0];

  const makeAdmin = (over = {}) =>
    createUser({ name: 'Alice', email: 'alice@example.com', password: PASSWORD, role: 'admin', ...over }, db);
  const makeSales = (over = {}) =>
    createUser({ name: 'Sam', email: 'sam@example.com', password: PASSWORD, role: 'sales', ...over }, db);

  async function signedIn(user) {
    const res = await login({ email: user.email, password: PASSWORD });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return cookieOf(res);
  }

  // ------------------------------------------------------------ signing in

  test('an active admin signs in with their email and password', async () => {
    await clean();
    const alice = await makeAdmin();

    const res = await login({ email: 'alice@example.com', password: PASSWORD });

    assert.equal(res.status, 200);
    assert.equal(res.body.data.id, alice.id);
    assert.equal(res.body.data.email, 'alice@example.com');
    assert.equal(res.body.data.role, 'admin');
    assert.ok(res.body.data.expires_at);
    assert.match(cookieOf(res)[0], /^cetizion_session=/);
    assert.match(cookieOf(res)[0], /HttpOnly/i);
    assert.match(cookieOf(res)[0], /SameSite=Lax/i);
  });

  test('a sales user may sign in too — authentication is not authorisation', async () => {
    await clean();
    await makeSales();

    const res = await login({ email: 'sam@example.com', password: PASSWORD });

    assert.equal(res.status, 200);
    assert.equal(res.body.data.role, 'sales');
  });

  test('the response never carries a password hash', async () => {
    await clean();
    await makeAdmin();

    const res = await login({ email: 'alice@example.com', password: PASSWORD });
    const me = await request(app).get('/api/auth/me').set('Cookie', cookieOf(res));

    for (const body of [res.body, me.body]) {
      const text = JSON.stringify(body);
      assert.ok(!/password_hash/.test(text), text);
      assert.ok(!/scrypt/.test(text), text);
      assert.ok(!text.includes(PASSWORD), text);
    }
  });

  test('the email matches however it was typed', async () => {
    await clean();
    await createUser({ name: 'Alice', email: 'Alice@Example.com', password: PASSWORD, role: 'admin' }, db);

    for (const typed of ['Alice@Example.com', 'alice@example.com', 'ALICE@EXAMPLE.COM', '  alice@example.com  ']) {
      const res = await login({ email: typed, password: PASSWORD });
      assert.equal(res.status, 200, typed);
    }
  });

  // --------------------------------------------- every failure looks alike

  test('a wrong password, an unknown address and a switched-off account are one answer', async () => {
    await clean();
    await makeAdmin();
    await createUser({ name: 'Off', email: 'off@example.com', password: PASSWORD, role: 'admin', active: false }, db);
    await db.query(`UPDATE users SET active = false WHERE email = 'off@example.com'`);

    const attempts = await Promise.all([
      login({ email: 'alice@example.com', password: 'not-the-password-at-all' }),
      login({ email: 'nobody@example.com', password: PASSWORD }),
      login({ email: 'off@example.com', password: PASSWORD }),
    ]);

    for (const res of attempts) {
      assert.equal(res.status, 401);
      assert.equal(res.body.error.message, 'That email address and password do not match');
      assert.equal(cookieOf(res), undefined, 'no cookie is set');
    }
    // One message, so the reply cannot be read as "that address exists".
    assert.equal(new Set(attempts.map((r) => r.body.error.message)).size, 1);
  });

  test('an account with no password hash cannot be signed into', async () => {
    await clean();
    const ghost = await createUser({ name: 'Ghost', active: false }, db);
    await db.query(`UPDATE users SET email = 'ghost@example.com' WHERE id = $1`, [ghost.id]);

    const res = await login({ email: 'ghost@example.com', password: PASSWORD });

    assert.equal(res.status, 401);
    assert.equal(cookieOf(res), undefined);
  });

  test('an unknown address still costs a real password check', async () => {
    await clean();
    await makeAdmin();

    // Not a stopwatch assertion — those are flaky. This proves the code path:
    // a reply that came back without hashing would be far faster than scrypt,
    // so a wildly sub-scrypt response would show the early return is back.
    const started = process.hrtime.bigint();
    await login({ email: 'nobody@example.com', password: PASSWORD });
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    assert.ok(elapsedMs > 5, `unknown address answered in ${elapsedMs.toFixed(1)}ms — too fast to have hashed`);
  });

  test('a request missing its fields is a validation failure, not a sign-in failure', async () => {
    await clean();
    await makeAdmin();

    const noEmail = await login({ password: PASSWORD });
    assert.equal(noEmail.status, 422);
    assert.ok(noEmail.body.error.fields.email);

    const noPassword = await login({ email: 'alice@example.com' });
    assert.equal(noPassword.status, 422);
    assert.ok(noPassword.body.error.fields.password);
  });

  // ---------------------------------------------------------- last_login_at

  test('a successful sign-in is stamped; a failed one is not', async () => {
    await clean();
    const alice = await makeAdmin();
    assert.equal((await row(alice.id)).last_login_at, null);

    await login({ email: 'alice@example.com', password: 'wrong-password-here' });
    assert.equal((await row(alice.id)).last_login_at, null, 'a failed attempt leaves no mark');

    await login({ email: 'alice@example.com', password: PASSWORD });
    const stamped = (await row(alice.id)).last_login_at;
    assert.ok(stamped instanceof Date, 'a successful one does');

    // Reading who you are is not signing in again.
    const cookie = await signedIn(alice);
    const before = (await row(alice.id)).last_login_at;
    await request(app).get('/api/auth/me').set('Cookie', cookie);
    await request(app).get('/api/projects').set('Cookie', cookie);
    assert.deepEqual((await row(alice.id)).last_login_at, before, 'ordinary requests do not restamp it');
  });

  // ------------------------------------------- the cookie is only a name-tag

  test('switching an account off ends its session on the very next request', async () => {
    await clean();
    const alice = await makeAdmin();
    const cookie = await signedIn(alice);
    assert.equal((await request(app).get('/api/auth/me').set('Cookie', cookie)).status, 200);

    await db.query('UPDATE users SET active = false WHERE id = $1', [alice.id]);

    for (const path of ['/api/auth/me', '/api/projects', '/api/lookups']) {
      const res = await request(app).get(path).set('Cookie', cookie);
      assert.equal(res.status, 401, `${path} must not still be open`);
    }
  });

  test('a demoted admin is a sales user on the very next request', async () => {
    await clean();
    const alice = await makeAdmin();
    const cookie = await signedIn(alice);
    assert.equal((await request(app).get('/api/auth/me').set('Cookie', cookie)).body.data.role, 'admin');

    await db.query(`UPDATE users SET role = 'sales' WHERE id = $1`, [alice.id]);

    const me = await request(app).get('/api/auth/me').set('Cookie', cookie);
    assert.equal(me.status, 200, 'still signed in');
    assert.equal(me.body.data.role, 'sales', 'the cookie did not preserve the old role');
  });

  test('a promoted sales user is an admin on the very next request', async () => {
    await clean();
    const sam = await makeSales();
    const cookie = await signedIn(sam);
    assert.equal((await request(app).get('/api/auth/me').set('Cookie', cookie)).body.data.role, 'sales');

    await db.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [sam.id]);

    assert.equal((await request(app).get('/api/auth/me').set('Cookie', cookie)).body.data.role, 'admin');
  });

  test('a renamed account reports its new name without signing in again', async () => {
    await clean();
    const alice = await makeAdmin();
    const cookie = await signedIn(alice);

    await db.query(`UPDATE users SET name = 'Alice Renamed' WHERE id = $1`, [alice.id]);

    assert.equal((await request(app).get('/api/auth/me').set('Cookie', cookie)).body.data.name, 'Alice Renamed');
  });

  test('a deleted account cannot go on using its cookie', async () => {
    await clean();
    const alice = await makeAdmin();
    const cookie = await signedIn(alice);

    await db.query('DELETE FROM users WHERE id = $1', [alice.id]);

    assert.equal((await request(app).get('/api/auth/me').set('Cookie', cookie)).status, 401);
    assert.equal((await request(app).get('/api/projects').set('Cookie', cookie)).status, 401);
  });

  // ------------------------------------------------------- mode isolation

  test('the shared password is not a way in while the database is the lock', async () => {
    await clean();
    await makeAdmin();

    // Offered as an email, it is simply a sign-in that fails.
    const asEmail = await login({ email: 'shared-admin', password: 'the-shared-password-in-env' });
    assert.equal(asEmail.status, 401);
    assert.equal(cookieOf(asEmail), undefined);

    // Offered in the old `username` field, it is not even a credential: the
    // Phase 1B-A alias is gone, so the request is missing its email.
    const asUsername = await login({ username: 'shared-admin', password: 'the-shared-password-in-env' });
    assert.equal(asUsername.status, 422, 'username is no longer a name for the email field');
    assert.ok(asUsername.body.error.fields.email);
    assert.equal(cookieOf(asUsername), undefined);
  });

  test('a database sign-in asks for an email, and says so when one is missing', async () => {
    await clean();
    const alice = await makeAdmin();

    const res = await login({ email: alice.email, password: PASSWORD });
    assert.equal(res.status, 200, 'email is the field');

    const noEmail = await login({ username: alice.email, password: PASSWORD });
    assert.equal(noEmail.status, 422);
    assert.equal(cookieOf(noEmail), undefined, 'and no session is handed out');
  });

  test('a cookie signed for shared mode is refused here, secret or no secret', async () => {
    await clean();
    await makeAdmin();

    // Correctly signed with this API's own secret — only the shape is wrong.
    const token = signSession(sharedPayload('shared-admin', Date.now() + 3_600_000), SECRET);

    for (const path of ['/api/auth/me', '/api/projects']) {
      const res = await request(app).get(path).set('Cookie', [`cetizion_session=${token}`]);
      assert.equal(res.status, 401, path);
    }
  });

  test('a forged or expired cookie is refused as before', async () => {
    await clean();
    const alice = await makeAdmin();

    const wrongSecret = signSession({ v: 2, uid: alice.id, exp: Date.now() + 3600_000 }, 'a-different-secret-entirely-ok');
    const expired = signSession({ v: 2, uid: alice.id, exp: Date.now() - 1 }, SECRET);
    const ghost = signSession({ v: 2, uid: 999_999, exp: Date.now() + 3600_000 }, SECRET);

    for (const [label, token] of [['wrong secret', wrongSecret], ['expired', expired], ['no such user', ghost], ['rubbish', 'not.atoken']]) {
      const res = await request(app).get('/api/auth/me').set('Cookie', [`cetizion_session=${token}`]);
      assert.equal(res.status, 401, label);
    }
  });

  // -------------------------------------------------------- role middleware

  test('requireAdmin lets an admin through and turns a sales user away', async () => {
    await clean();
    const alice = await makeAdmin();
    const sam = await makeSales();

    // A real mounted use of it: the importer has always been admin-only.
    const asAdmin = await request(app).get('/api/import/batches').set('Cookie', await signedIn(alice));
    assert.notEqual(asAdmin.status, 403, 'an admin is not turned away');
    assert.notEqual(asAdmin.status, 401);

    const asSales = await request(app).get('/api/import/batches').set('Cookie', await signedIn(sam));
    assert.equal(asSales.status, 403);
    assert.equal(asSales.body.error.message, 'You do not have access to this');

    const signedOut = await request(app).get('/api/import/batches');
    assert.equal(signedOut.status, 401, 'not signed in is 401, not 403');
  });

  test('a demotion closes an admin-only route immediately', async () => {
    await clean();
    const alice = await makeAdmin();
    const cookie = await signedIn(alice);
    assert.notEqual((await request(app).get('/api/import/batches').set('Cookie', cookie)).status, 403);

    await db.query(`UPDATE users SET role = 'sales' WHERE id = $1`, [alice.id]);

    assert.equal((await request(app).get('/api/import/batches').set('Cookie', cookie)).status, 403);
  });

  test('requireRole reads the role off the refreshed request user', () => {
    const run = (middleware, user) => {
      let outcome = 'next';
      middleware({ user }, {}, (err) => { outcome = err ? err.status : 'next'; });
      return outcome;
    };

    assert.equal(run(requireAdmin, { role: 'admin' }), 'next');
    assert.equal(run(requireAdmin, { role: 'sales' }), 403);
    assert.equal(run(requireAdmin, undefined), 401);
    assert.equal(run(requireRole('sales', 'admin'), { role: 'sales' }), 'next');
    assert.equal(run(requireRole('sales'), { role: 'admin' }), 403);
  });

  // ------------------------------------------------------ the request user

  test('an authenticated request carries an identity with no hash in it', async () => {
    await clean();
    const alice = await makeAdmin();
    const cookie = await signedIn(alice);

    const me = await request(app).get('/api/auth/me').set('Cookie', cookie);

    // No compatibility `username` any more: database users have a real name
    // and a real email, and the front end now reads those.
    assert.deepEqual(Object.keys(me.body.data).sort(), ['email', 'expires_at', 'id', 'name', 'role']);
    assert.equal(me.body.data.id, alice.id);
    assert.equal(me.body.data.role, 'admin');
  });
  test('the public auth config reports database mode and nothing else', async () => {
    const res = await request(app).get('/api/auth/config');

    assert.equal(res.status, 200, 'readable without signing in');
    // The mode, and which provider buttons to draw — nothing else. No
    // provider is configured in this suite, so the list is empty.
    assert.deepEqual(res.body.data, { mode: 'database', providers: [] });
    const text = JSON.stringify(res.body);
    assert.ok(!text.includes('shared-admin'), text);
    assert.ok(!/secret|password|AUTH_/i.test(text), text);
  });

  // ------------------------------------------------------ a broken database
  // Last, because it breaks the schema this suite runs on.

  test('a database that cannot answer fails the request closed', async () => {
    await clean();
    const alice = await makeAdmin();
    const cookie = await signedIn(alice);
    assert.equal((await request(app).get('/api/auth/me').set('Cookie', cookie)).status, 200);

    // The users table stops answering mid-session.
    await db.query('DROP TABLE users CASCADE');

    for (const path of ['/api/auth/me', '/api/projects']) {
      const res = await request(app).get(path).set('Cookie', cookie);
      assert.notEqual(res.status, 200, `${path} must not succeed`);
      // Not 401 either: "signed out" would invite retrying until it opens,
      // and would be indistinguishable from a real sign-out. An outage is
      // an outage.
      assert.equal(res.status, 500, path);
    }

    // And emphatically not a quiet fall back to the shared password.
    const shared = await login({ username: 'shared-admin', password: 'the-shared-password-in-env' });
    assert.notEqual(shared.status, 200, 'the shared password is never a fallback');
  });
});
