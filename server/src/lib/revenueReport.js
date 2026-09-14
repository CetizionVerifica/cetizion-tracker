import { query } from '../db.js';
import { nameKey } from './names.js';
import { IN_PERIOD, RATES } from './salesReport.js';

/**
 * Revenue by month: what was won, and what has since been invoiced and
 * collected against it.
 *
 * A quotation marked "Won - PO Received" is the order, placed in the month
 * of its quotation date. Its money after that lives on the purchase orders
 * linked to it (purchase_orders.quotation_no): PO value, invoiced, received
 * and due now, read from v_purchase_orders. A PO counts only through that
 * link, so it is counted once even when its project holds several won
 * quotations. Every amount is converted to INR at the Settings rate; an
 * amount whose rate is not set is left out of the INR figures and reported
 * separately, never guessed.
 */

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Sep 2026" for "2026-09"; "No date" for an order whose quotation has none. */
export const monthLabel = (month) =>
  month ? `${MONTH_NAMES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}` : 'No date';

const r2 = (n) => Math.round(n * 100) / 100;
const sum = (list, field) => r2(list.reduce((total, row) => total + row[field], 0));

/** Optional ?sector=&sales_person= on top of the period. Sector "__none__" = not set. */
export function revenueFilters(reqQuery) {
  const pick = (name) => String(reqQuery[name] ?? '').trim() || null;
  return { sector: pick('sector'), sales_person: pick('sales_person') };
}

function monthsBetween(first, last) {
  const months = [];
  let [year, month] = first.split('-').map(Number);
  const [lastYear, lastMonth] = last.split('-').map(Number);
  while ((year < lastYear || (year === lastYear && month <= lastMonth)) && months.length < 600) {
    months.push(`${year}-${String(month).padStart(2, '0')}`);
    month += 1;
    if (month > 12) { month = 1; year += 1; }
  }
  return months;
}

function summarise(orders) {
  const valued = orders.filter((row) => row.order_value_inr !== null);
  const unconverted = new Map();
  for (const row of orders) {
    if (row.quotation_value !== null && row.rate === null) {
      unconverted.set(row.currency, r2((unconverted.get(row.currency) || 0) + row.quotation_value));
    }
  }
  const registered = orders.filter((row) => row.po_count > 0);
  const converted = registered.filter((row) => !row.po_rate_missing);
  const intake = sum(valued, 'order_value_inr');
  const poValue = sum(converted, 'po_value_inr');
  const received = sum(converted, 'received_inr');

  return {
    orders_won: orders.length,
    order_intake_inr: intake,
    // Averaged over the orders the intake actually includes.
    average_deal_inr: valued.length ? r2(intake / valued.length) : null,
    orders_without_value: orders.filter((row) => row.quotation_value === null).length,
    order_unconverted: [...unconverted].map(([currency, amount]) => ({ currency, amount })),
    pos: registered.reduce((total, row) => total + row.po_count, 0),
    po_value_inr: poValue,
    invoiced_inr: sum(converted, 'invoiced_inr'),
    received_inr: received,
    due_now_inr: sum(converted, 'due_now_inr'),
    balance_inr: r2(poValue - received),
    // Won orders with no PO linked to them yet.
    not_registered: orders.length - registered.length,
    // Of those, the ones that still need a project before a PO can be added.
    no_project: orders.filter((row) => !row.project_id).length,
    pos_unconverted: registered.length - converted.length,
    po_missing_rates: [...new Set(registered.flatMap((row) => row.po_missing_currencies))].sort(),
  };
}

/**
 * The month rows for a set of orders: every month from the first to the
 * last in range, so a quiet month shows as zero, then one "No date" row for
 * orders whose quotation has no date — which can only happen when no date
 * range is chosen. The rows always add up to the total.
 */
export function revenueMonths(rows, { from, to } = {}) {
  const dated = rows.filter((row) => row.month);
  const first = (from || dated[0]?.month || to || '').slice(0, 7);
  const last = (to || dated.at(-1)?.month || from || '').slice(0, 7);
  const months = (first && last ? monthsBetween(first, last) : []).map((month) => ({
    month,
    label: monthLabel(month),
    ...summarise(rows.filter((row) => row.month === month)),
  }));

  const undated = rows.filter((row) => !row.month);
  if (undated.length) months.push({ month: null, label: monthLabel(null), ...summarise(undated) });
  return months;
}

export async function revenueReport({ from, to }, { sector = null, sales_person = null } = {}) {
  const [orders, years, unlinked] = await Promise.all([
    query(
      `WITH ${RATES},
       pos AS (
         SELECT p.quotation_no,
                COUNT(*)::int                                                       AS po_count,
                string_agg(p.po_number, ', ' ORDER BY p.po_number)                  AS po_numbers,
                string_agg(DISTINCT p.payment_status, ', ')                         AS payment_status,
                bool_or(r.rate IS NULL)                                             AS po_rate_missing,
                COALESCE(array_agg(DISTINCT p.currency) FILTER (WHERE r.rate IS NULL), '{}') AS po_missing_currencies,
                ROUND(SUM(p.po_value * r.rate), 2)                                  AS po_value_inr,
                ROUND(SUM(p.total_invoiced * r.rate), 2)                            AS invoiced_inr,
                ROUND(SUM(p.total_received * r.rate), 2)                            AS received_inr,
                ROUND(SUM(p.balance_due_now * r.rate), 2)                           AS due_now_inr
           FROM v_purchase_orders p
           LEFT JOIN rates r ON r.currency = p.currency
          WHERE p.quotation_no IS NOT NULL
          GROUP BY p.quotation_no
       )
       SELECT q.id,
              q.quotation_no,
              q.quotation_date,
              to_char(q.quotation_date, 'YYYY-MM')                AS month,
              btrim(q.client_name)                                AS client,
              COALESCE(NULLIF(btrim(q.sector), ''), 'Not set')    AS sector,
              q.sales_person,
              q.currency,
              q.quotation_value,
              qr.rate,
              ROUND(q.quotation_value * qr.rate, 2)               AS order_value_inr,
              q.project_id,
              COALESCE(po.po_count, 0)                            AS po_count,
              po.po_numbers,
              po.payment_status,
              COALESCE(po.po_rate_missing, false)                 AS po_rate_missing,
              COALESCE(po.po_missing_currencies, '{}')            AS po_missing_currencies,
              po.po_value_inr,
              po.invoiced_inr,
              po.received_inr,
              po.due_now_inr
         FROM quotations q
         LEFT JOIN rates qr ON qr.currency = q.currency
         LEFT JOIN pos po   ON po.quotation_no = q.quotation_no
        WHERE q.status = 'Won - PO Received'
          AND ${IN_PERIOD}
          AND ($3::text IS NULL
               OR CASE WHEN $3::text = '__none__' THEN NULLIF(${nameKey('q.sector')}, '') IS NULL
                       ELSE ${nameKey('q.sector')} = ${nameKey('$3::text')} END)
          AND ($4::text IS NULL OR ${nameKey('q.sales_person')} = ${nameKey('$4::text')})
        ORDER BY q.quotation_date NULLS LAST, q.quotation_no`,
      [from, to, sector, sales_person]
    ),
    // Years with won orders, for the year picker, whatever the filters.
    query(
      `SELECT DISTINCT EXTRACT(YEAR FROM quotation_date)::int AS year
         FROM quotations
        WHERE status = 'Won - PO Received' AND quotation_date IS NOT NULL
        ORDER BY 1 DESC`
    ),
    // POs that revenue cannot place: no quotation named, or one that is not won.
    query(
      `SELECT p.po_number, p.project_id, p.quotation_no
         FROM purchase_orders p
        WHERE NOT EXISTS (SELECT 1 FROM quotations q
                           WHERE q.quotation_no = p.quotation_no AND q.status = 'Won - PO Received')
        ORDER BY p.po_number`
    ),
  ]);

  const rows = orders.rows;
  for (const row of rows) {
    // A PO amount in a currency without a rate is unknown in INR, not zero.
    if (row.po_rate_missing) {
      row.po_value_inr = row.invoiced_inr = row.received_inr = row.due_now_inr = null;
    }
    row.balance_inr = row.po_count > 0 && !row.po_rate_missing ? r2(row.po_value_inr - row.received_inr) : null;
  }

  return {
    months: revenueMonths(rows, { from, to }),
    total: summarise(rows),
    rows,
    years: years.rows.map((row) => row.year),
    unlinked_pos: unlinked.rows,
  };
}

// ---------------------------------------------------------------------
// CSV shapes
// ---------------------------------------------------------------------

const withTotal = ({ months, total }) => [...months, { label: 'Total', ...total }];
const notInInr = (list) => list.map((a) => `${a.currency} ${a.amount}`).join('; ');

export function ordersCsvRows(report) {
  return withTotal(report).map((row) => ({
    Month: row.label,
    'Orders won': row.orders_won,
    'Order intake (INR)': row.order_intake_inr,
    'Average deal (INR)': row.average_deal_inr ?? '',
    'Orders with no value entered': row.orders_without_value,
    'Not in INR (rate not set)': notInInr(row.order_unconverted),
  }));
}

export function invoicingCsvRows(report) {
  return withTotal(report).map((row) => ({
    Month: row.label,
    POs: row.pos,
    'PO value (INR)': row.po_value_inr,
    'Invoiced (INR)': row.invoiced_inr,
    'Received (INR)': row.received_inr,
    'Due now (INR)': row.due_now_inr,
    'Balance (INR)': row.balance_inr,
    'Won without a linked PO': row.not_registered,
    'Of which no project yet': row.no_project,
    'POs left out (rate not set)': row.pos_unconverted,
  }));
}

export function revenueDetailCsvRows({ rows }) {
  return rows.map((row) => ({
    Month: monthLabel(row.month),
    Quotation: row.quotation_no,
    Date: row.quotation_date ?? '',
    Client: row.client,
    Sector: row.sector,
    'Sales person': row.sales_person ?? '',
    Currency: row.currency,
    'Order value': row.quotation_value ?? '',
    'Order value (INR)': row.order_value_inr ?? '',
    PO: row.po_numbers ?? 'Not linked',
    'PO value (INR)': row.po_value_inr ?? '',
    'Invoiced (INR)': row.invoiced_inr ?? '',
    'Received (INR)': row.received_inr ?? '',
    'Due now (INR)': row.due_now_inr ?? '',
    'Balance (INR)': row.balance_inr ?? '',
    'Payment status': row.payment_status ?? '',
  }));
}
