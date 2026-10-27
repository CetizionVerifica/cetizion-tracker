import assert from 'node:assert/strict';
import test, { beforeEach, describe } from 'node:test';
import request from 'supertest';

/**
 * The super admin portal's sign-in and its separation from the staff one.
 * Nothing here reaches the users table; the sign-in record is best-effort
 * and points at an address that refuses at once.
 */

const EMAIL = 'super@example.com';
const PASSWORD = 'a-good-long-super-password';
const SECRET = 'test-secret-that-is-long-enough-to-pass';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgres://127.0.0.1:1/nothing_here';
process.env.AUTH_MODE = 'shared';
process.env.AUTH_USERNAME = 'tester';
process.env.AUTH_PASSWORD = 'a-good-long-test-password';
process.env.SESSION_SECRET = SECRET;
process.env.SUPER_ADMIN_EMAIL = EMAIL;
process.env.SUPER_ADMIN_PASSWORD = PASSWORD;

const { default: app } = await import('../src/app.js');
const { signSession, sharedPayload } = await import('../src/auth/session.js');
const { superAdminToken, checkSuperAdmin } = await import('../src/auth/superAdmin.js');
const { superAdminLoginLimiter } = await import('../src/routes/superAdmin.js');
const { loginLimiter } = await import('../src/auth/routes.js');
const { hashPassword } = await import('../src/lib/passwords.js');

const resetLimits = () => {
  for (const ip of ['::ffff:127.0.0.1', '127.0.0.1', '::1']) {
    for (const limiter of [superAdminLoginLimiter, loginLimiter]) {
      try { limiter.resetKey(ip); } catch { /* not a key this store knows */ }
    }
  }
};

const signIn = (email = EMAIL, password = PASSWORD) =>
  request(app).post('/api/super-admin/login').send({ email, password });

describe('the super admin sign-in', () => {
  beforeEach(() => {
    resetLimits();
    process.env.SUPER_ADMIN_EMAIL = EMAIL;
    process.env.SUPER_ADMIN_PASSWORD = PASSWORD;
  });

  test('the right email and password give a cookie of its own', async () => {
    const res = await signIn(' Super@Example.com ');
    assert.equal(res.status, 200);
    assert.equal(res.body.data.email, EMAIL);
    const cookie = res.headers['set-cookie'].join(';');
    assert.match(cookie, /cetizion_super_admin=/);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /Path=\/api\/super-admin/);

    const me = await request(app).get('/api/super-admin/me').set('Cookie', res.headers['set-cookie']);
    assert.equal(me.status, 200);
    assert.equal(me.body.data.email, EMAIL);
  });

  test('a wrong password or a wrong email is refused the same way', async () => {
    for (const [email, password] of [[EMAIL, 'wrong-password'], ['other@example.com', PASSWORD]]) {
      const res = await signIn(email, password);
      assert.equal(res.status, 401);
      assert.equal(res.body.error.message, 'That email address and password do not match');
      assert.equal(res.headers['set-cookie'], undefined);
    }
  });

  test('the staff login is not a way in', async () => {
    const staff = await request(app).post('/api/auth/login').send({ username: 'tester', password: 'a-good-long-test-password' });
    assert.equal(staff.status, 200);
    const asStaff = staff.headers['set-cookie'];
    assert.equal((await request(app).get('/api/super-admin/me').set('Cookie', asStaff)).status, 401);
    assert.equal((await request(app).get('/api/super-admin/users').set('Cookie', asStaff)).status, 401);

    // A staff-shaped payload under the staff key, renamed to the super admin cookie.
    const forged = signSession(sharedPayload(EMAIL, Date.now() + 3_600_000), SECRET);
    assert.equal((await request(app).get('/api/super-admin/users').set('Cookie', `cetizion_super_admin=${forged}`)).status, 401);
  });

  test('a super admin cookie is not a staff session', async () => {
    const token = superAdminToken(EMAIL, Date.now() + 3_600_000);
    for (const name of ['cetizion_super_admin', 'cetizion_session']) {
      const res = await request(app).get('/api/users').set('Cookie', `${name}=${token}`);
      assert.equal(res.status, 401, name);
    }
  });

  test('changing SUPER_ADMIN_EMAIL ends the old sessions', async () => {
    const res = await signIn();
    process.env.SUPER_ADMIN_EMAIL = 'someone-else@example.com';
    assert.equal((await request(app).get('/api/super-admin/me').set('Cookie', res.headers['set-cookie'])).status, 401);
  });

  test('an expired cookie is refused', async () => {
    const token = superAdminToken(EMAIL, Date.now() - 1000);
    assert.equal((await request(app).get('/api/super-admin/me').set('Cookie', `cetizion_super_admin=${token}`)).status, 401);
  });

  test('signed out, the user routes are 401', async () => {
    assert.equal((await request(app).get('/api/super-admin/users')).status, 401);
    assert.equal((await request(app).delete('/api/super-admin/users/1')).status, 401);
  });

  test('logout clears the cookie', async () => {
    const res = await request(app).post('/api/super-admin/logout');
    assert.equal(res.status, 204);
    assert.match(res.headers['set-cookie'].join(';'), /cetizion_super_admin=;/);
  });

  test('with no super admin set, the portal is a 404', async () => {
    delete process.env.SUPER_ADMIN_EMAIL;
    assert.equal((await signIn()).status, 404);
    assert.equal((await request(app).get('/api/super-admin/me')).status, 404);
  });

  test('the password may be stored as a hash', async () => {
    const settings = { email: EMAIL, password: await hashPassword(PASSWORD), sessionMs: 1000 };
    assert.equal(await checkSuperAdmin(EMAIL, PASSWORD, settings), true);
    assert.equal(await checkSuperAdmin(EMAIL, 'wrong-password', settings), false);
  });

  test('a plain password that merely starts with "scrypt$" is compared as a password', async () => {
    const plain = 'scrypt$MyLongPassphrase1';
    const settings = { email: EMAIL, password: plain, sessionMs: 1000 };
    assert.equal(await checkSuperAdmin(EMAIL, plain, settings), true);
  });

  test('the hash script refuses a password the portal would refuse', async () => {
    const { superAdminPasswordProblem } = await import('../src/auth/superAdmin.js');
    assert.match(superAdminPasswordProblem('abc'), /at least 14/);
    assert.match(superAdminPasswordProblem('123456'), /at least 14/);
    assert.equal(superAdminPasswordProblem('a-good-long-super-password'), null);
  });
});
