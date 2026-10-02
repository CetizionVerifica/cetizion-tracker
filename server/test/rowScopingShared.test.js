import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * Row-level ownership while the tracker is still on the shared password
 * (#18 Phase 2C).
 *
 * The legacy shared login is one administrator with no users row behind it,
 * so there is no owner id to compare anything against. It therefore sees
 * everything — owned, somebody else's, and unassigned alike. That is not a
 * gap: the whole dual-mode transition rests on the shared admin keeping full
 * access until the cutover is done, and inventing a user id for it would be
 * inventing a person.
 *
 * Its own file because AUTH_MODE is read once, when the app is imported.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
const ENTITIES = ['enquiries', 'quotations', 'projects'];

describe('the shared admin and row ownership', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let dbUrl; let db; let app; let pool; let cookie; let sales;

  before(async () => {
    const root = new pg.Client({ connectionString: ADMIN_URL });
    await root.connect();
    const name = `rowscope_shared_${process.pid}_${Date.now()}`;
    await root.query(`CREATE DATABASE ${name}`);
    await root.end();

    const u = new URL(ADMIN_URL);
    u.pathname = `/${name}`;
    dbUrl = u.toString();

    db = new pg.Client({ connectionString: dbUrl });
    await db.connect();
    await db.query(readFileSync(join(DB_DIR, 'schema.sql'), 'utf8'));
    await db.query(readFileSync(join(DB_DIR, 'views.sql'), 'utf8'));

    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = dbUrl;
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

    // One real salesperson, so there is somebody else's work to be shown.
    sales = (await db.query(
      `INSERT INTO users (name, email, password_hash, role) VALUES ('Sam', 'sam@example.com', 'x', 'sales')
       RETURNING id`)).rows[0].id;
    let n = 0;
    for (const owner of [sales, null]) {
      n += 1;
      const tag = String(n).padStart(3, '0');
      await db.query(`INSERT INTO enquiries (enquiry_no, client_name, owner_user_id) VALUES ($1, $2, $3)`,
        [`CTZ/ENQ/2026/${tag}`, `Client ${n}`, owner]);
      await db.query(
        `INSERT INTO quotations (quotation_no, client_name, quotation_date, quotation_value, currency, owner_user_id)
         VALUES ($1, $2, '2026-05-01', 1000, 'INR', $3)`, [`CTZ/QT/2026/${tag}`, `Client ${n}`, owner]);
      await db.query(`INSERT INTO projects (project_id, client_name, owner_user_id) VALUES ($1, $2, $3)`,
        [`PRJ-2026-${tag}`, `Client ${n}`, owner]);
    }
  });

  after(async () => {
    await pool?.end();
    await db?.end();
    const root = new pg.Client({ connectionString: ADMIN_URL });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${new URL(dbUrl).pathname.slice(1)} WITH (FORCE)`);
    await root.end();
  });

  const get = (path) => request(app).get(path).set('Cookie', cookie);

  test('it lists everybody’s records and the unassigned ones', async () => {
    for (const t of ENTITIES) {
      const res = await get(`/api/${t}`);
      assert.equal(res.status, 200, t);
      assert.equal(res.body.total, 2, `${t}: one owned by Sam, one owned by nobody`);
    }
  });

  test('it opens a record owned by somebody else, and an unassigned one', async () => {
    for (const t of ENTITIES) {
      const { rows: all } = await db.query(`SELECT id FROM ${t} ORDER BY id`);
      for (const row of all) assert.equal((await get(`/api/${t}/${row.id}`)).status, 200, t);
    }
  });

  test('its dropdowns, exports and reports are unrestricted', async () => {
    const lookups = await get('/api/lookups');
    assert.equal(lookups.status, 200);
    const offered = JSON.stringify(lookups.body);
    assert.ok(offered.includes('PRJ-2026-001') && offered.includes('PRJ-2026-002'), 'every project is offered');

    const csv = await get('/api/export/quotations.csv');
    assert.equal(csv.status, 200);
    assert.ok(csv.text.includes('Client 1') && csv.text.includes('Client 2'), 'the export holds both');

    const report = await get('/api/reports/sales');
    assert.equal(report.status, 200);
    assert.ok(JSON.stringify(report.body).includes('Client 2'), 'the report counts the unassigned one');
  });

  test('it may read a document that belongs to nothing yet', async () => {
    const { rows: [doc] } = await db.query(
      `INSERT INTO documents (storage_key, file_name, content_type, size_bytes)
       VALUES ('shared-orphan', 'quote.pdf', 'application/pdf', 100) RETURNING id`);

    // Unattached means ownership is unknown, which is admin-only — and the
    // shared login is an admin. Storage is not configured under test, so a
    // permitted read fails at the fetch; what is asserted is that it is not
    // refused by the ownership check.
    assert.notEqual((await get(`/api/documents/${doc.id}`)).status, 404);
  });

  test('a record it creates is unowned — no user id is invented for it', async () => {
    const res = await request(app).post('/api/enquiries').set('Cookie', cookie)
      .send({ client_name: 'Shared Co', service: 'ASI audit' });

    assert.equal(res.status, 201, JSON.stringify(res.body));
    const [row] = (await db.query('SELECT owner_user_id FROM enquiries WHERE id = $1', [res.body.data.id])).rows;
    assert.equal(row.owner_user_id, null);
    assert.equal(
      (await db.query('SELECT count(*)::int n FROM users')).rows[0].n, 1,
      'and no account was created to stand in for the shared login'
    );
  });
});
