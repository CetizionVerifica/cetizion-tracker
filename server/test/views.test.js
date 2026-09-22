import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * Saved views — the pinned sidebar, and every report.
 *
 * Two things decide whether this is safe. A view belongs to somebody or to
 * everybody, and only an admin may make one everybody's — otherwise any
 * sales user could put an item in the whole company's sidebar. And a
 * view's count must be the count of the list it links to, or the sidebar
 * lies about what is behind it.
 *
 * Runs in database mode, because that is the only mode with two kinds of
 * user to tell apart. Needs a Postgres it may create databases on: set
 * TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const PASSWORD = 'a-good-long-test-password';

describe('saved views', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let dbUrl;
  let app;
  let pool;
  let admin;
  let sales;

  const as = (cookie) => (method, path) => request(app)[method](path).set('Cookie', cookie);

  async function exec(sql, params = []) {
    const client = new pg.Client({ connectionString: dbUrl });
    await client.connect();
    try { return (await client.query(sql, params)).rows; } finally { await client.end(); }
  }

  before(async () => {
    const root = new pg.Client({ connectionString: ADMIN_URL });
    await root.connect();
    const name = `views_test_${process.pid}_${Date.now()}`;
    await root.query(`CREATE DATABASE ${name}`);
    await root.end();

    const u = new URL(ADMIN_URL);
    u.pathname = `/${name}`;
    dbUrl = u.toString();

    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const dbDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
    const client = new pg.Client({ connectionString: dbUrl });
    await client.connect();
    await client.query(readFileSync(join(dbDir, 'schema.sql'), 'utf8'));
    await client.query(readFileSync(join(dbDir, 'views.sql'), 'utf8'));
    await client.end();

    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = dbUrl;
    process.env.AUTH_MODE = 'database';
    process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-to-pass';

    app = (await import('../src/app.js')).default;
    pool = (await import('../src/db.js')).pool;
    const { createUser } = await import('../src/lib/users.js');

    await createUser({ name: 'Ada Admin', email: 'admin@example.test', password: PASSWORD, role: 'admin' });
    await createUser({ name: 'Sam Sales', email: 'sales@example.test', password: PASSWORD, role: 'sales' });

    const signIn = async (email) => {
      const res = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
      assert.equal(res.status, 200, `sign-in failed for ${email}: ${JSON.stringify(res.body)}`);
      return res.headers['set-cookie'];
    };
    admin = { cookie: await signIn('admin@example.test') };
    sales = { cookie: await signIn('sales@example.test') };
  });

  after(async () => {
    await pool.end();
    const root = new pg.Client({ connectionString: ADMIN_URL });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${new URL(dbUrl).pathname.slice(1)} WITH (FORCE)`);
    await root.end();
  });

  test('the sidebar starts with three pinned views, and they are everybody\'s', async () => {
    const res = await as(sales.cookie)('get', '/api/views');
    assert.equal(res.status, 200);
    const pinned = res.body.data.filter((v) => v.pinned);
    assert.equal(pinned.length, 3, JSON.stringify(res.body.data.map((v) => v.name)));
    assert.ok(pinned.every((v) => v.owner === null), 'shipped views belong to nobody, so everybody sees them');
    assert.deepEqual(pinned.map((v) => v.name), ['Overdue money', 'To invoice', 'Open deals'], 'in sort order');
  });

  test('a count is the count of the list the view links to', async () => {
    await exec(`INSERT INTO quotations (quotation_no, client_name, quotation_date, quotation_value, status)
                VALUES ('CTZ/QT/2026/801', 'A Ltd', '2026-04-01', 100000, 'Submitted'),
                       ('CTZ/QT/2026/802', 'B Ltd', '2026-04-01', 100000, 'Under Negotiation'),
                       ('CTZ/QT/2026/803', 'C Ltd', '2026-04-01', 100000, 'Lost')`);

    const views = await as(sales.cookie)('get', '/api/views?counts=1');
    const open = views.body.data.find((v) => v.name === 'Open deals');
    // Two of the three match the view's filter; the lost one does not.
    assert.equal(open.count, 2, JSON.stringify(open));

    // And the same filter through the list endpoint agrees, which is the
    // whole promise of the number in the sidebar.
    const list = await as(sales.cookie)('get', '/api/quotations?status=Submitted,Under Negotiation');
    assert.equal(list.body.data.length, 2);
  });

  test('a sales user may save a view for themselves', async () => {
    const res = await as(sales.cookie)('post', '/api/views')
      .send({ resource: 'quotations', name: 'My open deals', filters: { status: 'Submitted' }, pinned: true, tone: 'info' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.owner, 'sales@example.test', 'it is theirs');
  });

  test('and nobody else sees it', async () => {
    const mine = await as(sales.cookie)('get', '/api/views');
    assert.ok(mine.body.data.some((v) => v.name === 'My open deals'));

    const theirs = await as(admin.cookie)('get', '/api/views');
    assert.ok(!theirs.body.data.some((v) => v.name === 'My open deals'), 'a private view stays private, even from an admin\'s list');
  });

  test('putting an item in everybody\'s sidebar is the admin\'s call', async () => {
    const refused = await as(sales.cookie)('post', '/api/views')
      .send({ resource: 'quotations', name: 'Everyone sees this', shared: true });
    assert.equal(refused.status, 403, JSON.stringify(refused.body));

    const allowed = await as(admin.cookie)('post', '/api/views')
      .send({ resource: 'quotations', name: 'Everyone sees this', shared: true });
    assert.equal(allowed.status, 201);
    assert.equal(allowed.body.data.owner, null);
  });

  test('a shared view is not a sales user\'s to change or delete', async () => {
    const { rows: [shared] } = { rows: (await exec(`SELECT id FROM saved_views WHERE name = 'Overdue money'`)) };
    const edit = await as(sales.cookie)('patch', `/api/views/${shared.id}`).send({ name: 'Renamed by sales' });
    assert.equal(edit.status, 403, JSON.stringify(edit.body));

    const remove = await as(sales.cookie)('delete', `/api/views/${shared.id}`);
    assert.equal(remove.status, 403);

    const byAdmin = await as(admin.cookie)('patch', `/api/views/${shared.id}`).send({ name: 'Overdue money' });
    assert.equal(byAdmin.status, 200);
  });

  test('a view on a list that does not exist is refused', async () => {
    const res = await as(admin.cookie)('post', '/api/views')
      .send({ resource: 'unicorns', name: 'Nope' });
    assert.equal(res.status, 422, JSON.stringify(res.body));
    assert.match(res.body.error.message, /no list called/i);
  });

  test('two views with the same name on the same list are refused', async () => {
    const first = await as(sales.cookie)('post', '/api/views').send({ resource: 'projects', name: 'Mine' });
    assert.equal(first.status, 201);
    const second = await as(sales.cookie)('post', '/api/views').send({ resource: 'projects', name: 'mine' });
    assert.equal(second.status, 409, 'differing only by case is the same name');
  });

  test('a filter the list no longer declares is ignored, not fatal', async () => {
    // A view outlives the list it filters. When a filter is dropped, the
    // stored key stays but stops applying — a slightly wider list beats a
    // sidebar entry that will not load.
    const made = await as(admin.cookie)('post', '/api/views')
      .send({ resource: 'quotations', name: 'Stale filter', filters: { status: 'Submitted', gone_column: 'x' } });
    assert.equal(made.status, 201);

    const counted = await as(admin.cookie)('get', '/api/views?counts=1');
    const view = counted.body.data.find((v) => v.name === 'Stale filter');
    assert.equal(typeof view.count, 'number', 'it still counts');
    assert.equal(view.count, 1, 'on the filter that survives, ignoring the one that does not');
  });

  test('un-sharing gives a view back to whoever made it', async () => {
    // An admin taking a shared view private must not quietly become its
    // owner — that removes it from everybody else's sidebar under
    // somebody else's name.
    const made = await as(sales.cookie)('post', '/api/views')
      .send({ resource: 'projects', name: 'Sam\'s own' });
    assert.equal(made.status, 201);

    const shared = await as(admin.cookie)('patch', `/api/views/${made.body.data.id}`).send({ shared: true });
    assert.equal(shared.status, 200);
    assert.equal(shared.body.data.owner, null);

    const back = await as(admin.cookie)('patch', `/api/views/${made.body.data.id}`).send({ shared: false });
    assert.equal(back.status, 200);
    assert.equal(back.body.data.owner, 'sales@example.test', 'back to Sam, not to the admin who unshared it');
  });

  test('a sales user may order their own sidebar, and only their own', async () => {
    const mine = await as(sales.cookie)('post', '/api/views')
      .send({ resource: 'companies', name: 'Ordering test', pinned: true });
    assert.equal(mine.status, 201);
    const shared = (await exec(`SELECT id FROM saved_views WHERE name = 'To invoice'`))[0];

    const res = await as(sales.cookie)('post', '/api/views/order')
      .send({ order: [mine.body.data.id, shared.id] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    // Their own moved; the shared one did not, because it is not theirs.
    assert.equal(res.body.data.ordered, 1, JSON.stringify(res.body));
  });

  test('a malformed order is refused, not a 500', async () => {
    const res = await as(sales.cookie)('post', '/api/views/order').send({ order: 'first please' });
    assert.equal(res.status, 422, JSON.stringify(res.body));
  });

  test('a dated view is counted over its own dates', async () => {
    // Without `from`/`to` surviving into the count, "invoiced this
    // quarter" would be counted across all time and the sidebar would
    // disagree with the list it links to.
    await exec(`INSERT INTO quotations (quotation_no, client_name, quotation_date, quotation_value, status)
                VALUES ('CTZ/QT/2026/901', 'Old Ltd', '2020-01-01', 100000, 'Submitted')`);

    const made = await as(admin.cookie)('post', '/api/views').send({
      resource: 'quotations', name: 'Quoted this era', filters: { from: '2026-01-01', to: '2026-12-31' },
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));

    const counted = await as(admin.cookie)('get', '/api/views?counts=1');
    const view = counted.body.data.find((v) => v.name === 'Quoted this era');
    const list = await as(admin.cookie)('get', '/api/quotations?from=2026-01-01&to=2026-12-31');
    assert.equal(view.count, list.body.data.length, 'the count is the list');
    assert.ok(view.count >= 1 && !list.body.data.some((q) => q.quotation_no === 'CTZ/QT/2026/901'),
      'and the 2020 one is outside it');
  });

  test('signing out closes it', async () => {
    assert.equal((await request(app).get('/api/views')).status, 401);
  });
});
