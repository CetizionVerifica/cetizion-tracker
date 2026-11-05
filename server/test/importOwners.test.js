import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';
import XLSX from 'xlsx';

/**
 * Imported deals belong to their salesperson, so their POs reach them.
 *
 * The bug: Orders showed an admin every PO and a salesperson only some.
 * A sales user sees a PO through a quotation or project they own, and the
 * sheet importer wrote the salesperson's name but never an owner, so every
 * imported deal was admin-only.
 *
 * Covers the owner list on a batch (import/owners.js), the choice for an
 * unmatched name, the commit refusing while a name is undecided, the owners
 * the commit writes, what each user's Orders list then holds, the admin's
 * "no owner" filter, and migration 104 for deals imported before the fix.
 *
 * The workbook is built here; no client file is used. The AI is off.
 * Needs TEST_DATABASE_URL (CI sets it); skipped otherwise.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
const MIGRATION = readFileSync(join(DB_DIR, 'migrations', '104_import_owners.sql'), 'utf8');
const PASSWORD = 'a-good-long-test-password';

const sheet = (rows) => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Deal Register – one row per deal'],
    ['Deal ID', 'Client', 'Client Contact', 'Service / Proposal', 'Sales Person', 'Deal Stage', 'Status Detail', 'Currency',
      'Proposal Date', 'Quoted Value', 'PO / WO No.', 'PO Date / Received', 'PO Value', 'PO (INR eq.)', 'Remarks / Source'],
    ...rows,
  ]), 'Deal Register');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
};
const won = (id, client, person, po) => [id, client, 'Asha', 'ASI Surveillance Audit', person, '4. Won – PO Received', 'PO received', 'INR',
  '01-Sep-2026', 100000, po, '05-Sep-2026', 100000, 100000, null];

describe('imported deals are owned by their salesperson', { skip: !ADMIN_URL && 'TEST_DATABASE_URL is not set' }, () => {
  let app; let pool; let db; let dbName;
  const people = {};

  before(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    dbName = `import_owners_${process.pid}_${Date.now()}`;
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    const url = new URL(ADMIN_URL); url.pathname = `/${dbName}`;
    db = new pg.Client({ connectionString: url.toString() });
    await db.connect();
    for (const f of ['schema.sql', 'views.sql']) await db.query(readFileSync(join(DB_DIR, f), 'utf8'));

    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = url.toString();
    process.env.AUTH_MODE = 'database';
    process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-to-pass';
    process.env.EMAIL_MODE = 'log';
    // Set, not deleted: dotenv would fill a deleted key in again from .env.
    process.env.OPENROUTER_API_KEY = '';
    const { createUser } = await import('../src/lib/users.js');
    for (const [key, name, role] of [
      ['alice', 'Alice Admin', 'admin'],
      ['priya', 'Priya Sharma', 'sales'],
      ['madhuri', 'Madhuri Pogir', 'sales'],
      ['leaver', 'Lee Leaver', 'sales'],
    ]) {
      people[key] = { user: await createUser({ name, email: `${key}@example.com`, password: PASSWORD, role }, db) };
    }
    ({ default: app } = await import('../src/app.js'));
    ({ pool } = await import('../src/db.js'));
    for (const key of Object.keys(people)) {
      const res = await request(app).post('/api/auth/login').send({ email: `${key}@example.com`, password: PASSWORD });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      people[key].cookie = res.headers['set-cookie'];
    }
  });

  after(async () => {
    await pool?.end().catch(() => {});
    await db?.end().catch(() => {});
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  });

  const as = (who) => (method, path) => request(app)[method](path).set('Cookie', people[who].cookie);
  const poNumbers = async (who, qs = '') => (await as(who)('get', `/api/purchase-orders${qs}`).expect(200)).body.data.map((r) => r.po_number).sort();

  let batch;

  test('an exact name is matched; any other waits for a choice', async () => {
    const res = await as('alice')('post', '/api/import/batches')
      .attach('file', sheet([won('CV-101', 'Owner Alpha', 'Priya  sharma', 'PO-ALPHA-1'), won('CV-102', 'Owner Beta', 'Madhuri', 'PO-BETA-1')]), 'owners.xlsx')
      .expect(201);
    batch = res.body.data;
    const owners = Object.fromEntries(batch.owners.map((o) => [o.key, o]));
    assert.equal(owners['priya sharma'].status, 'matched', 'case and spacing do not matter');
    assert.equal(owners['priya sharma'].owner_user_id, people.priya.user.id);
    assert.equal(owners.madhuri.status, 'undecided');
    assert.equal(owners.madhuri.owner_user_id, null);
  });

  test('the commit is refused while a name has no owner, and nothing is written', async () => {
    const res = await as('alice')('post', `/api/import/batches/${batch.id}/commit`).expect(422);
    assert.match(res.body.error.message, /Choose an owner .*Madhuri/);
    assert.equal((await db.query('SELECT count(*)::int n FROM purchase_orders')).rows[0].n, 0);
  });

  test('an owner must be an active sales user on a name that is on the sheet', async () => {
    await as('alice')('put', `/api/import/batches/${batch.id}/owners`).send({ key: 'Madhuri', user_id: people.alice.user.id }).expect(422);
    await as('alice')('put', `/api/import/batches/${batch.id}/owners`).send({ key: 'Somebody Else', user_id: people.madhuri.user.id }).expect(422);
    await as('priya')('put', `/api/import/batches/${batch.id}/owners`).send({ key: 'Madhuri', user_id: people.madhuri.user.id }).expect(403);
  });

  test('the admin\'s choice applies to every row with that name, and the commit writes the owners', async () => {
    const chosen = (await as('alice')('put', `/api/import/batches/${batch.id}/owners`).send({ key: 'Madhuri', user_id: people.madhuri.user.id }).expect(200)).body.data;
    assert.equal(chosen.owners.find((o) => o.key === 'madhuri').status, 'chosen');
    await as('alice')('post', `/api/import/batches/${batch.id}/commit`).expect(200);

    const owners = async (table, col, value) => (await db.query(`SELECT owner_user_id FROM ${table} WHERE ${col} = $1`, [value])).rows.map((r) => r.owner_user_id);
    const { rows: [alpha] } = await db.query("SELECT quotation_no, project_id FROM quotations WHERE client_name = 'Owner Alpha'");
    const { rows: [beta] } = await db.query("SELECT quotation_no, project_id FROM quotations WHERE client_name = 'Owner Beta'");
    assert.deepEqual(await owners('quotations', 'quotation_no', alpha.quotation_no), [people.priya.user.id]);
    assert.deepEqual(await owners('projects', 'project_id', alpha.project_id), [people.priya.user.id], 'the project takes its quotation\'s owner');
    assert.deepEqual(await owners('quotations', 'quotation_no', beta.quotation_no), [people.madhuri.user.id]);
    assert.deepEqual(await owners('projects', 'project_id', beta.project_id), [people.madhuri.user.id]);
    const { rows: history } = await db.query("SELECT count(*)::int n FROM ownership_history WHERE reason LIKE 'Owner set by the sheet import%'");
    assert.equal(history[0].n, 4, 'every assignment is in the ownership history');
  });

  test('each salesperson\'s Orders list holds their own POs, and the admin\'s holds all', async () => {
    assert.deepEqual(await poNumbers('alice'), ['PO-ALPHA-1', 'PO-BETA-1']);
    assert.deepEqual(await poNumbers('priya'), ['PO-ALPHA-1']);
    assert.deepEqual(await poNumbers('madhuri'), ['PO-BETA-1']);
    assert.deepEqual(await poNumbers('alice', '?unowned=1'), [], 'nothing imported is left without an owner');
  });

  test('"No owner" lists the POs no salesperson can see', async () => {
    await db.query("INSERT INTO projects (project_id, client_name, sales_person) VALUES ('PRJ-UNOWNED-1', 'Owner Gamma', 'Nobody Here')");
    await db.query("INSERT INTO purchase_orders (po_number, project_id, po_date, po_value) VALUES ('PO-GAMMA-1', 'PRJ-UNOWNED-1', '2026-09-07', 500)");
    assert.deepEqual(await poNumbers('alice', '?unowned=1'), ['PO-GAMMA-1']);
    assert.deepEqual(await poNumbers('priya', '?unowned=1'), [], 'a salesperson sees none of them');
  });

  test('migration 104 gives deals imported before the fix their owners, once', async () => {
    // As the old importer wrote them: a salesperson's name, no owner.
    await db.query(`INSERT INTO quotations (quotation_no, client_name, quotation_date, sales_person, status, po_received)
      VALUES ('CTZ/QT/OLD/1', 'Owner Delta', '2026-08-01', 'PRIYA SHARMA', 'Won - PO Received', true)`);
    await db.query("INSERT INTO projects (project_id, client_name, sales_person) VALUES ('PRJ-OLD-1', 'Owner Delta', NULL)");
    await db.query("UPDATE quotations SET project_id = 'PRJ-OLD-1' WHERE quotation_no = 'CTZ/QT/OLD/1'");
    await db.query("INSERT INTO purchase_orders (po_number, project_id, quotation_no, po_date, po_value) VALUES ('PO-DELTA-1', 'PRJ-OLD-1', 'CTZ/QT/OLD/1', '2026-08-05', 700)");
    assert.equal((await poNumbers('priya')).includes('PO-DELTA-1'), false, 'hidden from her before the migration');

    await db.query(MIGRATION);
    await db.query(MIGRATION); // safe to run again
    const owner = async (sql) => (await db.query(sql)).rows[0].owner_user_id;
    assert.equal(await owner("SELECT owner_user_id FROM quotations WHERE quotation_no = 'CTZ/QT/OLD/1'"), people.priya.user.id, 'matched by name, ignoring case');
    assert.equal(await owner("SELECT owner_user_id FROM projects WHERE project_id = 'PRJ-OLD-1'"), people.priya.user.id, 'the blank project takes its quotation\'s owner');
    assert.equal(await owner("SELECT owner_user_id FROM projects WHERE project_id = 'PRJ-UNOWNED-1'"), null, 'a name nobody carries stays unassigned');
    assert.equal((await poNumbers('priya')).includes('PO-DELTA-1'), true);
    const { rows } = await db.query("SELECT count(*)::int n FROM ownership_history WHERE reason LIKE '%(104)'");
    assert.equal(rows[0].n, 2, 'each assignment recorded once');
  });

  test('"No owner" also lists POs whose owner has left', async () => {
    await db.query("INSERT INTO projects (project_id, client_name, sales_person, owner_user_id) VALUES ('PRJ-LEFT-1', 'Owner Zeta', 'Lee Leaver', $1)", [people.leaver.user.id]);
    await db.query("INSERT INTO purchase_orders (po_number, project_id, po_date, po_value) VALUES ('PO-ZETA-1', 'PRJ-LEFT-1', '2026-09-08', 900)");
    assert.equal((await poNumbers('alice', '?unowned=1')).includes('PO-ZETA-1'), false, 'owned by an active user');
    await db.query('UPDATE users SET active = false WHERE id = $1', [people.leaver.user.id]);
    assert.equal((await poNumbers('alice', '?unowned=1')).includes('PO-ZETA-1'), true, 'nobody active can see it now');
  });

  test('an original is asked about only when the batch would give it an owner', async () => {
    const { batchOwners } = await import('../src/import/owners.js');
    const { query } = await import('../src/db.js');
    await db.query(`INSERT INTO quotations (quotation_no, client_name, quotation_date, sales_person, status, owner_user_id) VALUES
      ('CTZ/QT/KEPT/1', 'Owner Eta', '2026-08-03', 'P Sharma', 'Submitted', NULL),
      ('CTZ/QT/KEPT/2', 'Owner Theta', '2026-08-04', 'P Sharma', 'Submitted', $1)`, [people.madhuri.user.id]);
    const deal = (ref, action) => ({ step: 'quotation', included: true, parent_included: true, action, existing_ref: ref, payload: { sales_person: 'P Sharma' } });
    const unowned = await batchOwners({ query }, { owner_map: {}, items: [deal('CTZ/QT/KEPT/1', 'skip')] });
    assert.deepEqual(unowned.map((o) => [o.key, o.rows, o.status]), [['p sharma', 1, 'undecided']], 'a kept original with no owner takes one, so what is planned under it does too');
    const owned = await batchOwners({ query }, { owner_map: {}, items: [deal('CTZ/QT/KEPT/2', 'update'), deal('CTZ/QT/KEPT/2', 'skip')] });
    assert.deepEqual(owned, [], 'an original that has an owner keeps it, so there is nothing to ask');
  });

  test('a replaced original an admin unassigned on purpose stays unassigned through a commit', async () => {
    const { commitBatch } = await import('../src/import/commit.js');
    const { rows: [q] } = await db.query(`INSERT INTO quotations (quotation_no, client_name, quotation_date, sales_person, status)
      VALUES ('CTZ/QT/HELD/1', 'Owner Iota', '2026-08-05', 'Priya Sharma', 'Submitted') RETURNING id`);
    await db.query(`INSERT INTO ownership_history (entity_type, entity_id, changed_by_name, actor_type, reason)
      VALUES ('quotations', $1, 'Alice Admin', 'user', 'Unassigned on purpose')`, [q.id]);
    const { rows: [b] } = await db.query("INSERT INTO import_batches (filename, kind) VALUES ('held.xlsx', 'sales') RETURNING id, status");
    const item = { seq: 1, step: 'quotation', action: 'update', included: true, parent_included: true, existing_ref: 'CTZ/QT/HELD/1',
      payload: { client_name: 'Owner Iota', sales_person: 'Priya Sharma', status: 'Under Negotiation', po_received: false, __update_fields: ['status'] } };
    await commitBatch({ ...b, filename: 'held.xlsx', owners: [{ key: 'priya sharma', owner_user_id: people.priya.user.id, status: 'matched' }] }, [item], { user: 'test' });
    const { rows: [after] } = await db.query('SELECT status, owner_user_id FROM quotations WHERE id = $1', [q.id]);
    assert.equal(after.status, 'Under Negotiation', 'the sheet\'s change was written');
    assert.equal(after.owner_user_id, null, 'and the admin\'s unassignment stands');
  });

  test('a commit through Claude is refused while a name has no owner', async () => {
    const { commitSheetImport } = await import('../src/lib/mcp/imports.js');
    const res = await as('alice')('post', '/api/import/batches')
      .attach('file', sheet([won('CV-201', 'Owner Kappa', 'Somebody Unknown', 'PO-KAPPA-1')]), 'mcp.xlsx').expect(201);
    // As if Claude had planned it: the connector only commits its own batches.
    await db.query("UPDATE import_batches SET filename = 'mcp:sheet.xlsx' WHERE id = $1", [res.body.data.id]);
    await assert.rejects(
      commitSheetImport({ role: 'admin' }, { person: 'Alice Admin', role: 'admin' }, { batch_id: res.body.data.id, confirm: true }),
      /Choose an owner .*Somebody Unknown.*Import screen/,
    );
    assert.equal((await db.query("SELECT count(*)::int n FROM purchase_orders WHERE po_number = 'PO-KAPPA-1'")).rows[0].n, 0);
  });

  test('a record an admin deliberately unassigned keeps that decision', async () => {
    await db.query(`INSERT INTO quotations (quotation_no, client_name, quotation_date, sales_person, status)
      VALUES ('CTZ/QT/OLD/2', 'Owner Epsilon', '2026-08-02', 'Priya Sharma', 'Submitted')`);
    const { rows: [q] } = await db.query("SELECT id FROM quotations WHERE quotation_no = 'CTZ/QT/OLD/2'");
    await db.query(`INSERT INTO ownership_history (entity_type, entity_id, changed_by_name, actor_type, reason)
      VALUES ('quotations', $1, 'Alice Admin', 'user', 'Unassigned on purpose')`, [q.id]);
    await db.query(MIGRATION);
    assert.equal((await db.query('SELECT owner_user_id FROM quotations WHERE id = $1', [q.id])).rows[0].owner_user_id, null);
  });
});
