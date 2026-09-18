import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { describe } from 'node:test';
import pg from 'pg';

/**
 * Filling in the owner from history (#18 Phase 2B).
 *
 * Migration 019 is DML only: it changes no column, constraint or index, so
 * the CI schema comparison cannot say anything about whether it is correct.
 * Everything that makes it safe is data behaviour, and this file is the
 * only thing that checks it.
 *
 * The rules under test, in one sentence each: an exact email wins; an exact
 * name that belongs to exactly one person is the fallback when there is no
 * email at all; anything else stays null; and a row that already has an
 * owner is never touched.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
const SCHEMA = readFileSync(join(DB_DIR, 'schema.sql'), 'utf8');
const VIEWS = readFileSync(join(DB_DIR, 'views.sql'), 'utf8');
const BACKFILL = readFileSync(join(DB_DIR, 'migrations', '019_backfill_record_ownership.sql'), 'utf8');
const DIAGNOSTIC = readFileSync(join(DB_DIR, 'diagnostics', 'ownership-backfill.sql'), 'utf8');

// The two tables carrying a salesperson email, and the one that does not.
const WITH_EMAIL = ['enquiries', 'quotations'];
const ALL = ['enquiries', 'quotations', 'projects'];

async function withDatabase(fn) {
  const name = `backfill_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
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

/** A user, created directly: these stand for accounts that already exist. */
let seq = 0;
// `active` defaults to whether there is an email, because that is the rule
// the table itself enforces (users_active_needs_login): somebody who can
// sign in has an address and a hash, and an attribution-only row — a name
// from the old data — has neither and is therefore switched off.
const addUser = async (db, { name, email = null, role = 'sales', active = email !== null }) => {
  const { rows } = await db.query(
    `INSERT INTO users (name, email, password_hash, role, active)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [name, email, email ? 'not-a-real-hash' : null, role, active]
  );
  return rows[0].id;
};

/**
 * One historical record in each of the three tables, carrying the same
 * salesperson fields — so every rule is proved on every table rather than
 * on whichever one was convenient.
 *
 * projects takes no sales_person_email because the column does not exist;
 * where a case supplies one, projects simply has nothing to match on, which
 * is itself the behaviour worth pinning down.
 */
async function historicalRow(db, { salesPerson = null, salesPersonEmail = null, owner = null } = {}) {
  seq += 1;
  const n = String(seq).padStart(3, '0');
  const ids = {};
  const { rows: e } = await db.query(
    `INSERT INTO enquiries (enquiry_no, client_name, sales_person, sales_person_email, owner_user_id)
     VALUES ($1, 'Old Client', $2, $3, $4) RETURNING id`,
    [`CTZ/ENQ/2026/${n}`, salesPerson, salesPersonEmail, owner]
  );
  ids.enquiries = e[0].id;
  const { rows: q } = await db.query(
    `INSERT INTO quotations (quotation_no, client_name, sales_person, sales_person_email, owner_user_id)
     VALUES ($1, 'Old Client', $2, $3, $4) RETURNING id`,
    [`CTZ/QT/2026/${n}`, salesPerson, salesPersonEmail, owner]
  );
  ids.quotations = q[0].id;
  const { rows: p } = await db.query(
    `INSERT INTO projects (project_id, client_name, sales_person, owner_user_id)
     VALUES ($1, 'Old Client', $2, $3) RETURNING id`,
    [`PRJ-2026-${n}`, salesPerson, owner]
  );
  ids.projects = p[0].id;
  return ids;
}

const ownerOf = async (db, table, id) =>
  (await db.query(`SELECT owner_user_id FROM ${table} WHERE id = $1`, [id])).rows[0].owner_user_id;

describe('migration 019 — ownership backfill', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  // ------------------------------------------------------- what it may do

  test('changes no schema at all: it is DML only', () => {
    const sql = BACKFILL.replace(/--.*$/gm, '');
    assert.doesNotMatch(sql, /\b(CREATE|ALTER|DROP|TRUNCATE)\b/i, 'no DDL belongs in a backfill');
    assert.doesNotMatch(sql, /\bINSERT\b/i, 'a backfill must not create users or records');
    assert.doesNotMatch(sql, /\bDELETE\s+FROM\b/i, 'a backfill must not remove anything');
  });

  test('writes only owner_user_id, and only where it is null', () => {
    const statements = BACKFILL.replace(/--.*$/gm, '')
      .split(';').map((s) => s.trim()).filter((s) => /^UPDATE/i.test(s));

    assert.equal(statements.length, 5, 'two email rules, three name rules');
    for (const s of statements) {
      assert.match(s, /SET owner_user_id = u\.id/, 'the only column written');
      assert.match(s, /owner_user_id IS NULL/, 'existing ownership is never overwritten');
    }
  });

  test('it manages no transaction of its own, as the runner requires', () => {
    assert.doesNotMatch(
      BACKFILL.replace(/--.*$/gm, ''),
      /^\s*(BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION)\b/im
    );
  });

  // -------------------------------------------------------- email matching

  test('an exact email assigns the owner, whatever the case or spacing', () =>
    withDatabase(async (db) => {
      const alice = await addUser(db, { name: 'Alice Smith', email: 'user@example.com' });
      const plain = await historicalRow(db, { salesPersonEmail: 'user@example.com' });
      const shouty = await historicalRow(db, { salesPersonEmail: '  User@Example.COM  ' });

      await db.query(BACKFILL);

      for (const t of WITH_EMAIL) {
        assert.equal(await ownerOf(db, t, plain[t]), alice, `${t}: exact email`);
        assert.equal(await ownerOf(db, t, shouty[t]), alice, `${t}: case and spacing ignored`);
      }
      assert.equal(
        await ownerOf(db, 'projects', plain.projects), null,
        'projects carries no salesperson email, so the email rule cannot reach it'
      );
    }));

  test('an email that matches nobody is left alone, and does not fall back to the name', () =>
    withDatabase(async (db) => {
      await addUser(db, { name: 'Ramesh', email: 'ramesh@example.com' });
      // The name would match on its own; the unmatched address says the data
      // is off, and a name beside a wrong address is not better evidence.
      const row = await historicalRow(db, { salesPerson: 'Ramesh', salesPersonEmail: 'typo@exmaple.com' });

      await db.query(BACKFILL);

      for (const t of WITH_EMAIL) assert.equal(await ownerOf(db, t, row[t]), null, t);
    }));

  test('no partial or fuzzy email matching', () =>
    withDatabase(async (db) => {
      await addUser(db, { name: 'Alice', email: 'alice@example.com' });
      const row = await historicalRow(db, { salesPersonEmail: 'alice@example.com.au' });

      await db.query(BACKFILL);

      for (const t of WITH_EMAIL) assert.equal(await ownerOf(db, t, row[t]), null, t);
    }));

  // --------------------------------------------------------- name matching

  test('with no email, a name belonging to exactly one user assigns them', () =>
    withDatabase(async (db) => {
      const ramesh = await addUser(db, { name: 'Ramesh', email: 'ramesh@example.com' });
      const plain = await historicalRow(db, { salesPerson: 'Ramesh' });
      const messy = await historicalRow(db, { salesPerson: '  rAMESH  ' });

      await db.query(BACKFILL);

      for (const t of ALL) {
        assert.equal(await ownerOf(db, t, plain[t]), ramesh, `${t}: exact name`);
        assert.equal(await ownerOf(db, t, messy[t]), ramesh, `${t}: case and spacing ignored`);
      }
    }));

  test('internal spacing is collapsed, not ignored altogether', () =>
    withDatabase(async (db) => {
      const alice = await addUser(db, { name: 'Alice Smith' });
      const spaced = await historicalRow(db, { salesPerson: 'alice   smith' });
      const joined = await historicalRow(db, { salesPerson: 'AliceSmith' });

      await db.query(BACKFILL);

      for (const t of ALL) {
        assert.equal(await ownerOf(db, t, spaced[t]), alice, `${t}: runs of space collapse`);
        assert.equal(await ownerOf(db, t, joined[t]), null, `${t}: removing the space is a different name`);
      }
    }));

  test('two users with the same name assigns neither', () =>
    withDatabase(async (db) => {
      await addUser(db, { name: 'Alice Smith', email: 'alice1@example.com' });
      await addUser(db, { name: 'alice  smith', email: 'alice2@example.com' });
      const row = await historicalRow(db, { salesPerson: 'Alice Smith' });

      await db.query(BACKFILL);

      for (const t of ALL) {
        assert.equal(await ownerOf(db, t, row[t]), null, `${t}: no arbitrary choice between two people`);
      }
    }));

  test('a name nobody carries stays unassigned, and the migration still succeeds', () =>
    withDatabase(async (db) => {
      await addUser(db, { name: 'Ramesh' });
      const row = await historicalRow(db, { salesPerson: 'Somebody Who Left In 2019' });

      await db.query(BACKFILL);

      for (const t of ALL) assert.equal(await ownerOf(db, t, row[t]), null, t);
    }));

  test('blank and missing salesperson fields are both simply missing', () =>
    withDatabase(async (db) => {
      await addUser(db, { name: 'Ramesh' });
      const missing = await historicalRow(db, {});
      const blank = await historicalRow(db, { salesPerson: '   ', salesPersonEmail: '   ' });

      await db.query(BACKFILL);

      for (const t of ALL) {
        assert.equal(await ownerOf(db, t, missing[t]), null, `${t}: null`);
        assert.equal(await ownerOf(db, t, blank[t]), null, `${t}: whitespace`);
      }
    }));

  // ------------------------------------------------------------ precedence

  test('the email wins when the name points somewhere else', () =>
    withDatabase(async (db) => {
      const byEmail = await addUser(db, { name: 'Alice Smith', email: 'a@example.com' });
      const byName = await addUser(db, { name: 'Ramesh', email: 'ramesh@example.com' });
      const row = await historicalRow(db, { salesPerson: 'Ramesh', salesPersonEmail: 'a@example.com' });

      await db.query(BACKFILL);

      for (const t of WITH_EMAIL) {
        assert.equal(await ownerOf(db, t, row[t]), byEmail, `${t}: the address decides`);
        assert.notEqual(await ownerOf(db, t, row[t]), byName, `${t}: the name does not get a vote`);
      }
      assert.equal(
        await ownerOf(db, 'projects', row.projects), byName,
        'projects has only the name to go on, so the name rule applies there'
      );
    }));

  // ------------------------------------------------------- who may be owner

  test('an inactive user is still a valid historical owner', () =>
    withDatabase(async (db) => {
      // An attribution-only row: a name from the old data, no email, cannot
      // sign in. Exactly what the name rule exists to resolve.
      const left = await addUser(db, { name: 'Vishnu', active: false });
      const byName = await historicalRow(db, { salesPerson: 'Vishnu' });
      // And somebody switched off who kept their address.
      const gone = await addUser(db, { name: 'Gone', email: 'gone@example.com', active: false });
      const byEmail = await historicalRow(db, { salesPersonEmail: 'gone@example.com' });

      await db.query(BACKFILL);

      for (const t of ALL) assert.equal(await ownerOf(db, t, byName[t]), left, `${t}: inactive, by name`);
      for (const t of WITH_EMAIL) assert.equal(await ownerOf(db, t, byEmail[t]), gone, `${t}: inactive, by email`);
    }));

  test('role is not consulted: an admin may own historical sales records', () =>
    withDatabase(async (db) => {
      const boss = await addUser(db, { name: 'Ramesh', email: 'ramesh@example.com', role: 'admin' });
      const row = await historicalRow(db, { salesPerson: 'Ramesh' });

      await db.query(BACKFILL);

      for (const t of ALL) assert.equal(await ownerOf(db, t, row[t]), boss, t);
    }));

  // ------------------------------------------------ the no-overwrite rule

  test('a record that already has an owner is never reassigned', () =>
    withDatabase(async (db) => {
      const keep = await addUser(db, { name: 'Keep Me', email: 'keep@example.com' });
      const claimant = await addUser(db, { name: 'Ramesh', email: 'ramesh@example.com' });
      // Every historical signal points at the claimant; the row is already
      // owned by somebody else, and that decision stands.
      const row = await historicalRow(db, {
        salesPerson: 'Ramesh', salesPersonEmail: 'ramesh@example.com', owner: keep,
      });

      await db.query(BACKFILL);

      for (const t of ALL) {
        assert.equal(await ownerOf(db, t, row[t]), keep, `${t}: a hand-made correction survives`);
        assert.notEqual(await ownerOf(db, t, row[t]), claimant, t);
      }
    }));

  test('running it again changes nothing, and picks up an account added since', () =>
    withDatabase(async (db) => {
      const ramesh = await addUser(db, { name: 'Ramesh' });
      const known = await historicalRow(db, { salesPerson: 'Ramesh' });
      const stranger = await historicalRow(db, { salesPerson: 'Vishnu' });

      await db.query(BACKFILL);
      await db.query(BACKFILL);

      for (const t of ALL) {
        assert.equal(await ownerOf(db, t, known[t]), ramesh, `${t}: stable across runs`);
        assert.equal(await ownerOf(db, t, stranger[t]), null, t);
      }

      // Vishnu joins later; a re-run claims their records and leaves the rest.
      const vishnu = await addUser(db, { name: 'Vishnu' });
      await db.query(BACKFILL);

      for (const t of ALL) {
        assert.equal(await ownerOf(db, t, stranger[t]), vishnu, `${t}: newly resolvable`);
        assert.equal(await ownerOf(db, t, known[t]), ramesh, `${t}: still untouched`);
      }
    }));

  test('the legacy salesperson fields are left exactly as they were', () =>
    withDatabase(async (db) => {
      await addUser(db, { name: 'Ramesh', email: 'ramesh@example.com' });
      await historicalRow(db, { salesPerson: '  Ramesh  ', salesPersonEmail: '  Ramesh@Example.com  ' });
      await db.query(`UPDATE projects SET project_manager = 'Diksha', project_manager_email = 'd@example.com'`);

      await db.query(BACKFILL);

      const [e] = (await db.query('SELECT sales_person, sales_person_email FROM enquiries')).rows;
      assert.equal(e.sales_person, '  Ramesh  ', 'not trimmed, not rewritten');
      assert.equal(e.sales_person_email, '  Ramesh@Example.com  ');
      const [p] = (await db.query('SELECT project_manager, project_manager_email FROM projects')).rows;
      assert.equal(p.project_manager, 'Diksha', 'the project manager is not the salesperson, and is untouched');
      assert.equal(p.project_manager_email, 'd@example.com');
    }));

  test('the project manager is never mistaken for the owner', () =>
    withDatabase(async (db) => {
      const pm = await addUser(db, { name: 'Diksha', email: 'diksha@example.com' });
      await db.query(
        `INSERT INTO projects (project_id, client_name, project_manager, project_manager_email)
         VALUES ('PRJ-2026-777', 'Old Client', 'Diksha', 'diksha@example.com')`
      );

      await db.query(BACKFILL);

      const [row] = (await db.query(`SELECT owner_user_id FROM projects WHERE project_id = 'PRJ-2026-777'`)).rows;
      assert.equal(row.owner_user_id, null, `delivering a project is not owning the sale (would have been ${pm})`);
    }));

  test('no user is created, promoted, reactivated or otherwise altered', () =>
    withDatabase(async (db) => {
      await addUser(db, { name: 'Ramesh', email: 'ramesh@example.com', role: 'sales' });
      await addUser(db, { name: 'Vishnu', active: false });
      await historicalRow(db, { salesPerson: 'Ramesh' });
      await historicalRow(db, { salesPerson: 'Nobody At All' });
      const snapshot = () =>
        db.query('SELECT id, name, email, role, active, session_version FROM users ORDER BY id')
          .then((r) => r.rows);
      const before = await snapshot();

      await db.query(BACKFILL);

      assert.deepEqual(await snapshot(), before);
    }));

  // ------------------------------------------------------------ diagnostic

  test('the diagnostic counts each table without naming anybody', () =>
    withDatabase(async (db) => {
      await addUser(db, { name: 'Ramesh', email: 'ramesh@example.com' });
      await addUser(db, { name: 'Twin', email: 'twin1@example.com' });
      await addUser(db, { name: 'twin', email: 'twin2@example.com' });
      await historicalRow(db, { salesPerson: 'Ramesh' });                       // unique name
      await historicalRow(db, { salesPersonEmail: 'ramesh@example.com' });       // email
      await historicalRow(db, { salesPerson: 'Twin' });                          // ambiguous
      await historicalRow(db, { salesPerson: 'Nobody' });                        // no signal

      await db.query(BACKFILL);
      const { rows } = await db.query(DIAGNOSTIC);

      assert.deepEqual(rows.map((r) => r.table_name), ['enquiries', 'projects', 'quotations']);
      const by = Object.fromEntries(rows.map((r) => [r.table_name, r]));

      // enquiries and quotations: the email row and the unique-name row are
      // owned; the ambiguous and unknown ones are not.
      for (const t of WITH_EMAIL) {
        assert.equal(Number(by[t].total), 4, t);
        assert.equal(Number(by[t].owned), 2, `${t}: email + unique name`);
        assert.equal(Number(by[t].name_ambiguous), 1, t);
        assert.equal(Number(by[t].no_signal), 1, t);
        assert.equal(Number(by[t].email_would_match), 0, `${t}: backfill left nothing matchable`);
        assert.equal(Number(by[t].name_would_match), 0, t);
      }
      // projects has no email column, so the email-only row has no signal.
      assert.equal(Number(by.projects.owned), 1, 'projects: the unique-name row only');
      assert.equal(Number(by.projects.no_signal), 2);

      assert.ok(
        !JSON.stringify(rows).includes('@') && !JSON.stringify(rows).includes('Ramesh'),
        'counts only — no address and no name leaves the diagnostic'
      );
    }));
});
