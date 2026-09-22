import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * The activity log while the tracker is still on the shared password
 * (#18 Phase 1.5).
 *
 * The audit trail has to work before the cutover, not after it. The shared
 * admin is the person who creates the first real accounts, and those are
 * exactly the acts somebody will later want a record of — so a log that
 * only starts working in database mode would have nothing to say about the
 * most consequential hour of the transition.
 *
 * What it must not do is pretend the shared admin is a database user. There
 * is no users row behind AUTH_USERNAME, and putting an id there would
 * either need a fake account or would name whoever holds that id.
 *
 * Its own file because AUTH_MODE is read once, when the app is imported.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const PASSWORD = 'a-good-long-test-password';

describe('the activity log in shared mode', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let dbUrl;
  let db;
  let app;
  let pool;
  let cookie;

  before(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    const name = `activityshared_suite_${process.pid}_${Date.now()}`;
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
    process.env.EMAIL_MODE = 'log';

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

  const clean = async () => {
    await db.query('DELETE FROM activity_log');
    await db.query('DELETE FROM users');
    await db.query('DELETE FROM companies');
  };
  const logged = async () => (await db.query('SELECT * FROM activity_log ORDER BY id')).rows;

  test('an account the shared admin creates is recorded, with no account behind the actor', async () => {
    await clean();

    const res = await request(app).post('/api/users').set('Cookie', cookie)
      .send({ name: 'Nina', email: 'nina@example.com', password: PASSWORD, role: 'admin' });

    assert.equal(res.status, 201, JSON.stringify(res.body));
    const rows = await logged();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, 'user.created');
    assert.equal(rows[0].actor_user_id, null, 'no users row stands in for the shared password');
    assert.equal(rows[0].actor_type, 'shared_admin');
    assert.equal(rows[0].entity_id, String(res.body.data.id));
    assert.equal(rows[0].metadata.actor_name, 'shared-admin', 'the name is a label, not an identity');

    assert.equal(
      (await db.query('SELECT count(*)::int AS n FROM users')).rows[0].n, 1,
      'only the account that was asked for — the shared admin is not one of them'
    );
  });

  test('the shared admin’s other audited acts are recorded the same way', async () => {
    await clean();
    const nina = await request(app).post('/api/users').set('Cookie', cookie)
      .send({ name: 'Nina', email: 'nina@example.com', password: PASSWORD, role: 'admin' });
    const gone = (await db.query(`INSERT INTO companies (name) VALUES ('Acme Limited') RETURNING id`)).rows[0];
    const kept = (await db.query(`INSERT INTO companies (name) VALUES ('Acme Ltd') RETURNING id`)).rows[0];

    await request(app).post(`/api/users/${nina.body.data.id}/password`).set('Cookie', cookie)
      .send({ password: 'another-good-long-password' });
    await request(app).post(`/api/companies/${gone.id}/merge`).set('Cookie', cookie).send({ into: kept.id });
    await request(app).post('/api/emails/test').set('Cookie', cookie).send({ to: 'someone@client.example' });

    const rows = await logged();
    assert.deepEqual(
      rows.map((r) => r.action),
      ['user.created', 'user.password_reset', 'company.merged', 'email.test_sent']
    );
    for (const row of rows) {
      assert.equal(row.actor_user_id, null, `${row.action} names no database account`);
      assert.equal(row.actor_type, 'shared_admin');
      assert.equal(row.metadata.actor_name, 'shared-admin');
    }

    const written = JSON.stringify(rows);
    for (const secret of ['the-shared-password-in-env', 'another-good-long-password', PASSWORD, '$2b$']) {
      assert.ok(!written.includes(secret), `${secret} must not reach the activity log`);
    }
  });

  test('the shared admin may read the log, and reads their own acts back', async () => {
    await clean();
    await request(app).post('/api/users').set('Cookie', cookie)
      .send({ name: 'Nina', email: 'nina@example.com', password: PASSWORD, role: 'admin' });

    const res = await request(app).get('/api/activity').set('Cookie', cookie);

    assert.equal(res.status, 200);
    assert.equal(res.body.data.length, 1);
    assert.equal(res.body.data[0].actor, null, 'there is no account to name');
    assert.equal(res.body.data[0].actor_type, 'shared_admin');
    assert.equal(res.body.data[0].metadata.actor_name, 'shared-admin');
  });

  test('a stranger still gets nothing', async () => {
    assert.equal((await request(app).get('/api/activity')).status, 401);
  });
});
