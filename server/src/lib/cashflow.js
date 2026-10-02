/**
 * Cash-flow forecast (#40): what is expected in and out, month by month,
 * from what the tracker already holds.
 *
 *   GET /api/cashflow?months=6
 *
 * In:  payments already received this month (`received`, not part of `inflow`
 *      — that is what is still to come);
 *      invoiced stages not yet paid, by their due date (overdue ones now);
 *      stages not yet invoiced, by when their trigger is expected (PO
 *      registration: now; delivery: the project's planned delivery, else
 *      the PO date plus the terms); open quotations weighted by their
 *      probability, by expected close date.
 * Out: vendor invoices unpaid, by their pay-by date; approved expense
 *      claims not yet reimbursed, now.
 * INR only; other currencies are listed separately, unconverted.
 *
 * Insights asks the same question with two options the endpoint does not
 * use: `scope`, to narrow the money to one owner's records (outflows are
 * the company's, so a narrowed forecast leaves them out), and `convert`, to
 * count other currencies in INR at the rate on each record's own date. A
 * record with no rate for its date stays in `foreign`, never guessed.
 */
import { UNRESTRICTED, scopedSources } from '../auth/ownership.js';
import { query } from '../db.js';
import { businessToday } from './businessDate.ts';
import { RATES, rateOn } from './salesReport.js';

const ym = (d) => String(d).slice(0, 7);
const addMonths = (yyyymm, n) => { const [y, m] = yyyymm.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; };

export async function cashflow({ months: wanted, scope = UNRESTRICTED, convert = false, db = { query }, today = businessToday() } = {}) {
  const months = Math.min(Math.max(Number(wanted) || 6, 1), 24);
  const first = ym(today);
  const keys = Array.from({ length: months }, (_, i) => addMonths(first, i));
  const blank = (month) => ({ month, received: 0, invoiced: 0, scheduled: 0, pipeline: 0, vendors: 0, claims: 0, items: [] });
  const rows = Object.fromEntries(keys.map((k) => [k, blank(k)]));
  const later = blank('later');
  const unscheduled = blank('unscheduled');
  const foreign = [];
  const put = (when, field, amount, item) => {
    if (!amount) return;
    const bucket = !when ? unscheduled : (ym(when) < first ? rows[first] : rows[ym(when)] || later);
    bucket[field] += Number(amount);
    if (item) bucket.items.push({ ...item, field, amount: Number(amount), when: when || null });
  };
  // The rate column, or INR-only when not converting: then every other
  // currency has no rate and lands in `foreign`, as it always has.
  const rate = (alias, currency, date) => (convert
    ? { col: `${alias}.rate AS fx_rate`, join: rateOn(alias, currency, date), with: `WITH ${RATES}` }
    : { col: `CASE WHEN ${currency} = 'INR' THEN 1 END AS fx_rate`, join: '', with: '' });
  const outflows = scope.unrestricted;

  const sParams = []; const sSrc = scopedSources(scope, sParams);
  const qParams = []; const qSrc = scopedSources(scope, qParams);
  const rParams = []; const rSrc = scopedSources(scope, rParams);
  const sRate = rate('sr', 'ps.currency', 'COALESCE(ps.invoice_date, po.po_date)');
  const qRate = rate('qr', 'v.currency', 'v.quotation_date');
  const rRate = rate('rr', 'ps.currency', 'p.received_on');
  rParams.push(today);
  const none = Promise.resolve({ rows: [] });
  const [{ rows: stages }, { rows: quotes }, { rows: vendors }, { rows: claims }, { rows: receipts }] = await Promise.all([
    db.query(`${sRate.with}
           SELECT ps.*, po.po_date, po.actual_delivery_date, po.payment_terms_days, pr.planned_delivery_date, pr.client_name AS project_client, ${sRate.col}
             FROM ${sSrc.vPaymentStages} ps JOIN purchase_orders po ON po.po_number = ps.po_number JOIN projects pr ON pr.project_id = po.project_id
             ${sRate.join}
            WHERE ps.stage_status <> 'Paid'`, sParams),
    db.query(`${qRate.with}
           SELECT v.quotation_no, v.client_name, v.quotation_value, v.currency, v.probability, v.weighted_value, v.expected_close_date, v.stage, ${qRate.col}
             FROM ${qSrc.vQuotations} v ${qRate.join}
            WHERE v.stage_type = 'open' AND v.quotation_value IS NOT NULL`, qParams),
    outflows ? db.query(`SELECT vendor_invoice_id, travel_vendor, invoice_amount, amount_paid, pay_by, payment_status FROM v_travel_vendor_invoices
            WHERE finance_to_pay`) : none,
    outflows ? db.query(`SELECT claim_id, employee_name, amount_claimed, amount_reimbursed, status FROM v_employee_expense_claims
            WHERE status IN ('Approved - to reimburse', 'Partly reimbursed')`) : none,
    // Money already in the bank this month. A forecast that starts at the
    // first of the month and shows only what is still owed reads as though
    // the month has collected nothing, which is wrong by the third of it.
    db.query(`${rRate.with}
           SELECT to_char(x.received_on, 'YYYY-MM') AS month, SUM(x.amount * x.fx_rate) AS amount
             FROM (SELECT p.amount, p.received_on, ${rRate.col}
                     FROM payments p JOIN ${rSrc.vPaymentStages} ps ON ps.id = p.stage_id ${rRate.join}
                    WHERE p.received_on >= date_trunc('month', $${rParams.length}::date)) x
            WHERE x.fx_rate IS NOT NULL
            GROUP BY 1`, rParams),
  ]);
  const fx = (row) => (row.fx_rate == null ? null : Number(row.fx_rate));

  for (const s of stages) {
    const owed = Number(s.stage_amount) - Number(s.amount_received || 0);
    if (owed <= 0) continue;
    if (fx(s) === null) { foreign.push({ kind: 'stage', ref: `${s.po_number} · ${s.stage_name}`, client: s.client_name, currency: s.currency, amount: owed }); continue; }
    const outstanding = owed * fx(s);
    const item = { ref: `${s.po_number} · ${s.stage_name}`, client: s.client_name };
    if (s.invoice_no) {
      put(s.invoice_due_date || today, 'invoiced', outstanding, { ...item, note: s.invoice_no });
    } else {
      const terms = Number(s.credit_days ?? s.payment_terms_days ?? 30);
      let when = null;
      if (s.trigger_event === 'On PO Registration') when = s.po_date ? plusDays(today, terms) : null;
      else if (s.trigger_event === 'On Delivery') when = plusDays(s.actual_delivery_date || s.planned_delivery_date || (s.po_date ? plusDays(s.po_date, 90) : null), terms);
      else if (s.trigger_event === 'On Milestone') when = s.milestone_reached_on ? plusDays(s.milestone_reached_on, terms) : null;
      put(when, 'scheduled', outstanding, { ...item, note: s.trigger_event });
    }
  }
  for (const q of quotes) {
    if (fx(q) === null) { foreign.push({ kind: 'quotation', ref: q.quotation_no, client: q.client_name, currency: q.currency, amount: Number(q.weighted_value) }); continue; }
    // The advance (half, by the usual split) arrives with the PO; the rest later. Kept simple: the weighted value at the close date.
    put(q.expected_close_date, 'pipeline', Number(q.weighted_value || 0) * fx(q), { ref: q.quotation_no, client: q.client_name, note: `${q.stage} · ${q.probability}%` });
  }
  for (const v of vendors) put(v.pay_by || today, 'vendors', Number(v.invoice_amount || 0) - Number(v.amount_paid || 0), { ref: v.vendor_invoice_id, client: v.travel_vendor, note: v.payment_status });
  for (const c of claims) put(today, 'claims', Number(c.amount_claimed || 0) - Number(c.amount_reimbursed || 0), { ref: c.claim_id, client: c.employee_name, note: c.status });
  // No item lines: a receipt is not a thing to chase, it is the month's floor.
  for (const r of receipts) (rows[r.month] || later).received += Number(r.amount || 0);

  const list = [...keys.map((k) => rows[k]), later, unscheduled].map((b) => ({
    ...b,
    inflow: b.invoiced + b.scheduled,
    inflow_with_pipeline: b.invoiced + b.scheduled + b.pipeline,
    outflow: b.vendors + b.claims,
    net: b.invoiced + b.scheduled - b.vendors - b.claims,
    items: b.items.sort((a, b2) => b2.amount - a.amount),
  }));
  return { today, months: list, foreign };
}


function plusDays(iso, n) {
  if (!iso) return null;
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
