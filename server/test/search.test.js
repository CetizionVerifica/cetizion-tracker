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

  const find = async (q, extra = '') => {
    const res = await request(app).get(`/api/search?q=${encodeURIComponent(q)}${extra}`).set('Cookie', cookie);
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
    // Two POs where one number is the start of the other (#75): the exact
    // one must come first however the list would otherwise sort them.
    await exec(dbUrl, `
      INSERT INTO purchase_orders (po_number, project_id, po_value, currency, po_date)
      VALUES ('HIN-PO-120', 'PRJ-2026-044', 10000, 'INR', '2026-06-01'),
             ('HIN-PO-12',  'PRJ-2026-044', 20000, 'INR', '2026-05-01')`);
    // Twenty-five quotations for one client, to see the limit bite.
    await exec(dbUrl, `
      INSERT INTO quotations (quotation_no, client_name, quotation_date, status)
      SELECT 'BULK/' || lpad(n::text, 3, '0'), 'Bulk Buyer Pvt Ltd', DATE '2026-01-01' + n, 'Submitted'
        FROM generate_series(1, 25) AS n`);
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

  test('an exact reference comes first, above records it is only the start of', async () => {
    const body = await find('HIN-PO-12');
    const orders = body.data.filter((row) => row.type === 'order').map((row) => row.title);
    assert.deepEqual(orders, ['HIN-PO-12', 'HIN-PO-120']);
    assert.equal(body.data[0].title, 'HIN-PO-12', 'first across every type, not just among orders');
    assert.equal(body.data[0].href, `/purchase-orders/${encodeURIComponent('HIN-PO-12')}`);
  });

  test('case and extra spaces do not matter', async () => {
    const shouted = await find('  HINDALCO    industries ');
    const company = shouted.data.find((row) => row.type === 'company');
    assert.equal(company?.title, 'Hindalco Industries');
    // A company's name is its reference, so the whole name typed is exact.
    assert.equal(company.rank, 0);

    const lower = await find('ctz/qt/2026/091');
    assert.deepEqual(lower.data.map((row) => row.title), ['CTZ/QT/2026/091']);
  });

  test('an empty q and a one-character q both answer 200 with nothing', async () => {
    assert.deepEqual((await find('')).data, []);
    assert.deepEqual((await find('a')).data, []);
    assert.deepEqual((await find('   a  ')).data, [], 'spaces do not make one character two');
  });

  test('limit is per type: five by default, as asked, and never above twenty', async () => {
    const deals = (body) => body.data.filter((row) => row.type === 'deal');

    const byDefault = await find('bulk buyer');
    assert.equal(deals(byDefault).length, 5);
    assert.equal(byDefault.meta.limit, 5);
    assert.equal(byDefault.meta.truncated, true, 'there were more than it showed');

    assert.equal(deals(await find('bulk buyer', '&limit=3')).length, 3);

    const capped = await find('bulk buyer', '&limit=500');
    assert.equal(capped.meta.limit, 20);
    assert.equal(deals(capped).length, 20);

    const all = await find('bulk buyer', '&limit=nonsense');
    assert.equal(all.meta.limit, 5, 'a limit that is not a number is the default');
  });

  test('signing out closes it, like every other read', async () => {
    const res = await request(app).get('/api/search?q=hindal');
    assert.equal(res.status, 401);
  });
});

