import { query } from '../db.js';
import { IN_PERIOD, RATES, inPeriod, rateOn } from './salesReport.js';
import { MONTH_NAMES } from './reportFormat.js';
import { r2, share } from './reportMath.js';
import { QUOTATION_STATUS } from './statuses.js';

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

/** "Sep 2026" for "2026-09"; "No date" for a row without one. */
export const monthLabel = (month) =>
  month ? `${MONTH_NAMES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}` : 'No date';

/** The Purchase orders list's payment statuses, most urgent first. */
export const PAYMENT_STATUSES = ['Overdue', 'To Invoice', 'Pending', 'Up to date', 'Fully Paid'];

const sum = (list, field) => r2(list.reduce((total, row) => total + row[field], 0));

const rateKey = (d) => `${d.currency}:${d.rate}:${d.effective_from}`;
const ratio = (part, whole) => (whole > 0 ? part / whole : null);

/** The PO-date rates behind po_value, deduplicated. */
function rateDetails(rows) {
  return [...new Map(rows
    .filter((row) => row.currency !== 'INR' && row.rate !== null)
    .map((row) => [`${row.currency}:${row.rate}:${row.rate_effective_from}`, {
      currency: row.currency, rate: row.rate, effective_from: row.rate_effective_from,
    }]))
    .values()];
}

/**
 * The stage rates behind invoiced, received and due now. These are not the
 * PO's rate: a stage converts on its own invoice or payment date, so the
 * figure and the rate named beside it have to come from the same place.
 */
function stageRateDetails(rows, field) {
  return [...new Map(rows.flatMap((row) => row[field] ?? []).map((d) => [rateKey(d), d])).values()]
    .sort((a, b) => a.currency.localeCompare(b.currency) || a.effective_from.localeCompare(b.effective_from));
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
    rate_details: rateDetails(orders),
  };
}

/** Purchase orders: their money in INR, and how much of it is billed and collected. */
export function summarisePurchaseOrders(pos) {
  // Only PO value is converted at the PO's own date, so only it drops out when
  // that rate is missing. Invoiced, received, due now and to bill are converted
  // per stage on their own dates: a PO whose PO date has no rate can still have
  // perfectly convertible stages, and stages_unconverted reports the rest.
  const converted = pos.filter((row) => row.rate !== null);
  const poValue = sum(converted, 'po_value_inr');
  const invoiced = sum(pos, 'invoiced_inr');
  const received = sum(pos, 'received_inr');
  // A stage billed or paid on a date no rate covers is left out of the INR
  // figures the same way a PO with no rate is, so it is named rather than lost.
  const stagesUnconverted = pos.reduce((n, row) => n + (row.stages_unconverted ?? 0), 0);
  return {
    pos: pos.length,
    po_value_inr: poValue,
    invoiced_inr: invoiced,
    received_inr: received,
    due_now_inr: sum(pos, 'due_now_inr'),
    // Billed but not yet collected is "due now"; this is what has not been
    // billed at all. Kept apart so neither figure overstates the other.
    to_bill_inr: sum(pos, 'to_bill_inr'),
    // The currency's own movement between invoicing and collection.
    fx_gain_loss_inr: sum(pos, 'fx_gain_loss_inr'),
    // Collections against invoices ÷ invoiced. Money received on a stage with
    // no invoice is real and stays in Received, but counting it here would
    // push the rate above 100%.
    collection_rate: ratio(sum(pos, 'received_invoiced_inr'), invoiced),
    invoiced_rate: ratio(invoiced, poValue),
    pos_unconverted: pos.length - converted.length,
    stages_unconverted: stagesUnconverted,
    missing_rates: [...new Set(
      pos.filter((row) => row.rate === null || (row.stages_unconverted ?? 0) > 0).map((row) => row.currency)
    )].sort(),
    rate_details: rateDetails(pos),
    invoice_rate_details: stageRateDetails(pos, 'invoice_rate_details'),
    payment_rate_details: stageRateDetails(pos, 'payment_rate_details'),
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
              qr.effective_from AS rate_effective_from,
              ROUND(q.quotation_value * qr.rate, 2) AS order_value_inr
         FROM quotations q
         ${rateOn('qr', 'q.currency', 'q.quotation_date')}
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
              r.effective_from AS rate_effective_from,
              p.payment_status,
              ROUND(p.po_value * r.rate, 2)          AS po_value_inr,
              st.invoiced_inr,
              st.received_inr,
              st.due_now_inr,
              st.to_bill_inr,
              st.received_invoiced_inr,
              st.fx_gain_loss_inr,
              st.stages_unconverted,
              st.invoice_rate_details,
              st.payment_rate_details
         FROM v_purchase_orders p
         ${rateOn('r', 'p.currency', 'p.po_date')}
         -- Each stage converts on its own date: the invoice date for what was
         -- billed, the payment date for what came in. Summing first and
         -- converting once would price an invoice at the PO's rate.
         CROSS JOIN LATERAL (
           SELECT ROUND(COALESCE(SUM(s.invoiced_amount  * ir.rate), 0), 2) AS invoiced_inr,
                  ROUND(COALESCE(SUM(s.amount_received  * pr.rate), 0), 2) AS received_inr,
                  ROUND(COALESCE(SUM(s.due_now_amount   * ir.rate), 0), 2) AS due_now_inr,
                  -- Not yet invoiced, so there is no invoice date to convert
                  -- on: rateOn falls back to the PO's date for these.
                  ROUND(COALESCE(SUM(s.to_bill_amount   * ir.rate), 0), 2) AS to_bill_inr,
                  -- At the INVOICE rate, like invoiced_inr: converting this at
                  -- the payment rate would make currency movement look like
                  -- collection and push the rate past 100%. LEAST also caps an
                  -- overpaid stage at what was billed.
                  ROUND(COALESCE(SUM(LEAST(s.received_on_invoiced, s.invoiced_amount) * ir.rate), 0), 2)
                    AS received_invoiced_inr,
                  -- What the currency itself gained or lost between billing and
                  -- collection. Zero in INR, where both rates are 1.
                  ROUND(COALESCE(SUM(s.amount_received * (pr.rate - ir.rate))
                                 FILTER (WHERE s.payment_received_date IS NOT NULL), 0), 2) AS fx_gain_loss_inr,
                  COUNT(*) FILTER (WHERE (s.invoiced_amount > 0 AND ir.rate IS NULL)
                                      OR (s.amount_received > 0 AND pr.rate IS NULL))::int AS stages_unconverted,
                  -- Named beside the figures they built, so a tooltip cannot
                  -- claim a rate the amount was not converted at.
                  COALESCE(json_agg(DISTINCT jsonb_build_object(
                             'currency', s.currency, 'rate', ir.rate, 'effective_from', ir.effective_from))
                           FILTER (WHERE s.currency <> 'INR' AND ir.rate IS NOT NULL), '[]'::json) AS invoice_rate_details,
                  COALESCE(json_agg(DISTINCT jsonb_build_object(
                             'currency', s.currency, 'rate', pr.rate, 'effective_from', pr.effective_from))
                           FILTER (WHERE s.currency <> 'INR' AND pr.rate IS NOT NULL
                                     AND s.payment_received_date IS NOT NULL), '[]'::json) AS payment_rate_details
             FROM v_payment_stages s
             -- A stage with no invoice date yet falls back to the PO's date.
             ${rateOn('ir', 's.currency', 'COALESCE(s.invoice_date, p.po_date)')}
             ${rateOn('pr', 's.currency', 'COALESCE(s.payment_received_date, s.invoice_date, p.po_date)')}
            WHERE s.po_number = p.po_number
         ) st
        WHERE ${inPeriod('p.po_date')}
        ORDER BY p.po_date NULLS LAST, p.po_number`,
      [from, to]
    ),
    // Years with won orders or dated POs, for the year picker.
    includeYears
      ? query(
        `SELECT year FROM (
           SELECT EXTRACT(YEAR FROM quotation_date)::int AS year
             FROM quotations WHERE status = '${QUOTATION_STATUS.won}' AND quotation_date IS NOT NULL
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
  // Every non-INR currency in play, including ones with no rate: the report's
  // rate strip prints "USD: not set" from this, so dropping them would hide
  // the gap rather than report it. A real rate always wins over a null one.
  const rates = new Map();
  for (const row of [...orders.rows, ...purchaseOrders.rows]) {
    if (row.currency === 'INR') continue;
    if (!rates.has(row.currency) || (rates.get(row.currency).rate === null && row.rate !== null)) {
      rates.set(row.currency, { rate: row.rate, effective_from: row.rate_effective_from });
    }
  }
  return {
    orders: { months: monthRows(orders.rows, period, summariseOrders), total: summariseOrders(orders.rows) },
    invoicing: { months: monthRows(purchaseOrders.rows, period, summarisePurchaseOrders), total: poTotal },
    payment_status: { rows: paymentStatusRows(purchaseOrders.rows), total: poTotal },
    years: years.rows.map((row) => row.year),
    rates: [...rates].map(([currency, rate]) => ({ currency, ...rate })),
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
  'To bill (INR)': row.to_bill_inr,
  'FX gain / loss (INR)': row.fx_gain_loss_inr,
  'POs left out (rate not set)': row.pos_unconverted,
  'Stages left out (no rate on their date)': row.stages_unconverted,
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
