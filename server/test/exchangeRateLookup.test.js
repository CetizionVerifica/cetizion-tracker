import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import pg from 'pg';
import { rateOn } from '../src/lib/salesReport.js';

/**
 * The dated lookup itself, run in Postgres against the real SQL the reports
 * build. Needs a database: set TEST_DATABASE_URL (CI does). Nothing is
 * created or written — the rates and records are inline VALUES lists, so the
 * lookup is exercised exactly as written without touching any table.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;

// USD has rates from 2025-01-01 and 2026-04-01. EUR has none at all.
const FIXTURE_RATES = `rates AS (
  SELECT 'INR'::text AS currency, 1::numeric AS rate, '0001-01-01'::date AS effective_from
  UNION ALL
  SELECT * FROM (VALUES
    ('USD', 83.00::numeric, '2025-01-01'::date),
    ('USD', 86.50::numeric, '2026-04-01'::date),
    ('USD', 88.90::numeric, '2026-09-20'::date)
  ) v(currency, rate, effective_from)
)`;

/** The rate the reports would use for one record, and the date it came from. */
async function rateFor(currency, date) {
  const client = new pg.Client({ connectionString: ADMIN_URL });
  await client.connect();
  try {
    const { rows } = await client.query(
      `WITH ${FIXTURE_RATES},
       q(currency, quotation_date) AS (VALUES ($1::text, $2::date))
       SELECT r.rate::float8 AS rate, r.effective_from::text AS effective_from
         FROM q
         ${rateOn('r', 'q.currency', 'q.quotation_date')}`,
      [currency, date]
    );
    return rows[0];
  } finally {
    await client.end();
  }
}

describe('the rate in force on a record own date', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  test('a date before the first rate has none, so the amount stays unconverted', async () => {
    assert.deepEqual(await rateFor('USD', '2024-06-30'), { rate: null, effective_from: null });
  });

  test('a date on the day a rate takes effect uses that rate, not the one before', async () => {
    assert.deepEqual(await rateFor('USD', '2026-04-01'), { rate: 86.5, effective_from: '2026-04-01' });
  });

  test('a date between two rates uses the earlier one', async () => {
    assert.deepEqual(await rateFor('USD', '2025-07-15'), { rate: 83, effective_from: '2025-01-01' });
    assert.deepEqual(await rateFor('USD', '2026-05-17'), { rate: 86.5, effective_from: '2026-04-01' });
  });

  test('a date after the last rate uses the last one', async () => {
    assert.deepEqual(await rateFor('USD', '2027-12-31'), { rate: 88.9, effective_from: '2026-09-20' });
  });

  test('a currency with no rate at all stays unconverted', async () => {
    assert.deepEqual(await rateFor('EUR', '2026-05-17'), { rate: null, effective_from: null });
  });

  test('INR is always 1, whatever the date', async () => {
    for (const date of ['2019-01-01', '2026-05-17', '2030-01-01']) {
      assert.equal((await rateFor('INR', date)).rate, 1);
    }
  });

  test('a record with no date falls back to today rather than dropping out', async () => {
    const today = new Date().toISOString().slice(0, 10);
    assert.deepEqual(await rateFor('USD', null), await rateFor('USD', today),
      'an undated record converts exactly as one dated today would');
  });

  test('adding a newer rate cannot change what an older record converts at', async () => {
    const before = await rateFor('USD', '2025-07-15');
    // FIXTURE_RATES already holds rates dated after it; the 2025 record is
    // unaffected by both, which is the whole point of dating them.
    assert.deepEqual(before, { rate: 83, effective_from: '2025-01-01' });
  });

});
