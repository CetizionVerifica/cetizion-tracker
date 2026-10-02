/**
 * Receivables ageing bands, written down once. Collections and Insights both
 * bucket by these edges, so one invoice cannot be "31–60" on one screen and
 * "1–30" on the other.
 *
 * Imports nothing, so a test can check the edges without a database.
 */

// Money that is not late yet used to land in the same bucket as money a
// month late, because days_overdue is negative before the due date and the
// lookup floored it. It is a different conversation, so it gets its own band.
export const AGEING_BUCKETS = Object.freeze([
  { key: 'not-due', label: 'Not yet due', lo: -1e6, hi: 0 },
  { key: '1-30', label: '1–30 days', lo: 1, hi: 30 },
  { key: '31-60', label: '31–60 days', lo: 31, hi: 60 },
  { key: '61-90', label: '61–90 days', lo: 61, hi: 90 },
  { key: '90+', label: 'Over 90 days', lo: 91, hi: 1e6 },
]);

export const ageingBucketOf = (days) => (AGEING_BUCKETS.find((b) => days >= b.lo && days <= b.hi) || AGEING_BUCKETS[0]).key;

/**
 * How long a follow-up has been overdue, in calendar days since its date.
 * 0 is "due today": the date has come and nothing was logged.
 */
export const FOLLOW_UP_BANDS = Object.freeze([
  { key: '0-3', label: 'Up to 3 days', lo: 0, hi: 3 },
  { key: '4-7', label: '4–7 days', lo: 4, hi: 7 },
  { key: '8-14', label: '8–14 days', lo: 8, hi: 14 },
  { key: '15+', label: '15 days or more', lo: 15, hi: 1e6 },
]);

export const followUpBandOf = (days) => (FOLLOW_UP_BANDS.find((b) => days >= b.lo && days <= b.hi) || FOLLOW_UP_BANDS[0]).key;

/**
 * A `lo-hi` or `lo+` range from a query string (`8-14`, `15+`), or null.
 * The quotation list takes ?overdue_days= in this form, so a bar on
 * Insights opens exactly the rows it counted.
 */
export function parseDayRange(raw) {
  const m = /^(\d+)(?:-(\d+)|\+)$/.exec(String(raw ?? '').trim());
  if (!m) return null;
  const lo = Number(m[1]);
  const hi = m[2] === undefined ? Infinity : Number(m[2]);
  return hi < lo ? null : { lo, hi };
}
