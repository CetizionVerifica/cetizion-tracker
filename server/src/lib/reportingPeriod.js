import { config } from '../config.js';
import { businessToday } from './businessDate.ts';
import { ApiError } from '../middleware/error.js';

/**
 * The period a report covers (#18 §5, §7).
 *
 * Every range here is **half-open**, `[from, to)`. One convention, stated
 * once, because the alternative is every caller remembering whether the
 * last day is included — and the answer differs between a `date` and a
 * `timestamptz`, which is how "won on 31 March" ends up in two financial
 * years or neither.
 *
 * The default is the Indian financial year, April to March. That is not a
 * preference: the tracker already runs on it. `financialYear()` in
 * lib/sequences.js numbers every invoice `CTZ/INV/26-27/...`, and a
 * management report whose year disagrees with the year on the invoices is
 * one nobody can reconcile. A calendar year is still a period this accepts;
 * it is just not the one assumed when nobody says.
 */

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** April. The month the Indian financial year starts. */
export const FY_START_MONTH = 4;

const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

/** The financial year a date falls in, as its starting calendar year. */
export function financialYearOf(date) {
  const [y, m] = date.split('-').map(Number);
  return m >= FY_START_MONTH ? y : y - 1;
}

/** `[2026-04-01, 2027-04-01)` for 2026. */
export const financialYearRange = (startYear) => ({
  from: iso(startYear, FY_START_MONTH, 1),
  to: iso(startYear + 1, FY_START_MONTH, 1),
});

export const calendarYearRange = (year) => ({ from: iso(year, 1, 1), to: iso(year + 1, 1, 1) });

/** `[2026-03-01, 2026-04-01)`. Month is 1-based. */
export function monthRange(year, month) {
  const nextYear = month === 12 ? year + 1 : year;
  const next = month === 12 ? 1 : month + 1;
  return { from: iso(year, month, 1), to: iso(nextYear, next, 1) };
}

/**
 * A financial quarter, 1–4, where Q1 is April–June.
 *
 * Numbered the way the business numbers them rather than by calendar, for
 * the same reason as the year: "Q3" in a room where the invoices say 26-27
 * means October–December, not July–September.
 */
export function quarterRange(fyStartYear, quarter) {
  const startMonth = FY_START_MONTH + (quarter - 1) * 3;
  const year = fyStartYear + Math.floor((startMonth - 1) / 12);
  const month = ((startMonth - 1) % 12) + 1;
  const { from } = monthRange(year, month);
  const endMonthIndex = startMonth + 2;
  const endYear = fyStartYear + Math.floor(endMonthIndex / 12);
  const endMonth = (endMonthIndex % 12) + 1;
  return { from, to: iso(endYear, endMonth, 1) };
}

/** Days between two ISO dates, on the UTC calendar so no clock can move one. */
const DAY_MS = 86_400_000;
const dayCount = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/**
 * The period before this one, for #18 §6's "change against the previous
 * period".
 *
 * Which "before" depends on what kind of period it is, and the two answers
 * genuinely differ:
 *
 *   a named period   steps back one of the same kind. May compares against
 *                    April, Q1 against the previous Q4, FY26-27 against
 *                    FY25-26. This is what a person means by "last month",
 *                    and it is what makes the comparison line up with the
 *                    months on the chart beside it.
 *   a custom range   steps back by its own length, because there is no
 *                    calendar unit to step. A fortnight compares against
 *                    the fortnight before it.
 *
 * Stepping a named month back by its own length instead would compare May
 * against 31 March–1 May: a window straddling two months, overlapping
 * neither cleanly, and matching nothing else on the page. The calendar
 * distortion that costs — February being three days shorter than January —
 * is real but is the comparison people actually asked for.
 */
export function previousPeriod({ from, to, type }) {
  if (type === 'month') {
    const [y, m] = from.split('-').map(Number);
    return m === 1 ? monthRange(y - 1, 12) : monthRange(y, m - 1);
  }
  if (type === 'quarter') {
    const fy = financialYearOf(from);
    const q = Math.floor(((Number(from.split('-')[1]) - FY_START_MONTH + 12) % 12) / 3) + 1;
    return q === 1 ? quarterRange(fy - 1, 4) : quarterRange(fy, q - 1);
  }
  if (type === 'fy') return financialYearRange(financialYearOf(from) - 1);
  if (type === 'calendar-year') return calendarYearRange(Number(from.slice(0, 4)) - 1);

  const length = dayCount(from, to);
  const shift = (date) => new Date(Date.parse(`${date}T00:00:00Z`) - length * DAY_MS).toISOString().slice(0, 10);
  return { from: shift(from), to: shift(to) };
}

const PRESETS = new Set(['month', 'quarter', 'fy', 'calendar-year']);

/**
 * Work out the range a request means.
 *
 *   from/to           an explicit half-open range, and the only way to ask
 *                     for something the presets do not describe.
 *   preset + anchor   'month' | 'quarter' | 'fy' | 'calendar-year', around
 *                     a date (default: today, where the business is).
 *   nothing           the financial year containing today.
 *
 * Validates rather than coerces. A range whose end precedes its start is a
 * mistake somewhere upstream, and silently swapping them would report
 * confident figures for a period nobody asked about.
 */
export function resolvePeriod({ from, to, preset, anchor, quarter } = {}) {
  const timeZone = config.businessTimeZone || 'Asia/Kolkata';
  const today = businessToday(undefined, timeZone);

  if (from || to) {
    if (!ISO.test(String(from || '')) || !ISO.test(String(to || ''))) {
      throw new ApiError(422, 'from and to must both be dates, as YYYY-MM-DD');
    }
    if (to <= from) throw new ApiError(422, 'to must be after from; the range is half-open [from, to)');
    return { from, to, type: 'custom', label: `${from} to ${to}`, time_zone: timeZone };
  }

  const on = anchor ? String(anchor) : today;
  if (!ISO.test(on)) throw new ApiError(422, 'anchor must be a date, as YYYY-MM-DD');

  const chosen = preset ? String(preset) : 'fy';
  if (!PRESETS.has(chosen)) {
    throw new ApiError(422, `period must be one of: ${[...PRESETS].join(', ')}, or an explicit from and to`);
  }

  const [year, month] = on.split('-').map(Number);
  const fyYear = financialYearOf(on);

  if (chosen === 'month') {
    return { ...monthRange(year, month), type: 'month', label: `${on.slice(0, 7)}`, time_zone: timeZone };
  }
  if (chosen === 'quarter') {
    const q = quarter ? Number(quarter) : Math.floor(((month - FY_START_MONTH + 12) % 12) / 3) + 1;
    if (!Number.isInteger(q) || q < 1 || q > 4) throw new ApiError(422, 'quarter must be 1, 2, 3 or 4');
    return { ...quarterRange(fyYear, q), type: 'quarter', label: `Q${q} FY${String(fyYear % 100).padStart(2, '0')}-${String((fyYear + 1) % 100).padStart(2, '0')}`, time_zone: timeZone };
  }
  if (chosen === 'calendar-year') {
    return { ...calendarYearRange(year), type: 'calendar-year', label: String(year), time_zone: timeZone };
  }
  return {
    ...financialYearRange(fyYear),
    type: 'fy',
    label: `FY${String(fyYear % 100).padStart(2, '0')}-${String((fyYear + 1) % 100).padStart(2, '0')}`,
    time_zone: timeZone,
  };
}

/**
 * The months a range covers, for rolling an annual target up from monthly
 * ones and for a month-by-month series.
 *
 * A month counts when it starts inside the range, so a custom range that
 * begins mid-month does not claim a whole month's target.
 */
export function monthsIn({ from, to }) {
  const months = [];
  let [y, m] = from.split('-').map(Number);
  if (from.slice(8) !== '01') {
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  for (;;) {
    const range = monthRange(y, m);
    if (range.from >= to) break;
    months.push(range);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return months;
}
