import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { describe } from 'node:test';
import pg from 'pg';

/**
 * When a deal was decided (#18 §3, migration 064).
 *
 * Five of §5's KPIs are defined on a won or lost date — orders won, order
 * intake, win rate, sales cycle, time to decision — and #18 opens by saying
 * the 44 won quotations have none. These are the columns that answer it.
 *
 * The rule is enforced by a trigger rather than by the routes, and the
 * reason is worth testing directly: a quotation's status changes through at
 * least four code paths (the generic CRUD PATCH, the convert flow, the
 * importer's merge, and the pipeline stage sync), and a rule written four
 * times has four chances to be missed. Every test here writes SQL straight
 * at the table — the one path that bypasses all application code — because
 * if the rule holds there it holds everywhere.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
const SCHEMA = readFileSync(join(DB_DIR, 'schema.sql'), 'utf8');
const VIEWS = readFileSync(join(DB_DIR, 'views.sql'), 'utf8');
const MIGRATION = readFileSync(join(DB_DIR, 'migrations', '064_decision_dates.sql'), 'utf8');

const WON = 'Won - PO Received';
const LOST = 'Lost';

/** The table as it was before 064, so the migration is run against it. */
const UNDO = `
  DROP TRIGGER IF EXISTS z_quotation_decision_dates ON quotations;
  DROP TRIGGER IF EXISTS z_enquiry_decision_date ON enquiries;
  ALTER TABLE quotations DROP COLUMN IF EXISTS won_at, DROP COLUMN IF EXISTS won_at_estimated,
                         DROP COLUMN IF EXISTS lost_at, DROP COLUMN IF EXISTS lost_at_estimated;
  ALTER TABLE enquiries  DROP COLUMN IF EXISTS decided_at, DROP COLUMN IF EXISTS decided_at_estimated;
`;

async function withDatabase(fn) {
  const name = `decdates_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
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
    const root = new pg.Client({ connectionString: ADMIN_URL });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await root.end();
  }
}

let seq = 0;
async function quotation(db, { status = 'Submitted', date = '2026-03-01' } = {}) {
  seq += 1;
  const { rows } = await db.query(
    `INSERT INTO quotations (quotation_no, client_name, quotation_date, quotation_value, status)
     VALUES ($1, 'A Client', $2, 100000, $3) RETURNING id`,
    [`CTZ/QT/2026/${String(seq).padStart(4, '0')}`, date, status]
  );
  return rows[0].id;
}
async function enquiry(db, { status = 'New', date = '2026-02-01' } = {}) {
  seq += 1;
  const { rows } = await db.query(
    `INSERT INTO enquiries (enquiry_no, client_name, enquiry_date, status)
     VALUES ($1, 'A Client', $2, $3) RETURNING id`,
    [`CTZ/ENQ/2026/${String(seq).padStart(4, '0')}`, date, status]
  );
  return rows[0].id;
}
const row = async (db, table, id) =>
  (await db.query(`SELECT * FROM ${table} WHERE id = $1`, [id])).rows[0];
const setStatus = (db, table, id, status) =>
  db.query(`UPDATE ${table} SET status = $1 WHERE id = $2`, [status, id]);

describe('decision dates', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  // ------------------------------------------------------ the transition

  test('a quotation moved to won gets a won date, and nothing else does', () =>
    withDatabase(async (db) => {
      const id = await quotation(db);
      assert.equal((await row(db, 'quotations', id)).won_at, null, 'an open quotation is undecided');

      await setStatus(db, 'quotations', id, WON);
      const won = await row(db, 'quotations', id);
      assert.ok(won.won_at, 'moving to Won stamps the date');
      assert.equal(won.won_at_estimated, false, 'a date we watched happen is not an estimate');
      assert.equal(won.lost_at, null);
    }));

  test('a quotation moved to lost gets a lost date', () =>
    withDatabase(async (db) => {
      const id = await quotation(db);
      await setStatus(db, 'quotations', id, LOST);
      const lost = await row(db, 'quotations', id);
      assert.ok(lost.lost_at);
      assert.equal(lost.lost_at_estimated, false);
      assert.equal(lost.won_at, null);
    }));

  test('an edit that is not a status change does not restamp the date', () =>
    withDatabase(async (db) => {
      const id = await quotation(db);
      await setStatus(db, 'quotations', id, WON);
      const first = (await row(db, 'quotations', id)).won_at;

      await db.query('UPDATE quotations SET quotation_value = 250000 WHERE id = $1', [id]);

      assert.deepEqual((await row(db, 'quotations', id)).won_at, first,
        'correcting the price of a won deal must not drag the win into this month');
    }));

  test('reopening clears both dates, so a stale one cannot sit in a period for ever', () =>
    withDatabase(async (db) => {
      const id = await quotation(db);
      await setStatus(db, 'quotations', id, WON);
      await setStatus(db, 'quotations', id, 'Under Negotiation');

      const reopened = await row(db, 'quotations', id);
      assert.equal(reopened.won_at, null, 'a quotation back in negotiation has not been won');
      assert.equal(reopened.lost_at, null);
      assert.equal(reopened.won_at_estimated, false);
    }));

  test('won then lost keeps only the outcome that is true now', () =>
    withDatabase(async (db) => {
      const id = await quotation(db);
      await setStatus(db, 'quotations', id, WON);
      await setStatus(db, 'quotations', id, LOST);

      const after = await row(db, 'quotations', id);
      assert.equal(after.won_at, null, 'two columns disagreeing about one deal is worse than either');
      assert.ok(after.lost_at);
    }));

  test('a quotation created already won is stamped on insert', () =>
    withDatabase(async (db) => {
      const id = await quotation(db, { status: WON });
      assert.ok((await row(db, 'quotations', id)).won_at, 'the importer creates records in their final state');
    }));

  test('an explicit date survives, so an admin can correct a guess', () =>
    withDatabase(async (db) => {
      const id = await quotation(db);
      await db.query(
        `UPDATE quotations SET status = $1, won_at = '2026-01-15T10:00:00Z', won_at_estimated = false WHERE id = $2`,
        [WON, id]
      );
      assert.equal((await row(db, 'quotations', id)).won_at.toISOString(), '2026-01-15T10:00:00.000Z');
    }));

  // ------------------------------------------------------------ enquiries

  test('an enquiry is decided when it is quoted or turned down, not while it is a lead', () =>
    withDatabase(async (db) => {
      for (const open of ['New', 'Contacted', 'Qualified', 'Nurture']) {
        const id = await enquiry(db, { status: open });
        assert.equal((await row(db, 'enquiries', id)).decided_at, null, `${open} is still in progress`);
      }
      for (const decided of ['Converted', 'Unqualified']) {
        const id = await enquiry(db);
        await setStatus(db, 'enquiries', id, decided);
        assert.ok((await row(db, 'enquiries', id)).decided_at, `${decided} is a decision`);
      }
    }));

  test('an enquiry reopened from a decision loses the date', () =>
    withDatabase(async (db) => {
      const id = await enquiry(db);
      await setStatus(db, 'enquiries', id, 'Unqualified');
      await setStatus(db, 'enquiries', id, 'Contacted');
      assert.equal((await row(db, 'enquiries', id)).decided_at, null);
    }));

  // ------------------------------------------------------------- backfill

  test('history decided before any of this gets a date, labelled as estimated', () =>
    withDatabase(async (db) => {
      await db.query(UNDO);
      const won = await quotation(db, { status: WON, date: '2025-06-10' });
      const lost = await quotation(db, { status: LOST, date: '2025-07-20' });
      const open = await quotation(db, { status: 'Submitted', date: '2025-08-01' });
      const conv = await enquiry(db, { status: 'Converted', date: '2025-05-05' });

      // These stand for records decided before the stage history existed,
      // so they carry no closed_at. Inserting one already-won makes
      // c_stage_sync stamp closed_at with now(), which is correct for a
      // transition happening now and wrong for history being described —
      // the next test covers the case where a real closed_at is present.
      await db.query('UPDATE quotations SET closed_at = NULL WHERE id = ANY($1::int[])',
        [[won, lost, open]]);

      await db.query(MIGRATION);

      const w = await row(db, 'quotations', won);
      assert.equal(w.won_at.toISOString().slice(0, 10), '2025-06-10', 'estimated from quotation_date');
      assert.equal(w.won_at_estimated, true, 'a sales cycle from this is zero days, which must be labelled');

      const l = await row(db, 'quotations', lost);
      assert.equal(l.lost_at.toISOString().slice(0, 10), '2025-07-20');
      assert.equal(l.lost_at_estimated, true);

      const o = await row(db, 'quotations', open);
      assert.equal(o.won_at, null, 'an open quotation is not given a decision date');

      const e = await row(db, 'enquiries', conv);
      assert.equal(e.decided_at.toISOString().slice(0, 10), '2025-05-05');
      assert.equal(e.decided_at_estimated, true, 'an enquiry has no closed_at to fall back on');
    }));

  test('a real closed_at is preferred to a guess, and is not called an estimate', () =>
    withDatabase(async (db) => {
      await db.query(UNDO);
      const id = await quotation(db, { status: WON, date: '2025-06-10' });
      await db.query("UPDATE quotations SET closed_at = '2025-09-30T12:00:00Z' WHERE id = $1", [id]);

      await db.query(MIGRATION);

      const w = await row(db, 'quotations', id);
      assert.equal(w.won_at.toISOString(), '2025-09-30T12:00:00.000Z', 'a real transition beats quotation_date');
      assert.equal(w.won_at_estimated, false, 'and is not an estimate');
    }));

  test('a won quotation with nothing to infer from stays null rather than inventing a date', () =>
    withDatabase(async (db) => {
      await db.query(UNDO);
      const id = await quotation(db, { status: WON });
      await db.query('UPDATE quotations SET quotation_date = NULL, closed_at = NULL WHERE id = $1', [id]);

      await db.query(MIGRATION);

      const w = await row(db, 'quotations', id);
      assert.equal(w.won_at, null, 'null is the honest answer for a record that never said');
      assert.equal(w.won_at_estimated, false);
    }));

  test('the backfill is idempotent and does not relabel a corrected date', () =>
    withDatabase(async (db) => {
      await db.query(UNDO);
      const id = await quotation(db, { status: WON, date: '2025-06-10' });
      await db.query(MIGRATION);

      // An admin corrects the guess to the real date.
      await db.query(
        "UPDATE quotations SET won_at = '2025-06-25T09:00:00Z', won_at_estimated = false WHERE id = $1", [id]);
      await db.query(MIGRATION);

      const w = await row(db, 'quotations', id);
      assert.equal(w.won_at.toISOString(), '2025-06-25T09:00:00.000Z', 'a correction is not undone by a re-run');
      assert.equal(w.won_at_estimated, false);
    }));
});
