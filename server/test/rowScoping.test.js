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
    // communications and tasks hang off a record by (entity, entity_id) text
    // rather than by a foreign key, so nothing cascades them away.
    for (const t of ['communications', 'tasks', 'notes', 'attachments', 'collection_log', 'payment_stages', 'po_services',
      'purchase_orders', ...ENTITIES, 'documents', 'users']) {
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
      // source, service and an estimated value: #24 requires all three before
      // an enquiry may leave New, so a fixture without them cannot be
      // converted. They are business fields, not ownership ones.
      rows.enquiries[key] = (await db.query(
        `INSERT INTO enquiries (enquiry_no, client_name, sales_person, owner_user_id,
                                source, service, estimated_value, currency)
         VALUES ($1, $2, 'Ramesh', $3, 'Referral', 'Audit', 50000, 'INR') RETURNING id`,
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

  // ============================= the enquiries view, read under scoping

  /**
   * Enquiries began reading through v_enquiries only after this branch was
   * written (client-data-gaps.md, gap 1), so ownership scoping and that view
   * met for the first time in the merge that brought them together.
   *
   * Two suites pass today without noticing the join: the tests above prove
   * isolation but never look at a column the view adds, and
   * clientContacts.test.js proves the view's columns but signs in as one
   * person, so nothing there is scoped. Between them, a regression that took
   * the view out of the read path — or took owner_user_id out of the view —
   * could stay hidden. This is the assertion that both hold at once.
   */
  describe('the enquiries view, read under scoping', () => {
    /**
     * A contact with an address, on one enquiry. Written straight to the
     * database: this is a test about the read path, so the write path is
     * deliberately not part of it. `tag` keeps each test's company its own,
     * because setUp() clears the records but not the companies they name.
     */
    const linkContact = async (enquiryId, who, tag, email, phone) => {
      const { rows: [company] } = await db.query(
        'INSERT INTO companies (name) VALUES ($1) RETURNING id', [`${who} ${tag} Ltd`]);
      const { rows: [contact] } = await db.query(
        'INSERT INTO contacts (company_id, name, email, phone) VALUES ($1,$2,$3,$4) RETURNING id',
        [company.id, who, email, phone]);
      // link_contact leaves a contact_id that is already set alone, so this
      // is not undone by the trigger.
      await db.query('UPDATE enquiries SET contact_id = $1 WHERE id = $2', [contact.id, enquiryId]);
    };

    test('a scoped list comes from the view, and still holds only the reader’s rows', async () => {
      await setUp();
      await linkContact(rows.enquiries.a, 'Anita', 'list', 'anita@a.example', '+91 90000 00001');
      await linkContact(rows.enquiries.b, 'Bhaskar', 'list', 'bhaskar@b.example', '+91 90000 00002');

      const res = await get(salesA.cookie, '/api/enquiries');
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(idsOf(res.body), [rows.enquiries.a], 'only A’s enquiry');
      // contact_email exists on v_enquiries and not on enquiries, so its
      // presence is what proves the scoped read came from the view.
      assert.equal(res.body.data[0].contact_email, 'anita@a.example', 'read back through v_enquiries');
      assert.equal(res.body.data[0].contact_phone, '+91 90000 00001');
      assert.equal(res.body.total, 1, 'and the count is the count of that list');
      assert.ok(!text(res).includes('bhaskar@b.example'), 'nothing of B’s comes with it');
    });

    test('a scoped detail read comes from the view; another user’s is 404', async () => {
      await setUp();
      await linkContact(rows.enquiries.a, 'Anita', 'detail', 'anita@a.example', '+91 90000 00001');
      await linkContact(rows.enquiries.b, 'Bhaskar', 'detail', 'bhaskar@b.example', '+91 90000 00002');

      const own = await get(salesA.cookie, `/api/enquiries/${rows.enquiries.a}`);
      assert.equal(own.status, 200, JSON.stringify(own.body));
      assert.equal(own.body.data.contact_email, 'anita@a.example',
        'the view’s own column survives the ownership predicate');

      // 404 and not 403, as everywhere else: the answer must not confirm
      // that B’s enquiry exists.
      assert.equal((await get(salesA.cookie, `/api/enquiries/${rows.enquiries.b}`)).status, 404);
      assert.equal((await get(salesA.cookie, `/api/enquiries/${rows.enquiries.none}`)).status, 404);
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

    /**
     * Where the two features actually meet. Since client-data-gaps.md gap 1,
     * saveEnquiry writes the contact's address and *then* converts, both in
     * the one transaction. Each half is covered alone — clientContacts.test.js
     * for the address, the tests above for the responsibility that carries
     * across — but nothing ever sent an address through a conversion, so
     * nothing proved the two survive each other.
     */
    test('a won enquiry writes the contact’s address and still carries origin across', async () => {
      await setUp();
      // The fixture's enquiries are owned but unattributed, and origin is
      // what Phase 4 preserves rather than invents — so give this one a
      // verified originator for the conversion to carry.
      await db.query(
        `UPDATE enquiries SET originating_user_id = $1, originating_user_snapshot_id = $1,
                              originating_user_name = 'Sam' WHERE id = $2`,
        [salesA.user.id, rows.enquiries.a]);

      const res = await request(app).patch(`/api/enquiries/${rows.enquiries.a}`)
        .set('Cookie', salesA.cookie)
        .send({
          status: 'Won - Quotation Sent',
          contact_person: 'Ravi Kumar',
          contact_email: 'ravi@clienta.example',
          contact_phone: '+91 98765 43210',
        });
      assert.equal(res.status, 200, JSON.stringify(res.body));

      // main's half: the address landed on the contact the trigger linked.
      const [contact] = (await db.query(
        `SELECT c.email, c.phone FROM contacts c
           JOIN enquiries e ON e.contact_id = c.id WHERE e.id = $1`, [rows.enquiries.a])).rows;
      assert.ok(contact, 'the trigger linked a contact for the address to land on');
      assert.equal(contact.email, 'ravi@clienta.example', 'the address is on the contact');
      assert.equal(contact.phone, '+91 98765 43210');

      // #141's half: the quotation the same transaction went on to create.
      const [made] = (await db.query(
        `SELECT owner_user_id, originating_user_id, originating_user_snapshot_id, originating_user_name
           FROM quotations WHERE remarks LIKE 'From enquiry%'`)).rows;
      assert.ok(made, 'the conversion still happened');
      assert.equal(made.owner_user_id, salesA.user.id, 'responsibility carried across');
      assert.equal(made.originating_user_id, salesA.user.id, 'and so did the verified origin');
      assert.equal(made.originating_user_snapshot_id, salesA.user.id);
      assert.equal(made.originating_user_name, 'Sam');
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
      const mine = await get(salesA.cookie, '/api/reports/sales');
      assert.equal(mine.status, 200);
      const body = JSON.stringify(mine.body);
      assert.ok(body.includes('Client A'), 'their own customer is counted');
      assert.ok(!body.includes('Client B'), 'B’s customer is not');
      assert.ok(!body.includes('Client NONE'), 'nor an unassigned one');

      const all = JSON.stringify((await get(admin.cookie, '/api/reports/sales')).body);
      assert.ok(all.includes('Client B') && all.includes('Client NONE'), 'an admin sees all of it');
    });

    test('the report is scoped, and still computes the same way', async () => {
      await setUp();
      const mine = await get(salesA.cookie, '/api/reports/sales');
      const all = await get(admin.cookie, '/api/reports/sales');
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
      // An admin who narrowed the page to one owner gets that owner's detailed CSV.
      const narrowed = text(await get(admin.cookie, `/api/export/sales-report/customers.csv?owner=${salesA.user.id}`));
      assert.ok(narrowed.includes('Client A') && !narrowed.includes('Client B'), 'the owner filter reaches the detailed tables');
    });

    test('the PDF builds for both, from each one’s own rows', async () => {
      await setUp();
      const mine = await get(salesA.cookie, '/api/export/sales-report.pdf');
      const all = await get(admin.cookie, '/api/export/sales-report.pdf');
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

  // ======================================================= global search

  /**
   * The command palette (GET /api/search) reads the same views the list
   * pages read, so it is the easiest place for row-level access to go
   * missing and the worst place for it to: two characters and somebody
   * else's quotation numbers, clients and project ids would come back in
   * one response, whatever the list endpoints say.
   */
  describe('the global search palette', () => {
    const titlesOf = (body, type) => body.data.filter((r) => r.type === type).map((r) => r.title).sort();

    test('a sales user finds only their own scoped records', async () => {
      await setUp();
      const res = await get(salesA.cookie, '/api/search?q=Client');
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(titlesOf(res.body, 'deal'), ['CTZ/QT/2026/001'], 'quotations');
      assert.deepEqual(titlesOf(res.body, 'enquiry'), ['CTZ/ENQ/2026/001'], 'enquiries');
      assert.deepEqual(titlesOf(res.body, 'project'), ['PRJ-2026-001'], 'projects');
    });

    test('an admin finds all of them, owned and unowned', async () => {
      await setUp();
      const res = await get(admin.cookie, '/api/search?q=Client');
      assert.equal(res.status, 200);
      assert.deepEqual(
        titlesOf(res.body, 'deal'),
        ['CTZ/QT/2026/001', 'CTZ/QT/2026/002', 'CTZ/QT/2026/003']);
      assert.deepEqual(
        titlesOf(res.body, 'enquiry'),
        ['CTZ/ENQ/2026/001', 'CTZ/ENQ/2026/002', 'CTZ/ENQ/2026/003']);
      assert.deepEqual(
        titlesOf(res.body, 'project'),
        ['PRJ-2026-001', 'PRJ-2026-002', 'PRJ-2026-003']);
    });

    test('naming another user\'s record outright still finds nothing', async () => {
      await setUp();
      // B's and the unassigned records, asked for by their own references —
      // the one search that would confirm they exist.
      for (const q of [
        'CTZ/QT/2026/002', 'CTZ/QT/2026/003',
        'CTZ/ENQ/2026/002', 'CTZ/ENQ/2026/003',
        'PRJ-2026-002', 'PRJ-2026-003',
      ]) {
        const res = await get(salesA.cookie, `/api/search?q=${encodeURIComponent(q)}`);
        assert.equal(res.status, 200, q);
        assert.deepEqual(res.body.data, [], `${q} must not surface`);
      }
    });

    test('purchase orders and payment stages in the palette follow their parent', async () => {
      await setUp();
      const projectOf = async (key) => (await db.query(
        'SELECT project_id FROM projects WHERE id = $1', [rows.projects[key]])).rows[0].project_id;
      for (const key of ['a', 'b', 'none']) {
        const po = `PO-SEARCH-${key.toUpperCase()}`;
        await db.query(
          `INSERT INTO purchase_orders (po_number, project_id, po_date, po_value, currency)
           VALUES ($1, $2, '2026-05-02', 100000, 'INR')`, [po, await projectOf(key)]);
        await db.query(
          `INSERT INTO payment_stages (po_number, stage_no, stage_name, trigger_event, stage_percent, invoice_no)
           VALUES ($1, 1, 'Advance', 'On PO Registration', 0.5, $2)`, [po, `INV-${key.toUpperCase()}`]);
      }

      const mine = await get(salesA.cookie, '/api/search?q=PO-SEARCH');
      assert.deepEqual(titlesOf(mine.body, 'order'), ['PO-SEARCH-A']);
      const all = await get(admin.cookie, '/api/search?q=PO-SEARCH');
      assert.deepEqual(titlesOf(all.body, 'order'), ['PO-SEARCH-A', 'PO-SEARCH-B', 'PO-SEARCH-NONE']);

      const stages = await get(salesA.cookie, '/api/search?q=INV-');
      assert.deepEqual(titlesOf(stages.body, 'stage'), ['INV-A']);
    });

    test('shared master data stays searchable by everybody', async () => {
      await setUp();
      // Companies are created by the link trigger from the client names
      // above and belong to nobody in particular — a client's name and
      // sector are not one salesperson's secret, so they are not scoped.
      const res = await get(salesA.cookie, '/api/search?q=Client');
      assert.ok(
        res.body.data.some((r) => r.type === 'company'),
        'companies are still found'
      );
    });
  });

  // ============================ rows that inherit ownership from a record

  /**
   * The child tables main added after Phase 2C was written: a quotation's
   * priced lines, the payments ledger, and a project's costs. None of them
   * carries an owner column — each takes its access from the record above
   * it through a declared foreign key.
   */
  describe('child records inherit their parent\'s ownership', () => {
    test('quotation lines, payments and project costs follow their parent', async () => {
      await setUp();
      const stageOf = async (key) => {
        const projectId = (await db.query(
          'SELECT project_id FROM projects WHERE id = $1', [rows.projects[key]])).rows[0].project_id;
        const po = `PO-CHILD-${key}`;
        await db.query(
          `INSERT INTO purchase_orders (po_number, project_id, po_date, po_value, currency)
           VALUES ($1, $2, '2026-05-02', 100000, 'INR')`, [po, projectId]);
        const { rows: [stage] } = await db.query(
          `INSERT INTO payment_stages (po_number, stage_no, stage_name, trigger_event, stage_percent)
           VALUES ($1, 1, 'Advance', 'On PO Registration', 0.5) RETURNING id`, [po]);
        return { projectId, stage: stage.id };
      };

      const made = {};
      for (const key of ['a', 'b', 'none']) {
        const { projectId, stage } = await stageOf(key);
        made[key] = {
          line: (await db.query(
            `INSERT INTO quotation_lines (quotation_id, description, qty, rate)
             VALUES ($1, $2, 1, 500) RETURNING id`,
            [rows.quotations[key], `Line ${key}`])).rows[0].id,
          payment: (await db.query(
            `INSERT INTO payments (stage_id, amount, received_on)
             VALUES ($1, 1000, '2026-05-10') RETURNING id`, [stage])).rows[0].id,
          cost: (await db.query(
            `INSERT INTO project_costs (project_id, description, amount, currency)
             VALUES ($1, $2, 250, 'INR') RETURNING id`,
            [projectId, `Cost ${key}`])).rows[0].id,
        };
      }

      const cases = [
        ['quotation-lines', 'line'],
        ['payments', 'payment'],
        ['project-costs', 'cost'],
      ];
      for (const [resource, field] of cases) {
        const list = await get(salesA.cookie, `/api/${resource}`);
        assert.equal(list.status, 200, `${resource}: ${JSON.stringify(list.body)}`);
        assert.deepEqual(idsOf(list.body), [made.a[field]], `${resource}: only A's`);
        assert.equal(list.body.total, 1, `${resource}: the count is scoped too`);

        assert.equal(
          (await get(admin.cookie, `/api/${resource}`)).body.total, 3,
          `${resource}: an admin sees all three`);

        for (const key of ['b', 'none']) {
          assert.equal(
            (await get(salesA.cookie, `/api/${resource}/${made[key][field]}`)).status, 404,
            `${resource}: ${key}'s row is not found`);
        }
        assert.equal(
          (await get(salesA.cookie, `/api/${resource}/${made.a[field]}`)).status, 200,
          `${resource}: A's own row opens`);
      }
    });
  });

  // ============================ the record endpoints latest main added

  /**
   * Phase 2C was written against the routes that existed then. Main has
   * since added a timeline, a touch log, a quotation document, an
   * acceptance flow, an approval flow, a pipeline board and a one-step
   * register — every one of them addressing a named enquiry, quotation,
   * project, purchase order or payment stage.
   *
   * Each is the same shape of hole: name somebody else's record and the
   * endpoint answers about it. So each is tested the same way — A reaches
   * A's, A cannot reach B's or an unassigned one, and an admin reaches all
   * three.
   */
  describe('record endpoints added after Phase 2C', () => {
    const post = (cookie, path, body = {}) => request(app).post(path).set('Cookie', cookie).send(body);

    /** A purchase order under `key`'s project, and an invoiced stage under it. */
    async function chain(key) {
      const projectId = (await db.query(
        'SELECT project_id FROM projects WHERE id = $1', [rows.projects[key]])).rows[0].project_id;
      const po = `PO-REC-${key.toUpperCase()}`;
      await db.query(
        `INSERT INTO purchase_orders (po_number, project_id, po_date, po_value, currency)
         VALUES ($1, $2, '2026-05-02', 100000, 'INR')`, [po, projectId]);
      const { rows: [stage] } = await db.query(
        `INSERT INTO payment_stages (po_number, stage_no, stage_name, trigger_event, stage_percent, invoice_no, invoice_date)
         VALUES ($1, 1, 'Advance', 'On PO Registration', 0.5, $2, '2026-05-03') RETURNING id`,
        [po, `INV-REC-${key.toUpperCase()}`]);
      await db.query(
        `INSERT INTO payments (stage_id, amount, received_on) VALUES ($1, 1000, '2026-05-10')`, [stage.id]);
      return { projectId, po, stage: stage.id };
    }

    /** The natural key each entity is addressed by, per owner. */
    async function refs(key) {
      const one = async (sql, id) => (await db.query(sql, [id])).rows[0];
      return {
        enquiry: (await one('SELECT enquiry_no AS k FROM enquiries WHERE id = $1', rows.enquiries[key])).k,
        quotation: (await one('SELECT quotation_no AS k FROM quotations WHERE id = $1', rows.quotations[key])).k,
        project: (await one('SELECT project_id AS k FROM projects WHERE id = $1', rows.projects[key])).k,
      };
    }

    // --------------------------------------------------------- timeline

    test('the timeline of another user’s record is not found', async () => {
      await setUp();
      const chains = { a: await chain('a'), b: await chain('b'), none: await chain('none') };
      const mine = await refs('a');
      const theirs = await refs('b');
      const nobody = await refs('none');

      const url = (entity, id) => `/api/timeline?entity=${entity}&id=${encodeURIComponent(id)}`;

      for (const [entity, id] of [['enquiry', mine.enquiry], ['quotation', mine.quotation], ['project', mine.project],
        ['purchase_order', chains.a.po], ['payment_stage', String(chains.a.stage)]]) {
        assert.equal((await get(salesA.cookie, url(entity, id))).status, 200, `A opens their own ${entity}`);
      }

      for (const [owner, r, ch] of [['B', theirs, chains.b], ['nobody', nobody, chains.none]]) {
        for (const [entity, id] of [['enquiry', r.enquiry], ['quotation', r.quotation], ['project', r.project],
          ['purchase_order', ch.po], ['payment_stage', String(ch.stage)]]) {
          const res = await get(salesA.cookie, url(entity, id));
          assert.equal(res.status, 404, `${owner}'s ${entity}: ${JSON.stringify(res.body)}`);
          assert.ok(!JSON.stringify(res.body).includes('Client B'), 'and nothing of theirs comes back');
        }
      }

      // The admin reaches every one of them.
      for (const r of [mine, theirs, nobody]) {
        for (const [entity, id] of [['enquiry', r.enquiry], ['quotation', r.quotation], ['project', r.project]]) {
          assert.equal((await get(admin.cookie, url(entity, id))).status, 200, `admin opens ${entity} ${id}`);
        }
      }
    });

    test('a company timeline stays open: master data is not one person’s', async () => {
      await setUp();
      const { rows: [c] } = await db.query('SELECT id FROM companies LIMIT 1');
      if (!c) return; // no company was created by the link trigger; nothing to assert
      assert.equal((await get(salesA.cookie, `/api/timeline?entity=company&id=${c.id}`)).status, 200);
    });

    // --------------------------------------------------- communications

    test('the touch log and its contacts follow the record', async () => {
      await setUp();
      const mine = await refs('a'); const theirs = await refs('b'); const nobody = await refs('none');

      for (const path of ['/api/communications', '/api/communications/contacts']) {
        assert.equal((await get(salesA.cookie, `${path}?entity=quotation&id=${encodeURIComponent(mine.quotation)}`)).status, 200, `${path}: own`);
        for (const [label, r] of [['B', theirs], ['unassigned', nobody]]) {
          assert.equal(
            (await get(salesA.cookie, `${path}?entity=quotation&id=${encodeURIComponent(r.quotation)}`)).status, 404,
            `${path}: ${label}`);
        }
        assert.equal((await get(admin.cookie, `${path}?entity=quotation&id=${encodeURIComponent(theirs.quotation)}`)).status, 200, `${path}: admin`);
      }
    });

    test('a touch cannot be logged against another user’s record', async () => {
      await setUp();
      const mine = await refs('a'); const theirs = await refs('b');
      const touch = (ref) => ({ entity: 'quotation', entity_id: ref, channel: 'call', summary: 'Called them' });

      assert.equal((await post(salesA.cookie, '/api/communications', touch(mine.quotation))).status, 201);
      assert.equal((await post(salesA.cookie, '/api/communications', touch(theirs.quotation))).status, 404);
      assert.equal((await post(admin.cookie, '/api/communications', touch(theirs.quotation))).status, 201);

      const { rows } = await db.query('SELECT entity_id FROM communications ORDER BY id');
      assert.deepEqual(rows.map((r) => r.entity_id), [mine.quotation, theirs.quotation], 'B’s row is the admin’s, not A’s');
    });

    test('the quiet-deals worklist carries only the caller’s records', async () => {
      await setUp();
      // Quiet means nothing has happened for a while, and the fixtures were
      // created a moment ago — so date them back, or every list is empty and
      // the assertions below would pass without testing anything.
      await db.query(`UPDATE enquiries SET enquiry_date = DATE '2020-01-01', created_at = TIMESTAMPTZ '2020-01-01'`);
      const mine = await get(salesA.cookie, '/api/communications/no-contact?days=1');
      assert.equal(mine.status, 200, JSON.stringify(mine.body));
      const body = JSON.stringify(mine.body);
      for (const leak of ['CTZ/QT/2026/002', 'CTZ/QT/2026/003', 'CTZ/ENQ/2026/002', 'CTZ/ENQ/2026/003']) {
        assert.ok(!body.includes(leak), `must not carry ${leak}`);
      }
      assert.deepEqual(mine.body.data.enquiries.map((e) => e.ref), ['CTZ/ENQ/2026/001'], 'A’s own, and only that');

      const all = await get(admin.cookie, '/api/communications/no-contact?days=1');
      assert.equal(all.status, 200);
      assert.deepEqual(
        all.body.data.enquiries.map((e) => e.ref).sort(),
        ['CTZ/ENQ/2026/001', 'CTZ/ENQ/2026/002', 'CTZ/ENQ/2026/003'],
        'the admin sees every quiet enquiry, owned and unowned');
    });

    // ----------------------------------------------- the quotation itself

    test('the quotation document, its acceptances and its approvals follow ownership', async () => {
      await setUp();
      const mine = await refs('a'); const theirs = await refs('b'); const nobody = await refs('none');
      const q = (ref) => encodeURIComponent(ref);

      assert.equal((await get(salesA.cookie, `/api/quotations/${q(mine.quotation)}/full`)).status, 200);
      assert.equal((await get(salesA.cookie, `/api/quotations/${q(mine.quotation)}/acceptances`)).status, 200);

      for (const [label, r] of [['B', theirs], ['unassigned', nobody]]) {
        assert.equal((await get(salesA.cookie, `/api/quotations/${q(r.quotation)}/full`)).status, 404, `full: ${label}`);
        // A list endpoint answers with an empty list rather than a 404 — the
        // rows are simply not reachable, which is the same information.
        const acc = await get(salesA.cookie, `/api/quotations/${q(r.quotation)}/acceptances`);
        assert.equal(acc.status, 200, `acceptances: ${label}`);
        assert.deepEqual(acc.body.data, [], `acceptances: ${label} carries nothing`);

        assert.equal((await post(salesA.cookie, `/api/quotations/${q(r.quotation)}/accept`, { accepted_by_name: 'Riya' })).status, 404, `accept: ${label}`);
        assert.equal((await post(salesA.cookie, `/api/quotations/${q(r.quotation)}/revise`, { note: 'x' })).status, 404, `revise: ${label}`);
        assert.equal((await post(salesA.cookie, `/api/quotations/${q(r.quotation)}/approval/request`, { reason: 'why' })).status, 404, `approval: ${label}`);
        assert.equal((await post(salesA.cookie, `/api/quotations/${q(r.quotation)}/acceptances/1/revoke`)).status, 404, `revoke: ${label}`);
      }

      // Nothing of B's was changed by any of those attempts.
      const { rows: [b] } = await db.query(
        'SELECT accepted_at, approval_status, revision FROM quotations WHERE id = $1', [rows.quotations.b]);
      assert.equal(b.accepted_at, null);
      assert.equal(b.approval_status, 'not_needed');
      assert.equal(b.revision, 0);

      // The admin reaches all of them.
      assert.equal((await get(admin.cookie, `/api/quotations/${q(theirs.quotation)}/full`)).status, 200);
      assert.equal((await post(admin.cookie, `/api/quotations/${q(nobody.quotation)}/accept`, { accepted_by_name: 'Riya' })).status, 200);
    });

    // ------------------------------------------------------ the pipeline

    test('the pipeline board shows only the caller’s cards', async () => {
      await setUp();
      // Cards are the open quotations; the fixtures are all won, so open a
      // couple by putting them on an open stage.
      const { rows: [stage] } = await db.query(`SELECT id FROM pipeline_stages WHERE type = 'open' ORDER BY sort_order LIMIT 1`);
      await db.query(`UPDATE quotations SET status = 'Submitted', stage_id = $1`, [stage.id]);

      const mine = await get(salesA.cookie, '/api/pipeline');
      assert.equal(mine.status, 200, JSON.stringify(mine.body));
      assert.deepEqual(mine.body.data.cards.map((c) => c.id), [rows.quotations.a], 'only A’s card');
      const stageTotals = mine.body.data.stages.reduce((n, s) => n + s.count, 0);
      assert.equal(stageTotals, 1, 'and the stage totals are counted from those cards');

      const all = await get(admin.cookie, '/api/pipeline');
      assert.equal(all.body.data.cards.length, 3, 'the admin sees every card');
    });

    test('a card that is not the caller’s cannot be moved', async () => {
      await setUp();
      const { rows: [open] } = await db.query(`SELECT id FROM pipeline_stages WHERE type = 'open' ORDER BY sort_order LIMIT 1`);
      const theirs = await refs('b'); const nobody = await refs('none'); const mine = await refs('a');

      // A card already sits on a stage before anybody touches it: the
      // quotation_stage_sync() trigger derives stage_id from status on
      // INSERT, and the fixtures are created 'Won - PO Received'. So "did not
      // move" is read against where the card actually was, not against null.
      const stageOf = async (key) =>
        (await db.query('SELECT stage_id FROM quotations WHERE id = $1', [rows.quotations[key]])).rows[0].stage_id;
      const before = { b: await stageOf('b'), none: await stageOf('none') };
      assert.notEqual(before.b, open.id, 'the fixture must not already be on the stage the move targets');

      assert.equal((await post(salesA.cookie, `/api/pipeline/${encodeURIComponent(mine.quotation)}/move`, { stage_id: open.id })).status, 200);
      for (const [label, r] of [['B', theirs], ['unassigned', nobody]]) {
        assert.equal(
          (await post(salesA.cookie, `/api/pipeline/${encodeURIComponent(r.quotation)}/move`, { stage_id: open.id })).status, 404, label);
      }
      for (const key of ['b', 'none']) {
        assert.equal(await stageOf(key), before[key], `${key}'s card is where it was`);
        assert.notEqual(await stageOf(key), open.id, `${key}'s card did not move to the requested stage`);
      }

      assert.equal(
        (await post(admin.cookie, `/api/pipeline/${encodeURIComponent(theirs.quotation)}/move`, { stage_id: open.id })).status, 200,
        'the admin may move it');
      assert.equal(await stageOf('b'), open.id, 'and the admin’s move actually lands');
    });

    // ------------------------------------------------------- registering

    test('registering a PO needs a quotation the caller may reach, and the project it makes is theirs', async () => {
      await setUp();
      const mine = await refs('a'); const theirs = await refs('b'); const nobody = await refs('none');
      // The fixtures are already won and linked to a project, so give A a
      // fresh unregistered quotation to register.
      const { rows: [fresh] } = await db.query(
        `INSERT INTO quotations (quotation_no, client_name, sales_person, quotation_date, quotation_value,
                                 currency, status, owner_user_id, originating_user_id, originating_user_snapshot_id, originating_user_name)
         VALUES ('CTZ/QT/2026/900', 'Client A', 'Ramesh', '2026-05-01', 1000, 'INR', 'Submitted', $1, $1, $1, 'Sam')
         RETURNING quotation_no`, [salesA.user.id]);

      const body = (po) => ({ po_number: po, po_date: '2026-06-01', po_value: 1000, currency: 'INR',
        payment_terms_template_id: 0, onboarding_template_id: 0 });

      for (const [label, r] of [['B', theirs], ['unassigned', nobody]]) {
        const res = await post(salesA.cookie, `/api/quotations/${encodeURIComponent(r.quotation)}/register`, body(`PO-REG-${label}`));
        assert.equal(res.status, 404, `${label}: ${JSON.stringify(res.body)}`);
      }
      assert.equal(
        (await db.query('SELECT count(*)::int n FROM purchase_orders')).rows[0].n, 0, 'nothing was registered');

      const ok = await post(salesA.cookie, `/api/quotations/${encodeURIComponent(fresh.quotation_no)}/register`, body('PO-REG-A'));
      assert.equal(ok.status, 201, JSON.stringify(ok.body));

      // Responsibility carries from the quotation to the project it becomes,
      // the same rule /convert follows — without it the salesperson who
      // registered their own PO could not open the project it created.
      const { rows: [created] } = await db.query(
        `SELECT p.owner_user_id, p.originating_user_id FROM projects p
          JOIN purchase_orders po ON po.project_id = p.project_id WHERE po.po_number = 'PO-REG-A'`);
      assert.equal(created.owner_user_id, salesA.user.id, 'the new project is A’s');
      assert.equal(created.originating_user_id, salesA.user.id);
      assert.equal(
        (await get(salesA.cookie, `/api/projects`)).body.data.filter((p) => p.owner_user_id === salesA.user.id).length, 2,
        'and A can see it');

      assert.equal(
        (await post(salesA.cookie, `/api/quotations/${encodeURIComponent(mine.quotation)}/register`,
          { ...body('PO-REG-OTHER'), project_id: (await refs('b')).project })).status, 422,
        'and it cannot be hung off B’s project');
    });

    // -------------------------------------------- receipts under a stage

    test('the receipts on a stage follow the purchase order above it', async () => {
      await setUp();
      const chains = { a: await chain('a'), b: await chain('b'), none: await chain('none') };

      const own = await get(salesA.cookie, `/api/collections/stages/${chains.a.stage}/payments`);
      assert.equal(own.status, 200);
      assert.equal(own.body.data.length, 1, 'A sees the receipt on their own stage');

      for (const key of ['b', 'none']) {
        const res = await get(salesA.cookie, `/api/collections/stages/${chains[key].stage}/payments`);
        assert.equal(res.status, 200, key);
        assert.deepEqual(res.body.data, [], `${key}'s receipts are not reachable`);
      }

      for (const key of ['a', 'b', 'none']) {
        assert.equal(
          (await get(admin.cookie, `/api/collections/stages/${chains[key].stage}/payments`)).body.data.length, 1,
          `the admin sees ${key}'s receipt`);
      }
    });
  });

  // ====================== child rows that name their parent in text

  /**
   * Tasks, notes and attachments are filed against a record as (entity,
   * entity_id) text. The timeline that reads them is gated, but the generic
   * CRUD router is a second door to the same rows — and `?entity=quotation&
   * entity_id=<anyone's number>` on it was the way round the gate.
   *
   * Ownership comes from the record named, never from a column on these
   * tables: they have none, and adding one would be inventing a second
   * answer to a question the parent already answers.
   */
  describe('tasks, notes and attachments follow the record they are filed against', () => {
    const post = (cookie, path, body = {}) => request(app).post(path).set('Cookie', cookie).send(body);
    const patch = (cookie, path, body) => request(app).patch(path).set('Cookie', cookie).send(body);
    const del = (cookie, path) => request(app).delete(path).set('Cookie', cookie);

    /** One task, note and attachment on each owner's quotation, plus a company's. */
    async function fileRows() {
      const made = {};
      for (const key of ['a', 'b', 'none']) {
        const { rows: [q] } = await db.query('SELECT quotation_no FROM quotations WHERE id = $1', [rows.quotations[key]]);
        const { rows: [doc] } = await db.query(
          `INSERT INTO documents (storage_key, file_name, content_type, size_bytes)
           VALUES ($1, $2, 'application/pdf', 10) RETURNING id`,
          [`child-key-${key}`, `file-${key}.pdf`]);
        made[key] = {
          ref: q.quotation_no,
          document: doc.id,
          task: (await db.query(
            `INSERT INTO tasks (entity, entity_id, title) VALUES ('quotation', $1, $2) RETURNING id`,
            [q.quotation_no, `Chase ${key}`])).rows[0].id,
          note: (await db.query(
            `INSERT INTO notes (entity, entity_id, body) VALUES ('quotation', $1, $2) RETURNING id`,
            [q.quotation_no, `Note ${key}`])).rows[0].id,
          attachment: (await db.query(
            `INSERT INTO attachments (entity, entity_id, document_id, label) VALUES ('quotation', $1, $2, $3) RETURNING id`,
            [q.quotation_no, doc.id, `Label ${key}`])).rows[0].id,
        };
      }
      return made;
    }

    const KINDS = [['tasks', 'task'], ['notes', 'note'], ['attachments', 'attachment']];

    test('a sales user lists only the rows filed against records they own', async () => {
      await setUp();
      const made = await fileRows();
      for (const [resource, field] of KINDS) {
        const res = await get(salesA.cookie, `/api/${resource}`);
        assert.equal(res.status, 200, `${resource}: ${JSON.stringify(res.body)}`);
        assert.deepEqual(idsOf(res.body), [made.a[field]], `${resource}: only A's`);
        assert.equal(res.body.total, 1, `${resource}: the count is scoped too`);
        assert.equal((await get(admin.cookie, `/api/${resource}`)).body.total, 3, `${resource}: admin sees all three`);
      }
    });

    test('filtering by another user’s record returns nothing rather than their rows', async () => {
      await setUp();
      const made = await fileRows();
      for (const [resource] of KINDS) {
        for (const key of ['b', 'none']) {
          const res = await get(salesA.cookie,
            `/api/${resource}?entity=quotation&entity_id=${encodeURIComponent(made[key].ref)}`);
          assert.equal(res.status, 200, resource);
          assert.deepEqual(res.body.data, [], `${resource}: ${key}'s rows must not surface`);
        }
      }
    });

    test('opening one of another user’s rows by id is not found', async () => {
      await setUp();
      const made = await fileRows();
      for (const [resource, field] of KINDS) {
        assert.equal((await get(salesA.cookie, `/api/${resource}/${made.a[field]}`)).status, 200, `${resource}: own`);
        for (const key of ['b', 'none']) {
          assert.equal((await get(salesA.cookie, `/api/${resource}/${made[key][field]}`)).status, 404, `${resource}: ${key}`);
          assert.equal((await get(admin.cookie, `/api/${resource}/${made[key][field]}`)).status, 200, `${resource}: admin, ${key}`);
        }
      }
    });

    test('a row cannot be created under another user’s record', async () => {
      await setUp();
      const made = await fileRows();
      // A's attempts and the admin's legitimate write are told apart by their
      // text: the admin is *supposed* to be able to file under B, so counting
      // rows under B without distinguishing them counts the admin's and
      // proves nothing about A.
      const bodies = {
        tasks: (ref, text) => ({ entity: 'quotation', entity_id: ref, title: text }),
        notes: (ref, text) => ({ entity: 'quotation', entity_id: ref, body: text }),
      };
      for (const resource of ['tasks', 'notes']) {
        assert.equal((await post(salesA.cookie, `/api/${resource}`, bodies[resource](made.a.ref, 'A: own'))).status, 201, `${resource}: own`);
        for (const key of ['b', 'none']) {
          const res = await post(salesA.cookie, `/api/${resource}`, bodies[resource](made[key].ref, 'A: sneak'));
          assert.equal(res.status, 404, `${resource}: ${key} — ${JSON.stringify(res.body)}`);
        }
        assert.equal((await post(admin.cookie, `/api/${resource}`, bodies[resource](made.b.ref, 'Admin: allowed'))).status, 201, `${resource}: admin`);
      }
      // Three fixtures, plus A's own and the admin's — and nothing A filed
      // under B or under the unassigned record, anywhere in the table.
      for (const [t, column, fixture] of [['tasks', 'title', 'Chase b'], ['notes', 'body', 'Note b']]) {
        assert.equal((await db.query(`SELECT count(*)::int n FROM ${t}`)).rows[0].n, 5, t);
        assert.equal(
          (await db.query(`SELECT count(*)::int n FROM ${t} WHERE ${column} = 'A: sneak'`)).rows[0].n, 0,
          `${t}: nothing A tried to file under somebody else exists`);
        const { rows: underB } = await db.query(
          `SELECT ${column} AS text FROM ${t} WHERE entity_id = $1 ORDER BY id`, [made.b.ref]);
        assert.deepEqual(
          underB.map((r) => r.text), [fixture, 'Admin: allowed'],
          `${t}: only the fixture and the admin's row sit under B`);
      }
    });

    test('a row under another user’s record cannot be edited or deleted', async () => {
      await setUp();
      const made = await fileRows();
      const edits = { tasks: { title: 'Taken' }, notes: { body: 'Taken' }, attachments: { label: 'Taken' } };
      for (const [resource, field] of KINDS) {
        for (const key of ['b', 'none']) {
          assert.equal((await patch(salesA.cookie, `/api/${resource}/${made[key][field]}`, edits[resource])).status, 404, `${resource} patch: ${key}`);
          assert.equal((await del(salesA.cookie, `/api/${resource}/${made[key][field]}`)).status, 404, `${resource} delete: ${key}`);
        }
        assert.equal((await patch(salesA.cookie, `/api/${resource}/${made.a[field]}`, edits[resource])).status, 200, `${resource} patch: own`);
      }
      // Nothing of B's moved.
      const { rows: [b] } = await db.query('SELECT title FROM tasks WHERE id = $1', [made.b.task]);
      assert.equal(b.title, 'Chase b');
      assert.equal((await db.query('SELECT count(*)::int n FROM notes')).rows[0].n, 3, 'all three notes still there');
    });

    test('a row cannot be moved onto another user’s record', async () => {
      await setUp();
      const made = await fileRows();
      // A's own task, re-pointed at B's quotation: the row is reachable, the
      // destination is not, and a task landing on B's timeline is a write
      // into B's record.
      const res = await patch(salesA.cookie, `/api/tasks/${made.a.task}`, { entity_id: made.b.ref });
      assert.equal(res.status, 404, JSON.stringify(res.body));
      const { rows: [t] } = await db.query('SELECT entity_id FROM tasks WHERE id = $1', [made.a.task]);
      assert.equal(t.entity_id, made.a.ref, 'it stayed where it was');

      // Moving it to another record of A's own is ordinary work.
      const { rows: [mine] } = await db.query('SELECT enquiry_no FROM enquiries WHERE id = $1', [rows.enquiries.a]);
      assert.equal(
        (await patch(salesA.cookie, `/api/tasks/${made.a.task}`, { entity: 'enquiry', entity_id: mine.enquiry_no })).status, 200);

      // And an admin may move it anywhere.
      assert.equal(
        (await patch(admin.cookie, `/api/tasks/${made.a.task}`, { entity: 'quotation', entity_id: made.b.ref })).status, 200);
    });

    test('a company’s notes stay shared, as the company itself is', async () => {
      await setUp();
      const { rows: [c] } = await db.query('SELECT id FROM companies LIMIT 1');
      if (!c) return;
      const { rows: [n] } = await db.query(
        `INSERT INTO notes (entity, entity_id, body) VALUES ('company', $1, 'Shared') RETURNING id`, [String(c.id)]);
      assert.equal((await get(salesA.cookie, `/api/notes/${n.id}`)).status, 200, 'readable');
      assert.equal(
        (await post(salesA.cookie, '/api/notes', { entity: 'company', entity_id: String(c.id), body: 'Also shared' })).status,
        201, 'and writable, exactly as /api/companies is open');
    });

    test('the task summary counts what the task list shows, and no more', async () => {
      await setUp();
      await fileRows();
      const mine = await get(salesA.cookie, '/api/tasks/summary');
      assert.equal(mine.status, 200, JSON.stringify(mine.body));
      assert.equal(mine.body.data.open, 1, 'A’s one open task');
      assert.equal(
        mine.body.data.open, (await get(salesA.cookie, '/api/tasks')).body.total,
        'the badge and the list it opens agree');
      assert.equal((await get(admin.cookie, '/api/tasks/summary')).body.data.open, 3, 'the admin counts all three');
    });

    test('a file attached to another user’s record cannot be fetched', async () => {
      await setUp();
      const made = await fileRows();
      // Storage is not configured in the test process, so a readable document
      // gets as far as the storage error; an unreadable one is refused before
      // that. The distinction is the point.
      const own = await get(salesA.cookie, `/api/documents/${made.a.document}`);
      assert.notEqual(own.status, 404, 'A’s own file is not refused');
      for (const key of ['b', 'none']) {
        assert.equal((await get(salesA.cookie, `/api/documents/${made[key].document}`)).status, 404, `${key}'s file`);
        assert.notEqual((await get(admin.cookie, `/api/documents/${made[key].document}`)).status, 404, `admin, ${key}`);
      }
    });
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
