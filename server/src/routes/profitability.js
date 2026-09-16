/**
 * Project profitability (#39).
 *
 *   GET /api/profitability?group=project|client|service|sector|owner&from=&to=
 *   GET /api/profitability/projects/:id    one project: totals and every cost line
 *
 * Manual costs are the project_costs resource (/api/project-costs).
 * Periods filter on the project's first PO date.
 */
import { Router } from 'express';
import { query } from '../db.js';
import { ApiError } from '../middleware/error.js';

export const profitabilityRouter = Router();

const GROUPS = {
  project: 'pp.project_id',
  client: 'pp.client_name',
  service: "COALESCE(pp.primary_service, 'No service set')",
  sector: "COALESCE(c.sector, 'No sector set')",
  owner: "COALESCE(NULLIF(pp.sales_person, ''), 'No owner')",
};
const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);

profitabilityRouter.get('/', async (req, res) => {
  const group = GROUPS[req.query.group] ? String(req.query.group) : 'project';
  const from = day(req.query.from); const to = day(req.query.to);
  const where = ['TRUE']; const params = [];
  if (from) { params.push(from); where.push(`pp.first_po_date >= $${params.length}`); }
  if (to) { params.push(to); where.push(`pp.first_po_date <= $${params.length}`); }
  const base = `FROM v_project_profitability pp LEFT JOIN companies c ON c.id = pp.company_id WHERE ${where.join(' AND ')}`;
  if (group === 'project') {
    const { rows } = await query(`SELECT pp.*, c.sector ${base} ORDER BY pp.margin_percent NULLS LAST, pp.project_id`, params);
    return res.json({ data: rows, group });
  }
  const { rows } = await query(
    `SELECT ${GROUPS[group]} AS name, COUNT(*)::int AS projects,
            SUM(pp.revenue) AS revenue, SUM(pp.total_cost) AS total_cost, SUM(pp.cost_committed) AS cost_committed, SUM(pp.margin) AS margin,
            CASE WHEN SUM(pp.revenue) > 0 THEN round(100 * SUM(pp.margin) / SUM(pp.revenue), 1) END AS margin_percent,
            round(AVG(pp.margin_percent), 1) AS average_margin_percent,
            SUM(pp.estimated_cost) AS estimated_cost,
            SUM(pp.total_cost) FILTER (WHERE pp.estimated_cost IS NOT NULL) AS actual_cost_where_estimated,
            SUM(pp.revenue_gaps + pp.cost_gaps)::int AS gaps
       ${base} GROUP BY 1 ORDER BY margin DESC NULLS LAST`, params);
  res.json({ data: rows, group });
});

profitabilityRouter.get('/projects/:id', async (req, res) => {
  const id = String(req.params.id);
  const { rows: [p] } = await query('SELECT * FROM v_project_profitability WHERE project_id = $1', [id]);
  if (!p) throw new ApiError(404, 'Project not found');
  const [vendors, claims, manual] = await Promise.all([
    query(`SELECT vi.vendor_invoice_id AS ref, t.travel_id, t.arranged_by AS vendor, t.destination, vi.invoice_date AS incurred_on, vi.invoice_amount AS amount, vi.amount_paid
             FROM travel_vendor_invoices vi JOIN travel_logs t ON t.travel_id = vi.travel_id JOIN purchase_orders po ON po.po_number = t.po_number
            WHERE po.project_id = $1 ORDER BY vi.invoice_date NULLS LAST`, [id]),
    query(`SELECT c.claim_id AS ref, t.travel_id, t.employee_name AS vendor, c.expense_category, c.submission_date AS incurred_on, c.amount_claimed AS amount, c.amount_reimbursed AS amount_paid, c.approval_status
             FROM employee_expense_claims c JOIN travel_logs t ON t.travel_id = c.travel_id JOIN purchase_orders po ON po.po_number = t.po_number
            WHERE po.project_id = $1 ORDER BY c.submission_date NULLS LAST`, [id]),
    query(`SELECT pc.*, d.file_name FROM project_costs pc LEFT JOIN documents d ON d.id = pc.document_id WHERE pc.project_id = $1 ORDER BY pc.incurred_on NULLS LAST, pc.id`, [id]),
  ]);
  const { rows: fx } = await query(`SELECT substr(key, 9) AS currency, value FROM settings WHERE key LIKE 'fx\_rate\_%'`);
  const rates = Object.fromEntries(fx.filter((r) => Number(r.value) > 0).map((r) => [r.currency, Number(r.value)]));
  const lines = [
    ...vendors.rows.map((r) => ({ kind: 'travel_vendor', ...r, gap: r.amount == null ? 'No invoice amount' : null, committed: r.amount == null ? 0 : Math.max(Number(r.amount) - Number(r.amount_paid), 0) })),
    ...claims.rows.map((r) => ({ kind: 'expense_claim', ...r, gap: null, committed: r.approval_status === 'Rejected' ? 0 : Math.max(Number(r.amount) - Number(r.amount_paid), 0) })),
    ...manual.rows.map((r) => ({ kind: 'manual', ref: r.id, ...r, gap: r.amount == null ? 'No amount' : r.currency !== 'INR' && !rates[r.currency] ? `No ${r.currency} exchange rate in Settings` : null })),
  ];
  const { rows: [{ value: alert }] } = await query(`SELECT COALESCE((SELECT value FROM settings WHERE key = 'margin_alert_percent'), '20') AS value`);
  res.json({ data: { ...p, margin_alert_percent: Number(alert), lines } });
});

/**
 * Daily: a project whose cost passes the configured share of its PO value
 * gets a task for its manager, once per share crossed.
 */
export async function costAlerts({ db = { query }, notify } = {}) {
  const { rows } = await db.query(
    `SELECT pp.project_id, pp.client_name, pp.project_manager, pp.revenue, pp.total_cost,
            round(100 * pp.total_cost / pp.revenue) AS share, setting_num('cost_alert_share_percent', 80) AS limit_share
       FROM v_project_profitability pp
      WHERE pp.revenue > 0 AND pp.total_cost >= pp.revenue * setting_num('cost_alert_share_percent', 80) / 100`);
  const raised = [];
  for (const r of rows) {
    const n = await notify({ kind: 'cost_alert', title: `${r.project_id}: costs at ${r.share}% of the PO value`, body: `${r.client_name} · cost ${r.total_cost} of ${r.revenue}`, entity: 'project', entityId: r.project_id, link: `/projects/${encodeURIComponent(r.project_id)}`, dedupeKey: `cost-alert:${r.project_id}:${r.limit_share}` }, db);
    if (!n) continue;
    await db.query(`INSERT INTO tasks (entity, entity_id, title, description, due_at, type, priority, assignee, created_by)
                    VALUES ('project', $1, $2, $3, CURRENT_DATE + 2, 'follow_up', 'high', $4, 'system')`,
      [r.project_id, `Review costs: ${r.share}% of the PO value spent`, `Costs ${r.total_cost} against PO value ${r.revenue}. Check what is left to spend.`, r.project_manager || null]);
    raised.push(r.project_id);
  }
  return raised;
}
