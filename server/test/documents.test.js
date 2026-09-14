import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import request from 'supertest';

/**
 * The document endpoints' guards. Every case here is turned away before
 * anything reaches Cloudinary or Postgres, so this suite needs neither.
 */

const USERNAME = 'tester';
const PASSWORD = 'a-good-long-test-password';

process.env.NODE_ENV = 'test';
process.env.AUTH_USERNAME = USERNAME;
process.env.AUTH_PASSWORD = PASSWORD;
process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-to-pass';
// A 1 KB ceiling, so the size limit can be tried with a tiny body.
process.env.DOCUMENT_MAX_MB = String(1 / 1024);

// Imported after the environment is set, because config reads it once.
const { default: app } = await import('../src/app.js');

const signIn = await request(app).post('/api/auth/login').send({ username: USERNAME, password: PASSWORD });
const cookie = signIn.headers['set-cookie'];

const upload = (body, path = '/api/documents?for=quotations') =>
  request(app)
    .post(path)
    .set('Cookie', cookie)
    .set('Content-Type', 'application/octet-stream')
    .set('X-File-Name', 'quotation.pdf')
    .send(body);

describe('uploading a document', () => {
  test('needs a signed-in session', async () => {
    const response = await request(app)
      .post('/api/documents?for=quotations')
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('x'));

    assert.equal(response.status, 401);
  });

  test('refuses an empty upload', async () => {
    const response = await upload(Buffer.alloc(0));

    assert.equal(response.status, 422);
    assert.match(response.body.error.message, /choose a file/i);
  });

  test('refuses a record type that takes no documents', async () => {
    const response = await upload(Buffer.from('x'), '/api/documents?for=projects');

    assert.equal(response.status, 422);
  });

  test('refuses a file over the size limit with a readable message', async () => {
    const response = await upload(Buffer.alloc(2048, 1));

    assert.equal(response.status, 413);
    assert.match(response.body.error.message, /larger than/);
  });
});

describe('viewing a document', () => {
  test('treats an id that is not a number as not found', async () => {
    const response = await request(app).get('/api/documents/abc').set('Cookie', cookie);

    assert.equal(response.status, 404);
  });
});
