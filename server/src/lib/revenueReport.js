import { query } from '../db.js';
import { IN_PERIOD, RATES, inPeriod } from './salesReport.js';

/**
 * Revenue for a period, in two halves read from different places:
 *
 * - Order intake: quotations marked "Won - PO Received", by quotation date.
 * - Invoicing & collections, and payment status: every purchase order, by
 *   its PO date, with PO value, invoiced, received, due now and payment
 *   status exactly as the Purchase orders list shows them — so the totals
 *   here are the totals of that list.
 *
 * Amounts are converted to INR at the Settings rate; an amount whose rate is
 * not set is left out of the INR figures and reported, never guessed.
 */

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Sep 2026" for "2026-09"; "No date" for a row without one. */
export const monthLabel = (month) =>
  month ? `${MONTH_NAMES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}` : 'No date';

/** The Purchase orders list's payment statuses, most urgent first. */
export const PAYMENT_STATUSES = ['Overdue', 'To Invoice', 'Pending', 'Up to date', 'Fully Paid'];

const r2 = (n) => Math.round(n * 100) / 100;
const sum = (list, field) => r2(list.reduce((total, row) => total + row[field], 0));
const ratio = (part, whole) => (whole ? part / whole : null);

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

/**
 * One row per month in range, quiet months as zero, then a "No date" row for
 * anything without a date — which only happens when no range is chosen. The
 * rows always add up to the total.
 */
export function monthRows(rows, { from, to } = {}, summarise) {
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

/** Won quotations: how many, their value in INR, and the average deal. */
export function summariseOrders(orders) {
  const valued = orders.filter((row) => row.order_value_inr !== null);
  const unconverted = new Map();
  for (const row of orders) {
    if (row.quotation_value !== null && row.rate === null) {
      unconverted.set(row.currency, r2((unconverted.get(row.currency) || 0) + row.quotation_value));
    }
  }
  const intake = sum(valued, 'order_value_inr');
  return {
    orders_won: orders.length,
    order_intake_inr: intake,
    // Averaged over the orders the intake actually includes.
    average_deal_inr: valued.length ? r2(intake / valued.length) : null,
    orders_without_value: orders.filter((row) => row.quotation_value === null).length,
    order_unconverted: [...unconverted].map(([currency, amount]) => ({ currency, amount })),
  };
}

/** Purchase orders: their money in INR, and how much of it is billed and collected. */
export function summarisePurchaseOrders(pos) {
  const converted = pos.filter((row) => row.rate !== null);
  const poValue = sum(converted, 'po_value_inr');
  const invoiced = sum(converted, 'invoiced_inr');
  const received = sum(converted, 'received_inr');
  return {
    pos: pos.length,
    po_value_inr: poValue,
    invoiced_inr: invoiced,
    received_inr: received,
    due_now_inr: sum(converted, 'due_now_inr'),
    // Received ÷ invoiced, and invoiced ÷ PO value; nothing to divide by means no rate.
    collection_rate: ratio(received, invoiced),
    invoiced_rate: ratio(invoiced, poValue),
    pos_unconverted: pos.length - converted.length,
    missing_rates: [...new Set(pos.filter((row) => row.rate === null).map((row) => row.currency))].sort(),
  };
}

/** Every payment status, even with no POs, so the table always reads the same way. */
export function paymentStatusRows(pos) {
  const rows = PAYMENT_STATUSES.map((status) => ({
    status,
    ...summarisePurchaseOrders(pos.filter((row) => row.payment_status === status)),
  }));
  // A status the list may gain later still counts, rather than going missing from the total.
  const other = pos.filter((row) => !PAYMENT_STATUSES.includes(row.payment_status));
  if (other.length) rows.push({ status: 'Other', ...summarisePurchaseOrders(other) });
  return rows;
}

/**
 * The revenue figures for a period. `years` fills the Sales reports page's
 * year picker; the PDF has no picker, so it passes includeYears: false and
 * that query is not run.
 */
export async function revenueReport({ from, to }, { includeYears = true } = {}) {
  const [orders, purchaseOrders, years, undated] = await Promise.all([
    query(
      `WITH ${RATES}
       SELECT q.quotation_no,
              to_char(q.quotation_date, 'YYYY-MM')  AS month,
              q.currency,
              q.quotation_value,
              qr.rate,
              ROUND(q.quotation_value * qr.rate, 2) AS order_value_inr
         FROM quotations q
         LEFT JOIN rates qr ON qr.currency = q.currency
        WHERE q.status = 'Won - PO Received' AND ${IN_PERIOD}
        ORDER BY q.quotation_date NULLS LAST, q.quotation_no`,
      [from, to]
    ),
    query(
      `WITH ${RATES}
       SELECT p.po_number,
              to_char(p.po_date, 'YYYY-MM')          AS month,
              p.currency,
              r.rate,
              p.payment_status,
              ROUND(p.po_value * r.rate, 2)          AS po_value_inr,
              ROUND(p.total_invoiced * r.rate, 2)    AS invoiced_inr,
              ROUND(p.total_received * r.rate, 2)    AS received_inr,
              ROUND(p.balance_due_now * r.rate, 2)   AS due_now_inr
         FROM v_purchase_orders p
         LEFT JOIN rates r ON r.currency = p.currency
        WHERE ${inPeriod('p.po_date')}
        ORDER BY p.po_date NULLS LAST, p.po_number`,
      [from, to]
    ),
    // Years with won orders or dated POs, for the year picker.
    includeYears
      ? query(
        `SELECT year FROM (
           SELECT EXTRACT(YEAR FROM quotation_date)::int AS year
             FROM quotations WHERE status = 'Won - PO Received' AND quotation_date IS NOT NULL
           UNION
           SELECT EXTRACT(YEAR FROM po_date)::int FROM purchase_orders WHERE po_date IS NOT NULL
         ) y
         ORDER BY year DESC`
      )
      : { rows: [] },
    // A PO without a PO date cannot be placed in a year or month.
    query('SELECT po_number FROM purchase_orders WHERE po_date IS NULL ORDER BY po_number'),
  ]);

  const period = { from, to };
  const poTotal = summarisePurchaseOrders(purchaseOrders.rows);
  // Exchange rates behind the INR figures, so the PDF can say which it used.
  const rates = new Map();
  for (const row of [...orders.rows, ...purchaseOrders.rows]) {
    if (row.currency !== 'INR' && !rates.has(row.currency)) rates.set(row.currency, row.rate);
  }
  return {
    orders: { months: monthRows(orders.rows, period, summariseOrders), total: summariseOrders(orders.rows) },
    invoicing: { months: monthRows(purchaseOrders.rows, period, summarisePurchaseOrders), total: poTotal },
    payment_status: { rows: paymentStatusRows(purchaseOrders.rows), total: poTotal },
    years: years.rows.map((row) => row.year),
    rates: [...rates].map(([currency, rate]) => ({ currency, rate })),
    // With a date range those POs are left out of every PO figure above, so
    // name them; without one they are already counted in a "No date" row.
    undated_pos: from || to ? undated.rows.map((row) => row.po_number) : [],
  };
}

// ---------------------------------------------------------------------
// CSV shapes
// ---------------------------------------------------------------------

const notInInr = (list) => list.map((a) => `${a.currency} ${a.amount}`).join('; ');
const moneyColumns = (row) => ({
  'PO value (INR)': row.po_value_inr,
  'Invoiced (INR)': row.invoiced_inr,
  'Received (INR)': row.received_inr,
  'Due now (INR)': row.due_now_inr,
  'POs left out (rate not set)': row.pos_unconverted,
});

export function ordersCsvRows({ orders }) {
  return [...orders.months, { label: 'Total', ...orders.total }].map((row) => ({
    Month: row.label,
    'Orders won': row.orders_won,
    'Order intake (INR)': row.order_intake_inr,
    'Average deal (INR)': row.average_deal_inr ?? '',
    'Orders with no value entered': row.orders_without_value,
    'Not in INR (rate not set)': notInInr(row.order_unconverted),
  }));
}

export function invoicingCsvRows({ invoicing }) {
  return [...invoicing.months, { label: 'Total', ...invoicing.total }].map((row) => ({
    Month: row.label,
    POs: row.pos,
    ...moneyColumns(row),
  }));
}

export function paymentStatusCsvRows({ payment_status: status }) {
  return [...status.rows, { status: 'Total', ...status.total }].map((row) => ({
    'Payment status': row.status,
    POs: row.pos,
    ...moneyColumns(row),
  }));
}
