/**
 * Months rolled up into Indian financial quarters or years, for Insights.
 *
 * Imports only quarters.js, which imports nothing, so a test can walk the
 * April boundary without a database.
 */
import { financialQuarter } from './quarters.js';

export const GRANULARITIES = Object.freeze(['month', 'quarter', 'fy']);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `YYYY-MM` plus `n` months. */
export function addMonths(yyyymm, n) {
  const [y, m] = yyyymm.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** The last day of a `YYYY-MM`, as YYYY-MM-DD. */
export function monthEnd(yyyymm) {
  const [y, m] = yyyymm.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/** The period a `YYYY-MM` falls in: `{ key, label }`. */
export function periodOf(month, granularity = 'month') {
  if (granularity === 'month') return { key: month, label: `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(2, 4)}` };
  const q = financialQuarter(`${month}-01`);
  if (granularity === 'quarter') return { key: q.key, label: q.label };
  return { key: `FY${q.fy}`, label: `FY${q.fy}` };
}

/**
 * Month rows `{ month: 'YYYY-MM', ...numbers }` summed into periods, in the
 * order the months came. Each period carries `from` and `to`, the first and
 * last day of the months it holds, so a bar can open the list behind it.
 * Only the `fields` named are summed.
 */
export function rollUp(rows, granularity, fields) {
  const out = new Map();
  for (const row of rows) {
    const { key, label } = periodOf(row.month, granularity);
    if (!out.has(key)) out.set(key, { period: key, label, from: `${row.month}-01`, to: monthEnd(row.month), months: [], ...Object.fromEntries(fields.map((f) => [f, 0])) });
    const p = out.get(key);
    p.months.push(row.month);
    p.to = monthEnd(row.month);
    for (const f of fields) p[f] += Number(row[f] || 0);
  }
  return [...out.values()];
}
