/**
 * Cash-flow forecast (#40): what is expected in and out, month by month,
 * from what the tracker already holds.
 *
 *   GET /api/cashflow?months=6
 *
 * In:  invoiced stages not yet paid, by their due date (overdue ones now);
 *      stages not yet invoiced, by when their trigger is expected (PO
 *      registration: now; delivery: the project's planned delivery, else
 *      the PO date plus the terms); open quotations weighted by their
 *      probability, by expected close date.
 * Out: vendor invoices unpaid, by their pay-by date; approved expense
 *      claims not yet reimbursed, now.
 * INR only; other currencies are listed separately, unconverted.
 */
import { Router } from 'express';
import { query } from '../db.js';
import { businessToday } from '../lib/businessDate.js';

export const cashflowRouter = Router();

const ym = (d) => String(d).slice(0, 7);
const addMonths = (yyyymm, n) => { const [y, m] = yyyymm.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; };

cashflowRouter.get('/', async (req, res) => {
  const months = Math.min(Math.max(Number(req.query.months) || 6, 1), 24);
  const today = businessToday();
  const first = ym(today);
  const keys = Array.from({ length: months }, (_, i) => addMonths(first, i));
  const rows = Object.fromEntries(keys.map((k) => [k, { month: k, invoiced: 0, scheduled: 0, pipeline: 0, vendors: 0, claims: 0, items: [] }]));
  const later = { month: 'later', invoiced: 0, scheduled: 0, pipeline: 0, vendors: 0, claims: 0, items: [] };
  const unscheduled = { month: 'unscheduled', invoiced: 0, scheduled: 0, pipeline: 0, vendors: 0, claims: 0, items: [] };
  const foreign = [];
  const put = (when, field, amount, item) => {
    if (!amount) return;
    const bucket = !when ? unscheduled : (ym(when) < first ? rows[first] : rows[ym(when)] || later);
    bucket[field] += Number(amount);
    if (item) bucket.items.push({ ...item, field, amount: Number(amount), when: when || null });
  };

  const [{ rows: stages }, { rows: quotes }, { rows: vendors }, { rows: claims }] = await Promise.all([
    query(`SELECT ps.*, po.po_date, po.actual_delivery_date, po.payment_terms_days, pr.planned_delivery_date, pr.client_name AS project_client
             FROM v_payment_stages ps JOIN purchase_orders po ON po.po_number = ps.po_number JOIN projects pr ON pr.project_id = po.project_id
            WHERE ps.stage_status <> 'Paid'`),
    query(`SELECT quotation_no, client_name, quotation_value, currency, probability, weighted_value, expected_close_date, stage
             FROM v_quotations WHERE stage_type = 'open' AND quotation_value IS NOT NULL`),
    query(`SELECT vendor_invoice_id, travel_vendor, invoice_amount, amount_paid, pay_by, payment_status FROM v_travel_vendor_invoices
            WHERE finance_to_pay`),
    query(`SELECT claim_id, employee_name, amount_claimed, amount_reimbursed, status FROM v_employee_expense_claims
            WHERE status IN ('Approved - to reimburse', 'Partly reimbursed')`),
  ]);

  for (const s of stages) {
    const outstanding = Number(s.stage_amount) - Number(s.amount_received || 0);
    if (outstanding <= 0) continue;
    if (s.currency !== 'INR') { foreign.push({ kind: 'stage', ref: `${s.po_number} · ${s.stage_name}`, client: s.client_name, currency: s.currency, amount: outstanding }); continue; }
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
    if (q.currency !== 'INR') { foreign.push({ kind: 'quotation', ref: q.quotation_no, client: q.client_name, currency: q.currency, amount: Number(q.weighted_value) }); continue; }
    // The advance (half, by the usual split) arrives with the PO; the rest later. Kept simple: the weighted value at the close date.
    put(q.expected_close_date, 'pipeline', Number(q.weighted_value || 0), { ref: q.quotation_no, client: q.client_name, note: `${q.stage} · ${q.probability}%` });
  }
  for (const v of vendors) put(v.pay_by || today, 'vendors', Number(v.invoice_amount || 0) - Number(v.amount_paid || 0), { ref: v.vendor_invoice_id, client: v.travel_vendor, note: v.payment_status });
  for (const c of claims) put(today, 'claims', Number(c.amount_claimed || 0) - Number(c.amount_reimbursed || 0), { ref: c.claim_id, client: c.employee_name, note: c.status });

  const list = [...keys.map((k) => rows[k]), later, unscheduled].map((b) => ({
    ...b,
    inflow: b.invoiced + b.scheduled,
    inflow_with_pipeline: b.invoiced + b.scheduled + b.pipeline,
    outflow: b.vendors + b.claims,
    net: b.invoiced + b.scheduled - b.vendors - b.claims,
    items: b.items.sort((a, b2) => b2.amount - a.amount),
  }));
  res.json({ data: { today, months: list, foreign } });
});

function plusDays(iso, n) {
  if (!iso) return null;
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
