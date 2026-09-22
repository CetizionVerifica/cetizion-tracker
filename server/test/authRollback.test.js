import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test, { after, before, describe } from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

/**
 * Flipping AUTH_MODE, and flipping it back (#18 Phase 1B-C1).
 *
 * The claim this file exists to check is the one a business depends on: if
 * the cutover goes wrong, changing one variable and restarting puts the old
 * lock back. Believing that is not the same as having seen it.
 *
 * The mode is read once, when auth/config.js is imported, so a single
 * process cannot be both. Each step below therefore boots the API in a
 * child process against the same database — which is what a restart is —
 * and cookies are carried across by hand, exactly as a browser would.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

const SHARED_USER = 'shared-admin';
const SHARED_PASSWORD = 'the-shared-password-in-env';
const ADMIN_EMAIL = 'alice@example.com';
const ADMIN_PASSWORD = 'alice-database-password';
const SECRET = 'a-secret-that-is-at-least-thirty-two-chars-long';

describe('switching modes and switching back', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let dbUrl;
  let db;

  before(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    const name = `rollback_suite_${process.pid}_${Date.now()}`;
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();

    const u = new URL(ADMIN_URL);
    u.pathname = `/${name}`;
    dbUrl = u.toString();

    const dbDir = join(SERVER_DIR, 'db');
    db = new pg.Client({ connectionString: dbUrl });
    await db.connect();
    await db.query(readFileSync(join(dbDir, 'schema.sql'), 'utf8'));
    await db.query(readFileSync(join(dbDir, 'views.sql'), 'utf8'));

    // The admin an operator would have created in Settings -> Users while
    // still on the shared password.
    const { createUser } = await import('../src/lib/users.js');
    await createUser(
      { name: 'Alice', email: ADMIN_EMAIL, password: ADMIN_PASSWORD, role: 'admin' },
      db
    );
  });

  after(async () => {
    await db?.end();
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${new URL(dbUrl).pathname.slice(1)} WITH (FORCE)`);
    await admin.end();
  });

  /**
   * Boot the API in `mode` and run `body` against it. A restart, in other
   * words — same database, same session secret, new process.
   */
  function inMode(mode, body) {
    const script = `
      const request = (await import('supertest')).default;
      const { default: app } = await import('./src/app.js');
      const { pool } = await import('./src/db.js');
      const out = {};
      ${body}
      await pool.end();
      console.log('@@' + JSON.stringify(out));
    `;
    const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: SERVER_DIR,
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_URL: dbUrl,
        AUTH_MODE: mode,
        AUTH_USERNAME: SHARED_USER,
        AUTH_PASSWORD: SHARED_PASSWORD,
        SESSION_SECRET: SECRET,
      },
    });
    const line = stdout.split('\n').find((l) => l.startsWith('@@'));
    assert.ok(line, `the child produced no result:\n${stdout}`);
    return JSON.parse(line.slice(2));
  }

  // ------------------------------------------------- shared -> database

  test('a session from shared mode does not survive the switch to database', () => {
    const before = inMode('shared', `
      const login = await request(app).post('/api/auth/login')
        .send({ username: ${JSON.stringify(SHARED_USER)}, password: ${JSON.stringify(SHARED_PASSWORD)} });
      out.login = login.status;
      out.cookie = login.headers['set-cookie'];
      out.me = (await request(app).get('/api/auth/me').set('Cookie', out.cookie)).status;
    `);
    assert.equal(before.login, 200, 'the shared password works before the switch');
    assert.equal(before.me, 200);

    // Same database, same secret, AUTH_MODE=database. A restart.
    const after = inMode('database', `
      const cookie = ${JSON.stringify(before.cookie)};
      out.me = (await request(app).get('/api/auth/me').set('Cookie', cookie)).status;
      out.projects = (await request(app).get('/api/projects').set('Cookie', cookie)).status;
      out.sharedPassword = (await request(app).post('/api/auth/login')
        .send({ username: ${JSON.stringify(SHARED_USER)}, password: ${JSON.stringify(SHARED_PASSWORD)} })).status;
      const asEmail = await request(app).post('/api/auth/login')
        .send({ email: ${JSON.stringify(SHARED_USER)}, password: ${JSON.stringify(SHARED_PASSWORD)} });
      out.sharedAsEmail = asEmail.status;
      const real = await request(app).post('/api/auth/login')
        .send({ email: ${JSON.stringify(ADMIN_EMAIL)}, password: ${JSON.stringify(ADMIN_PASSWORD)} });
      out.databaseLogin = real.status;
      out.databaseRole = real.body.data?.role;
    `);

    assert.equal(after.me, 401, 'the old cookie is no longer anybody');
    assert.equal(after.projects, 401);
    assert.equal(after.sharedPassword, 422, 'username is not a field database mode knows');
    assert.equal(after.sharedAsEmail, 401, 'and the shared password is not a fallback');
    assert.equal(after.databaseLogin, 200, 'the real account is the way in now');
    assert.equal(after.databaseRole, 'admin');
  });

  // ------------------------------------------------- database -> shared

  test('a session from database mode does not survive the rollback to shared', () => {
    const before = inMode('database', `
      const login = await request(app).post('/api/auth/login')
        .send({ email: ${JSON.stringify(ADMIN_EMAIL)}, password: ${JSON.stringify(ADMIN_PASSWORD)} });
      out.login = login.status;
      out.cookie = login.headers['set-cookie'];
      out.me = (await request(app).get('/api/auth/me').set('Cookie', out.cookie)).status;
    `);
    assert.equal(before.login, 200);
    assert.equal(before.me, 200);

    // The rollback: one variable back, restart. Nothing in the database
    // is touched — which is the point, because a rollback that needed a
    // migration would not be a rollback.
    const after = inMode('shared', `
      const cookie = ${JSON.stringify(before.cookie)};
      out.me = (await request(app).get('/api/auth/me').set('Cookie', cookie)).status;
      out.projects = (await request(app).get('/api/projects').set('Cookie', cookie)).status;
      out.databaseCredentials = (await request(app).post('/api/auth/login')
        .send({ username: ${JSON.stringify(ADMIN_EMAIL)}, password: ${JSON.stringify(ADMIN_PASSWORD)} })).status;
      const shared = await request(app).post('/api/auth/login')
        .send({ username: ${JSON.stringify(SHARED_USER)}, password: ${JSON.stringify(SHARED_PASSWORD)} });
      out.sharedLogin = shared.status;
      out.sharedMe = (await request(app).get('/api/auth/me')
        .set('Cookie', shared.headers['set-cookie'])).body.data;
    `);

    assert.equal(after.me, 401, 'the database cookie is no longer anybody');
    assert.equal(after.projects, 401);
    assert.equal(after.databaseCredentials, 401, 'a real account is not a second way in here');
    assert.equal(after.sharedLogin, 200, 'THE ROLLBACK: the old credentials work again');
    assert.deepEqual(Object.keys(after.sharedMe).sort(), ['expires_at', 'username']);
    assert.equal(after.sharedMe.username, SHARED_USER);
  });

  test('the rollback needs no change to the database at all', async () => {
    const before = (await db.query('SELECT * FROM users ORDER BY id')).rows;

    inMode('database', `out.ok = (await request(app).get('/api/health')).status;`);
    inMode('shared', `out.ok = (await request(app).get('/api/health')).status;`);

    const after = (await db.query('SELECT * FROM users ORDER BY id')).rows;
    assert.deepEqual(after, before, 'switching either way wrote nothing');
  });

  // ------------------------------------------------- what the mode says

  test('each mode announces itself where a deploy can see it', () => {
    for (const mode of ['shared', 'database']) {
      const result = inMode(mode, `
        const health = await request(app).get('/api/health');
        out.authMode = health.body.auth_mode;
        out.status = health.body.status;
        out.config = (await request(app).get('/api/auth/config')).body.data;
      `);

      assert.equal(result.status, 'ok', mode);
      assert.equal(result.authMode, mode, '/api/health reports the mode');
      assert.deepEqual(result.config, { mode }, '/api/auth/config agrees');
    }
  });

  test('neither public endpoint gives anything else away', () => {
    const result = inMode('database', `
      out.health = (await request(app).get('/api/health')).body;
      out.config = (await request(app).get('/api/auth/config')).body;
    `);

    const text = JSON.stringify(result);
    assert.ok(!text.includes(SHARED_USER), 'not the shared username');
    assert.ok(!text.includes(SHARED_PASSWORD), 'not the shared password');
    assert.ok(!text.includes(ADMIN_EMAIL), 'not an admin address');
    assert.ok(!text.includes(SECRET), 'not the session secret');
    assert.ok(!/scrypt|password_hash/.test(text));
    // environment says production or staging (#35): the STAGING band reads it
    // before anyone signs in, and it names no account or secret.
    assert.deepEqual(Object.keys(result.health).sort(), ['auth_mode', 'environment', 'started_at', 'status', 'time']);
  });

  // --------------------------------------------- database mode is strict

  test('database mode will not start without an active admin, and will not fall back', async () => {
    await db.query(`UPDATE users SET active = false WHERE role = 'admin'`);
    try {
      // start.js is the real production entry point, readiness gate and all.
      assert.throws(
        () =>
          execFileSync(process.execPath, ['--input-type=module', '-e', `
            const t = setTimeout(() => { console.log('LISTENING'); process.exit(0); }, 4000);
            await import('./src/start.js');
          `], {
            cwd: SERVER_DIR, encoding: 'utf8', timeout: 20_000,
            env: {
              ...process.env, NODE_ENV: 'production', DATABASE_URL: dbUrl, AUTH_MODE: 'database',
              AUTH_USERNAME: SHARED_USER, AUTH_PASSWORD: SHARED_PASSWORD,
              SESSION_SECRET: SECRET, COOKIE_SECURE: 'false',
            },
          }),
        (err) => {
          const output = `${err.stdout ?? ''}${err.stderr ?? ''}`;
          assert.match(output, /no active admin/);
          assert.ok(!output.includes('LISTENING'), 'it must not have started serving');
          // The temptation this guards against: carrying on in shared mode
          // because the shared password would still work.
          assert.ok(!/mode: shared/.test(output), 'and it did not quietly fall back');
          return true;
        }
      );
    } finally {
      await db.query(`UPDATE users SET active = true WHERE role = 'admin'`);
    }
  });
});
