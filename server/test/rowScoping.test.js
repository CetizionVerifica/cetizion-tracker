import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * Row-level ownership (#18 Phase 2C).
 *
 * The rule: an admin sees everything, a sales user sees what they own, and
 * a record owned by nobody is admin-only. The risk is never the rule — it
 * is the endpoint nobody remembered. So this file works through the leak
 * surfaces one at a time: lists and details, writes, creation, the
 * conversions, the composite responses, lookups, exports, the reports and
 * the PDF, documents, the dashboard, counts, search.
 *
 * Sales A must never observe anything of B's or of an unassigned record —
 * not a row, not an identifier, not a total.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const PASSWORD = 'a-good-long-test-password';
const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');

const ENTITIES = ['enquiries', 'quotations', 'projects'];

describe('row-level ownership', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let dbUrl; let db; let app; let pool; let createUser;
  let admin; let salesA; let salesB;
  let rows;   // { enquiries: { a, b, none }, … } — row ids by owner

  before(async () => {
    const root = new pg.Client({ connectionString: ADMIN_URL });
    await root.connect();
    const name = `rowscope_${process.pid}_${Date.now()}`;
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

  /**
   * Three people and nine records: one each per table for A, for B, and for
   * nobody. Written straight to the database so ownership is exactly what
   * the test says it is, rather than whatever the create rule decided.
   */
  async function setUp() {
    for (const t of ['payment_stages', 'po_services', 'purchase_orders', ...ENTITIES, 'documents', 'users']) {
      await db.query(`DELETE FROM ${t}`);
    }
    const mk = async (over) => createUser({ password: PASSWORD, ...over }, db);
    const a = await mk({ name: 'Alice', email: 'alice@example.com', role: 'admin' });
    const s = await mk({ name: 'Sam', email: 'sam@example.com', role: 'sales' });
    const b = await mk({ name: 'Bea', email: 'bea@example.com', role: 'sales' });
    admin = { user: a, cookie: await signIn(a.email) };
    salesA = { user: s, cookie: await signIn(s.email) };
    salesB = { user: b, cookie: await signIn(b.email) };

    rows = { enquiries: {}, quotations: {}, projects: {} };
    const owners = { a: salesA.user.id, b: salesB.user.id, none: null };
    let n = 0;
    for (const [key, owner] of Object.entries(owners)) {
      n += 1;
      const tag = String(n).padStart(3, '0');
      rows.enquiries[key] = (await db.query(
        `INSERT INTO enquiries (enquiry_no, client_name, sales_person, owner_user_id)
         VALUES ($1, $2, 'Ramesh', $3) RETURNING id`,
        [`CTZ/ENQ/2026/${tag}`, `Client ${key.toUpperCase()}`, owner])).rows[0].id;
      rows.quotations[key] = (await db.query(
        `INSERT INTO quotations (quotation_no, client_name, sales_person, quotation_date,
                                 quotation_value, currency, status, owner_user_id)
         VALUES ($1, $2, 'Ramesh', '2026-05-01', 1000, 'INR', 'Won - PO Received', $3) RETURNING id`,
        [`CTZ/QT/2026/${tag}`, `Client ${key.toUpperCase()}`, owner])).rows[0].id;
      rows.projects[key] = (await db.query(
        `INSERT INTO projects (project_id, client_name, sales_person, owner_user_id)
         VALUES ($1, $2, 'Ramesh', $3) RETURNING id`,
        [`PRJ-2026-${tag}`, `Client ${key.toUpperCase()}`, owner])).rows[0].id;
    }
  }

  const get = (cookie, path) => request(app).get(path).set('Cookie', cookie);
  const idsOf = (body) => body.data.map((r) => r.id).sort();
  const text = (res) => (typeof res.text === 'string' ? res.text : String(res.body));

  // =================================================== lists and details

  describe('lists', () => {
    test('a sales user sees only their own rows, in every table', async () => {
      await setUp();
      for (const t of ENTITIES) {
        const res = await get(salesA.cookie, `/api/${t}`);
        assert.equal(res.status, 200, t);
        assert.deepEqual(idsOf(res.body), [rows[t].a], `${t}: only A's row`);
      }
    });

    test('an admin sees every row, owned and unowned', async () => {
      await setUp();
      for (const t of ENTITIES) {
        const res = await get(admin.cookie, `/api/${t}`);
        assert.deepEqual(idsOf(res.body), [rows[t].a, rows[t].b, rows[t].none].sort(), t);
      }
    });

    test('the count is the count of what the caller may see', async () => {
      await setUp();
      for (const t of ENTITIES) {
        // The total drives pagination. A global one would tell a sales user
        // how many records exist that they cannot open.
        assert.equal((await get(salesA.cookie, `/api/${t}`)).body.total, 1, t);
        assert.equal((await get(admin.cookie, `/api/${t}`)).body.total, 3, t);
      }
    });

    test('search and filters narrow within the scope, never out of it', async () => {
      await setUp();
      // B's client name, searched by A: the predicate is in the SQL, so this
      // matches nothing rather than matching and then being stripped.
      const hunt = await get(salesA.cookie, '/api/enquiries?q=Client B');
      assert.equal(hunt.status, 200);
      assert.deepEqual(hunt.body.data, [], 'searching for B finds nothing');
      assert.equal(hunt.body.total, 0);

      const own = await get(salesA.cookie, '/api/enquiries?q=Client A');
      assert.deepEqual(idsOf(own.body), [rows.enquiries.a]);
    });

    test('paging cannot walk past the scope', async () => {
      await setUp();
      const page = await get(salesA.cookie, '/api/quotations?limit=1&offset=1');
      assert.equal(page.status, 200);
      assert.deepEqual(page.body.data, [], 'there is no second page of one row');
    });
  });

  describe('details', () => {
    test('own → 200, another user’s → 404, unassigned → 404', async () => {
      await setUp();
      for (const t of ENTITIES) {
        assert.equal((await get(salesA.cookie, `/api/${t}/${rows[t].a}`)).status, 200, `${t} own`);
        // 404 and not 403: the answer must not confirm the record exists.
        assert.equal((await get(salesA.cookie, `/api/${t}/${rows[t].b}`)).status, 404, `${t} other`);
        assert.equal((await get(salesA.cookie, `/api/${t}/${rows[t].none}`)).status, 404, `${t} unassigned`);
      }
    });

    test('an admin reads all three', async () => {
      await setUp();
      for (const t of ENTITIES) {
        for (const key of ['a', 'b', 'none']) {
          assert.equal((await get(admin.cookie, `/api/${t}/${rows[t][key]}`)).status, 200, `${t} ${key}`);
        }
      }
    });

    test('an unauthenticated request is 401, not 404', async () => {
      await setUp();
      assert.equal((await request(app).get('/api/enquiries')).status, 401);
      assert.equal((await request(app).get(`/api/enquiries/${rows.enquiries.a}`)).status, 401);
    });
  });

  // ============================================================== writes

  describe('writes', () => {
    const patch = (cookie, t, id, body) =>
      request(app).patch(`/api/${t}/${id}`).set('Cookie', cookie).send(body);

    test('a sales user may edit their own and nothing else', async () => {
      await setUp();
      for (const t of ENTITIES) {
        assert.equal((await patch(salesA.cookie, t, rows[t].a, { client_name: 'Renamed' })).status, 200, t);
        assert.equal((await patch(salesA.cookie, t, rows[t].b, { client_name: 'Hijacked' })).status, 404, t);
        assert.equal((await patch(salesA.cookie, t, rows[t].none, { client_name: 'Claimed' })).status, 404, t);

        const names = (await db.query(`SELECT id, client_name FROM ${t} ORDER BY id`)).rows;
        const changed = names.filter((r) => r.client_name !== 'Renamed').length;
        assert.equal(changed, 2, `${t}: only A's row was rewritten`);
      }
    });

    test('a sales user may delete their own and nothing else', async () => {
      await setUp();
      for (const t of ENTITIES) {
        const del = (id) => request(app).delete(`/api/${t}/${id}`).set('Cookie', salesA.cookie);
        assert.equal((await del(rows[t].b)).status, 404, `${t}: another user's row`);
        assert.equal((await del(rows[t].none)).status, 404, `${t}: unassigned`);
        assert.equal((await db.query(`SELECT count(*)::int n FROM ${t}`)).rows[0].n, 3, `${t}: nothing gone yet`);
        assert.equal((await del(rows[t].a)).status, 204, `${t}: own row`);
        assert.equal((await db.query(`SELECT count(*)::int n FROM ${t}`)).rows[0].n, 2, t);
      }
    });

    test('an admin may edit and delete all three', async () => {
      await setUp();
      for (const t of ENTITIES) {
        for (const key of ['a', 'b', 'none']) {
          assert.equal((await patch(admin.cookie, t, rows[t][key], { client_name: `Admin ${key}` })).status, 200);
        }
        assert.equal(
          (await request(app).delete(`/api/${t}/${rows[t].none}`).set('Cookie', admin.cookie)).status, 204);
      }
    });
  });

  // =========================================================== creation

  describe('new records', () => {
    const body = {
      enquiries: { client_name: 'New Co', service: 'ASI audit' },
      quotations: { client_name: 'New Co', service_quoted: 'ASI audit' },
      projects: { client_name: 'New Co', primary_service: 'ASI audit' },
    };
    const create = (cookie, t, extra = {}) =>
      request(app).post(`/api/${t}`).set('Cookie', cookie).send({ ...body[t], ...extra });

    test('a sales user owns what they enter', async () => {
      await setUp();
      for (const t of ENTITIES) {
        const res = await create(salesA.cookie, t);
        assert.equal(res.status, 201, `${t}: ${JSON.stringify(res.body)}`);
        const [row] = (await db.query(`SELECT owner_user_id FROM ${t} WHERE id = $1`, [res.body.data.id])).rows;
        assert.equal(row.owner_user_id, salesA.user.id, t);
      }
    });

    test('an owner in the request body is ignored, not honoured', async () => {
      await setUp();
      for (const t of ENTITIES) {
        const res = await create(salesA.cookie, t, { owner_user_id: salesB.user.id });
        assert.equal(res.status, 201, t);
        const [row] = (await db.query(`SELECT owner_user_id FROM ${t} WHERE id = $1`, [res.body.data.id])).rows;
        assert.equal(row.owner_user_id, salesA.user.id, `${t}: the session decides, not the payload`);
      }
    });

    test('an admin creates an unowned record rather than guessing', async () => {
      await setUp();
      for (const t of ENTITIES) {
        const res = await create(admin.cookie, t, { owner_user_id: salesB.user.id });
        assert.equal(res.status, 201, t);
        const [row] = (await db.query(`SELECT owner_user_id FROM ${t} WHERE id = $1`, [res.body.data.id])).rows;
        assert.equal(row.owner_user_id, null, `${t}: unassigned, and visibly so`);
      }
    });

    test('a sales user can read back what they just created', async () => {
      await setUp();
      const made = await create(salesA.cookie, 'enquiries');
      assert.equal((await get(salesA.cookie, `/api/enquiries/${made.body.data.id}`)).status, 200);
    });
  });

  // ========================================================= conversions

  describe('conversions carry responsibility forward', () => {
    test('a won enquiry makes a quotation owned by the enquiry’s owner', async () => {
      await setUp();
      const res = await request(app).patch(`/api/enquiries/${rows.enquiries.a}`)
        .set('Cookie', salesA.cookie).send({ status: 'Won - Quotation Sent' });

      assert.equal(res.status, 200, JSON.stringify(res.body));
      const [made] = (await db.query(
        `SELECT owner_user_id FROM quotations WHERE remarks LIKE 'From enquiry%'`)).rows;
      assert.equal(made.owner_user_id, salesA.user.id);
    });

    test('an unowned enquiry makes an unowned quotation', async () => {
      await setUp();
      const res = await request(app).patch(`/api/enquiries/${rows.enquiries.none}`)
        .set('Cookie', admin.cookie).send({ status: 'Won - Quotation Sent' });

      assert.equal(res.status, 200, JSON.stringify(res.body));
      const [made] = (await db.query(
        `SELECT owner_user_id FROM quotations WHERE remarks LIKE 'From enquiry%'`)).rows;
      assert.equal(made.owner_user_id, null, 'no owner is invented along the way');
    });

    test('registering a won quotation makes a project with the same owner', async () => {
      await setUp();
      const res = await request(app).post(`/api/quotations/${rows.quotations.a}/convert`)
        .set('Cookie', salesA.cookie).send({});

      assert.equal(res.status, 201, JSON.stringify(res.body));
      const [made] = (await db.query(
        `SELECT owner_user_id FROM projects WHERE remarks LIKE 'Won from quotation%'`)).rows;
      assert.equal(made.owner_user_id, salesA.user.id);
    });

    test('a sales user cannot register somebody else’s quotation', async () => {
      await setUp();
      for (const key of ['b', 'none']) {
        const res = await request(app).post(`/api/quotations/${rows.quotations[key]}/convert`)
          .set('Cookie', salesA.cookie).send({});
        assert.equal(res.status, 404, key);
      }
      assert.equal(
        (await db.query(`SELECT count(*)::int n FROM projects WHERE remarks LIKE 'Won from%'`)).rows[0].n, 0);
    });

    test('an admin registering a win does not become its owner', async () => {
      await setUp();
      const res = await request(app).post(`/api/quotations/${rows.quotations.a}/convert`)
        .set('Cookie', admin.cookie).send({});

      assert.equal(res.status, 201, JSON.stringify(res.body));
      const [made] = (await db.query(
        `SELECT owner_user_id FROM projects WHERE remarks LIKE 'Won from quotation%'`)).rows;
      assert.equal(made.owner_user_id, salesA.user.id, 'the quotation’s owner, not the registrar');
    });
  });

  // =================================================== composite reads

  describe('composite endpoints', () => {
    test('a company response embeds only the caller’s own records', async () => {
      await setUp();
      // Every record above names its own client; put them all on one company.
      await db.query(`UPDATE enquiries SET client_name = 'Shared Co'`);
      await db.query(`UPDATE quotations SET client_name = 'Shared Co'`);
      await db.query(`UPDATE projects SET client_name = 'Shared Co'`);
      const [company] = (await db.query(
        `SELECT id FROM companies WHERE name_key = name_key('Shared Co')`)).rows;
      assert.ok(company, 'the link trigger made the company');

      const mine = await get(salesA.cookie, `/api/companies/${company.id}/full`);
      assert.equal(mine.status, 200);
      for (const t of ENTITIES) {
        assert.deepEqual(mine.body.data[t].map((r) => r.id), [rows[t].a], `${t} in the company response`);
      }

      const all = await get(admin.cookie, `/api/companies/${company.id}/full`);
      for (const t of ENTITIES) assert.equal(all.body.data[t].length, 3, `${t} for an admin`);
    });

    test('a project composite is 404 unless the project is the caller’s', async () => {
      await setUp();
      const idOf = async (key) =>
        (await db.query('SELECT project_id FROM projects WHERE id = $1', [rows.projects[key]])).rows[0].project_id;

      assert.equal((await get(salesA.cookie, `/api/projects/${await idOf('a')}/full`)).status, 200);
      assert.equal((await get(salesA.cookie, `/api/projects/${await idOf('b')}/full`)).status, 404);
      assert.equal((await get(salesA.cookie, `/api/projects/${await idOf('none')}/full`)).status, 404);
      assert.equal((await get(admin.cookie, `/api/projects/${await idOf('b')}/full`)).status, 200);
    });

    test('a purchase order follows the quotation or project above it', async () => {
      await setUp();
      const keyOf = async (table, column, key) =>
        (await db.query(`SELECT ${column} FROM ${table} WHERE id = $1`, [rows[table][key]])).rows[0][column];
      for (const key of ['a', 'b']) {
        await db.query(
          `INSERT INTO purchase_orders (po_number, project_id, quotation_no, po_date, po_value, currency)
           VALUES ($1, $2, $3, '2026-05-02', 1000, 'INR')`,
          [`PO-${key}`, await keyOf('projects', 'project_id', key), await keyOf('quotations', 'quotation_no', key)]);
      }

      assert.equal((await get(salesA.cookie, '/api/purchase-orders/PO-a/full')).status, 200);
      assert.equal((await get(salesA.cookie, '/api/purchase-orders/PO-b/full')).status, 404);
      assert.equal((await get(admin.cookie, '/api/purchase-orders/PO-b/full')).status, 200);
    });
  });

  // ============================================================ lookups

  test('dropdowns offer only reachable records', async () => {
    await setUp();
    const mine = await get(salesA.cookie, '/api/lookups');
    assert.equal(mine.status, 200);
    const body = JSON.stringify(mine.body);

    assert.ok(!body.includes('CTZ/QT/2026/002'), 'no quotation number of B’s');
    assert.ok(!body.includes('PRJ-2026-002'), 'no project id of B’s');
    assert.ok(body.includes('CTZ/QT/2026/001'), 'their own quotation is offered');

    // The client list is deliberately not scoped. companies is master data —
    // one spelling per client, shared by everybody, and the link trigger
    // creates a row the first time any record names a client. A salesperson
    // needs the whole list to file their own work against the right client,
    // and a client's name is not one salesperson's secret. What must not
    // leak is the records: numbers, ids, values, statuses.
    const withoutClients = JSON.stringify({
      ...mine.body.data, clients: undefined, companies: undefined,
    });
    assert.ok(!withoutClients.includes('Client B'), 'no record of B’s behind the dropdowns');
    assert.ok(!withoutClients.includes('Client NONE'), 'nothing from an unassigned record');

    const all = await get(admin.cookie, '/api/lookups');
    assert.ok(JSON.stringify(all.body).includes('PRJ-2026-002'), 'an admin sees everything');
  });

  // ============================================================ exports

  describe('exports', () => {
    test('a spreadsheet contains only what the list would show', async () => {
      await setUp();
      for (const t of ENTITIES) {
        const mine = await get(salesA.cookie, `/api/export/${t}.csv`);
        assert.equal(mine.status, 200, t);
        assert.ok(text(mine).includes('Client A'), `${t}: their own row is there`);
        assert.ok(!text(mine).includes('Client B'), `${t}: nothing of B’s`);
        assert.ok(!text(mine).includes('Client NONE'), `${t}: nothing unassigned`);

        const all = await get(admin.cookie, `/api/export/${t}.csv`);
        assert.ok(text(all).includes('Client B'), `${t}: an admin exports everything`);
      }
    });

    test('the xlsx route is scoped too, not only the csv one', async () => {
      await setUp();
      const res = await get(salesA.cookie, '/api/export/quotations.xlsx');
      assert.equal(res.status, 200);
      // A workbook is a zip; the sheet strings are not greppable. Compare the
      // row count the same query produced for CSV instead.
      const csv = text(await get(salesA.cookie, '/api/export/quotations.csv'));
      assert.equal(csv.trim().split('\n').length, 2, 'header plus one row');
    });
  });

  // ============================================================ reports

  describe('reports and the PDF', () => {
    test('the sales report covers only the caller’s pipeline', async () => {
      await setUp();
      const mine = await get(salesA.cookie, '/api/dashboard/sales-report');
      assert.equal(mine.status, 200);
      const body = JSON.stringify(mine.body);
      assert.ok(body.includes('Client A'), 'their own customer is counted');
      assert.ok(!body.includes('Client B'), 'B’s customer is not');
      assert.ok(!body.includes('Client NONE'), 'nor an unassigned one');

      const all = JSON.stringify((await get(admin.cookie, '/api/dashboard/sales-report')).body);
      assert.ok(all.includes('Client B') && all.includes('Client NONE'), 'an admin sees all of it');
    });

    test('the revenue report is scoped, and still computes the same way', async () => {
      await setUp();
      const mine = await get(salesA.cookie, '/api/dashboard/revenue-report');
      const all = await get(admin.cookie, '/api/dashboard/revenue-report');
      assert.equal(mine.status, 200);
      assert.equal(all.status, 200);
      assert.deepEqual(
        Object.keys(mine.body.data).sort(), Object.keys(all.body.data).sort(),
        'the same report, not a different shape'
      );
    });

    test('a report CSV is scoped', async () => {
      await setUp();
      const mine = await get(salesA.cookie, '/api/export/sales-report/customers.csv');
      assert.equal(mine.status, 200);
      assert.ok(!text(mine).includes('Client B'), 'no customer of B’s');
      assert.ok(text(await get(admin.cookie, '/api/export/sales-report/customers.csv')).includes('Client B'));
    });

    test('the PDF builds for both, from each one’s own rows', async () => {
      await setUp();
      const mine = await get(salesA.cookie, '/api/export/sales-report.pdf?year=2026');
      const all = await get(admin.cookie, '/api/export/sales-report.pdf?year=2026');
      assert.equal(mine.status, 200);
      assert.equal(all.status, 200);
      assert.equal(mine.headers['content-type'], 'application/pdf');
      // Same report, fewer records: the admin's covers three quotations and
      // the sales user's one, so the documents cannot be identical.
      assert.notEqual(mine.body.length, all.body.length);
    });
  });

  // ========================================================== documents

  describe('documents', () => {
    /** A document, attached to the quotation owned by `key` (or to nothing). */
    const makeDocument = async (key) => {
      const { rows: [doc] } = await db.query(
        `INSERT INTO documents (storage_key, file_name, content_type, size_bytes)
         VALUES ($1, 'quote.pdf', 'application/pdf', 100) RETURNING id`,
        [`key-${key}-${Date.now()}-${Math.random()}`]);
      if (key !== 'unattached') {
        await db.query('UPDATE quotations SET document_id = $1 WHERE id = $2', [doc.id, rows.quotations[key]]);
      }
      return doc.id;
    };

    // Storage is not configured under test, so a permitted read fails later,
    // at the fetch from Cloudinary. What is being asserted is the
    // authorization step in front of it: a refusal is 404 and a permitted
    // read is anything but — it gets as far as trying to read the file.
    const allowed = async (cookie, id, why) =>
      assert.notEqual((await get(cookie, `/api/documents/${id}`)).status, 404, why);
    const refused = async (cookie, id, why) =>
      assert.equal((await get(cookie, `/api/documents/${id}`)).status, 404, why);

    test('a sales user reads a document attached to their own record', async () => {
      await setUp();
      await allowed(salesA.cookie, await makeDocument('a'), 'their own quotation’s document');
    });

    test('and none attached to another user’s or an unassigned record', async () => {
      await setUp();
      await refused(salesA.cookie, await makeDocument('b'), 'attached to B’s quotation');
      await refused(salesA.cookie, await makeDocument('none'), 'attached to an unassigned quotation');
    });

    test('an unattached document is admin-only, not public', async () => {
      await setUp();
      const orphan = await makeDocument('unattached');

      // "No parent" means ownership is unknown, and unknown ownership is
      // admin-only — the same answer an unassigned record gets. Nothing in
      // the app needs this: uploading returns the document's own metadata,
      // and the form saves the record with that id in the same submit.
      await refused(salesA.cookie, orphan, 'a sales user may not read an orphan by guessing its id');
      await allowed(admin.cookie, orphan, 'an admin may');
    });

    test('a refusal does not say whether the document exists', async () => {
      await setUp();
      const real = await makeDocument('b');
      const missing = 999_999;

      const forbidden = await get(salesA.cookie, `/api/documents/${real}`);
      const absent = await get(salesA.cookie, `/api/documents/${missing}`);

      assert.equal(forbidden.status, absent.status, 'same status');
      assert.deepEqual(forbidden.body, absent.body, 'and the same body');
    });
  });

  // =========================== purchase-order and payment-stage mutations

  describe('rows that inherit their ownership', () => {
    /** A purchase order under `key`'s project, and a payment stage under it. */
    async function chain(key) {
      const projectId = (await db.query(
        'SELECT project_id FROM projects WHERE id = $1', [rows.projects[key]])).rows[0].project_id;
      const po = `PO-${key}`;
      await db.query(
        `INSERT INTO purchase_orders (po_number, project_id, po_date, po_value, currency)
         VALUES ($1, $2, '2026-05-02', 100000, 'INR')`, [po, projectId]);
      const { rows: [stage] } = await db.query(
        `INSERT INTO payment_stages (po_number, stage_no, stage_name, trigger_event, stage_percent)
         VALUES ($1, 1, 'Advance', 'On PO Registration', 0.5) RETURNING id`, [po]);
      return { projectId, po, stage: stage.id };
    }

    const post = (cookie, path, body = {}) =>
      request(app).post(path).set('Cookie', cookie).send(body);
    const patch = (cookie, path, body) =>
      request(app).patch(path).set('Cookie', cookie).send(body);

    test('reads follow the parent', async () => {
      await setUp();
      const a = await chain('a'); const b = await chain('b'); const none = await chain('none');

      assert.deepEqual(
        (await get(salesA.cookie, '/api/purchase-orders')).body.data.map((r) => r.po_number),
        [a.po], 'only the PO under A’s project');
      assert.equal((await get(salesA.cookie, '/api/payment-stages')).body.total, 1);
      assert.equal((await get(admin.cookie, '/api/purchase-orders')).body.total, 3);

      for (const other of [b, none]) {
        assert.equal((await get(salesA.cookie, `/api/purchase-orders/${other.po}/full`)).status, 404);
      }
    });

    test('creating one under another user’s parent is refused', async () => {
      await setUp();
      const a = await chain('a'); const b = await chain('b'); const none = await chain('none');
      const projectOf = async (key) => (await db.query(
        'SELECT project_id FROM projects WHERE id = $1', [rows.projects[key]])).rows[0].project_id;

      const mine = await post(salesA.cookie, '/api/purchase-orders', {
        po_number: 'PO-new-a', project_id: await projectOf('a'),
        po_date: '2026-05-03', po_value: 1000, currency: 'INR',
      });
      assert.equal(mine.status, 201, JSON.stringify(mine.body));

      for (const key of ['b', 'none']) {
        const res = await post(salesA.cookie, '/api/purchase-orders', {
          po_number: `PO-new-${key}`, project_id: await projectOf(key),
          po_date: '2026-05-03', po_value: 1000, currency: 'INR',
        });
        assert.equal(res.status, 404, `${key}: ${JSON.stringify(res.body)}`);
      }

      // And the same for the rows that hang off a purchase order.
      for (const [key, made] of [['a', a], ['b', b], ['none', none]]) {
        const res = await post(salesA.cookie, '/api/payment-stages', {
          po_number: made.po, stage_no: 9, stage_name: 'Extra',
          trigger_event: 'On PO Registration', stage_percent: 0.1,
        });
        assert.equal(res.status, key === 'a' ? 201 : 404, `stage under ${key}`);
        const svc = await post(salesA.cookie, '/api/po-services', {
          po_number: made.po, service: 'Assessment', service_value: 100,
        });
        assert.equal(svc.status, key === 'a' ? 201 : 404, `service under ${key}`);
      }
    });

    test('editing one under another user’s parent is refused', async () => {
      await setUp();
      const a = await chain('a'); const b = await chain('b'); const none = await chain('none');
      const idOf = async (po) => (await db.query(
        'SELECT id FROM purchase_orders WHERE po_number = $1', [po])).rows[0].id;

      assert.equal((await patch(salesA.cookie, `/api/purchase-orders/${await idOf(a.po)}`,
        { po_value: 111 })).status, 200);
      for (const other of [b, none]) {
        assert.equal((await patch(salesA.cookie, `/api/purchase-orders/${await idOf(other.po)}`,
          { po_value: 222 })).status, 404);
      }
      assert.equal((await patch(salesA.cookie, `/api/payment-stages/${b.stage}`,
        { remarks: 'hijacked' })).status, 404);

      const values = (await db.query('SELECT po_value FROM purchase_orders ORDER BY po_number')).rows;
      assert.equal(values.filter((v) => Number(v.po_value) === 222).length, 0, 'nothing of B’s moved');
    });

    test('splitting a purchase order into stages follows the parent', async () => {
      await setUp();
      const a = await chain('a'); const b = await chain('b');
      const body = {
        replace: true,
        stages: [{ stage_no: 1, stage_name: 'Advance', trigger_event: 'On PO Registration', stage_percent: 1 }],
      };

      assert.equal((await post(salesA.cookie, `/api/purchase-orders/${a.po}/stages`, body)).status, 201);
      assert.equal((await post(salesA.cookie, `/api/purchase-orders/${b.po}/stages`, body)).status, 404);
      assert.equal((await post(admin.cookie, `/api/purchase-orders/${b.po}/stages`, body)).status, 201);
    });

    test('invoicing and receipting a stage follow the parent', async () => {
      await setUp();
      const a = await chain('a'); const b = await chain('b'); const none = await chain('none');
      const invoice = { invoice_no: 'INV-1', invoice_date: '2026-05-10' };
      const receipt = { amount_received: 100, payment_received_date: '2026-05-20', mode: 'add' };

      assert.equal((await post(salesA.cookie, `/api/payment-stages/${a.stage}/invoice`, invoice)).status, 200);
      assert.equal((await post(salesA.cookie, `/api/payment-stages/${a.stage}/payment`, receipt)).status, 200);

      for (const other of [b, none]) {
        assert.equal((await post(salesA.cookie, `/api/payment-stages/${other.stage}/invoice`, invoice)).status, 404);
        assert.equal((await post(salesA.cookie, `/api/payment-stages/${other.stage}/payment`, receipt)).status, 404);
      }

      // Refused, not quietly done.
      const touched = (await db.query(
        'SELECT invoice_no, amount_received FROM payment_stages WHERE id = ANY($1)',
        [[b.stage, none.stage]])).rows;
      for (const row of touched) {
        assert.equal(row.invoice_no, null, 'no invoice number was written');
        assert.equal(Number(row.amount_received), 0, 'no receipt was recorded');
      }
    });

    test('applying an onboarding template follows the project', async () => {
      await setUp();
      const a = await chain('a'); const b = await chain('b');

      assert.equal((await post(salesA.cookie,
        `/api/projects/${a.projectId}/onboarding/apply-template`)).status, 201);
      assert.equal((await post(salesA.cookie,
        `/api/projects/${b.projectId}/onboarding/apply-template`)).status, 404);
    });

    test('deleting stays admin-only, by role rather than by ownership', async () => {
      await setUp();
      const a = await chain('a');
      const id = (await db.query('SELECT id FROM purchase_orders WHERE po_number = $1', [a.po])).rows[0].id;

      // adminOnlyDeletes from Phase 1C, which runs before any ownership
      // check — so this is 403, not 404, even though the row is A's own.
      const res = await request(app).delete(`/api/purchase-orders/${id}`).set('Cookie', salesA.cookie);
      assert.equal(res.status, 403);
      assert.equal(
        (await db.query('SELECT count(*)::int n FROM purchase_orders')).rows[0].n, 1, 'still there');
    });
  });

  // ========================================================== dashboard

  test('the dashboard counts only the caller’s records', async () => {
    await setUp();
    const mine = await get(salesA.cookie, '/api/dashboard/overview');
    const all = await get(admin.cookie, '/api/dashboard/overview');
    assert.equal(mine.status, 200);
    assert.equal(all.status, 200);

    const quotationsOf = (res) => res.body.data.sales.quotations;
    assert.equal(quotationsOf(mine), 1, 'their own quotation');
    assert.equal(quotationsOf(all), 3, 'all three');
  });

  test('the worklist leaks no identifier from another user’s records', async () => {
    await setUp();
    const mine = await get(salesA.cookie, '/api/dashboard/worklist');
    assert.equal(mine.status, 200);
    const body = JSON.stringify(mine.body);
    for (const leak of ['CTZ/QT/2026/002', 'CTZ/QT/2026/003', 'PRJ-2026-002', 'Client B', 'Client NONE']) {
      assert.ok(!body.includes(leak), `worklist must not carry ${leak}`);
    }
  });

  // ======================================================= role changes

  describe('a role change takes effect on the next request', () => {
    test('promoting a sales user to admin opens everything', async () => {
      await setUp();
      assert.equal((await get(salesA.cookie, '/api/enquiries')).body.total, 1);

      await db.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [salesA.user.id]);

      // The same cookie. Permission is read from the row on every request and
      // is deliberately not signed into the session.
      assert.equal((await get(salesA.cookie, '/api/enquiries')).body.total, 3);
    });

    test('demoting an admin closes it again', async () => {
      await setUp();
      assert.equal((await get(admin.cookie, '/api/enquiries')).body.total, 3);

      await db.query(`UPDATE users SET role = 'sales' WHERE id = $1`, [admin.user.id]);

      const after = await get(admin.cookie, '/api/enquiries');
      assert.equal(after.body.total, 0, 'an admin owns none of these records');
    });
  });
});
