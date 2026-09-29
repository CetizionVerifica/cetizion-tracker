import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * The Unassigned queue, over HTTP (#18 §2 and §7).
 *
 * Phase 2C made an unowned record admin-only, which is the safe reading of
 * "we do not know whose this is" — and which means the people who actually
 * sold those records cannot see them until somebody assigns them. The
 * issue names that as the rollout risk. These endpoints are the worklist
 * that clears it, so what they must never do is leak: they name records and
 * they name people, and both are admin-only at the router.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const PASSWORD = 'a-good-long-test-password';
const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
const ENTITIES = ['enquiries', 'quotations', 'projects'];

describe('the unassigned queue', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let dbUrl;
  let db;
  let app;
  let pool;
  let createUser;
  let admin;
  let sales;

  before(async () => {
    const root = new pg.Client({ connectionString: ADMIN_URL });
    await root.connect();
    const name = `unassigned_${process.pid}_${Date.now()}`;
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
    process.env.AUTH_MODE = 'database';
    process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-to-pass';
    process.env.EMAIL_MODE = 'log';

    ({ default: app } = await import('../src/app.js'));
    ({ pool } = await import('../src/db.js'));
    ({ createUser } = await import('../src/lib/users.js'));
  });

  after(async () => {
    await pool?.end();
    await db?.end();
    const root = new pg.Client({ connectionString: ADMIN_URL });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${new URL(dbUrl).pathname.slice(1)} WITH (FORCE)`);
    await root.end();
  });

  const signIn = async (email) => {
    const res = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.headers['set-cookie'];
  };

  let seq = 0;
  async function unowned(table, { salesPerson = null, email = null, date = '2026-01-15' } = {}) {
    seq += 1;
    const n = String(seq).padStart(4, '0');
    if (table === 'enquiries') {
      const { rows } = await db.query(
        `INSERT INTO enquiries (enquiry_no, client_name, sales_person, sales_person_email, enquiry_date)
         VALUES ($1, 'Old Client', $2, $3, $4) RETURNING id`,
        [`CTZ/ENQ/2026/${n}`, salesPerson, email, date]
      );
      return rows[0].id;
    }
    if (table === 'quotations') {
      const { rows } = await db.query(
        `INSERT INTO quotations (quotation_no, client_name, sales_person, sales_person_email, quotation_date)
         VALUES ($1, 'Old Client', $2, $3, $4) RETURNING id`,
        [`CTZ/QT/2026/${n}`, salesPerson, email, date]
      );
      return rows[0].id;
    }
    const { rows } = await db.query(
      `INSERT INTO projects (project_id, client_name, sales_person, planned_start_date)
       VALUES ($1, 'Old Client', $2, $3) RETURNING id`,
      [`PRJ-2026-${n}`, salesPerson, date]
    );
    return rows[0].id;
  }

  async function setUp() {
    for (const t of ['ownership_history', 'activity_log', ...ENTITIES, 'users']) {
      await db.query(`DELETE FROM ${t}`);
    }
    const mk = async (over) => createUser({ password: PASSWORD, ...over }, db);
    const a = await mk({ name: 'Alice Admin', email: 'alice@example.com', role: 'admin' });
    const s = await mk({ name: 'Sam Sales', email: 'sam@example.com', role: 'sales' });
    admin = { user: a, cookie: await signIn(a.email) };
    sales = { user: s, cookie: await signIn(s.email) };
  }

  // ------------------------------------------------------- authorization

  const ADMIN_ONLY = [
    ['get', '/api/ownership/unassigned'],
    ['get', '/api/ownership/unassigned?entity=quotations'],
    ['get', '/api/ownership/unassigned/quotations/suggestions?ids=1'],
    ['get', '/api/ownership/historical-salespeople'],
    ['post', '/api/ownership/historical-salespeople?dry_run=true'],
  ];

  test('every queue endpoint refuses a sales user', async () => {
    await setUp();
    await unowned('quotations', { salesPerson: 'Ramesh' });

    for (const [method, path] of ADMIN_ONLY) {
      const res = await request(app)[method](path).set('Cookie', sales.cookie);
      assert.equal(res.status, 403, `${method.toUpperCase()} ${path} must be admin-only`);
    }
  });

  test('every queue endpoint refuses an anonymous caller', async () => {
    await setUp();
    for (const [method, path] of ADMIN_ONLY) {
      const res = await request(app)[method](path);
      assert.equal(res.status, 401, `${method.toUpperCase()} ${path} must require a session`);
    }
  });

  // -------------------------------------------------------------- listing

  test('counts what is waiting, per table', async () => {
    await setUp();
    await unowned('quotations', { salesPerson: 'Ramesh' });
    await unowned('quotations', { salesPerson: null });
    await unowned('enquiries', { salesPerson: 'Vishnu' });

    const res = await request(app).get('/api/ownership/unassigned').set('Cookie', admin.cookie);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data.counts,
      { enquiries: 1, quotations: 2, projects: 0, total: 3 });
  });

  test('an owned record leaves the queue', async () => {
    await setUp();
    const id = await unowned('quotations', { salesPerson: 'Ramesh' });

    const assign = await request(app)
      .patch(`/api/quotations/${id}/owner`)
      .set('Cookie', admin.cookie)
      .send({ expected_owner_user_id: null, new_owner_user_id: sales.user.id, reason: 'clearing the backlog' });
    assert.equal(assign.status, 200, JSON.stringify(assign.body));

    const res = await request(app).get('/api/ownership/unassigned').set('Cookie', admin.cookie);
    assert.equal(res.body.data.counts.total, 0, 'assigning is what empties the queue');
  });

  test('lists a page oldest first, so the history reporting needs clears first', async () => {
    await setUp();
    await unowned('quotations', { salesPerson: 'Newer', date: '2026-06-01' });
    await unowned('quotations', { salesPerson: 'Older', date: '2024-02-01' });

    const res = await request(app)
      .get('/api/ownership/unassigned?entity=quotations')
      .set('Cookie', admin.cookie);

    assert.equal(res.status, 200);
    assert.equal(res.body.data.total, 2);
    assert.deepEqual(res.body.data.records.map((r) => r.sales_person), ['Older', 'Newer']);
    assert.equal(res.body.data.has_more, false);
  });

  test('pages, and a page past the end still reports the real total', async () => {
    await setUp();
    for (let i = 0; i < 3; i += 1) await unowned('quotations', { salesPerson: `P${i}` });

    const first = await request(app)
      .get('/api/ownership/unassigned?entity=quotations&limit=2')
      .set('Cookie', admin.cookie);
    assert.equal(first.body.data.records.length, 2);
    assert.equal(first.body.data.total, 3);
    assert.equal(first.body.data.has_more, true);

    // The bug #142 is fixing in the MCP lists: COUNT(*) OVER () lives on
    // the rows, so an empty page has nothing to read the total from.
    const past = await request(app)
      .get('/api/ownership/unassigned?entity=quotations&limit=2&offset=99')
      .set('Cookie', admin.cookie);
    assert.equal(past.body.data.records.length, 0);
    assert.equal(past.body.data.total, 3, 'an empty page still knows how many are waiting');
    assert.equal(past.body.data.has_more, false);
  });

  test('refuses a table that ownership does not scope', async () => {
    await setUp();
    const res = await request(app)
      .get('/api/ownership/unassigned?entity=companies')
      .set('Cookie', admin.cookie);
    assert.equal(res.status, 422);
  });

  // ---------------------------------------------------------- suggestions

  test('suggests the owner the record names, by email then by name', async () => {
    await setUp();
    const byEmail = await unowned('quotations', { salesPerson: 'Whoever', email: 'sam@example.com' });
    const byName = await unowned('quotations', { salesPerson: 'Sam Sales' });
    const nobody = await unowned('quotations', { salesPerson: null });

    const res = await request(app)
      .get(`/api/ownership/unassigned/quotations/suggestions?ids=${byEmail},${byName},${nobody}`)
      .set('Cookie', admin.cookie);

    assert.equal(res.status, 200);
    const got = Object.fromEntries(res.body.data.map((r) => [r.id, r]));
    assert.equal(got[byEmail].suggested_user_id, sales.user.id);
    assert.equal(got[byEmail].basis, 'email');
    assert.equal(got[byName].suggested_user_id, sales.user.id);
    assert.equal(got[byName].basis, 'name');
    assert.equal(got[nobody].suggested_user_id, null, 'a record naming nobody suggests nobody');
  });

  test('suggests nobody when two accounts share the name, and says it is ambiguous', async () => {
    await setUp();
    await createUser({ name: 'Sam Sales', email: 'sam2@example.com', password: PASSWORD, role: 'sales' }, db);
    const id = await unowned('quotations', { salesPerson: 'sam sales' });

    const res = await request(app)
      .get(`/api/ownership/unassigned/quotations/suggestions?ids=${id}`)
      .set('Cookie', admin.cookie);

    assert.equal(res.body.data[0].suggested_user_id, null);
    assert.equal(res.body.data[0].ambiguous, true);
  });

  test('a suggestion is never an assignment', async () => {
    await setUp();
    const id = await unowned('quotations', { salesPerson: 'Sam Sales' });

    await request(app)
      .get(`/api/ownership/unassigned/quotations/suggestions?ids=${id}`)
      .set('Cookie', admin.cookie);

    const { rows } = await db.query('SELECT owner_user_id FROM quotations WHERE id = $1', [id]);
    assert.equal(rows[0].owner_user_id, null, 'reading a suggestion must not write one');
    const { rows: hist } = await db.query('SELECT COUNT(*)::int AS n FROM ownership_history');
    assert.equal(hist[0].n, 0);
  });

  // ------------------------------------------------ creating the people

  test('a dry run names who would be created and writes nobody', async () => {
    await setUp();
    await unowned('quotations', { salesPerson: 'Ramesh' });

    const res = await request(app)
      .post('/api/ownership/historical-salespeople?dry_run=true')
      .set('Cookie', admin.cookie);

    assert.equal(res.status, 200);
    assert.equal(res.body.data.dryRun, true);
    assert.deepEqual(res.body.data.created.map((p) => p.displayName), ['Ramesh']);

    const { rows } = await db.query("SELECT COUNT(*)::int AS n FROM users WHERE name = 'Ramesh'");
    assert.equal(rows[0].n, 0);
  });

  test('creating them, then assigning, empties the part of the queue the data settles', async () => {
    await setUp();
    await unowned('quotations', { salesPerson: 'Ramesh' });
    await unowned('quotations', { salesPerson: null });

    const created = await request(app)
      .post('/api/ownership/historical-salespeople')
      .set('Cookie', admin.cookie);
    assert.equal(created.status, 201);

    const { rows } = await db.query("SELECT active, role, password_hash FROM users WHERE name = 'Ramesh'");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].active, false, 'an invented identity cannot sign in');
    assert.equal(rows[0].password_hash, null);

    const { backfillOwnership } = await import('../src/lib/ownership.js');
    await backfillOwnership(pool);

    const after = await request(app).get('/api/ownership/unassigned').set('Cookie', admin.cookie);
    assert.equal(after.body.data.counts.total, 1, 'the record naming nobody is still for a person to settle');
  });
});
