import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { describe } from 'node:test';
import pg from 'pg';

/**
 * Creating the people the backfill needs (#18 §2).
 *
 * Migration 060 assigns an owner by matching a record's salesperson against
 * a users row that already exists, and on every database today none of them
 * do. This is the step that makes those rows — "one inactive `sales` user
 * per distinct person", in the issue's words — and the one place where the
 * tracker invents an identity, so what it refuses to do matters more than
 * what it does.
 *
 * The rules under test: one account per distinct name under the same
 * case- and space-insensitive rule 060 uses; never a second account for a
 * name somebody already has; never any account for a name two people share;
 * an address only when the data agrees on exactly one; and every account
 * created is inactive and cannot sign in.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
const SCHEMA = readFileSync(join(DB_DIR, 'schema.sql'), 'utf8');
const VIEWS = readFileSync(join(DB_DIR, 'views.sql'), 'utf8');
const BACKFILL = readFileSync(join(DB_DIR, 'migrations', '060_backfill_record_ownership.sql'), 'utf8');

async function withDatabase(fn) {
  const name = `histusers_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  const db = new pg.Client({ connectionString: url.toString() });
  await db.connect();
  try {
    await db.query(SCHEMA);
    await db.query(VIEWS);
    return await fn(db);
  } finally {
    await db.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  }
}

/**
 * The module under test talks to `pool` unless handed a client, and pool is
 * built from DATABASE_URL at import time. Import it lazily, after the
 * throwaway database exists, and hand every call the client explicitly.
 */
const lib = async () => import('../src/lib/historicalUsers.js');

let seq = 0;
async function record(db, table, { salesPerson = null, email = null, owner = null } = {}) {
  seq += 1;
  const n = String(seq).padStart(4, '0');
  if (table === 'enquiries') {
    const { rows } = await db.query(
      `INSERT INTO enquiries (enquiry_no, client_name, sales_person, sales_person_email, owner_user_id)
       VALUES ($1, 'Old Client', $2, $3, $4) RETURNING id`,
      [`CTZ/ENQ/2026/${n}`, salesPerson, email, owner]
    );
    return rows[0].id;
  }
  if (table === 'quotations') {
    const { rows } = await db.query(
      `INSERT INTO quotations (quotation_no, client_name, sales_person, sales_person_email, owner_user_id)
       VALUES ($1, 'Old Client', $2, $3, $4) RETURNING id`,
      [`CTZ/QT/2026/${n}`, salesPerson, email, owner]
    );
    return rows[0].id;
  }
  const { rows } = await db.query(
    `INSERT INTO projects (project_id, client_name, sales_person, owner_user_id)
     VALUES ($1, 'Old Client', $2, $3) RETURNING id`,
    [`PRJ-2026-${n}`, salesPerson, owner]
  );
  return rows[0].id;
}

const addUser = async (db, { name, email = null, role = 'sales' }) => {
  const { rows } = await db.query(
    `INSERT INTO users (name, email, password_hash, role, active)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [name, email, email ? 'not-a-real-hash' : null, role, email !== null]
  );
  return rows[0].id;
};

const byName = (list, name) => list.find((p) => p.displayName === name);

describe('creating historical salespeople', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  // ------------------------------------------------------------ discovery

  test('groups spellings of one name the way the backfill does', () =>
    withDatabase(async (db) => {
      const { discoverHistoricalSalespeople } = await lib();
      await record(db, 'quotations', { salesPerson: 'Ramesh' });
      await record(db, 'quotations', { salesPerson: '  ramesh ' });
      await record(db, 'enquiries', { salesPerson: 'RAMESH' });
      await record(db, 'projects', { salesPerson: 'Ramesh   Kumar' });

      const found = await discoverHistoricalSalespeople(db);
      const names = found.map((p) => p.normalisedName).sort();
      assert.deepEqual(names, ['ramesh', 'ramesh kumar'],
        'case and surrounding space collapse; a different name stays different');

      const ramesh = found.find((p) => p.normalisedName === 'ramesh');
      assert.equal(ramesh.records.total, 3);
      assert.deepEqual(
        { e: ramesh.records.enquiries, q: ramesh.records.quotations, p: ramesh.records.projects },
        { e: 1, q: 2, p: 0 },
        'counted per table, so an operator can see where the work is'
      );
      assert.equal(ramesh.spellingCount, 3, 'three ways it was typed');
    }));

  test('ignores records that already have an owner', () =>
    withDatabase(async (db) => {
      const { discoverHistoricalSalespeople } = await lib();
      const existing = await addUser(db, { name: 'Vishnu', email: 'vishnu@example.com' });
      await record(db, 'quotations', { salesPerson: 'Settled', owner: existing });

      assert.deepEqual(await discoverHistoricalSalespeople(db), [],
        'the queue is unowned records; an assigned one is not waiting for anything');
    }));

  // ------------------------------------------------------------- creation

  test('creates one inactive sales account per distinct name', () =>
    withDatabase(async (db) => {
      const { createHistoricalUsers } = await lib();
      await record(db, 'quotations', { salesPerson: 'Ramesh' });
      await record(db, 'enquiries', { salesPerson: 'ramesh' });
      await record(db, 'projects', { salesPerson: 'Vishnu' });

      const { created } = await createHistoricalUsers(db);
      assert.equal(created.length, 2, 'two people, four records');

      const { rows } = await db.query('SELECT name, email, password_hash, role, active FROM users ORDER BY name');
      assert.equal(rows.length, 2);
      for (const row of rows) {
        assert.equal(row.active, false, 'an invented identity cannot sign in');
        assert.equal(row.password_hash, null, 'and has no credential to sign in with');
        assert.equal(row.role, 'sales');
      }
    }));

  test('is idempotent: a second run creates nobody', () =>
    withDatabase(async (db) => {
      const { createHistoricalUsers } = await lib();
      await record(db, 'quotations', { salesPerson: 'Ramesh' });

      assert.equal((await createHistoricalUsers(db)).created.length, 1);
      const second = await createHistoricalUsers(db);
      assert.equal(second.created.length, 0, 'the name now resolves, so there is nothing to invent');
      assert.equal(second.skipped[0].disposition, 'exists');

      const { rows } = await db.query("SELECT COUNT(*)::int AS n FROM users");
      assert.equal(rows[0].n, 1, 'and no duplicate was written');
    }));

  test('never adds a second account for a name somebody already has', () =>
    withDatabase(async (db) => {
      const { createHistoricalUsers } = await lib();
      await addUser(db, { name: '  RAMESH  ', email: 'ramesh@example.com' });
      await record(db, 'quotations', { salesPerson: 'Ramesh' });

      const { created, skipped } = await createHistoricalUsers(db);
      assert.equal(created.length, 0, 'the existing account matches under the same rule');
      assert.equal(skipped[0].disposition, 'exists');
    }));

  test('refuses a name two people share, and says so', () =>
    withDatabase(async (db) => {
      const { createHistoricalUsers } = await lib();
      await addUser(db, { name: 'Ramesh', email: 'ramesh.a@example.com' });
      await addUser(db, { name: 'ramesh', email: 'ramesh.b@example.com' });
      await record(db, 'quotations', { salesPerson: 'Ramesh' });

      const { created, skipped } = await createHistoricalUsers(db);
      assert.equal(created.length, 0, 'a third Ramesh would make the guess worse, not better');
      assert.equal(skipped[0].disposition, 'ambiguous');
      assert.equal(skipped[0].existingUserCount, 2);
    }));

  // -------------------------------------------------------------- the email

  test('carries the address when the data agrees on exactly one', () =>
    withDatabase(async (db) => {
      const { createHistoricalUsers } = await lib();
      await record(db, 'quotations', { salesPerson: 'Ramesh', email: 'Ramesh@Example.com' });
      await record(db, 'enquiries', { salesPerson: 'ramesh', email: ' ramesh@example.com ' });

      const { created } = await createHistoricalUsers(db);
      assert.equal(created[0].email, 'ramesh@example.com', 'normalised, and the same address either way');

      const { rows } = await db.query('SELECT email, active FROM users');
      assert.equal(rows[0].email, 'ramesh@example.com');
      assert.equal(rows[0].active, false, 'an address is not a credential: still switched off');
    }));

  test('withholds the address when one name carries two of them', () =>
    withDatabase(async (db) => {
      const { createHistoricalUsers } = await lib();
      await record(db, 'quotations', { salesPerson: 'Ramesh', email: 'ramesh@example.com' });
      await record(db, 'enquiries', { salesPerson: 'Ramesh', email: 'r.kumar@example.com' });

      const { created } = await createHistoricalUsers(db);
      assert.equal(created[0].email, null, 'picking a winner would be inventing an address');
      assert.match(created[0].emailWithheldReason, /more than one address/);
    }));

  test('withholds an address that already belongs to an account', () =>
    withDatabase(async (db) => {
      const { createHistoricalUsers } = await lib();
      await addUser(db, { name: 'Someone Else', email: 'shared@example.com' });
      await record(db, 'quotations', { salesPerson: 'Ramesh', email: 'shared@example.com' });

      const { created } = await createHistoricalUsers(db);
      assert.equal(created[0].email, null, 'users_email_key would refuse it, and so does this');
      assert.match(created[0].emailWithheldReason, /already belongs/);
      assert.equal(created[0].displayName, 'Ramesh', 'the person is still created, by name');
    }));

  // --------------------------------------------------------------- dry run

  test('a dry run reports what it would do and writes nothing', () =>
    withDatabase(async (db) => {
      const { createHistoricalUsers } = await lib();
      await record(db, 'quotations', { salesPerson: 'Ramesh' });

      const { created, dryRun } = await createHistoricalUsers(db, { dryRun: true });
      assert.equal(dryRun, true);
      assert.equal(created.length, 1, 'the same answer a real run would give');
      assert.equal(created[0].id, null, 'but no row, so no id');

      const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM users');
      assert.equal(rows[0].n, 0, 'the transaction rolled back');
    }));

  // ------------------------------------------------- the two steps together

  test('create then backfill assigns what the data named beyond doubt', () =>
    withDatabase(async (db) => {
      const { createHistoricalUsers } = await lib();
      const q = await record(db, 'quotations', { salesPerson: 'Ramesh', email: 'ramesh@example.com' });
      const p = await record(db, 'projects', { salesPerson: 'Vishnu' });
      const orphan = await record(db, 'quotations', { salesPerson: null });

      await createHistoricalUsers(db);
      await db.query(BACKFILL);

      const owner = async (table, id) =>
        (await db.query(`SELECT owner_user_id FROM ${table} WHERE id = $1`, [id])).rows[0].owner_user_id;

      assert.ok(await owner('quotations', q), 'matched by the address the account carries');
      assert.ok(await owner('projects', p), 'matched by name, which is all projects has');
      assert.equal(await owner('quotations', orphan), null, 'a record naming nobody stays unowned');
    }));

  test('leaves the ambiguous records for a person, even after creating everyone else', () =>
    withDatabase(async (db) => {
      const { createHistoricalUsers } = await lib();
      await addUser(db, { name: 'Ramesh', email: 'ramesh.a@example.com' });
      await addUser(db, { name: 'Ramesh', email: 'ramesh.b@example.com' });
      const contested = await record(db, 'quotations', { salesPerson: 'Ramesh' });
      const clear = await record(db, 'quotations', { salesPerson: 'Vishnu' });

      await createHistoricalUsers(db);
      await db.query(BACKFILL);

      const owner = async (id) =>
        (await db.query('SELECT owner_user_id FROM quotations WHERE id = $1', [id])).rows[0].owner_user_id;

      assert.equal(await owner(contested), null, "two Rameshes means neither, and 060's count guard agrees");
      assert.ok(await owner(clear), 'the unambiguous record is unaffected by the contested one');
    }));

  test('the normalisation rule is character-for-character the migration\'s', async () => {
    const { NORMALISE_NAME_SQL } = await lib();

    // Compared against the migration itself rather than against a copy
    // written here — a literal repeated in the test drifts as silently as
    // one repeated in the code. 060 Rule B normalises `u.name`; this is
    // that exact expression.
    const fromMigration = "lower(regexp_replace(btrim(u.name), '\\s+', ' ', 'g'))";
    assert.ok(
      BACKFILL.includes(fromMigration),
      'migration 060 no longer contains the expression this test pins; check Rule B'
    );
    assert.equal(
      NORMALISE_NAME_SQL.replace('%s', 'u.name'),
      fromMigration,
      'if this and 060 Rule B drift, this file creates users the backfill then refuses to match'
    );
  });
});
