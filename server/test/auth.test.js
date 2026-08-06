import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';

/**
 * The gate itself, end to end. None of these routes touch Postgres, so this
 * suite runs without a database.
 */

const USERNAME = 'tester';
const PASSWORD = 'a-good-long-test-password';

process.env.NODE_ENV = 'test';
process.env.AUTH_USERNAME = USERNAME;
process.env.AUTH_PASSWORD = PASSWORD;
process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-to-pass';

// Imported after the environment is set, because the auth config reads it once.
const { default: app } = await import('../src/app.js');

const signIn = () =>
  request(app).post('/api/auth/login').send({ username: USERNAME, password: PASSWORD });

const cookieFrom = (response) => response.headers['set-cookie'];

describe('the gate', () => {
  test('turns away an unauthenticated request to a data route', async () => {
    const response = await request(app).get('/api/projects');

    assert.equal(response.status, 401);
    assert.match(response.body.error.message, /sign in/i);
  });

  test('turns away a request carrying a forged cookie', async () => {
    const response = await request(app)
      .get('/api/auth/me')
      .set('Cookie', 'cetizion_session=not.arealtoken');

    assert.equal(response.status, 401);
  });

  test('leaves the health check open for the platform to poll', async () => {
    const response = await request(app).get('/api/health');

    assert.notEqual(response.status, 401);
  });
});

describe('signing in', () => {
  test('rejects the wrong password without setting a cookie', async () => {
    const response = await request(app)
      .post('/api/auth/login')
      .send({ username: USERNAME, password: 'not-the-password' });

    assert.equal(response.status, 401);
    assert.equal(cookieFrom(response), undefined);
  });

  test('rejects the wrong username', async () => {
    const response = await request(app)
      .post('/api/auth/login')
      .send({ username: 'somebody-else', password: PASSWORD });

    assert.equal(response.status, 401);
  });

  test('asks for both fields when one is missing', async () => {
    const response = await request(app).post('/api/auth/login').send({ username: USERNAME });

    assert.equal(response.status, 422);
    assert.ok(response.body.error.fields.password);
  });

  test('accepts the right credentials and sets an httpOnly cookie', async () => {
    const response = await signIn();

    assert.equal(response.status, 200);
    assert.equal(response.body.data.username, USERNAME);

    const [cookie] = cookieFrom(response);
    assert.match(cookie, /^cetizion_session=/);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Lax/i);
  });
});

describe('a signed-in session', () => {
  let cookie;

  before(async () => {
    cookie = cookieFrom(await signIn());
  });

  test('reports who is signed in', async () => {
    const response = await request(app).get('/api/auth/me').set('Cookie', cookie);

    assert.equal(response.status, 200);
    assert.equal(response.body.data.username, USERNAME);
  });

  test('reaches a data route that was closed a moment ago', async () => {
    const response = await request(app).get('/api/lookups').set('Cookie', cookie);

    // Past the gate. Whatever happens next is the database's business.
    assert.notEqual(response.status, 401);
  });

  test('is cleared by signing out', async () => {
    const response = await request(app).post('/api/auth/logout').set('Cookie', cookie);

    assert.equal(response.status, 204);
    assert.match(cookieFrom(response)[0], /cetizion_session=;/);
  });
});
