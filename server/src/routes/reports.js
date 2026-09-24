/**
 * Reports (#22): the few numbers a quarter is judged on, each one a chart
 * with a table twin and a filtered list behind every bar.
 *
 *   GET /api/reports/win-rate?quarters=8   won / (won + lost) by financial quarter
 *
 * Pipeline by stage comes from /api/pipeline, ageing from /api/collections
 * and the cash bands from /api/cashflow. Only win rate had nowhere to come
 * from, because nothing else groups a closed quotation by when it closed.
 *
 * Quarters are Indian financial quarters — Q1 is April to June — because
 * every other total on the screen is stated for a financial year, and two
 * definitions of "this quarter" on one page is one too many.
 */
import { Router } from 'express';
import { config } from '../config.js';
import { query } from '../db.js';
import { businessToday } from '../lib/businessDate.ts';
import { financialQuarter, recentQuarters } from '../lib/quarters.js';

export const reportsRouter = Router();

const MIN_QUARTERS = 1;
const MAX_QUARTERS = 20;
const DEFAULT_QUARTERS = 8;

reportsRouter.get('/win-rate', async (req, res) => {
  const asked = Number(req.query.quarters);
  const count = Math.min(Math.max(Number.isFinite(asked) ? Math.trunc(asked) : DEFAULT_QUARTERS, MIN_QUARTERS), MAX_QUARTERS);
  const today = businessToday();
  const wanted = recentQuarters(today, count);

  // A quotation closes when its stage turns won or lost, and closed_at is
  // stamped then. Rows imported before that column existed fall back to the
  // stage change and then to the quotation date, so none is dropped for want
  // of a timestamp. The date is read where the business is: a deal closed at
  // 9pm on 31 March in Mumbai belongs to that quarter, not the next one.
  const { rows } = await query(
    `SELECT stage_type,
            to_char((COALESCE(closed_at, stage_changed_at, quotation_date::timestamptz)) AT TIME ZONE $2, 'YYYY-MM-DD') AS closed_on,
            quotation_value, currency
       FROM v_quotations
      WHERE stage_type IN ('won', 'lost')
        AND ((COALESCE(closed_at, stage_changed_at, quotation_date::timestamptz)) AT TIME ZONE $2)::date >= $1::date`,
    [wanted[0].starts_on, config.businessTimeZone]);

  const byKey = new Map(wanted.map((q) => [q.key, { ...q, won: 0, lost: 0, won_value: 0, lost_value: 0 }]));
  // The rate is a count, so a deal in another currency counts in it like any
  // other. Only the value beside it is INR, like every total on this page.
  let foreign = 0;
  for (const row of rows) {
    // A `date` comes back from node-pg as a Date at local midnight, which
    // toISOString() then shifts into the previous day east of UTC — so the
    // query hands back text and this reads text.
    const cell = byKey.get(financialQuarter(row.closed_on).key);
    if (!cell) continue;
    const field = row.stage_type === 'won' ? 'won' : 'lost';
    cell[field] += 1;
    if (row.currency === 'INR') cell[`${field}_value`] += Number(row.quotation_value || 0);
    else foreign += 1;
  }

  const here = financialQuarter(today).key;
  const quarters = [...byKey.values()].map((cell) => ({
    ...cell,
    closed: cell.won + cell.lost,
    win_rate: cell.won + cell.lost > 0 ? cell.won / (cell.won + cell.lost) : null,
    current: cell.key === here,
  }));
  const won = quarters.reduce((sum, q) => sum + q.won, 0);
  const closed = quarters.reduce((sum, q) => sum + q.closed, 0);
  res.json({ data: { today, quarters, totals: { won, closed, win_rate: closed > 0 ? won / closed : null }, foreign } });
});
