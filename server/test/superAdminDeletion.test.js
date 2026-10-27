import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before, beforeEach, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';
import XLSX from 'xlsx';

/**
 * Deleting an account from the super admin portal (lib/userDeletion.js):
 * the Excel backup is made, stored, checked, and only then are open records
 * moved and the account archived — or nothing happens at all. Closed
 * records and past targets stay with the person, so reports still name them.
 *
 * Storage is a stand-in that keeps files in memory and writes real
 * documents rows, so the suite never uploads to Cloudinary.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const PASSWORD = 'a-good-long-test-password';
const EMAIL = 'super@example.com';
const SUPER_PASSWORD = 'a-good-long-super-password';

describe('deleting a user with a backup', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let dbUrl;
  let db;
  let app;
  let pool;
  let cookie;
  let createUser;
  let backupStore;
  let businessYear;
  const files = new Map();
  let failNext = null; // 'upload' | 'fetch' | 'corrupt'

  before(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    const name = `sadelete_suite_${process.pid}_${Date.now()}`;
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
    process.env.CLOUDINARY_CLOUD_NAME = '';

    ({ default: app } = await import('../src/app.js'));
    ({ pool } = await import('../src/db.js'));
    ({ createUser } = await import('../src/lib/users.js'));
    ({ backupStore } = await import('../src/lib/userDeletion.js'));
    ({ businessYear } = await import('../src/lib/businessDate.ts'));

    backupStore.ready = () => true;
    backupStore.upload = async ({ buffer, fileName, contentType }) => {
      if (failNext === 'upload') { failNext = null; throw new Error('storage said no'); }
      const key = `test/${randomUUID()}`;
      const { rows: [doc] } = await pool.query(
        `INSERT INTO documents (storage_key, file_name, content_type, size_bytes) VALUES ($1,$2,$3,$4) RETURNING *`,
        [key, fileName, contentType, buffer.length]);
      files.set(doc.id, Buffer.from(buffer));
      return doc;
    };
    backupStore.fetch = async (id) => {
      if (failNext === 'fetch') { failNext = null; throw new Error('storage unreachable'); }
      let body = files.get(id);
      if (failNext === 'corrupt') { failNext = null; body = Buffer.concat([body, Buffer.from('x')]); }
      return { document: { id }, body };
    };
    backupStore.discard = async (id) => {
      files.delete(id);
      await pool.query('DELETE FROM documents WHERE id = $1', [id]);
    };

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

  let alice; let sam; let tara;
  beforeEach(async () => {
    failNext = null;
    await db.query(`DELETE FROM deleted_users; DELETE FROM ownership_history; DELETE FROM activity_log;
                    DELETE FROM sales_targets; DELETE FROM payment_stages; DELETE FROM purchase_orders;
                    DELETE FROM enquiries; DELETE FROM quotations; DELETE FROM projects;
                    DELETE FROM documents; DELETE FROM users`);
    files.clear();
    alice = await createUser({ name: 'Alice', email: 'alice@example.com', password: PASSWORD, role: 'admin' }, db);
    sam = await createUser({ name: 'Sam Seller', email: 'sam@example.com', password: PASSWORD, role: 'sales' }, db);
    tara = await createUser({ name: 'Tara', email: 'tara@example.com', password: PASSWORD, role: 'sales' }, db);
  });

  /** Sam owns an open and a closed record of each kind, a PO, and targets. */
  async function samsRecords() {
    const year = businessYear();
    await db.query(
      `INSERT INTO enquiries (enquiry_no, client_name, status, owner_user_id, originating_user_id, notes) VALUES
         ('ENQ-OPEN', 'Open Co', 'Contacted', $1, $1, '=1+1 is not a formula'),
         ('ENQ-DONE', 'Done Co', 'Unqualified', $1, NULL, NULL)`, [sam.id]);
    await db.query(
      `INSERT INTO quotations (quotation_no, client_name, quotation_date, status, owner_user_id) VALUES
         ('QT-OPEN', 'Open Co', '2026-05-01', 'Submitted', $1),
         ('QT-LOST', 'Lost Co', '2026-04-01', 'Lost', $1)`, [sam.id]);
    await db.query(
      `INSERT INTO projects (project_id, client_name, owner_user_id, percent_complete) VALUES
         ('PRJ-OPEN', 'Open Co', $1, 0.5),
         ('PRJ-DONE', 'Done Co', $1, 1)`, [sam.id]);
    await db.query(
      `INSERT INTO purchase_orders (po_number, project_id, po_value) VALUES ('PO-1', 'PRJ-OPEN', 1000)`);
    await db.query(
      `INSERT INTO sales_targets (salesperson_user_id, calendar_year, metric, target_value, unit, actor_type) VALUES
         ($1, $2, 'enquiries', 10, 'count', 'system'),
         ($1, $3, 'enquiries', 12, 'count', 'system'),
         ($1, $3, 'wins', 4, 'count', 'system')`, [sam.id, year - 1, year]);
  }

  const plan = (id) => request(app).get(`/api/super-admin/users/${id}/deletion-plan`).set('Cookie', cookie);
  const remove = (id, body = {}) => request(app).delete(`/api/super-admin/users/${id}`).set('Cookie', cookie).send(body);
  const ownerOf = async (table, key, col) => (await db.query(`SELECT owner_user_id FROM ${table} WHERE ${col} = $1`, [key])).rows[0].owner_user_id;
  const isDeleted = async (id) => (await db.query('SELECT 1 FROM deleted_users WHERE user_id = $1', [id])).rows.length === 1;
  const accountOf = async (id) => (await db.query('SELECT active, password_hash FROM users WHERE id = $1', [id])).rows[0];
  const actions = async () => (await db.query('SELECT action FROM activity_log ORDER BY id')).rows.map((r) => r.action);

  test('the plan counts their records and lists who may take over', async () => {
    await samsRecords();
    const res = await plan(sam.id);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const p = res.body.data;
    assert.equal(p.open_owned, 3);
    assert.equal(p.needs_replacement, true);
    assert.deepEqual(p.records.enquiries, { total: 2, open_owned: 1 });
    assert.deepEqual(p.targets, { total: 3, past: 1, current_or_future: 2 });
    assert.deepEqual(p.candidates.map((c) => c.name), ['Tara'], 'only active Sales users other than Sam');
  });

  test('backs up, moves open records and targets, then deletes', async () => {
    await samsRecords();
    const res = await remove(sam.id, { replacement_user_id: tara.id, move_targets: true });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    // Archived: the row stays, but it cannot sign in.
    assert.equal(await isDeleted(sam.id), true);
    assert.deepEqual(await accountOf(sam.id), { active: false, password_hash: null });
    const login = await request(app).post('/api/auth/login').send({ email: 'sam@example.com', password: PASSWORD });
    assert.equal(login.status, 401);

    // Open records went to Tara; closed ones are still Sam's.
    assert.equal(await ownerOf('enquiries', 'ENQ-OPEN', 'enquiry_no'), tara.id);
    assert.equal(await ownerOf('quotations', 'QT-OPEN', 'quotation_no'), tara.id);
    assert.equal(await ownerOf('projects', 'PRJ-OPEN', 'project_id'), tara.id);
    assert.equal(await ownerOf('enquiries', 'ENQ-DONE', 'enquiry_no'), sam.id);
    assert.equal(await ownerOf('quotations', 'QT-LOST', 'quotation_no'), sam.id);
    assert.equal(await ownerOf('projects', 'PRJ-DONE', 'project_id'), sam.id);

    // This year's targets moved because it was asked; last year's stayed.
    const { rows: targets } = await db.query('SELECT salesperson_user_id, calendar_year FROM sales_targets ORDER BY id');
    assert.deepEqual(targets.map((t) => t.salesperson_user_id), [sam.id, tara.id, tara.id]);

    // The handover is in the ownership history, with Sam's name kept.
    const { rows: history } = await db.query('SELECT previous_owner_name, new_owner_name, previous_owner_snapshot_id FROM ownership_history');
    assert.equal(history.length, 3);
    for (const h of history) {
      assert.equal(h.previous_owner_name, 'Sam Seller');
      assert.equal(h.previous_owner_snapshot_id, sam.id);
      assert.equal(h.new_owner_name, 'Tara');
    }

    const logged = await actions();
    for (const a of ['ownership.reassigned', 'target.updated', 'user.backup_created', 'user.deleted']) {
      assert.ok(logged.includes(a), `${a} recorded`);
    }
    assert.equal(res.body.data.summary.targets_moved, 2);
    assert.equal(res.body.data.summary.targets_kept, 1);
  });

  test('without the option, every target stays with them', async () => {
    await samsRecords();
    const res = await remove(sam.id, { replacement_user_id: tara.id });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const { rows } = await db.query('SELECT DISTINCT salesperson_user_id FROM sales_targets');
    assert.deepEqual(rows.map((r) => r.salesperson_user_id), [sam.id]);
    assert.equal(res.body.data.summary.targets_moved, 0);
  });

  test('old records and past targets keep reporting under their name', async () => {
    await samsRecords();
    await remove(sam.id, { replacement_user_id: tara.id, move_targets: true });

    // How the MIS reports and report definitions name an owner.
    const { rows: [closed] } = await db.query(
      `SELECT COALESCE(u.name, NULLIF(btrim(e.sales_person), '')) AS owner
         FROM enquiries e LEFT JOIN users u ON u.id = e.owner_user_id WHERE e.enquiry_no = 'ENQ-DONE'`);
    assert.equal(closed.owner, 'Sam Seller');

    // The targets screen lists last year's target under Sam still.
    const { listSalesTargets } = await import('../src/lib/salesTargets.js');
    const past = await listSalesTargets(pool, { salespersonUserId: sam.id, calendarYear: businessYear() - 1 });
    assert.equal(past.length, 1);

    // The ownership history of a moved record still says it was Sam's.
    const { rows: [moved] } = await db.query(
      `SELECT h.previous_owner_user_id FROM ownership_history h JOIN enquiries e ON e.id = h.entity_id
        WHERE h.entity_type = 'enquiries' AND e.enquiry_no = 'ENQ-OPEN'`);
    assert.equal(moved.previous_owner_user_id, sam.id);

    // Listed for reports, flagged as deleted.
    const list = await request(app).get('/api/super-admin/users').set('Cookie', cookie);
    assert.ok(list.body.data.find((u) => u.id === sam.id).deleted_at);
  });

  test('their email is freed for a new account, and kept on the deleted record', async () => {
    await samsRecords();
    await remove(sam.id, { replacement_user_id: tara.id });

    const { rows: [archived] } = await db.query('SELECT name, email FROM users WHERE id = $1', [sam.id]);
    assert.deepEqual(archived, { name: 'Sam Seller', email: null }, 'the address is off the archived row');
    const list = await request(app).get('/api/super-admin/deleted-users').set('Cookie', cookie);
    assert.equal(list.body.data[0].email, 'sam@example.com', 'and the Deleted users tab still shows it');

    // Somebody rejoining, or a mistaken delete: the same address, a new account.
    const again = await request(app).post('/api/super-admin/users').set('Cookie', cookie)
      .send({ name: 'Sam Seller', email: 'sam@example.com', role: 'sales', password: PASSWORD });
    assert.equal(again.status, 201, JSON.stringify(again.body));
    assert.notEqual(again.body.data.id, sam.id);
    const login = await request(app).post('/api/auth/login').send({ email: 'sam@example.com', password: PASSWORD });
    assert.equal(login.status, 200, 'the new account signs in with it');

    // The old records still name the person who did the work.
    assert.equal(await ownerOf('enquiries', 'ENQ-DONE', 'enquiry_no'), sam.id);
  });

  test('their API tokens are revoked, and nobody else\'s', async () => {
    await db.query(
      `INSERT INTO api_tokens (name, token_hash, token_prefix, role, person) VALUES
         ('sam laptop', 'h1', 'ctz_a', 'sales', 'Sam Seller'),
         ('tara laptop', 'h2', 'ctz_b', 'sales', 'Tara'),
         ('admin bot', 'h3', 'ctz_c', 'admin', NULL)`);
    try {
      assert.equal((await plan(sam.id)).body.data.api_tokens, 1, 'the screen says so first');
      const res = await remove(sam.id, {});
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.summary.api_tokens_revoked, 1);
      const { rows } = await db.query('SELECT name, revoked_at IS NOT NULL AS revoked FROM api_tokens ORDER BY id');
      assert.deepEqual(rows, [
        { name: 'sam laptop', revoked: true },
        { name: 'tara laptop', revoked: false },
        { name: 'admin bot', revoked: false },
      ]);
    } finally {
      await db.query('DELETE FROM api_tokens');
    }
  });

  test('the super admin is recorded as itself, not as the shared login', async () => {
    await samsRecords();
    await remove(sam.id, { replacement_user_id: tara.id });
    const { rows } = await db.query(`SELECT DISTINCT actor_type FROM activity_log WHERE action IN ('user.deleted', 'user.backup_created', 'ownership.reassigned')`);
    assert.deepEqual(rows.map((r) => r.actor_type), ['super_admin']);
    const { rows: [h] } = await db.query('SELECT actor_type, changed_by_name FROM ownership_history LIMIT 1');
    assert.equal(h.actor_type, 'super_admin');
    assert.equal(h.changed_by_name, 'Super admin (super@example.com)');
  });

  test('a deleted account cannot be edited, given a password, or switched back on', async () => {
    await remove(tara.id, {});
    const edit = await request(app).patch(`/api/super-admin/users/${tara.id}`).set('Cookie', cookie).send({ active: true });
    assert.equal(edit.status, 404);
    const pw = await request(app).post(`/api/super-admin/users/${tara.id}/password`).set('Cookie', cookie).send({ password: PASSWORD });
    assert.equal(pw.status, 404);

    // Nor through the main app's Users & roles screen.
    const staff = await request(app).post('/api/auth/login').send({ email: 'alice@example.com', password: PASSWORD });
    const viaSettings = await request(app).patch(`/api/users/${tara.id}`).set('Cookie', staff.headers['set-cookie']).send({ active: true });
    assert.equal(viaSettings.status, 404);
    assert.deepEqual(await accountOf(tara.id), { active: false, password_hash: null });
  });

  test('the backup opens in Excel with every sheet, and downloads from the Deleted users tab', async () => {
    await samsRecords();
    await remove(sam.id, { replacement_user_id: tara.id });

    const list = await request(app).get('/api/super-admin/deleted-users').set('Cookie', cookie);
    assert.equal(list.status, 200);
    assert.equal(list.body.data.length, 1);
    const entry = list.body.data[0];
    assert.equal(entry.name, 'Sam Seller');
    assert.equal(entry.replacement_name, 'Tara');

    const file = await request(app).get(`/api/super-admin/deleted-users/${entry.id}/backup`).set('Cookie', cookie)
      .buffer(true).parse((res, cb) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); });
    assert.equal(file.status, 200);
    assert.match(file.headers['content-disposition'], /attachment; filename="deleted-user-\d+-sam-seller-/);
    assert.match(file.headers['cache-control'], /no-store/);

    const book = XLSX.read(file.body, { type: 'buffer' });
    assert.deepEqual(book.SheetNames, ['Summary', 'Enquiries', 'Quotations', 'Projects', 'Purchase orders',
      'Payment stages', 'Sales targets', 'Ownership history', 'Follow-ups', 'Activity']);
    const enquiries = XLSX.utils.sheet_to_json(book.Sheets.Enquiries);
    assert.equal(enquiries.length, 2);
    const open = enquiries.find((e) => e.enquiry_no === 'ENQ-OPEN');
    assert.equal(open['Moves to'], 'Tara');
    assert.equal(open.Link, 'Owner and creator');
    // Text, never a formula.
    const cellRef = Object.keys(book.Sheets.Enquiries).find((k) => book.Sheets.Enquiries[k]?.v === '=1+1 is not a formula');
    assert.ok(cellRef);
    assert.equal(book.Sheets.Enquiries[cellRef].f, undefined);
    assert.equal(XLSX.utils.sheet_to_json(book.Sheets['Purchase orders']).length, 1);
    assert.equal(XLSX.utils.sheet_to_json(book.Sheets['Sales targets']).length, 3);

    assert.ok((await actions()).includes('user.backup_downloaded'));
  });

  test('a user with open records needs somebody to take them over', async () => {
    await samsRecords();
    const none = await remove(sam.id, {});
    assert.equal(none.status, 422);
    assert.match(none.body.error.fields.replacement_user_id, /3 open records/);

    const admin = await remove(sam.id, { replacement_user_id: alice.id });
    assert.equal(admin.status, 422, 'records move only to an active Sales user');
    assert.equal(await isDeleted(sam.id), false);
    assert.equal(files.size, 0, 'no backup was even made');
  });

  test('someone with no open records needs no replacement', async () => {
    const res = await remove(tara.id, {});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(await isDeleted(tara.id), true);
  });

  for (const [what, failure] of [['the upload fails', 'upload'], ['the backup cannot be read back', 'fetch'], ['the stored backup is damaged', 'corrupt']]) {
    test(`nothing is deleted when ${what}`, async () => {
      await samsRecords();
      failNext = failure;
      const res = await remove(sam.id, { replacement_user_id: tara.id, move_targets: true });
      assert.equal(res.status, 502, JSON.stringify(res.body));
      assert.match(res.body.error.message, /nothing was deleted/);

      assert.equal(await isDeleted(sam.id), false);
      assert.equal((await accountOf(sam.id)).active, true);
      assert.equal(await ownerOf('enquiries', 'ENQ-OPEN', 'enquiry_no'), sam.id);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM sales_targets WHERE salesperson_user_id = $1', [sam.id])).rows[0].n, 3);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM deleted_users')).rows[0].n, 0);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM documents')).rows[0].n, 0, 'the half-made backup is cleaned away');
      assert.ok((await actions()).includes('user.deletion_failed'));
    });
  }

  test('nothing is deleted when their records change while the backup is made', async () => {
    await samsRecords();
    const realFetch = backupStore.fetch;
    backupStore.fetch = async (id) => {
      await pool.query(`UPDATE enquiries SET status = 'Qualified' WHERE enquiry_no = 'ENQ-OPEN'`);
      return realFetch(id);
    };
    try {
      const res = await remove(sam.id, { replacement_user_id: tara.id });
      assert.equal(res.status, 409, JSON.stringify(res.body));
      assert.match(res.body.error.message, /changed while the backup was being made/);
    } finally {
      backupStore.fetch = realFetch;
    }
    assert.equal(await isDeleted(sam.id), false);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM documents')).rows[0].n, 0);
  });

  test('the last active admin is refused before any backup is made', async () => {
    const p = await plan(alice.id);
    assert.equal(p.body.data.admin_remains, false, 'the screen is told up front');
    const res = await remove(alice.id, {});
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.match(res.body.error.message, /no active admin/);
    assert.equal(files.size, 0, 'no backup was made');
    assert.equal(await isDeleted(alice.id), false);
  });

  test('a failure late in the transaction undoes every step before it', async () => {
    // Records and targets move first; then saving the deleted_users row
    // fails, standing in for anything going wrong at the end.
    await samsRecords();
    await db.query(`CREATE FUNCTION fail_once() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'disk full'; END $$ LANGUAGE plpgsql;
                    CREATE TRIGGER fail_once BEFORE INSERT ON deleted_users FOR EACH ROW EXECUTE FUNCTION fail_once();`);
    let res;
    try {
      res = await remove(sam.id, { replacement_user_id: tara.id, move_targets: true });
    } finally {
      await db.query('DROP TRIGGER fail_once ON deleted_users; DROP FUNCTION fail_once();');
    }
    assert.equal(res.status, 502, JSON.stringify(res.body));
    assert.match(res.body.error.message, /nothing was deleted: disk full/);

    assert.equal(await ownerOf('enquiries', 'ENQ-OPEN', 'enquiry_no'), sam.id, 'the move was rolled back');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM sales_targets WHERE salesperson_user_id = $1', [sam.id])).rows[0].n, 3);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM ownership_history')).rows[0].n, 0);
    assert.equal(await isDeleted(sam.id), false);
    assert.equal((await accountOf(sam.id)).active, true);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM documents')).rows[0].n, 0, 'the backup was taken away again');
    const logged = await actions();
    assert.ok(!logged.includes('user.deleted') && !logged.includes('ownership.reassigned') && !logged.includes('target.updated'));
    assert.ok(logged.includes('user.deletion_failed'));
  });

  test('deleting twice: the second is a 404, and two at once delete once', async () => {
    const [a, b] = await Promise.all([remove(tara.id, {}), remove(tara.id, {})]);
    const statuses = [a.status, b.status].sort();
    assert.equal(statuses[0], 200);
    assert.ok([404, 409].includes(statuses[1]), `the other was turned away (${statuses[1]})`);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM deleted_users')).rows[0].n, 1);
    assert.equal((await remove(tara.id, {})).status, 404);
    assert.equal((await plan(tara.id)).status, 404);
  });

  test('the daily purge leaves a backup alone', async () => {
    await remove(tara.id, {});
    await db.query(`UPDATE documents SET created_at = now() - interval '3 days'`);
    const { purgeOrphanedDocuments } = await import('../src/lib/documents.js');
    await purgeOrphanedDocuments().catch(() => {});
    assert.equal((await db.query('SELECT count(*)::int AS n FROM documents')).rows[0].n, 1);
  });

  test('without a super admin session, none of it is reachable', async () => {
    for (const call of [
      request(app).get(`/api/super-admin/users/${sam.id}/deletion-plan`),
      request(app).delete(`/api/super-admin/users/${sam.id}`),
      request(app).get('/api/super-admin/deleted-users'),
      request(app).get('/api/super-admin/deleted-users/1/backup'),
    ]) assert.equal((await call).status, 401);

    // A staff admin's session is not a way in either.
    const staff = await request(app).post('/api/auth/login').send({ email: 'alice@example.com', password: PASSWORD });
    assert.equal((await request(app).get('/api/super-admin/deleted-users').set('Cookie', staff.headers['set-cookie'])).status, 401);
  });

  test('a backup is never served from a link: only the authorised route, and only intact', async () => {
    await remove(tara.id, {});
    const { rows: [entry] } = await db.query('SELECT id, backup_document_id FROM deleted_users');

    // The general documents route does not hand it to a staff admin, whose
    // scope would otherwise open every document: refused before the file is
    // even looked for.
    const staff = await request(app).post('/api/auth/login').send({ email: 'alice@example.com', password: PASSWORD });
    const viaDocuments = await request(app).get(`/api/documents/${entry.backup_document_id}`).set('Cookie', staff.headers['set-cookie']);
    assert.equal(viaDocuments.status, 404, JSON.stringify(viaDocuments.body));
    const { assertDocumentReadable } = await import('../src/lib/documents.js');
    await assert.rejects(assertDocumentReadable({ unrestricted: true }, entry.backup_document_id), /not found/i);

    // Nor can anybody upload into the backups' folder.
    const upload = await request(app).post('/api/documents?for=user-backups').set('Cookie', staff.headers['set-cookie'])
      .set('Content-Type', 'application/octet-stream').set('X-File-Name', 'x.xlsx').send(Buffer.from('x'));
    assert.notEqual(upload.status, 201);

    // Nothing in the list is a URL to the file.
    const list = await request(app).get('/api/super-admin/deleted-users').set('Cookie', cookie);
    assert.ok(!/https?:\/\//.test(JSON.stringify(list.body)), 'no storage URL leaves the server');

    // A file that no longer matches its fingerprint is refused.
    failNext = 'corrupt';
    const damaged = await request(app).get(`/api/super-admin/deleted-users/${entry.id}/backup`).set('Cookie', cookie);
    assert.equal(damaged.status, 502);
  });
});
