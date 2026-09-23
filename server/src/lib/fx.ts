/**
 * Exchange rates from the European Central Bank.
 *
 * The tracker converts every foreign figure at the rate in force on that
 * record's own date (rateOn in salesReport.js). That rule is only as good as
 * the rows behind it: with one rate per currency, a whole year of deals
 * converts at January's number. This module keeps those rows current, and
 * fills in the history the reports read back through.
 *
 * The source is the ECB's euro reference rates: free, no key, published by a
 * central bank every TARGET working day at about 16:00 CET, and available as
 * history going back decades — which is why the same source serves both the
 * daily job and the backfill. Figures produced now and figures produced for
 * last March are then arrived at the same way, with no seam between them.
 *
 * Two things the ECB does not give, and how each is handled:
 *
 *   Rupees per unit. The file is euro-based: one euro buys 1.1463 dollars and
 *   109.58 rupees. So rupees per dollar is 109.58 / 1.1463, a cross rate
 *   through the euro. The euro's own rate is the INR figure as published.
 *
 *   The dirham. The ECB does not publish AED at all. It is pegged to the
 *   dollar at 3.6725 and has been since 1997, so rupees per dirham is the
 *   dollar figure divided by that peg. This is how the tracker's own manual
 *   rows were already arrived at: 95.54 / 3.6725 = 26.02, the AED rate
 *   somebody typed in on 1 January 2026.
 */
import { query } from '../db.js';
import { STATUS } from './statuses.js';

/** The dirham's fixed peg to the dollar, unchanged since 1997. */
export const AED_PER_USD = 3.6725;

export const ECB_DAILY = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';
export const ECB_HISTORY_90D = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml';
export const ECB_HISTORY_FULL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.xml';

/** A day of the ECB file: euros as the base, so EUR itself is not listed. */
export type EcbDay = { date: string; rates: Record<string, number> };

/** One row as the table holds it: rupees for one unit of `currency`. */
export type FeedRate = { currency: string; rate: number; effective_from: string };

type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

/**
 * The currencies the tracker actually uses, minus the rupee itself. Read from
 * STATUS so adding a currency there is the only change needed.
 */
export function trackedCurrencies(): string[] {
  return STATUS.currency.filter((c: string) => c !== 'INR');
}

/**
 * Days of rates out of an ECB file.
 *
 * The daily file quotes its attributes with apostrophes and the history files
 * with quotation marks, so both are accepted. Anything that is not a plain
 * positive number is left out rather than guessed at.
 */
export function parseEcbXml(xml: string): EcbDay[] {
  const days: EcbDay[] = [];
  const dayPattern = /<Cube\s+time=["']([\d-]{10})["']\s*>([\s\S]*?)(?=<Cube\s+time=|<\/Cube>\s*<\/Cube>|$)/g;
  for (const day of xml.matchAll(dayPattern)) {
    const date = day[1];
    const body = day[2];
    if (!date || !body) continue;
    const rates: Record<string, number> = {};
    for (const cell of body.matchAll(/<Cube\s+currency=["']([A-Z]{3})["']\s+rate=["']([\d.]+)["']/g)) {
      const currency = cell[1];
      const rate = Number(cell[2]);
      if (currency && Number.isFinite(rate) && rate > 0) rates[currency] = rate;
    }
    if (Object.keys(rates).length) days.push({ date, rates });
  }
  return days;
}

/**
 * Rupees per unit for one day, for the currencies asked for.
 *
 * A currency the ECB did not publish that day is left out — a report showing
 * an amount unconverted is honest, a report converting at an invented rate is
 * not. The same goes for AED when the dollar is missing.
 */
export function inrRatesFor(day: EcbDay, currencies: string[] = trackedCurrencies()): FeedRate[] {
  const inrPerEur = day.rates.INR;
  if (!inrPerEur) return [];                       // no rupee that day: nothing can be converted
  const rows: FeedRate[] = [];
  for (const currency of currencies) {
    let rate: number | undefined;
    if (currency === 'EUR') rate = inrPerEur;                       // the file's own base
    else if (currency === 'AED') {
      const perUsd = day.rates.USD;
      if (perUsd) rate = inrPerEur / perUsd / AED_PER_USD;          // through the dollar peg
    } else {
      const perUnit = day.rates[currency];
      if (perUnit) rate = inrPerEur / perUnit;                      // cross rate through the euro
    }
    if (rate !== undefined && Number.isFinite(rate) && rate > 0) {
      rows.push({ currency, rate: Number(rate.toFixed(6)), effective_from: day.date });
    }
  }
  return rows;
}

/** Fetch and parse one ECB file. Throws with a readable message; writes nothing. */
export async function fetchEcb(url: string, { timeoutMs = 30_000, fetchImpl = fetch } = {}): Promise<EcbDay[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let xml: string;
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`ECB ${res.status} for ${url}`);
    // Inside the timeout, not after it: the headers arriving says nothing
    // about the body, and a connection that stalls halfway through 8MB of
    // history would otherwise hang the job until somebody noticed.
    xml = await res.text();
  } catch (err: any) {
    if (err?.name === 'AbortError') throw new Error(`ECB timed out after ${timeoutMs / 1000}s`);
    if (/^ECB \d/.test(err?.message || '')) throw err;
    throw new Error(`ECB unreachable: ${err?.message}`);
  } finally {
    clearTimeout(timer);
  }
  const days = parseEcbXml(xml);
  if (!days.length) throw new Error(`ECB returned nothing usable from ${url}`);
  return days;
}

/**
 * Write feed rows, leaving anybody's hand-entered rate exactly as it is.
 *
 * One row per currency per day is the table's own unique key, so running this
 * twice for the same day updates that day rather than adding a second row.
 * The `WHERE source = 'feed'` on the conflict is what protects a manual
 * correction: the insert is refused rather than applied, and the row is
 * counted as kept so the job log says what happened.
 */
export async function upsertFeedRates(rates: FeedRate[], { db = { query } as Db, enteredBy = 'schedule' } = {}) {
  if (!rates.length) return { written: 0, kept_manual: [] as string[] };
  // One statement per call rather than one per rate: a backfill of several
  // years is tens of thousands of rows, and a round trip each would take
  // minutes against a database that is not on this machine.
  const { rows } = await db.query(
    `INSERT INTO exchange_rates (from_currency, to_currency, rate, effective_from, source, entered_by, note)
     SELECT c, 'INR', r, d::date, 'feed', $4, 'ECB reference rate'
       FROM unnest($1::text[], $2::numeric[], $3::text[]) AS t(c, r, d)
     ON CONFLICT (from_currency, to_currency, effective_from) DO UPDATE
        SET rate = EXCLUDED.rate, entered_by = EXCLUDED.entered_by, note = EXCLUDED.note
      WHERE exchange_rates.source = 'feed'
     RETURNING from_currency, effective_from::text AS effective_from`,
    [rates.map((r) => r.currency), rates.map((r) => r.rate), rates.map((r) => r.effective_from), enteredBy]
  );
  // Whatever did not come back was refused by the WHERE above: a rate that
  // somebody entered by hand, left exactly as they left it.
  const stored = new Set(rows.map((r: any) => `${r.from_currency} ${r.effective_from}`));
  const keptManual = rates.map((r) => `${r.currency} ${r.effective_from}`).filter((key) => !stored.has(key));
  return { written: rows.length, kept_manual: keptManual };
}

/**
 * The daily job: today's ECB rates, stored.
 *
 * A failed fetch throws before anything is written, so the run is recorded as
 * failed, the worker carries on and yesterday's rates stand — which is the
 * right answer for a report, because the rate in force on an older record has
 * not changed just because today's file was late.
 */
export async function runExchangeRateSync({ db = { query } as Db, url = ECB_DAILY, fetchImpl = fetch, startedBy = 'schedule' } = {}) {
  const days = await fetchEcb(url, { fetchImpl });
  const day = days[days.length - 1]!;              // the daily file holds one
  const rates = inrRatesFor(day);
  const missing = trackedCurrencies().filter((c) => !rates.some((r) => r.currency === c));
  const result = await upsertFeedRates(rates, { db, enteredBy: startedBy });
  return { ecb_date: day.date, currencies: rates.map((r) => r.currency), missing, ...result };
}

/**
 * Load history from a given date, for the rates the reports read back
 * through. Nothing is invented for a day the ECB did not publish: weekends
 * and bank holidays simply have no row, and the lookup then uses the newest
 * row before them, which is what a bank would have quoted on that day too.
 */
export async function backfillExchangeRates({
  from, to = null, db = { query } as Db, fetchImpl = fetch, enteredBy = 'backfill', log = (_: string) => {},
}: { from: string; to?: string | null; db?: Db; fetchImpl?: typeof fetch; enteredBy?: string; log?: (line: string) => void }) {
  // The 90-day file is a tenth of the size; the full one goes back decades.
  const ninetyDaysAgo = new Date(Date.now() - 88 * 86_400_000).toISOString().slice(0, 10);
  const url = from >= ninetyDaysAgo ? ECB_HISTORY_90D : ECB_HISTORY_FULL;
  log(`reading ${url}`);
  const days = (await fetchEcb(url, { fetchImpl, timeoutMs: 120_000 }))
    .filter((d) => d.date >= from && (!to || d.date <= to))
    .sort((a, b) => a.date.localeCompare(b.date));
  log(`${days.length} publishing days between ${days[0]?.date ?? from} and ${days[days.length - 1]?.date ?? to ?? 'today'}`);

  let written = 0;
  const keptManual: string[] = [];
  // A month at a time: one statement each, and a run that stops halfway has
  // still stored every month before it — the same command picks up from
  // there, because storing a rate twice is storing it once.
  const CHUNK = 20;
  for (let i = 0; i < days.length; i += CHUNK) {
    const batch = days.slice(i, i + CHUNK);
    const res = await upsertFeedRates(batch.flatMap((day) => inrRatesFor(day)), { db, enteredBy });
    written += res.written;
    keptManual.push(...res.kept_manual);
    log(`${batch[0]!.date} to ${batch[batch.length - 1]!.date}: ${res.written} row(s)`);
  }
  return { from, to, days: days.length, written, kept_manual: keptManual };
}

/* ------------------------------------------------------------------ */
/* Staleness                                                            */
/* ------------------------------------------------------------------ */

/**
 * ECB publishing days between two dates, counting weekdays only.
 *
 * Saturday and Sunday are not late rates, they are days with no rate, and a
 * warning that cries wolf every Monday is a warning nobody reads. Bank
 * holidays are not in any list here: allowing a few publishing days before
 * anything is called stale covers them without pretending to know the TARGET
 * calendar.
 */
export function publishingDaysBetween(from: string, to: string): number {
  let days = 0;
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cursor < end) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6) days += 1;
  }
  return days;
}

/** "1 Jan 2026", the way the notice reads it out. */
export function readableDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d} ${months[(m ?? 1) - 1]} ${y}`;
}

export type RateAge = { currency: string; effective_from: string; publishing_days: number; stale: boolean; note: string };

/**
 * How old the newest rate for each currency is, and whether that is worth
 * saying out loud. `maxPublishingDays` allows for a long weekend with a bank
 * holiday on either side before anything is called stale.
 */
export function rateAges(
  latest: Array<{ currency: string; effective_from: string }>,
  { today, maxPublishingDays = 4 }: { today: string; maxPublishingDays?: number }
): RateAge[] {
  return latest.map(({ currency, effective_from }) => {
    const publishing = publishingDaysBetween(effective_from, today);
    return {
      currency,
      effective_from,
      publishing_days: publishing,
      stale: publishing > maxPublishingDays,
      note: `${currency} converted at the rate of ${readableDate(effective_from)}`,
    };
  });
}

/**
 * The newest rate in force for each currency, whoever entered it.
 *
 * Bounded at `asOf` for the same reason rateOn is: a rate dated next month is
 * not in force today. Without the bound, one forward-dated row would report
 * the currency as current for ever while every figure kept converting at the
 * older rate — the warning silenced by the very thing it should describe.
 */
export async function newestRates({ db = { query } as Db, currencies = [] as string[], asOf = new Date().toISOString().slice(0, 10) } = {}) {
  const { rows } = await db.query(
    `SELECT DISTINCT ON (from_currency) from_currency AS currency, effective_from::text AS effective_from, rate, source
       FROM exchange_rates
      WHERE to_currency = 'INR' AND effective_from <= $1::date
        ${currencies.length ? 'AND from_currency = ANY($2)' : ''}
      ORDER BY from_currency, effective_from DESC`,
    currencies.length ? [asOf, currencies] : [asOf]
  );
  return rows as Array<{ currency: string; effective_from: string; rate: string; source: string }>;
}

/**
 * Currencies whose newest rate is itself days old.
 *
 * This is about the table, not about any one record: a deal from June
 * converting at June's rate is right, and saying so would be noise. What is
 * worth saying is that the newest rate a currency has is from months ago,
 * because then every recent figure in it converts at a number from before —
 * which is exactly the state this whole module exists to end.
 *
 * `currencies` narrows it to the ones a page actually shows, so a report with
 * no dirhams on it never mentions the dirham.
 */
export async function staleRates({
  db = { query } as Db, currencies = [] as string[], today = new Date().toISOString().slice(0, 10), maxPublishingDays = 4,
} = {}) {
  const rows = await newestRates({ db, currencies, asOf: today });
  return rateAges(rows, { today, maxPublishingDays }).filter((r) => r.stale);
}
