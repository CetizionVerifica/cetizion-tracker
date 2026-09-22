import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * GET /api/search?q= — the one search the ⌘K palette reads.
 *
 * The palette is the replacement for a thirty-item sidebar, so the thing
 * that matters here is that a fragment somebody actually remembers finds
 * the record: half a client's name, a quotation number, a destination.
 * The rest of these guard the edges that would make it useless or unsafe —
 * a one-letter query returning the whole database, a `%` matching
 * everything, a column name that has drifted away from the view.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;

async function applySchema(dbUrl) {
  const { readFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const dbDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  try {
    await client.query(readFileSync(join(dbDir, 'schema.sql'), 'utf8'));
    await client.query(readFileSync(join(dbDir, 'views.sql'), 'utf8'));
  } finally {
    await client.end();
  }
}

async function exec(dbUrl, sql, params = []) {
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  try {
    return (await client.query(sql, params)).rows;
  } finally {
    await client.end();
  }
}

describe('GET /api/search', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let dbUrl;
  let app;
  let pool;
  let cookie;

  const find = async (q) => {
    const res = await request(app).get(`/api/search?q=${encodeURIComponent(q)}`).set('Cookie', cookie);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body;
  };

  before(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    const name = `search_test_${process.pid}_${Date.now()}`;
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();

    const u = new URL(ADMIN_URL);
    u.pathname = `/${name}`;
    dbUrl = u.toString();
    await applySchema(dbUrl);

    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = dbUrl;
    process.env.AUTH_USERNAME = 'tester';
    process.env.AUTH_PASSWORD = 'test-password-long-enough';
    process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-to-pass';

    app = (await import('../src/app.js')).default;
    pool = (await import('../src/db.js')).pool;

    const signIn = await request(app).post('/api/auth/login')
      .send({ username: 'tester', password: 'test-password-long-enough' });
    assert.equal(signIn.status, 200, 'sign-in failed');
    cookie = signIn.headers['set-cookie'];

    await exec(dbUrl, `INSERT INTO companies (name, sector, city) VALUES ('Hindalco Industries', 'Metal Industry', 'Mumbai')`);
    await exec(dbUrl, `INSERT INTO projects (project_id, client_name, primary_service) VALUES ('PRJ-2026-044', 'Hindalco Industries', 'ASI Certification')`);
    await exec(dbUrl, `
      INSERT INTO quotations (quotation_no, client_name, quotation_date, quotation_value, status, service_quoted)
      VALUES ('CTZ/QT/2026/091', 'Hindalco Industries', '2026-04-02', 625000, 'Submitted', 'ASI Certification')`);
    await exec(dbUrl, `
      INSERT INTO travel_logs (travel_id, employee_name, destination, travel_start_date)
      VALUES ('TRV-2026-031', 'R. Bhatt', 'Renukoot', '2026-05-01')`);
  });

  after(async () => {
    await pool.end();
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${new URL(dbUrl).pathname.slice(1)} WITH (FORCE)`);
    await admin.end();
  });

  test('half a client name finds every object that names them', async () => {
    const body = await find('hindal');
    const types = new Set(body.data.map((row) => row.type));
    assert.ok(types.has('company'), 'the company itself');
    assert.ok(types.has('deal'), 'the quotation naming them');
    assert.ok(types.has('project'), 'the project naming them');
  });

  test('a reference number finds exactly its own record', async () => {
    const body = await find('CTZ/QT/2026/091');
    assert.equal(body.data.length, 1, JSON.stringify(body.data));
    const [hit] = body.data;
    assert.equal(hit.type, 'deal');
    assert.equal(hit.title, 'CTZ/QT/2026/091');
    assert.equal(hit.state, 'Submitted', 'the row says what it is waiting on');
    assert.ok(hit.href.includes(encodeURIComponent('CTZ/QT/2026/091')), 'and where it goes, escaped');
  });

  test('a destination finds the trip, which no other object would match', async () => {
    const body = await find('renukoot');
    assert.deepEqual(body.data.map((r) => r.type), ['trip']);
    assert.equal(body.data[0].title, 'TRV-2026-031');
    assert.match(body.data[0].subtitle, /Renukoot/);
  });

  test('one character answers with nothing rather than with everything', async () => {
    // The useful answer to a single keystroke is the verb list above the
    // results, not every record in the database.
    const body = await find('h');
    assert.deepEqual(body.data, []);
  });

  test('a wildcard is a character to search for, not a pattern', async () => {
    // ILIKE would treat a bare % as "match everything" if it reached the
    // pattern unescaped, which turns the palette into a data dump.
    const body = await find('%%');
    assert.deepEqual(body.data, [], JSON.stringify(body.data.slice(0, 3)));
  });

  test('every searchable object still compiles against its view', async () => {
    // A column renamed in a migration and not here would 500 for that one
    // object only, which is invisible until somebody searches for it.
    const body = await find('zzz-nothing-matches-this');
    assert.deepEqual(body.data, []);
  });

  test('signing out closes it, like every other read', async () => {
    const res = await request(app).get('/api/search?q=hindal');
    assert.equal(res.status, 401);
  });
});
