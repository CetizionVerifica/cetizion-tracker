/**
 * Reports (#22): the few numbers a quarter is judged on, each one a chart
 * with a table twin and a filtered list behind every bar.
 *
 *   GET /api/reports/win-rate?quarters=8     won / (won + lost) by financial quarter
 *   GET /api/reports/conversion?by=sector    won / lost / rate by sector, owner or service
 *   GET /api/reports/quoted-won?months=6     what was quoted against what was won, by month
 *   GET /api/reports/by-status               open deals by the status they are sitting in
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

/**
 * Win rate by a dimension rather than by time.
 *
 * The quarterly rate says whether the team is getting better; this says
 * where it is already good, which is a different question and the one a
 * sales lead asks before deciding what to chase. Only three dimensions are
 * offered because they are the three a quotation actually carries.
 */
const DIMENSIONS = {
  sector: { column: 'sector', label: 'Sector' },
  owner: { column: 'sales_person', label: 'Owner' },
  service: { column: 'service_quoted', label: 'Service' },
};

const MAX_ROWS = 12;

reportsRouter.get('/conversion', async (req, res) => {
  const asked = String(req.query.by || 'sector');
  const dimension = DIMENSIONS[asked] ? asked : 'sector';
  const { column, label } = DIMENSIONS[dimension];

  // The column is chosen from a fixed map, never taken from the query, so
  // the only thing interpolated is one of three known identifiers.
  const { rows } = await query(
    `SELECT COALESCE(NULLIF(btrim(${column}), ''), 'Not recorded') AS key,
            COUNT(*) FILTER (WHERE stage_type = 'won')::int  AS won,
            COUNT(*) FILTER (WHERE stage_type = 'lost')::int AS lost,
            COALESCE(SUM(quotation_value) FILTER (WHERE stage_type = 'won' AND currency = 'INR'), 0)::float8 AS won_value
       FROM v_quotations
      WHERE stage_type IN ('won', 'lost')
      GROUP BY 1
      ORDER BY (COUNT(*) FILTER (WHERE stage_type = 'won')) DESC, COUNT(*) DESC
      LIMIT $1`,
    [MAX_ROWS]
  );

  const groups = rows.map((row) => {
    const closed = row.won + row.lost;
    return { ...row, closed, win_rate: closed > 0 ? row.won / closed : null };
  });
  res.json({ data: { dimension, label, groups } });
});

const MIN_MONTHS = 3;
const MAX_MONTHS = 24;
const DEFAULT_MONTHS = 6;

/**
 * Quoted against won, by the month the quotation is dated.
 *
 * Two series on one axis, because the gap between them is the thing —
 * a month where both fell is a quiet month, and a month where quoting
 * held while winning fell is a problem, and one bar cannot say which.
 * Both are INR only, like every other money figure on this page; a
 * quotation in another currency is counted and reported separately
 * rather than converted at today's rate into a month that has passed.
 */
reportsRouter.get('/quoted-won', async (req, res) => {
  const asked = Number(req.query.months);
  const months = Math.min(Math.max(Number.isFinite(asked) ? Math.trunc(asked) : DEFAULT_MONTHS, MIN_MONTHS), MAX_MONTHS);
  const today = businessToday();

  const { rows } = await query(
    `SELECT to_char(date_trunc('month', quotation_date), 'YYYY-MM') AS month,
            COALESCE(SUM(quotation_value) FILTER (WHERE currency = 'INR'), 0)::float8 AS quoted,
            COALESCE(SUM(quotation_value) FILTER (WHERE currency = 'INR' AND stage_type = 'won'), 0)::float8 AS won,
            COUNT(*)::int AS deals,
            COUNT(*) FILTER (WHERE currency <> 'INR')::int AS foreign_deals
       FROM v_quotations
      WHERE quotation_date >= (date_trunc('month', $1::date) - make_interval(months => $2::int - 1))
      GROUP BY 1 ORDER BY 1`,
    [today, months]
  );

  // Months with nothing quoted are still months: a gap in the axis reads as
  // missing data rather than as a quiet March.
  const start = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
  const wanted = [];
  for (let i = months - 1; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - i, 1));
    wanted.push(d.toISOString().slice(0, 7));
  }
  const byMonth = new Map(rows.map((r) => [r.month, r]));
  const series = wanted.map((month) => byMonth.get(month) || { month, quoted: 0, won: 0, deals: 0, foreign_deals: 0 });

  res.json({ data: { today, months: series, foreign: series.reduce((n, m) => n + m.foreign_deals, 0) } });
});

/**
 * Open deals by the status they are sitting in.
 *
 * The pipeline chart is by stage, which is what the team moves a deal
 * through. Status is what the record says it is, and the two drift — a
 * deal parked at "On Hold" for a month is invisible on a stage board that
 * only shows where it got to.
 */
reportsRouter.get('/by-status', async (req, res) => {
  const { rows } = await query(
    `SELECT COALESCE(NULLIF(btrim(status), ''), 'Not recorded') AS status,
            COUNT(*)::int AS deals,
            COALESCE(SUM(quotation_value) FILTER (WHERE currency = 'INR'), 0)::float8 AS value,
            COUNT(*) FILTER (WHERE currency <> 'INR')::int AS foreign_deals
       FROM v_quotations
      WHERE stage_type NOT IN ('won', 'lost')
      GROUP BY 1 ORDER BY 2 DESC`
  );
  res.json({ data: { statuses: rows, foreign: rows.reduce((n, r) => n + r.foreign_deals, 0) } });
});
