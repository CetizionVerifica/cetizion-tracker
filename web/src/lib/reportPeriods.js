/**
 * The Reports page's period control (docs/sales-report-rework-plan.md §3.2).
 *
 * Dates are plain YYYY-MM-DD strings and all arithmetic is on the calendar,
 * so no clock or time zone can move a day. Financial years run April to
 * March, as everywhere else in the tracker; calendar years are offered too.
 */

const pad = (n) => String(n).padStart(2, '0');
const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
/** The last day of a month, `m` 1–12. */
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const monthSpan = (y, m) => ({ from: ymd(y, m, 1), to: ymd(y, m, lastDay(y, m)) });
const fyStart = (y, m) => (m >= 4 ? y : y - 1);

/** Today where the browser is, as YYYY-MM-DD. */
export function localToday(now = new Date()) {
  return ymd(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

/** In the order the menu lists them: financial year first, as Reports always has. */
export const PRESETS = [
  { key: 'this-fy', label: 'This FY' },
  { key: 'this-quarter', label: 'This quarter (FY)' },
  { key: 'this-month', label: 'This month' },
  { key: 'last-month', label: 'Last month' },
  { key: 'last-fy', label: 'Last FY' },
  { key: 'this-year', label: 'This calendar year' },
  { key: 'last-year', label: 'Last calendar year' },
  { key: 'custom', label: 'Custom' },
];

export const DEFAULT_PRESET = 'this-month';

/** { from, to } for a preset, as of `today`. Custom has none of its own. */
export function presetPeriod(key, today) {
  const [y, m] = today.split('-').map(Number);
  switch (key) {
    case 'this-month': return monthSpan(y, m);
    case 'last-month': return m === 1 ? monthSpan(y - 1, 12) : monthSpan(y, m - 1);
    case 'this-quarter': {
      // FY quarters: Apr–Jun, Jul–Sep, Oct–Dec, Jan–Mar.
      const first = m - ((m - 4 + 12) % 3);
      const start = first < 1 ? first + 12 : first;
      const startYear = first < 1 ? y - 1 : y;
      const endMonth = ((start + 1) % 12) + 1;
      const endYear = endMonth < start ? startYear + 1 : startYear;
      return { from: ymd(startYear, start, 1), to: ymd(endYear, endMonth, lastDay(endYear, endMonth)) };
    }
    case 'this-fy': { const s = fyStart(y, m); return { from: ymd(s, 4, 1), to: ymd(s + 1, 3, 31) }; }
    case 'last-fy': { const s = fyStart(y, m) - 1; return { from: ymd(s, 4, 1), to: ymd(s + 1, 3, 31) }; }
    case 'this-year': return { from: ymd(y, 1, 1), to: ymd(y, 12, 31) };
    case 'last-year': return { from: ymd(y - 1, 1, 1), to: ymd(y - 1, 12, 31) };
    default: return null;
  }
}

/** The preset a from/to pair is, or "custom". */
export function presetOf(from, to, today) {
  const match = PRESETS.find((p) => p.key !== 'custom' && (() => {
    const period = presetPeriod(p.key, today);
    return period.from === from && period.to === to;
  })());
  return match?.key ?? 'custom';
}

/** Mirrors defaultGrain on the server: a month or less by day, up to six months by week. */
export function defaultGrain(from, to) {
  if (!from || !to) return 'month';
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
  if (days <= 31) return 'day';
  if (days <= 186) return 'week';
  return 'month';
}

/**
 * The report's period and filters read off the address bar, with defaults:
 * the page's state lives there, so a link or a bookmark is the report.
 */
export function readReportQuery(searchParams, today) {
  const valid = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
  let from = searchParams.get('from');
  let to = searchParams.get('to');
  if (!valid(from) || !valid(to) || from > to) ({ from, to } = presetPeriod(DEFAULT_PRESET, today));
  const grain = ['day', 'week', 'month'].includes(searchParams.get('grain')) ? searchParams.get('grain') : '';
  const owner = /^\d+$/.test(searchParams.get('owner') || '') ? searchParams.get('owner') : '';
  return { from, to, grain, owner, preset: presetOf(from, to, today) };
}

/** The last day of the bucket starting `key` at `grain`, clipped to the period. */
export function bucketEnd(key, grain, periodTo) {
  let end;
  if (grain === 'day') end = key;
  else if (grain === 'week') end = new Date(Date.parse(`${key}T00:00:00Z`) + 6 * 86_400_000).toISOString().slice(0, 10);
  else { const [y, m] = key.split('-').map(Number); end = ymd(y, m, lastDay(y, m)); }
  return periodTo && end > periodTo ? periodTo : end;
}

/** The first day of a bucket, clipped to the period. */
export function bucketStart(key, grain, periodFrom) {
  const start = grain === 'month' ? `${key}-01` : key;
  return periodFrom && start < periodFrom ? periodFrom : start;
}

/**
 * A link to the records behind a slice: the list, carrying the report's
 * period and owner so the server runs the same rules the chart did.
 */
export function drillLink(list, { from, to, owner }, slice = {}) {
  const params = new URLSearchParams({ report_from: from, report_to: to });
  if (owner) params.set('report_owner', owner);
  for (const [key, value] of Object.entries(slice)) if (value != null && value !== '') params.set(`report_${key}`, value);
  return `/${list}?${params}`;
}
