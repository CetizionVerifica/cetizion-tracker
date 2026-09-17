import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { describe } from 'node:test';
import pg from 'pg';

/**
 * Migration 010 on a database that already holds real data: the Settings
 * rates must carry over so that every figure is the same the moment the
 * switch happens. Needs a Postgres the runner may create databases on: set
 * TEST_DATABASE_URL (CI does).
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
const MIGRATION = readFileSync(join(DB_DIR, 'migrations', '013_exchange_rates.sql'), 'utf8');

// The shape 010 arrives at: the tables it reads, and the trigger it attaches.
const BEFORE = `
CREATE TABLE settings (key text PRIMARY KEY, value text NOT NULL, notes text,
                       updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE projects (project_id text PRIMARY KEY);
CREATE TABLE quotations (id serial PRIMARY KEY, quotation_no text NOT NULL UNIQUE,
                         quotation_date date, quotation_value numeric(16,2),
                         currency text NOT NULL DEFAULT 'INR');
CREATE TABLE purchase_orders (po_number text PRIMARY KEY, po_date date,
                              currency text NOT NULL DEFAULT 'INR');
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

INSERT INTO settings (key, value) VALUES
  ('fx_rate_USD', '88.25'), ('fx_rate_EUR', '111.00'),
  ('fx_rate_GBP', ''),      -- never set: must stay "not set"
  ('fx_rate_AED', '  '),    -- blank spaces: also not set
  ('fx_rate_SGD', 'abc');   -- unusable: must not become a rate
INSERT INTO quotations (quotation_no, quotation_date, quotation_value, currency) VALUES
  ('Q-OLD', '2025-03-04', 1000, 'USD'),
  ('Q-MID', '2026-02-11', 2000, 'EUR'),
  ('Q-GBP', '2026-05-05', 3000, 'GBP');
INSERT INTO purchase_orders (po_number, po_date, currency) VALUES ('PO-1', '2025-01-20', 'USD');
`;

async function withDatabase(fn) {
  const name = `fx_migration_test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(ADMIN_URL);
    url.pathname = `/${name}`;
    const client = new pg.Client({ connectionString: url.toString() });
    try {
      // Connecting is inside the try: a failure here must still drop the
      // database and close the admin client, or the run never exits.
      await client.connect();
      await client.query(BEFORE);
      return await fn(client);
    } finally {
      await client.end();
    }
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
    await admin.end();
  }
}

/** What each quotation converts to, the way the reports do it. */
const CONVERTED = `
  WITH rates AS (
    SELECT 'INR'::text AS currency, 1::numeric AS rate, '0001-01-01'::date AS effective_from
    UNION ALL
    SELECT from_currency, rate, effective_from FROM exchange_rates WHERE to_currency = 'INR'
  )
  SELECT q.quotation_no, (q.quotation_value * r.rate)::float8 AS inr
    FROM quotations q
    LEFT JOIN LATERAL (
      SELECT rate FROM rates
       WHERE currency = q.currency
         AND effective_from <= COALESCE(q.quotation_date, CURRENT_DATE)
       ORDER BY effective_from DESC LIMIT 1
    ) r ON true
   ORDER BY q.quotation_no`;

describe('010 carries the Settings rates over', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  test('runs on a database that already holds data', () =>
    withDatabase(async (client) => {
      await client.query(MIGRATION);
      const { rows } = await client.query(
        `SELECT from_currency, to_currency, rate::float8, effective_from::text, source, note
           FROM exchange_rates ORDER BY from_currency`);
      // Only the two usable settings become rates; blank and unusable stay unset.
      assert.deepEqual(rows.map((r) => r.from_currency), ['EUR', 'USD']);
      assert.deepEqual(rows.map((r) => r.rate), [111, 88.25]);
      assert.ok(rows.every((r) => r.to_currency === 'INR' && r.source === 'manual'));
      // Dated from the earliest record that exists, so nothing predates a rate.
      assert.ok(rows.every((r) => r.effective_from === '2025-01-20'), 'earliest PO date');
      assert.ok(rows.every((r) => /estimates/.test(r.note)), 'says older rates are estimates');
    }));

  test('every figure is the same the moment the switch happens', () =>
    withDatabase(async (client) => {
      // What the reports showed the day before: one current value per currency.
      const { rows: before } = await client.query(`
        WITH rates AS (
          SELECT 'INR'::text AS currency, 1::numeric AS rate
          UNION ALL
          SELECT substr(key, 9),
                 CASE WHEN btrim(value) ~ '^[0-9]+(\.[0-9]+)?$' THEN NULLIF(btrim(value)::numeric, 0) END
            FROM settings WHERE key LIKE 'fx\_rate\_%'
        )
        SELECT q.quotation_no, (q.quotation_value * r.rate)::float8 AS inr
          FROM quotations q LEFT JOIN rates r ON r.currency = q.currency
         ORDER BY q.quotation_no`);

      await client.query(MIGRATION);
      const { rows: after } = await client.query(CONVERTED);

      assert.deepEqual(after, before, 'no figure may move when the switch happens');
      // And the currency that was never set is still reported as unconverted.
      assert.equal(after.find((r) => r.quotation_no === 'Q-GBP').inr, null);
    }));

  test('the old settings are marked read-only, not deleted', () =>
    withDatabase(async (client) => {
      await client.query(MIGRATION);
      const { rows } = await client.query(
        `SELECT count(*)::int AS kept,
                count(*) FILTER (WHERE notes LIKE 'Replaced by%')::int AS marked
           FROM settings WHERE key LIKE 'fx\_rate\_%'`);
      assert.deepEqual(rows[0], { kept: 5, marked: 5 });
    }));

  test('running it twice changes nothing, like every other migration here', () =>
    withDatabase(async (client) => {
      await client.query(MIGRATION);
      // The runner never repeats a migration, but re-running one by hand is a
      // documented recovery, so it has to be safe from the first statement on.
      await client.query(MIGRATION);
      const { rows } = await client.query('SELECT count(*)::int AS n FROM exchange_rates');
      assert.equal(rows[0].n, 2);
    }));
});
