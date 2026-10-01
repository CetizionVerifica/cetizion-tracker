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
