import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * Managing accounts from the super admin portal: list, create, edit,
 * password and switch off, against a database of its own. Deleting is in
 * superAdminDeletion.test.js.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const PASSWORD = 'a-good-long-test-password';
const EMAIL = 'super@example.com';
const SUPER_PASSWORD = 'a-good-long-super-password';

describe('the super admin user routes', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let dbUrl;
  let db;
  let app;
  let pool;
  let cookie;

  before(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    const name = `superadmin_suite_${process.pid}_${Date.now()}`;
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
    process.env.SUPER_ADMIN_EMAIL = EMAIL;
    process.env.SUPER_ADMIN_PASSWORD = SUPER_PASSWORD;
    // Never the developer's real document storage from a test.
    process.env.CLOUDINARY_CLOUD_NAME = '';

    ({ default: app } = await import('../src/app.js'));
    ({ pool } = await import('../src/db.js'));

    const res = await request(app).post('/api/super-admin/login').send({ email: EMAIL, password: SUPER_PASSWORD });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    cookie = res.headers['set-cookie'];
  });

  after(async () => {
    await pool?.end();
    await db?.end();
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${new URL(dbUrl).pathname.slice(1)} WITH (FORCE)`);
    await admin.end();
  });

  const clean = () => db.query('DELETE FROM activity_log; DELETE FROM sales_targets; DELETE FROM users');
  const list = () => request(app).get('/api/super-admin/users').set('Cookie', cookie);
  const create = (body) => request(app).post('/api/super-admin/users').set('Cookie', cookie).send(body);
  const edit = (id, body) => request(app).patch(`/api/super-admin/users/${id}`).set('Cookie', cookie).send(body);
    const lastActivity = async () =>
    (await db.query('SELECT * FROM activity_log ORDER BY id DESC LIMIT 1')).rows[0];

  const anAdmin = { name: 'Alice', email: 'alice@example.com', role: 'admin', password: PASSWORD };
  const aSalesUser = { name: 'Sam', email: 'sam@example.com', role: 'sales', password: PASSWORD };

  test('creates users with their profile details, and lists them without hashes', async () => {
    await clean();
    assert.equal((await create(anAdmin)).status, 201);
    const res = await create({ ...aSalesUser, phone: '+91 98450 00000', time_zone: 'Asia/Kolkata' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.phone, '+91 98450 00000');
    assert.equal(res.body.data.time_zone, 'Asia/Kolkata');

    const all = await list();
    assert.equal(all.status, 200);
    assert.equal(all.body.data.length, 2);
    assert.deepEqual(all.body.roles, ['admin', 'sales', 'hr']);
    for (const user of all.body.data) assert.equal(user.password_hash, undefined);

    const logged = await lastActivity();
    assert.equal(logged.action, 'user.created');
    assert.equal(logged.actor_type, 'super_admin');
    // The profile details are part of the one recorded creation.
    assert.equal(logged.metadata.phone, '+91 98450 00000');
    assert.equal(logged.metadata.time_zone, 'Asia/Kolkata');
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM activity_log WHERE action = 'user.updated'`)).rows[0].n, 0, 'not a second, separate edit');
  });

  test('refuses a short password and a duplicate email', async () => {
    await clean();
    await create(anAdmin);
    assert.equal((await create({ ...aSalesUser, password: '123456' })).status, 422);
    const dup = await create({ ...aSalesUser, email: 'ALICE@example.com' });
    assert.equal(dup.status, 422);
    assert.ok(dup.body.error.fields.email);
  });

  test('edits a user, and switching one off ends their sign-in', async () => {
    await clean();
    await create(anAdmin);
    const { body: { data: sam } } = await create(aSalesUser);

    const res = await edit(sam.id, { name: 'Samuel', role: 'hr', phone: '12345' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.name, 'Samuel');
    assert.equal(res.body.data.role, 'hr');
    assert.equal(res.body.data.phone, '12345');

    const off = await edit(sam.id, { active: false });
    assert.equal(off.status, 200);
    assert.equal(off.body.data.active, false);
    assert.equal((await lastActivity()).action, 'user.deactivated');

    const login = await request(app).post('/api/auth/login').send({ email: sam.email, password: PASSWORD });
    assert.equal(login.status, 401, 'a switched-off account cannot sign in');
  });

  test('a new password works for the main app sign-in', async () => {
    await clean();
    await create(anAdmin);
    const { body: { data: sam } } = await create(aSalesUser);
    const fresh = 'another-good-long-password';
    const res = await request(app).post(`/api/super-admin/users/${sam.id}/password`).set('Cookie', cookie).send({ password: fresh });
    assert.equal(res.status, 200);
    const login = await request(app).post('/api/auth/login').send({ email: sam.email, password: fresh });
    assert.equal(login.status, 200);
  });
});
