import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * The sign-in limiter, in database mode (#18 Phase 1B-A).
 *
 * It has always guarded the shared password; the question this file answers
 * is whether moving the guessed field from a username to an email left a
 * way around it. It did not — the limit follows the caller, not the field —
 * and this proves it rather than asserting it.
 *
 * Its own file because tripping the limiter is the point here, and every
 * other suite has to keep clear of it.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const PASSWORD = 'a-good-long-test-password';
const MAX_ATTEMPTS = 10;

describe('the sign-in limiter', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let dbUrl;
  let db;
  let app;
  let pool;

  before(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    const name = `authlimit_suite_${process.pid}_${Date.now()}`;
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
    process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-to-pass';

    ({ default: app } = await import('../src/app.js'));
    ({ pool } = await import('../src/db.js'));

    const { createUser } = await import('../src/lib/users.js');
    await createUser({ name: 'Alice', email: 'alice@example.com', password: PASSWORD, role: 'admin' }, db);
  });

  after(async () => {
    await pool?.end();
    await db?.end();
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${new URL(dbUrl).pathname.slice(1)} WITH (FORCE)`);
    await admin.end();
  });

  const login = (body) => request(app).post('/api/auth/login').send(body);

  test('a run of wrong guesses is cut off, and a different address does not reset it', async () => {
    const statuses = [];

    // Each guess names a different address on purpose: if the limiter were
    // keyed on the account being tried, every one of these would be the
    // first attempt for that key and none would ever be refused.
    for (let i = 0; i < MAX_ATTEMPTS + 2; i += 1) {
      const res = await login({ email: `guess-${i}@example.com`, password: 'not-the-password' });
      statuses.push(res.status);
    }

    assert.deepEqual(
      statuses.slice(0, MAX_ATTEMPTS),
      Array(MAX_ATTEMPTS).fill(401),
      'the first ten are ordinary refusals'
    );
    assert.ok(
      statuses.slice(MAX_ATTEMPTS).every((s) => s === 429),
      `the rest are cut off, got ${statuses.join(',')}`
    );
  });

  test('once cut off, the right password does not get through either', async () => {
    // The limiter is already tripped by the test above, in this same process.
    const res = await login({ email: 'alice@example.com', password: PASSWORD });

    assert.equal(res.status, 429);
    assert.equal(res.headers['set-cookie'], undefined, 'and no session is handed out');
  });
});
