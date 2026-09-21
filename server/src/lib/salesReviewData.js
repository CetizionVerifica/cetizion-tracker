import { query } from '../db.js';
import { IN_PERIOD, RATES, inPeriod, rateOn } from './salesReport.js';
import { monthRows } from './revenueReport.js';
import { NO_SERVICE, OTHER_SERVICE, SERVICE_LINES, serviceLinesFor } from './serviceLines.js';
import { r2, share } from './reportMath.js';
import { normalizeName } from './names.js';
import { daysBetween } from './salesReviewAnalysis.js';
import { ENQUIRY_STATUS, QUOTATION_STATUS } from './statuses.js';

/**
 * Figures only the sales review PDF uses: the enquiry funnel, the service
 * lines, the exchange rates and the gaps in the source data. The Sales
 * reports page does not show these.
 */

export { ENQUIRY_STATUS };
const WON = QUOTATION_STATUS.won;
const LOST = QUOTATION_STATUS.lost;

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
    quote_rate: share(quoted, rows.length),
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
    pipeline: enquiryPipeline(rows),
  };
}

/**
 * How many rows carry each value of a text field, most first, blanks last.
 * Grouped the same way every other name in this report is (case and stray
 * spaces ignored — see names.js), so "Aluminium" and "aluminium " count as
 * one row here too, not two.
 */
function countBy(rows, field) {
  const counts = new Map();
  for (const row of rows) {
    const raw = String(row[field] ?? '').trim();
    const key = raw ? normalizeName(raw) : '';
    const existing = counts.get(key);
    if (existing) existing.count += 1;
    else counts.set(key, { label: raw || 'Not set', count: 1 });
  }
  return [...counts.values()]
    .sort((a, b) => (a.label === 'Not set') - (b.label === 'Not set') || b.count - a.count || a.label.localeCompare(b.label));
}

/**
 * Where enquiries in the period end up, and how long the ones that got there
 * took: a contract is a PO on the enquiry's linked quotation (enquiryRows
 * fetches contract_date, the earliest such PO's date, for this). TAT is the
 * whole enquiry-to-contract span, not just a first reply.
 */
export function enquiryPipeline(rows) {
  const detail = rows.map((row) => ({
    enquiry_no: row.enquiry_no,
    client: row.client,
    enquiry_date: row.enquiry_date,
    source: row.source,
    service: row.service,
    sector: row.sector,
    country: row.country,
    status: row.status,
    contract_date: row.contract_date,
    tat_days: row.contract_date && row.enquiry_date ? daysBetween(row.enquiry_date, row.contract_date) : null,
  }));
  const tatDays = detail.filter((row) => row.tat_days != null).map((row) => row.tat_days);
  const declined = detail.filter((row) => row.status === ENQUIRY_STATUS.declined).length;
  const contracted = detail.filter((row) => row.contract_date).length;

  return {
    total: rows.length,
    contracted,
    declined,
    pending: rows.length - contracted - declined,
    average_tat_days: tatDays.length ? r2(tatDays.reduce((sum, d) => sum + d, 0) / tatDays.length) : null,
    tat_count: tatDays.length,
    by_source: countBy(rows, 'source'),
    by_sector: countBy(rows, 'sector'),
    by_country: countBy(rows, 'country'),
    detail,
  };
}

// ---------------------------------------------------------------------
// The rows behind the review sections
//
// The enquiry section, the quotation section and the service split all read
// the same two row sets, so the PDF fetches each once and summarises it
// three ways rather than running a query per section.
// ---------------------------------------------------------------------

/**
 * Enquiries in the period. Oldest first: the month rows and the oldest open
 * enquiry read that order. contract_date is the earliest PO date on the
 * enquiry's linked quotation — a quotation's PO is matched by quotation_no,
 * or by project_id when the PO was raised against the project instead, the
 * same rule the revenue figures use.
 */
const enquiryRows = ({ from, to }) =>
  query(
    `SELECT e.enquiry_no,
            btrim(e.client_name)                   AS client,
            to_char(e.enquiry_date, 'YYYY-MM-DD')  AS enquiry_date,
            to_char(e.enquiry_date, 'YYYY-MM')     AS month,
            e.status,
            e.service,
            e.source,
            e.sector,
            e.country,
            to_char(
              (SELECT MIN(po.po_date)
                 FROM purchase_orders po
                WHERE po.quotation_no = e.quotation_no
                   OR (po.quotation_no IS NULL AND EXISTS (
                        SELECT 1 FROM quotations q
                         WHERE q.quotation_no = e.quotation_no
                           AND q.project_id IS NOT NULL
                           AND po.project_id = q.project_id
                      ))),
              'YYYY-MM-DD'
            ) AS contract_date
       FROM enquiries e
      WHERE ${inPeriod('e.enquiry_date')}
      ORDER BY e.enquiry_date NULLS LAST, e.enquiry_no`,
    [from, to]
  );

/**
 * Quotations in the period with the INR rate for their currency, oldest
 * first. contract_date is the earliest PO date matched to this quotation —
 * by quotation_no, or by project_id when the PO was raised against the
 * project instead — the same rule enquiryRows and the revenue figures use.
 */
const quotationRows = ({ from, to }) =>
  query(
    `WITH ${RATES}
     SELECT q.quotation_no,
            btrim(q.client_name)                  AS client,
            to_char(q.quotation_date, 'YYYY-MM-DD') AS quotation_date,
            to_char(q.quotation_date, 'YYYY-MM')  AS month,
            q.status,
            q.quotation_value,
            q.currency,
            r.rate,
            q.service_quoted                      AS service,
            q.sector,
            q.country,
            to_char(
              (SELECT MIN(po.po_date)
                 FROM purchase_orders po
                WHERE po.quotation_no = q.quotation_no
                   OR (po.quotation_no IS NULL AND q.project_id IS NOT NULL AND po.project_id = q.project_id)),
              'YYYY-MM-DD'
            ) AS contract_date
       FROM quotations q
       ${rateOn('r', 'q.currency', 'q.quotation_date')}
      WHERE ${IN_PERIOD}
      ORDER BY q.quotation_date NULLS LAST, q.quotation_no`,
    [from, to]
  );

/**
 * Purchase orders (contracts) received in the period, by their own PO date —
 * not the date of the quotation they fulfil. service/sector/country come
 * from the linked quotation, since a PO carries none of its own: its own
 * quotation_no when the PO names one, otherwise the first quotation on its
 * project (the same fallback contract_date above uses), so each PO resolves
 * to at most one quotation and is never counted twice.
 */
const purchaseOrderRows = ({ from, to }) =>
  query(
    `WITH ${RATES},
     po_quote AS (
       SELECT po.id AS po_id,
              COALESCE(
                po.quotation_no,
                (SELECT q.quotation_no FROM quotations q
                  WHERE q.project_id = po.project_id
                  ORDER BY q.quotation_no LIMIT 1)
              ) AS quotation_no
         FROM purchase_orders po
     )
     SELECT po.po_number,
            to_char(po.po_date, 'YYYY-MM-DD') AS po_date,
            to_char(po.po_date, 'YYYY-MM')    AS month,
            po.po_value,
            po.currency,
            r.rate,
            btrim(q.client_name)              AS client,
            q.service_quoted                  AS service,
            q.sector,
            q.country
       FROM purchase_orders po
       JOIN po_quote pq ON pq.po_id = po.id
       LEFT JOIN quotations q ON q.quotation_no = pq.quotation_no
       ${rateOn('r', 'po.currency', 'po.po_date')}
      WHERE ${inPeriod('po.po_date')}
      ORDER BY po.po_date NULLS LAST, po.po_number`,
    [from, to]
  );

/** How many contracts (POs) came in, their value, and how they split by service, sector and country. */
export function contractPipeline(rows) {
  const { value_inr, without_value, unconverted } = inrTotals(
    rows.map((row) => ({ quotation_value: row.po_value, currency: row.currency, rate: row.rate }))
  );
  const detail = rows.map((row) => ({
    po_number: row.po_number,
    po_date: row.po_date,
    client: row.client,
    service: row.service,
    sector: row.sector,
    country: row.country,
    po_value: row.po_value,
    currency: row.currency,
  }));
  return {
    total: rows.length,
    value_inr,
    without_value,
    unconverted,
    by_service: countBy(rows, 'service'),
    by_sector: countBy(rows, 'sector'),
    by_country: countBy(rows, 'country'),
    detail,
  };
}

export async function contractReport(period) {
  return contractPipeline((await purchaseOrderRows(period)).rows);
}

/** The sections that share those rows, in three queries instead of six. */
export async function salesReviewSections(period) {
  const [quotations, enquiries, purchaseOrders] = await Promise.all([
    quotationRows(period), enquiryRows(period), purchaseOrderRows(period),
  ]);
  return {
    enquiries: enquirySummary(enquiries.rows, period),
    quotationStatus: quotationStatusSummary(quotations.rows, period),
    services: serviceRows(quotations.rows, enquiries.rows),
    contracts: contractPipeline(purchaseOrders.rows),
  };
}

export async function enquiryReport(period) {
  return enquirySummary((await enquiryRows(period)).rows, period);
}

/** Quotations and enquiries per service line, named lines first by won value. */
export function serviceRows(quotations, enquiries) {
  // Each quotation is classified three times below (bucketing, bundled,
  // unmatched) and service texts repeat, so match each distinct text once.
  // The arrays are shared between rows and must not be modified.
  const cache = new Map();
  const linesOf = (text) => {
    const key = String(text ?? '').trim();
    if (!cache.has(key)) cache.set(key, serviceLinesFor(key));
    return cache.get(key);
  };

  const names = [...SERVICE_LINES.map((line) => line.name), OTHER_SERVICE, NO_SERVICE];
  const lines = new Map(names.map((name) => [name, { service: name, enquiries: 0, list: [] }]));
  for (const e of enquiries) for (const name of linesOf(e.service)) lines.get(name).enquiries += 1;
  for (const q of quotations) for (const name of linesOf(q.service)) lines.get(name).list.push(q);

  const summarise = (list) => {
    const won = list.filter((q) => q.status === WON);
    const lost = list.filter((q) => q.status === LOST).length;
    return {
      quotations: list.length,
      won: won.length,
      lost,
      pipeline: list.length - won.length - lost,
      win_rate: share(won.length, won.length + lost),
      ...wonValue(won),
    };
  };
  const unmatched = (q) => linesOf(q.service).some((name) => name === OTHER_SERVICE || name === NO_SERVICE);

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
      bundled: quotations.filter((q) => linesOf(q.service).length > 1).length,
      unmatched: quotations.filter(unmatched).length,
    },
  };
}

export async function serviceReport(period) {
  const [quotations, enquiries] = await Promise.all([quotationRows(period), enquiryRows(period)]);
  return serviceRows(quotations.rows, enquiries.rows);
}

/** Quotation statuses as they read: still open first, then the outcome. */
export const QUOTATION_STATUSES = [
  QUOTATION_STATUS.submitted, QUOTATION_STATUS.negotiating, QUOTATION_STATUS.onHold, WON, LOST,
];
const STATUS_FIELD = {
  [QUOTATION_STATUS.submitted]: 'submitted',
  [QUOTATION_STATUS.negotiating]: 'negotiating',
  [QUOTATION_STATUS.onHold]: 'on_hold',
  [WON]: 'won',
  [LOST]: 'lost',
};

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
    win_rate: share(counts.won, counts.won + counts.lost),
    ...inrTotals(quotations),
    open_value_inr: open.value_inr,
    open_without_value: open.without_value,
    open_unconverted: open.unconverted,
  };
}

/**
 * Where quotations in the period end up, and how long the ones that got
 * there took: a contract is a PO matched to the quotation (quotationRows
 * fetches contract_date for this — see there). TAT is quotation date to
 * contract date. Conversion ratio and average ticket size are both simple
 * calculations over the same rows, not stored anywhere.
 */
export function quotationPipeline(rows) {
  const detail = rows.map((row) => ({
    quotation_no: row.quotation_no,
    client: row.client,
    quotation_date: row.quotation_date,
    service: row.service,
    sector: row.sector,
    country: row.country,
    quotation_value: row.quotation_value,
    currency: row.currency,
    status: row.status,
    contract_date: row.contract_date,
    tat_days: row.contract_date && row.quotation_date ? daysBetween(row.quotation_date, row.contract_date) : null,
  }));
  const tatDays = detail.filter((row) => row.tat_days != null).map((row) => row.tat_days);
  const contracted = detail.filter((row) => row.contract_date).length;
  const lost = detail.filter((row) => row.status === LOST).length;
  const { value_inr, without_value } = inrTotals(rows);
  // A quotation needs both a value and a known rate to convert to INR; each
  // is excluded from the average for a different reason, so counted apart.
  const withoutRate = rows.filter((row) => row.quotation_value != null && row.rate == null).length;
  const convertedCount = rows.length - without_value - withoutRate;

  return {
    total: rows.length,
    contracted,
    lost,
    pending: rows.length - contracted - lost,
    conversion_rate: rows.length ? share(contracted, rows.length) : null,
    average_ticket_inr: convertedCount ? r2(value_inr / convertedCount) : null,
    average_ticket_count: convertedCount,
    quotations_without_value: without_value,
    quotations_without_rate: withoutRate,
    average_tat_days: tatDays.length ? r2(tatDays.reduce((sum, d) => sum + d, 0) / tatDays.length) : null,
    tat_count: tatDays.length,
    by_country: countBy(rows, 'country'),
    detail,
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
    pipeline: quotationPipeline(rows),
  };
}

export async function quotationStatusReport(period) {
  return quotationStatusSummary((await quotationRows(period)).rows, period);
}

/**
 * The latest rate on record for each currency, for the report's rate strip.
 * Figures are not converted with this — each one uses the rate in force on its
 * own date — so it is shown as "latest", with the date it took effect.
 */
export async function exchangeRates() {
  const { rows } = await query(
    `SELECT DISTINCT ON (from_currency)
            from_currency AS currency, rate, effective_from
       FROM exchange_rates
      WHERE to_currency = 'INR'
      ORDER BY from_currency, effective_from DESC`
  );
  return Object.fromEntries(rows.map((row) => [row.currency, { rate: row.rate, effective_from: row.effective_from }]));
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
