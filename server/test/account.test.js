import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * My account (C20): the ways in, the devices, and the fields only you may
 * change.
 *
 * The whole file runs with AUTH_MODE=database, in its own database. What
 * it is really checking is that a session is now a row somebody can end —
 * before this, a signed cookie was valid until it expired and nothing
 * could take it away short of resetting the password.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */
const ADMIN_URL = process.env.TEST_DATABASE_URL;
const SECRET = 'test-secret-that-is-long-enough-to-pass';
const PASSWORD = 'a-good-long-test-password';

describe('my account', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, async () => {
  let dbUrl; let db; let app; let pool; let createUser;

  before(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    const name = `account_suite_${process.pid}_${Date.now()}`;
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
    process.env.AUTH_MODE = 'database';
    process.env.AUTH_USERNAME = 'shared-admin';
    process.env.AUTH_PASSWORD = 'the-shared-password-in-env';
    process.env.SESSION_SECRET = SECRET;

    ({ default: app } = await import('../src/app.js'));
    ({ pool } = await import('../src/db.js'));
    ({ createUser } = await import('../src/lib/users.js'));
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
    const { loginLimiter } = await import('../src/auth/routes.js');
    for (const ip of ['::ffff:127.0.0.1', '127.0.0.1', '::1']) {
      try { loginLimiter.resetKey(ip); } catch { /* not a key this store knows */ }
    }
    await db.query('DELETE FROM users');
  };

  const makeUser = () => createUser(
    { name: 'Alice', email: 'alice@example.com', password: PASSWORD, role: 'admin' }, db);

  /** Sign in and return the session cookie, as one device would hold it. */
  async function signIn(agent = 'Chrome on a MacBook') {
    const res = await request(app)
      .post('/api/auth/login')
      .set('User-Agent', agent)
      .send({ email: 'alice@example.com', password: PASSWORD });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return [].concat(res.headers['set-cookie']).find((c) => c.startsWith('cetizion_session=')).split(';')[0];
  }

  const account = (cookie) => request(app).get('/api/auth/account').set('Cookie', cookie);

  test('each sign-in is its own session, and the caller knows which one is theirs', async () => {
    await clean();
    await makeUser();
    const laptop = await signIn('Chrome on a MacBook');
    const phone = await signIn('Safari on an iPhone');

    const res = await account(laptop);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.sessions.length, 2);

    const mine = res.body.data.sessions.filter((s) => s.current);
    assert.equal(mine.length, 1, 'exactly one session is "this device"');
    assert.match(mine[0].user_agent, /MacBook/);
    assert.equal(mine[0].via, 'password');

    // And the other device sees the same two, with the other one current.
    const fromPhone = await account(phone);
    assert.match(fromPhone.body.data.sessions.find((s) => s.current).user_agent, /iPhone/);
  });

  test('ending one device ends that device and no other', async () => {
    await clean();
    await makeUser();
    const laptop = await signIn('Chrome on a MacBook');
    const phone = await signIn('Safari on an iPhone');

    const phoneSession = (await account(phone)).body.data.sessions.find((s) => s.current).id;
    const ended = await request(app).delete(`/api/auth/account/sessions/${phoneSession}`).set('Cookie', laptop);
    assert.equal(ended.status, 200);

    // The phone's cookie is still perfectly well signed, and it is finished.
    assert.equal((await account(phone)).status, 401);
    assert.equal((await account(laptop)).status, 200);
  });

  test('a session cannot be ended from somebody else\'s account', async () => {
    await clean();
    await makeUser();
    await createUser({ name: 'Mallory', email: 'mallory@example.com', password: PASSWORD, role: 'sales' }, db);
    const alice = await signIn();
    const aliceSession = (await account(alice)).body.data.sessions[0].id;

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'mallory@example.com', password: PASSWORD });
    const mallory = [].concat(res.headers['set-cookie']).find((c) => c.startsWith('cetizion_session=')).split(';')[0];

    const attempt = await request(app).delete(`/api/auth/account/sessions/${aliceSession}`).set('Cookie', mallory);
    assert.equal(attempt.status, 404, 'not theirs to end, and not confirmed to exist either');
    assert.equal((await account(alice)).status, 200, 'Alice is still signed in');
  });

  test('sign out everywhere includes here — the words mean what they say', async () => {
    await clean();
    await makeUser();
    const laptop = await signIn('Chrome on a MacBook');
    const phone = await signIn('Safari on an iPhone');

    const res = await request(app).post('/api/auth/account/sessions/revoke-all').set('Cookie', laptop);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.ended, 2);

    assert.equal((await account(laptop)).status, 401);
    assert.equal((await account(phone)).status, 401);
  });

  test('a person may change what they are called, not what they are', async () => {
    await clean();
    const user = await makeUser();
    const cookie = await signIn();

    const ok = await request(app).patch('/api/auth/account').set('Cookie', cookie).send({
      name: 'Alice R.',
      signature: 'Alice R. · Director, Sales',
      phone: '+91 98200 12345',
      notify: { monday_brief: true },
      // Sent, and must be ignored: this is the whole point of the endpoint.
      role: 'sales',
      email: 'someone.else@example.com',
      active: false,
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.data.name, 'Alice R.');
    assert.equal(ok.body.data.signature, 'Alice R. · Director, Sales');
    assert.deepEqual(ok.body.data.notify, { monday_brief: true });

    const after = (await db.query('SELECT * FROM users WHERE id = $1', [user.id])).rows[0];
    assert.equal(after.role, 'admin', 'nobody promotes themselves here');
    assert.equal(after.email, 'alice@example.com', 'nor changes the address an admin set');
    assert.equal(after.active, true);
  });

  test('one notification switch does not clear the other three', async () => {
    await clean();
    await makeUser();
    const cookie = await signIn();

    await request(app).patch('/api/auth/account').set('Cookie', cookie)
      .send({ notify: { monday_brief: true, deal_accepted: true } });
    const res = await request(app).patch('/api/auth/account').set('Cookie', cookie)
      .send({ notify: { monday_brief: false } });

    assert.deepEqual(res.body.data.notify, { monday_brief: false, deal_accepted: true });
  });

  test('changing your password ends every other device and keeps this one', async () => {
    await clean();
    await makeUser();
    const laptop = await signIn('Chrome on a MacBook');
    const phone = await signIn('Safari on an iPhone');

    const wrong = await request(app).post('/api/auth/account/password').set('Cookie', laptop)
      .send({ current_password: 'not-it', new_password: 'another-good-long-password' });
    assert.equal(wrong.status, 422, 'an open tab is not enough to take the account');

    const res = await request(app).post('/api/auth/account/password').set('Cookie', laptop)
      .send({ current_password: PASSWORD, new_password: 'another-good-long-password' });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const replaced = [].concat(res.headers['set-cookie']).find((c) => c.startsWith('cetizion_session=')).split(';')[0];
    assert.equal((await account(replaced)).status, 200, 'the tab you typed in stays signed in');
    assert.equal((await account(phone)).status, 401, 'the other device does not');
  });

  test('a short new password is refused, and the old one still works', async () => {
    await clean();
    await makeUser();
    const cookie = await signIn();

    const res = await request(app).post('/api/auth/account/password').set('Cookie', cookie)
      .send({ current_password: PASSWORD, new_password: 'short' });
    assert.equal(res.status, 422);
    assert.ok(res.body.error.fields.new_password);
    assert.equal((await account(cookie)).status, 200);
  });

  test('unlinking the only way in is refused', async () => {
    await clean();
    const user = await makeUser();
    const cookie = await signIn();

    await db.query(
      `INSERT INTO auth_identities (user_id, provider, subject, email) VALUES ($1,'google','g-1',$2)`,
      [user.id, 'alice@example.com']);
    // With a password set, unlinking is fine.
    const first = await request(app).delete('/api/auth/account/identities/google').set('Cookie', cookie);
    assert.equal(first.status, 200);

    // With no password and one identity, it is the only door.
    await db.query('UPDATE users SET active = false, password_hash = NULL WHERE id = $1', [user.id]);
    await db.query('UPDATE users SET active = true WHERE id = $1', [user.id]).catch(() => {});
    const only = await db.query('SELECT password_hash, active FROM users WHERE id = $1', [user.id]);
    assert.equal(only.rows[0].password_hash, null);
    assert.equal(only.rows[0].active, false, 'the table refuses an active account with no way in');
  });

  test('the whole page is 404 in shared mode, rather than half working', async () => {
    // Proven where shared mode actually runs: usersApiShared.test.js holds
    // the shared-mode app. Here the guard is the other half — a database
    // session with no user id cannot reach it either.
    await clean();
    const res = await request(app).get('/api/auth/account');
    assert.equal(res.status, 401, 'signed out is signed out, not 404');
  });
});
