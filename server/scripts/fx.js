#!/usr/bin/env node
/**
 * Exchange-rate chores, run by hand.
 *
 *   npm run fx:today                    fetch today's ECB rates and store them
 *   npm run fx:backfill -- 2026-01-01   load every publishing day from that date
 *   npm run fx:status                   what is stored now, and how old it is
 *
 * The daily fetch also runs on a schedule (jobs.js, `exchange.rates`); this is
 * the same code, for when somebody wants it now.
 *
 * The backfill is deliberate, not automatic. It changes what historical
 * figures convert to — a report run after it will not match one run before —
 * so it is a command somebody types, having decided that is what they want.
 * Hand-entered rates are never touched, whichever command is used.
 */
import pg from 'pg';
import { config } from '../src/config.js';
import { backfillExchangeRates, runExchangeRateSync, rateAges, trackedCurrencies } from '../src/lib/fx.ts';
import { businessToday } from '../src/lib/businessDate.ts';

const pool = new pg.Pool({ connectionString: config.databaseUrl });
const db = { query: (sql, params) => pool.query(sql, params) };

/** Where the rates are going, so nobody backfills the wrong database by accident. */
function announceTarget() {
  const url = new URL(config.databaseUrl);
  console.log(`database: ${url.hostname}:${url.port || 5432}${url.pathname}\n`);
}

const commands = {
  async today() {
    announceTarget();
    // Not 'manual': that is what the source column calls a rate somebody
    // typed, and these are feed rows that a person merely asked for early.
    const result = await runExchangeRateSync({ db, startedBy: 'command line' });
    console.log(`✓ ECB ${result.ecb_date}: ${result.written} row(s) written for ${result.currencies.join(', ')}`);
    if (result.missing.length) console.warn(`! not published that day: ${result.missing.join(', ')}`);
    if (result.kept_manual.length) console.log(`• left alone (entered by hand): ${result.kept_manual.join(', ')}`);
  },

  async backfill() {
    const from = process.argv[3];
    const to = process.argv[4] || null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '')) {
      throw new Error('give the date to start from, e.g. npm run fx:backfill -- 2026-01-01 [end-date]');
    }
    announceTarget();
    console.log(`Backfilling ${trackedCurrencies().join(', ')} from ${from}${to ? ` to ${to}` : ''}.`);
    console.log('Historical figures will convert at the rate of their own day afterwards,');
    console.log('so reports run after this will differ from the same report run before it.\n');
    const result = await backfillExchangeRates({ from, to, db, enteredBy: 'backfill', log: (l) => console.log(`• ${l}`) });
    console.log(`\n✓ ${result.written} row(s) written across ${result.days} publishing days`);
    if (result.kept_manual.length) {
      console.log(`• left alone (entered by hand): ${result.kept_manual.length} row(s)`);
      console.log(`  ${result.kept_manual.slice(0, 10).join(', ')}${result.kept_manual.length > 10 ? ' …' : ''}`);
    }
  },

  async status() {
    announceTarget();
    const { rows } = await db.query(
      `SELECT DISTINCT ON (from_currency) from_currency AS currency, effective_from::text AS effective_from, rate, source
         FROM exchange_rates WHERE to_currency = 'INR'
        ORDER BY from_currency, effective_from DESC`
    );
    const counts = await db.query(
      `SELECT source, count(*)::int AS n, min(effective_from)::text AS first, max(effective_from)::text AS last
         FROM exchange_rates GROUP BY source ORDER BY source`
    );
    const today = businessToday();
    for (const age of rateAges(rows, { today })) {
      const row = rows.find((r) => r.currency === age.currency);
      console.log(`${age.currency}  ${String(row.rate).padStart(12)}  ${age.effective_from}  ${row.source}${age.stale ? `  ← stale (${age.publishing_days} publishing days)` : ''}`);
    }
    console.log();
    for (const c of counts.rows) console.log(`${c.source}: ${c.n} row(s), ${c.first} → ${c.last}`);
  },
};

const command = process.argv[2];
if (!commands[command]) {
  console.error(`Usage: node scripts/fx.js <${Object.keys(commands).join('|')}>`);
  process.exit(1);
}

commands[command]()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error(`\n✗ ${err.message}`);
    await pool.end().catch(() => {});
    process.exit(1);
  });
