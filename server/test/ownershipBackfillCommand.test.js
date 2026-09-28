import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';

/**
 * Running the backfill again, later (#18 Phase 2B).
 *
 * The problem this covers: migration 019 runs once. On every database that
 * exists today the historical salespeople are text in the records and not
 * rows in `users`, so 019 correctly assigns nothing, is marked applied, and
 * never looks again. `npm run ownership:backfill` is the second way in,
 * after an admin has prepared the user list.
 *
 * The rules themselves are not retested here — they are migration 019's,
 * and ownershipBackfill.test.js covers them. What matters here is that this
 * really is the same SQL, that it is safe to run twice, and that it either
 * lands whole or not at all.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
const SCHEMA = readFileSync(join(DB_DIR, 'schema.sql'), 'utf8');
const VIEWS = readFileSync(join(DB_DIR, 'views.sql'), 'utf8');

const ALL = ['enquiries', 'quotations', 'projects'];

describe('npm run ownership:backfill', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let dbUrl; let db; let ownership;

  before(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    const name = `backfill_cmd_${process.pid}_${Date.now()}`;
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();

    const u = new URL(ADMIN_URL);
    u.pathname = `/${name}`;
    dbUrl = u.toString();

    db = new pg.Client({ connectionString: dbUrl });
    await db.connect();

    // Set before the module is imported: src/db.js builds its pool from
    // config at import time, and it must not be the developer's own database.
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = dbUrl;
    ownership = await import('../src/lib/ownership.js');
  });

  after(async () => {
    const { pool } = await import('../src/db.js');
    await pool.end();
    await db.end();
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${new URL(dbUrl).pathname.slice(1)} WITH (FORCE)`);
    await admin.end();
  });

  /** A database at the state a deploy leaves: schema, records, migration run. */
  async function freshDeploy({ withUsers = false } = {}) {
    await db.query(SCHEMA);
    await db.query(VIEWS);
    await db.query(`
      INSERT INTO enquiries  (enquiry_no, client_name, sales_person) VALUES ('CTZ/ENQ/2026/001', 'Old Client', 'Ramesh');
      INSERT INTO quotations (quotation_no, client_name, sales_person) VALUES ('CTZ/QT/2026/001', 'Old Client', 'Ramesh');
      INSERT INTO projects   (project_id, client_name, sales_person)   VALUES ('PRJ-2026-001', 'Old Client', 'Ramesh');
    `);
    if (withUsers) await db.query(`INSERT INTO users (name, active) VALUES ('Ramesh', false)`);
    // What the deploy does: run the migration exactly as the runner would.
    await db.query(ownership.BACKFILL_SQL);
  }

  const owners = async () => {
    const out = {};
    for (const t of ALL) out[t] = (await db.query(`SELECT owner_user_id FROM ${t}`)).rows[0].owner_user_id;
    return out;
  };
  const addRamesh = async () =>
    (await db.query(`INSERT INTO users (name, active) VALUES ('Ramesh', false) RETURNING id`)).rows[0].id;

  // ------------------------------------------------- one source of the rules

  test('it runs the migration itself, not a second copy of the rules', () => {
    const onDisk = readFileSync(join(DB_DIR, 'migrations', ownership.BACKFILL_MIGRATION), 'utf8');

    assert.equal(ownership.BACKFILL_SQL, onDisk, 'the command executes the migration file verbatim');
    assert.equal(ownership.BACKFILL_MIGRATION, '052_backfill_record_ownership.sql');
    // If this ever fails, the rules have moved and BACKFILL_MIGRATION is stale.
    assert.match(onDisk, /SET owner_user_id = u\.id/);
    assert.match(onDisk, /owner_user_id IS NULL/);
  });

  // ------------------------------------------------ the regression it exists for

  test('a deploy before the users exist leaves records unowned — and a later run claims them', async () => {
    await freshDeploy();

    // The migration has run. It is now marked applied and will never run
    // again, and every record is unowned because nobody matched.
    assert.deepEqual(await owners(), { enquiries: null, quotations: null, projects: null });

    // The admin prepares the historical salesperson, as an attribution-only
    // account — a name from the old data with no way to sign in.
    const ramesh = await addRamesh();

    const result = await ownership.backfillOwnership(db);

    assert.deepEqual(await owners(), { enquiries: ramesh, quotations: ramesh, projects: ramesh });
    assert.deepEqual(result.assigned, { enquiries: 1, quotations: 1, projects: 1 });
    assert.equal(result.total, 3);
  });

  test('running it again changes nothing and reports nothing assigned', async () => {
    await freshDeploy({ withUsers: true });
    const settled = await owners();
    assert.ok(settled.enquiries, 'the migration itself matched this time');

    const again = await ownership.backfillOwnership(db);

    assert.deepEqual(await owners(), settled);
    assert.deepEqual(again.assigned, { enquiries: 0, quotations: 0, projects: 0 });
    assert.equal(again.total, 0);
  });

  test('an owner already set is never overwritten by a later run', async () => {
    await freshDeploy();
    const keep = (await db.query(
      `INSERT INTO users (name, email, password_hash) VALUES ('Keep', 'keep@example.com', 'x') RETURNING id`
    )).rows[0].id;
    for (const t of ALL) await db.query(`UPDATE ${t} SET owner_user_id = $1`, [keep]);
    // Every historical signal now points at somebody else.
    const ramesh = await addRamesh();

    const result = await ownership.backfillOwnership(db);

    for (const [t, owner] of Object.entries(await owners())) {
      assert.equal(owner, keep, `${t}: the decision already on the record stands`);
      assert.notEqual(owner, ramesh, t);
    }
    assert.equal(result.total, 0);
  });

  test('no user is created or changed by a run', async () => {
    await freshDeploy({ withUsers: true });
    const snapshot = () =>
      db.query('SELECT id, name, email, role, active, session_version FROM users ORDER BY id').then((r) => r.rows);
    const before = await snapshot();

    await ownership.backfillOwnership(db);

    assert.deepEqual(await snapshot(), before);
  });

  // ------------------------------------------------------------- all or none

  test('a failure part-way through leaves every table as it was', async () => {
    await freshDeploy();
    await addRamesh();
    // projects is updated last. Refusing writes there means the first two
    // tables have already been assigned when the third fails — exactly the
    // half-finished state a single transaction has to prevent.
    await db.query('ALTER TABLE projects ADD CONSTRAINT tmp_no_owner CHECK (owner_user_id IS NULL)');

    await assert.rejects(
      ownership.backfillOwnership(db),
      /tmp_no_owner/,
      'the failure is raised, not swallowed and reported as success'
    );

    assert.deepEqual(
      await owners(), { enquiries: null, quotations: null, projects: null },
      'the two tables that succeeded were rolled back with the one that did not'
    );

    // And once the obstruction is gone, the same command completes.
    await db.query('ALTER TABLE projects DROP CONSTRAINT tmp_no_owner');
    const result = await ownership.backfillOwnership(db);
    assert.equal(result.total, 3);
  });

  // ------------------------------------------------------------- the dry run

  test('the dry run measures what a run would do, and writes nothing', async () => {
    await freshDeploy();
    await addRamesh();

    const before = await ownership.ownershipReport(db);
    const wouldMatch = before.reduce((n, r) => n + r.emailWouldMatch + r.nameWouldMatch, 0);

    assert.equal(wouldMatch, 3, 'three records are claimable');
    assert.deepEqual(await owners(), { enquiries: null, quotations: null, projects: null }, 'and nothing was written');

    // The measurement is real: a run assigns exactly what it counted.
    const result = await ownership.backfillOwnership(db);
    assert.equal(result.total, wouldMatch);
    assert.equal(
      (await ownership.ownershipReport(db)).reduce((n, r) => n + r.emailWouldMatch + r.nameWouldMatch, 0), 0,
      'and afterwards there is nothing left to claim'
    );
  });

  test('the report and its formatting name nobody', async () => {
    await freshDeploy({ withUsers: true });

    const report = await ownership.ownershipReport(db);
    const printed = ownership.formatOwnershipReport(report);

    assert.deepEqual(report.map((r) => r.table).sort(), ['enquiries', 'projects', 'quotations']);
    for (const text of [JSON.stringify(report), printed]) {
      assert.ok(!text.includes('Ramesh'), 'no salesperson name');
      assert.ok(!text.includes('@'), 'no email address');
    }
    for (const t of ALL) assert.match(printed, new RegExp(t));
  });
});
