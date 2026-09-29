import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { describe } from 'node:test';
import pg from 'pg';

/**
 * Migrations 066 and 067, run against the shape they are written for.
 *
 * Both are tested by putting the tables back the way they were and then
 * running the file, because a migration only ever run against the schema it
 * already produced proves nothing about the databases it will meet. The
 * same reasoning as mcpTokenIdentity.test.js.
 *
 * What has to hold for #18's "migrations are additive" criterion: existing
 * rows survive, the new constraints do not reject data the table already
 * held, and a second run changes nothing.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
const SCHEMA = readFileSync(join(DB_DIR, 'schema.sql'), 'utf8');
const VIEWS = readFileSync(join(DB_DIR, 'views.sql'), 'utf8');
const M066 = readFileSync(join(DB_DIR, 'migrations', '066_target_periods.sql'), 'utf8');
const M067 = readFileSync(join(DB_DIR, 'migrations', '067_payment_origin.sql'), 'utf8');

/** sales_targets as 062 left it: keyed on a calendar year. */
const UNDO_066 = `
  DROP INDEX IF EXISTS sales_targets_period_unique_idx;
  DROP INDEX IF EXISTS sales_targets_period_idx;
  ALTER TABLE sales_targets
    DROP CONSTRAINT IF EXISTS sales_targets_period_ordered,
    DROP CONSTRAINT IF EXISTS sales_targets_period_type_check,
    DROP CONSTRAINT IF EXISTS sales_targets_metric_known,
    DROP COLUMN IF EXISTS period_start,
    DROP COLUMN IF EXISTS period_end,
    DROP COLUMN IF EXISTS period_type;
  ALTER TABLE sales_targets ALTER COLUMN calendar_year SET NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS sales_targets_unique_idx
    ON sales_targets (salesperson_user_id, calendar_year, metric, COALESCE(currency, ''));
  DELETE FROM settings WHERE key = 'stale_quotation_days';
`;

/** payments as #27 left it: no origin column, opening balances known only by their notes. */
const UNDO_067 = `
  DROP INDEX IF EXISTS payments_received_on_idx;
  ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_origin_check;
  ALTER TABLE payments DROP COLUMN IF EXISTS origin;

  -- The trigger has to go back too. schema.sql now ships 067's version,
  -- which sets NEW.origin; leaving it beside a dropped column would be a
  -- state no real database was ever in, and every insert would fail with
  -- "record new has no field origin" before the migration got a chance.
  CREATE OR REPLACE FUNCTION payments_opening() RETURNS trigger AS $fn$
  DECLARE cur record;
  BEGIN
    IF NEW.notes = 'Opening balance from the stage' THEN RETURN NEW; END IF;
    IF NOT EXISTS (SELECT 1 FROM payments WHERE stage_id = NEW.stage_id) THEN
      SELECT amount_received, payment_received_date INTO cur FROM payment_stages WHERE id = NEW.stage_id;
      IF cur.amount_received > 0 THEN
        INSERT INTO payments (stage_id, amount, received_on, mode, notes)
        VALUES (NEW.stage_id, cur.amount_received, cur.payment_received_date, 'other', 'Opening balance from the stage');
      END IF;
    END IF;
    RETURN NEW;
  END $fn$ LANGUAGE plpgsql;
`;

async function withDatabase(prefix, fn) {
  const name = `${prefix}_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
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

const salesperson = async (db, name = 'Ramesh') => (await db.query(
  `INSERT INTO users (name, email, password_hash, role, active)
   VALUES ($1, $2, 'x', 'sales', true) RETURNING id`,
  [name, `${name.toLowerCase()}@example.com`]
)).rows[0].id;

describe('migration 066 — targets by period', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  test('an existing annual target keeps its value and gains the year as a range', () =>
    withDatabase('m066_keep', async (db) => {
      await db.query(UNDO_066);
      const uid = await salesperson(db);
      await db.query(
        `INSERT INTO sales_targets (salesperson_user_id, calendar_year, metric, target_value, unit, currency)
         VALUES ($1, 2026, 'order_intake_value', 5000000, 'currency', 'INR')`, [uid]);

      await db.query(M066);

      const { rows: [t] } = await db.query(
        'SELECT target_value, period_start::text, period_end::text, period_type, calendar_year FROM sales_targets');
      assert.equal(Number(t.target_value), 5000000, 'nothing anybody set is lost');
      assert.equal(t.period_start, '2026-01-01');
      assert.equal(t.period_end, '2027-01-01');
      assert.equal(t.period_type, 'year');
      assert.equal(t.calendar_year, 2026, 'and the old column is kept, not dropped');
    }));

  test('twelve monthly targets in one year become possible', () =>
    withDatabase('m066_monthly', async (db) => {
      await db.query(UNDO_066);
      const uid = await salesperson(db);
      await db.query(M066);

      for (let m = 1; m <= 12; m += 1) {
        const start = `2026-${String(m).padStart(2, '0')}-01`;
        const end = m === 12 ? '2027-01-01' : `2026-${String(m + 1).padStart(2, '0')}-01`;
        await db.query(
          `INSERT INTO sales_targets (salesperson_user_id, period_start, period_end, period_type, metric, target_value, unit, currency)
           VALUES ($1, $2::date, $3::date, 'month', 'order_intake_value', 100000, 'currency', 'INR')`,
          [uid, start, end]);
      }
      const { rows: [c] } = await db.query('SELECT COUNT(*)::int AS n FROM sales_targets');
      assert.equal(c.n, 12, "the old index keyed on the year and would have refused the second");
    }));

  test('the same person, period and metric is still refused twice', () =>
    withDatabase('m066_unique', async (db) => {
      await db.query(UNDO_066);
      const uid = await salesperson(db);
      await db.query(M066);
      const insert = () => db.query(
        `INSERT INTO sales_targets (salesperson_user_id, period_start, period_end, period_type, metric, target_value, unit)
         VALUES ($1, '2026-04-01', '2026-05-01', 'month', 'won_quotations_count', 5, 'count')`, [uid]);
      await insert();
      await assert.rejects(insert, /sales_targets_period_unique_idx/);
    }));

  test('a metric nothing computes cannot be stored', () =>
    withDatabase('m066_metric', async (db) => {
      await db.query(UNDO_066);
      const uid = await salesperson(db);
      await db.query(M066);
      await assert.rejects(
        () => db.query(
          `INSERT INTO sales_targets (salesperson_user_id, period_start, period_end, period_type, metric, target_value, unit)
           VALUES ($1, '2026-04-01', '2026-05-01', 'month', 'handshakes', 5, 'count')`, [uid]),
        /sales_targets_metric_known/,
        'a target on a metric nothing computes is a bar that never moves and no error anybody sees'
      );
    }));

  test('a period that ends before it starts is refused', () =>
    withDatabase('m066_ordered', async (db) => {
      await db.query(UNDO_066);
      const uid = await salesperson(db);
      await db.query(M066);
      await assert.rejects(
        () => db.query(
          `INSERT INTO sales_targets (salesperson_user_id, period_start, period_end, period_type, metric, target_value, unit)
           VALUES ($1, '2026-05-01', '2026-04-01', 'month', 'won_quotations_count', 5, 'count')`, [uid]),
        /sales_targets_period_ordered/
      );
    }));

  test('it seeds the stale-quotation threshold #18 §5 leaves open', () =>
    withDatabase('m066_setting', async (db) => {
      await db.query(UNDO_066);
      await db.query(M066);
      const { rows: [s] } = await db.query("SELECT value FROM settings WHERE key = 'stale_quotation_days'");
      assert.equal(s.value, '14', 'the number #18 suggests, changeable without a deploy');
    }));

  test('is idempotent', () =>
    withDatabase('m066_twice', async (db) => {
      await db.query(UNDO_066);
      const uid = await salesperson(db);
      await db.query(
        `INSERT INTO sales_targets (salesperson_user_id, calendar_year, metric, target_value, unit)
         VALUES ($1, 2026, 'won_quotations_count', 40, 'count')`, [uid]);
      await db.query(M066);
      await db.query(M066);
      const { rows } = await db.query('SELECT period_start, target_value FROM sales_targets');
      assert.equal(rows.length, 1);
      assert.equal(Number(rows[0].target_value), 40);
    }));
});

describe('migration 067 — telling a receipt from a balance', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  async function stage(db) {
    await db.query(`INSERT INTO projects (project_id, client_name) VALUES ('PRJ-1', 'A Client')`);
    await db.query(
      `INSERT INTO purchase_orders (po_number, project_id, po_date, po_value, currency)
       VALUES ('PO-1', 'PRJ-1', '2026-04-01', 500000, 'INR')`);
    return (await db.query(
      `INSERT INTO payment_stages (po_number, stage_no, stage_name, trigger_event, stage_percent)
       VALUES ('PO-1', 1, 'Advance', 'On PO Registration', 1) RETURNING id`)).rows[0].id;
  }

  test('existing rows are classified by the marks they already carry', () =>
    withDatabase('m067_classify', async (db) => {
      await db.query(UNDO_067);
      const id = await stage(db);
      await db.query(
        `INSERT INTO payments (stage_id, amount, received_on, mode, notes) VALUES
          ($1, 200000, '2026-05-01', 'other', 'Opening balance from the stage'),
          ($1, 100000, '2026-06-01', 'bank_transfer', NULL),
          ($1, -25000, '2026-06-05', 'other', 'Adjusted: total set to 275000')`, [id]);

      await db.query(M067);

      const { rows } = await db.query('SELECT amount, origin FROM payments ORDER BY id');
      assert.deepEqual(rows.map((r) => r.origin), ['opening_balance', 'receipt', 'adjustment'],
        'the prose match is used exactly once — to retire itself');
    }));

  test('a new receipt defaults to being a receipt', () =>
    withDatabase('m067_default', async (db) => {
      await db.query(UNDO_067);
      const id = await stage(db);
      await db.query(M067);
      await db.query(
        `INSERT INTO payments (stage_id, amount, received_on, mode) VALUES ($1, 50000, '2026-07-01', 'upi')`, [id]);
      const { rows: [p] } = await db.query("SELECT origin FROM payments WHERE amount = 50000");
      assert.equal(p.origin, 'receipt');
    }));

  test('the trigger marks a balance it carries in, without relying on the notes', () =>
    withDatabase('m067_trigger', async (db) => {
      await db.query(UNDO_067);
      const id = await stage(db);
      await db.query(M067);

      // A stage paid before receipts were itemised, then receipted again.
      await db.query(
        `UPDATE payment_stages SET amount_received = 300000, payment_received_date = '2025-11-01' WHERE id = $1`, [id]);
      await db.query(
        `INSERT INTO payments (stage_id, amount, received_on, mode) VALUES ($1, 50000, '2026-07-01', 'upi')`, [id]);

      const { rows } = await db.query('SELECT amount, origin FROM payments ORDER BY amount DESC');
      assert.equal(rows.length, 2, 'payments_opening books what was already there');
      assert.equal(rows[0].origin, 'opening_balance');
      assert.equal(Number(rows[0].amount), 300000);
      assert.equal(rows[1].origin, 'receipt');
    }));

  test('an unknown origin is refused', () =>
    withDatabase('m067_check', async (db) => {
      await db.query(UNDO_067);
      const id = await stage(db);
      await db.query(M067);
      await assert.rejects(
        () => db.query(
          `INSERT INTO payments (stage_id, amount, mode, origin) VALUES ($1, 1, 'upi', 'guesswork')`, [id]),
        /payments_origin_check/
      );
    }));

  test('the stage total is still the sum of its rows, whatever their origin', () =>
    withDatabase('m067_total', async (db) => {
      await db.query(UNDO_067);
      const id = await stage(db);
      await db.query(M067);
      await db.query(
        `INSERT INTO payments (stage_id, amount, tds_amount, received_on, mode, origin) VALUES
          ($1, 90000, 10000, '2026-06-01', 'bank_transfer', 'receipt'),
          ($1, -20000, 0, '2026-06-05', 'other', 'adjustment')`, [id]);

      const { rows: [s] } = await db.query('SELECT amount_received FROM payment_stages WHERE id = $1', [id]);
      assert.equal(Number(s.amount_received), 80000,
        'payments_changed is untouched: 067 adds a label, it does not change the arithmetic');
    }));

  test('is idempotent', () =>
    withDatabase('m067_twice', async (db) => {
      await db.query(UNDO_067);
      const id = await stage(db);
      await db.query(
        `INSERT INTO payments (stage_id, amount, received_on, mode, notes)
         VALUES ($1, 200000, '2026-05-01', 'other', 'Opening balance from the stage')`, [id]);
      await db.query(M067);
      await db.query(M067);
      const { rows } = await db.query('SELECT origin FROM payments');
      assert.deepEqual(rows.map((r) => r.origin), ['opening_balance']);
    }));
});
