/**
 * The date-range filter on a list (`ListPage dateRange`): the presets it
 * offers and the ?from=&to= pair each one means. The server filters the
 * resource's `dateFilter` column on that pair, both ends inclusive.
 *
 * A list is drilled into by "what came in lately" more than by financial
 * period, so the rolling windows come first; the month, quarter and year
 * spans are the Reports page's own (reportPeriods.js), so a list and a
 * report agree on what "this quarter" is.
 */
import { presetPeriod } from './reportPeriods.js';

export const LIST_DATE_PRESETS = [
  { key: 'today', label: 'Today' },
  { key: 'last-7', label: 'Last 7 days' },
  { key: 'last-30', label: 'Last 30 days' },
  { key: 'this-month', label: 'This month' },
  { key: 'last-month', label: 'Last month' },
  { key: 'this-quarter', label: 'This quarter (FY)' },
  { key: 'this-fy', label: 'This FY' },
  { key: 'last-fy', label: 'Last FY' },
  { key: 'custom', label: 'Custom range' },
];

/** `day` moved by `n` calendar days, on the calendar so no clock can shift it. */
function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** { from, to } for a preset as of `today`; null for custom or an unknown key. */
export function listPresetRange(key, today) {
  switch (key) {
    case 'today': return { from: today, to: today };
    // "Last 7 days" counts today, as people say it: today and the six before.
    case 'last-7': return { from: addDays(today, -6), to: today };
    case 'last-30': return { from: addDays(today, -29), to: today };
    case 'custom': return null;
    default: return LIST_DATE_PRESETS.some((p) => p.key === key) ? presetPeriod(key, today) : null;
  }
}

/** The preset a from/to pair is: '' for no range, else its key or 'custom'. */
export function listPresetOf(from, to, today) {
  if (!from && !to) return '';
  const match = LIST_DATE_PRESETS.find((p) => {
    const range = listPresetRange(p.key, today);
    return range && range.from === (from || '') && range.to === (to || '');
  });
  return match?.key ?? 'custom';
}
