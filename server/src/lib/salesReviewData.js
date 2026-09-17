import { query } from '../db.js';
import { IN_PERIOD, RATES, inPeriod } from './salesReport.js';
import { monthRows } from './revenueReport.js';
import { NO_SERVICE, OTHER_SERVICE, SERVICE_LINES, serviceLinesFor } from './serviceLines.js';

/**
 * Figures only the sales review PDF uses: the enquiry funnel, the service
 * lines, the exchange rates and the gaps in the source data. The Sales
 * reports page does not show these.
 */

export const ENQUIRY_STATUS = { open: 'In Progress', declined: 'Declined', quoted: 'Won - Quotation Sent' };
const WON = 'Won - PO Received';
const LOST = 'Lost';

const r2 = (n) => Math.round(n * 100) / 100;
const ratio = (part, whole) => (whole ? part / whole : null);

/** Value in INR of some quotations, how many have no value, and what has no rate. */
function inrTotals(quotations) {
  let inr = 0;
  let withoutValue = 0;
  const unconverted = new Map();
  for (const q of quotations) {
    if (q.quotation_value == null) withoutValue += 1;
    else if (q.rate == null) unconverted.set(q.currency, r2((unconverted.get(q.currency) || 0) + q.quotation_value));
    else inr += q.quotation_value * q.rate;
  }
  return {
    value_inr: r2(inr),
    without_value: withoutValue,
    unconverted: [...unconverted].map(([currency, amount]) => ({ currency, amount })),
  };
}

function wonValue(quotations) {
  const { value_inr, without_value, unconverted } = inrTotals(quotations);
  return { won_value_inr: value_inr, won_without_value: without_value, won_unconverted: unconverted };
}

/**
 * Enquiries by their status on the Enquiries page. What became of the
 * quotations they led to is the quotation section's subject, so the enquiry
 * figures deliberately do not join quotations or exchange rates.
 */
export function summariseEnquiries(rows) {
  const quoted = rows.filter((row) => row.status === ENQUIRY_STATUS.quoted).length;
  return {
    enquiries: rows.length,
    in_progress: rows.filter((row) => row.status === ENQUIRY_STATUS.open).length,
    declined: rows.filter((row) => row.status === ENQUIRY_STATUS.declined).length,
    quoted,
    quote_rate: ratio(quoted, rows.length),
  };
}

/** The enquiry section's figures from enquiry rows (dated YYYY-MM-DD, oldest first). */
export function enquirySummary(rows, period = {}) {
  const months = monthRows(rows, period, summariseEnquiries);
  const dated = months.filter((m) => m.month);
  const busiest = dated.reduce((best, m) => (m.enquiries > (best?.enquiries ?? 0) ? m : best), null);
  const oldestOpen = rows.find((row) => row.status === ENQUIRY_STATUS.open && row.enquiry_date);
  return {
    months,
    total: summariseEnquiries(rows),
    average_per_month: dated.length ? r2(dated.reduce((n, m) => n + m.enquiries, 0) / dated.length) : null,
    busiest: busiest ? { label: busiest.label, enquiries: busiest.enquiries } : null,
    oldest_open: oldestOpen
      ? { enquiry_no: oldestOpen.enquiry_no, client: oldestOpen.client, enquiry_date: oldestOpen.enquiry_date }
      : null,
  };
}

export async function enquiryReport({ from, to }) {
  const { rows } = await query(
    // Oldest first: the month rows and the oldest open enquiry both read this order.
    `SELECT e.enquiry_no,
            btrim(e.client_name)                   AS client,
            to_char(e.enquiry_date, 'YYYY-MM-DD')  AS enquiry_date,
            to_char(e.enquiry_date, 'YYYY-MM')     AS month,
            e.status
       FROM enquiries e
      WHERE ${inPeriod('e.enquiry_date')}
      ORDER BY e.enquiry_date NULLS LAST, e.enquiry_no`,
    [from, to]
  );
  return enquirySummary(rows, { from, to });
}

/** Quotations and enquiries per service line, named lines first by won value. */
export function serviceRows(quotations, enquiries) {
  const names = [...SERVICE_LINES.map((line) => line.name), OTHER_SERVICE, NO_SERVICE];
  const lines = new Map(names.map((name) => [name, { service: name, enquiries: 0, list: [] }]));
  for (const e of enquiries) for (const name of serviceLinesFor(e.service)) lines.get(name).enquiries += 1;
  for (const q of quotations) for (const name of serviceLinesFor(q.service)) lines.get(name).list.push(q);

  const summarise = (list) => {
    const won = list.filter((q) => q.status === WON);
    const lost = list.filter((q) => q.status === LOST).length;
    return {
      quotations: list.length,
      won: won.length,
      lost,
      pipeline: list.length - won.length - lost,
      win_rate: ratio(won.length, won.length + lost),
      ...wonValue(won),
    };
  };
  const unmatched = (q) => serviceLinesFor(q.service).some((name) => name === OTHER_SERVICE || name === NO_SERVICE);

  const rows = [...lines.values()]
    .filter((line) => line.enquiries || line.list.length)
    .map(({ list, ...line }) => ({
      ...line,
      other: line.service === OTHER_SERVICE || line.service === NO_SERVICE,
      ...summarise(list),
    }))
    .sort((a, b) => a.other - b.other || b.won_value_inr - a.won_value_inr || b.quotations - a.quotations || b.enquiries - a.enquiries);

  return {
    rows,
    // Totals count each quotation once, however many lines it is in.
    summary: {
      enquiries: enquiries.length,
      ...summarise(quotations),
      bundled: quotations.filter((q) => serviceLinesFor(q.service).length > 1).length,
      unmatched: quotations.filter(unmatched).length,
    },
  };
}

export async function serviceReport({ from, to }) {
  const [quotations, enquiries] = await Promise.all([
    query(
      `WITH ${RATES}
       SELECT q.service_quoted AS service, q.status, q.quotation_value, q.currency, r.rate
         FROM quotations q
         LEFT JOIN rates r ON r.currency = q.currency
        WHERE ${IN_PERIOD}`,
      [from, to]
    ),
    query(`SELECT service FROM enquiries WHERE ${inPeriod('enquiry_date')}`, [from, to]),
  ]);
  return serviceRows(quotations.rows, enquiries.rows);
}

/** Quotation statuses as they read: still open first, then the outcome. */
export const QUOTATION_STATUSES = ['Submitted', 'Under Negotiation', 'On Hold', WON, LOST];
const STATUS_FIELD = { Submitted: 'submitted', 'Under Negotiation': 'negotiating', 'On Hold': 'on_hold', [WON]: 'won', [LOST]: 'lost' };

/** How many quotations are at each status, the win rate, and the value still open. */
export function summariseQuotationStatuses(quotations) {
  const counts = Object.fromEntries(Object.values(STATUS_FIELD).map((field) => [field, 0]));
  for (const q of quotations) if (STATUS_FIELD[q.status]) counts[STATUS_FIELD[q.status]] += 1;
  // Open = neither won nor lost, the same as "Pipeline" in the sector table.
  const open = inrTotals(quotations.filter((q) => q.status !== WON && q.status !== LOST));
  return {
    quotations: quotations.length,
    ...counts,
    open: quotations.filter((q) => q.status !== WON && q.status !== LOST).length,
    win_rate: ratio(counts.won, counts.won + counts.lost),
    ...inrTotals(quotations),
    open_value_inr: open.value_inr,
    open_without_value: open.without_value,
    open_unconverted: open.unconverted,
  };
}

/** Quotations (month YYYY-MM, oldest first) per status, per month and in total. */
export function quotationStatusSummary(rows, period = {}) {
  // Every status is listed, even at zero; one the Quotations page gains later still counts.
  const others = [...new Set(rows.map((q) => q.status).filter((status) => !QUOTATION_STATUSES.includes(status)))];
  return {
    rows: [...QUOTATION_STATUSES, ...others].map((status) => {
      const list = rows.filter((q) => q.status === status);
      return { status, quotations: list.length, ...inrTotals(list) };
    }),
    months: monthRows(rows, period, summariseQuotationStatuses),
    total: summariseQuotationStatuses(rows),
  };
}

export async function quotationStatusReport({ from, to }) {
  const { rows } = await query(
    `WITH ${RATES}
     SELECT q.quotation_no,
            to_char(q.quotation_date, 'YYYY-MM') AS month,
            q.status,
            q.quotation_value,
            q.currency,
            r.rate
       FROM quotations q
       LEFT JOIN rates r ON r.currency = q.currency
      WHERE ${IN_PERIOD}
      ORDER BY q.quotation_date NULLS LAST, q.quotation_no`,
    [from, to]
  );
  return quotationStatusSummary(rows, { from, to });
}

/** INR for one unit of each currency, null where Settings has no rate. */
export async function exchangeRates() {
  const { rows } = await query(`WITH ${RATES} SELECT currency, rate FROM rates`);
  return Object.fromEntries(rows.map((row) => [row.currency, row.rate]));
}

/** Missing or inconsistent source data that limits the report. */
export async function dataGaps({ from, to }) {
  const {
    rows: [gaps],
  } = await query(
    `WITH q AS (SELECT * FROM quotations WHERE ${IN_PERIOD}),
          e AS (SELECT * FROM enquiries WHERE ${inPeriod('enquiry_date')})
     SELECT (SELECT COUNT(*) FROM q)::int                                              AS quotations,
            (SELECT COUNT(*) FROM q WHERE quotation_value IS NULL)::int                AS quotations_without_value,
            (SELECT COUNT(*) FROM q WHERE quotation_value IS NULL AND status = '${WON}')::int AS won_without_value,
            (SELECT COUNT(*) FROM q
              WHERE status = '${WON}'
                AND NOT EXISTS (SELECT 1 FROM purchase_orders p
                                 WHERE p.quotation_no = q.quotation_no
                                    OR (q.project_id IS NOT NULL AND p.project_id = q.project_id)))::int AS won_without_po,
            (SELECT COUNT(*) FROM q WHERE NULLIF(btrim(sector), '') IS NULL)::int       AS quotations_without_sector,
            (SELECT COUNT(*) FROM q WHERE NULLIF(btrim(sales_person), '') IS NULL)::int AS quotations_without_sales_person,
            (SELECT COUNT(*) FROM e)::int                                              AS enquiries,
            (SELECT COUNT(*) FROM e WHERE NULLIF(btrim(sector), '') IS NULL)::int       AS enquiries_without_sector,
            (SELECT COUNT(*) FROM e
              WHERE status = '${ENQUIRY_STATUS.quoted}' AND quotation_no IS NULL)::int AS quoted_enquiries_unlinked,
            -- Rows with no date only fall outside a period when one is chosen.
            (CASE WHEN $1::date IS NULL AND $2::date IS NULL THEN 0
                  ELSE (SELECT COUNT(*) FROM quotations WHERE quotation_date IS NULL) END)::int AS undated_quotations,
            (CASE WHEN $1::date IS NULL AND $2::date IS NULL THEN 0
                  ELSE (SELECT COUNT(*) FROM enquiries WHERE enquiry_date IS NULL) END)::int   AS undated_enquiries`,
    [from, to]
  );
  return gaps;
}
