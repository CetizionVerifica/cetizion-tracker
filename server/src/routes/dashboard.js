import { Router } from 'express';
import { query } from '../db.js';
import { scopedSources, scopeOf } from '../auth/ownership.js';
import { customerReport, fxReport, reportPeriod, sectorReport } from '../lib/salesReport.js';
import { revenueReport } from '../lib/revenueReport.js';

export const dashboardRouter = Router();

/**
 * The overview screen: the same headline numbers the workbook's three
 * dashboard tabs carried, in one request.
 */
dashboardRouter.get('/overview', async (req, res) => {
  // Every figure below is still computed exactly as it was; only the set of
  // rows it is computed from narrows (#18 Phase 2C). A sales user's totals,
  // counts and lists cover their own records, an admin's cover everything.
  const ownerParams = [];
  const src = scopedSources(scopeOf(req), ownerParams);
  const [sales, finance, portfolio, travel, byStage, byService, pipeline] = await Promise.all([
    query(`
      SELECT
        COUNT(*)::int                                              AS quotations,
        COUNT(*) FILTER (WHERE status = 'Won - PO Received')::int  AS won,
        COUNT(*) FILTER (WHERE status IN ('Submitted','Under Negotiation'))::int AS open,
        COUNT(*) FILTER (WHERE status = 'Lost')::int               AS lost,
        COALESCE(SUM(quotation_value) FILTER (WHERE currency = 'INR'), 0) AS value_inr,
        COALESCE(SUM(quotation_value) FILTER (WHERE currency = 'INR'
                 AND status = 'Won - PO Received'), 0)             AS won_value_inr,
        COUNT(*) FILTER (WHERE status = 'Won - PO Received'
                 AND project_id IS NULL)::int                      AS won_without_project
      FROM ${src.vQuotations}`, ownerParams),
    query(`
      -- Every amount here is labelled in rupees on the Overview, so only INR
      -- stages are summed — the same rule the quotation figures above use.
      -- Adding a dollar stage to a rupee one would make the tile meaningless.
      -- Counts still cover every currency: a USD invoice is just as overdue.
      SELECT
        COALESCE(SUM(invoiced_amount) FILTER (WHERE currency = 'INR'), 0)   AS invoiced,
        COALESCE(SUM(amount_received) FILTER (WHERE currency = 'INR'), 0)   AS received,
        -- due_now is now strictly what is owed on invoices raised, so the
        -- money still to be billed has to be added back or this tile silently
        -- drops it. v_quotations.outstanding is defined the same way.
        COALESCE(SUM(due_now_amount + to_bill_amount) FILTER (WHERE currency = 'INR'), 0) AS outstanding,
        COUNT(*) FILTER (WHERE stage_status = 'To Invoice')::int    AS to_invoice,
        COUNT(*) FILTER (WHERE stage_status = 'Overdue')::int       AS overdue,
        COALESCE(SUM(due_now_amount) FILTER (WHERE stage_status = 'Overdue' AND currency = 'INR'), 0) AS overdue_amount,
        COALESCE(SUM(stage_amount) FILTER (WHERE stage_status = 'To Invoice' AND currency = 'INR'), 0) AS to_invoice_amount
      FROM ${src.vPaymentStages}`, ownerParams),
    query(`
      SELECT
        COUNT(*)::int                                              AS projects,
        COALESCE(SUM(po_count), 0)::int                            AS purchase_orders,
        -- Labelled in rupees, so INR projects only — a EUR project summed in
        -- here would be counted as though its value were rupees. v_projects
        -- exposes currency, and it is null when a project's POs disagree.
        COALESCE(SUM(total_contract_value) FILTER (WHERE currency = 'INR'), 0) AS contract_value,
        COALESCE(AVG(onboarding_percent) FILTER (WHERE onboarding_total > 0), 0) AS avg_onboarding,
        COUNT(*) FILTER (WHERE payment_status = 'Overdue')::int    AS projects_overdue,
        COUNT(*) FILTER (WHERE follow_up_action LIKE 'Delivery overdue%')::int AS delivery_overdue
      FROM ${src.vProjects}`, ownerParams),
    query(`
      SELECT
        (SELECT COUNT(*)::int FROM travel_logs)                    AS trips,
        (SELECT COALESCE(SUM(total_travel_cost), 0) FROM v_travel_logs) AS total_cost,
        (SELECT COUNT(*)::int FROM v_travel_vendor_invoices WHERE finance_to_pay) AS vendor_to_pay,
        (SELECT COALESCE(SUM(invoice_amount - amount_paid), 0)
           FROM v_travel_vendor_invoices WHERE finance_to_pay)     AS vendor_to_pay_amount,
        (SELECT COUNT(*)::int FROM v_travel_vendor_invoices WHERE payment_status = 'Overdue') AS vendor_overdue,
        (SELECT COUNT(*)::int FROM v_employee_expense_claims WHERE status = 'Pending approval') AS claims_pending,
        (SELECT COUNT(*)::int FROM v_employee_expense_claims
           WHERE status IN ('Approved - to reimburse','Partly reimbursed')) AS claims_to_pay,
        (SELECT COALESCE(SUM(amount_claimed - amount_reimbursed), 0)
           FROM v_employee_expense_claims
           WHERE status IN ('Approved - to reimburse','Partly reimbursed')) AS claims_to_pay_amount`),
    query(`
      SELECT project_stage AS label, COUNT(*)::int AS count,
             COALESCE(SUM(total_contract_value) FILTER (WHERE currency = 'INR'), 0) AS value
      FROM ${src.vProjects} GROUP BY 1 ORDER BY 1`, ownerParams),
    query(`
      SELECT service_quoted AS label, COUNT(*)::int AS count,
             COALESCE(SUM(quotation_value) FILTER (WHERE currency = 'INR'), 0) AS value,
             COUNT(*) FILTER (WHERE status = 'Won - PO Received')::int AS won
      FROM ${src.vQuotations}
      WHERE service_quoted IS NOT NULL
      GROUP BY 1 ORDER BY count DESC, label LIMIT 12`, ownerParams),
    query(`
      SELECT status AS label, COUNT(*)::int AS count,
             COALESCE(SUM(quotation_value) FILTER (WHERE currency = 'INR'), 0) AS value
      FROM ${src.vQuotations} GROUP BY 1`, ownerParams),
  ]);

  res.json({
    data: {
      sales: sales.rows[0],
      finance: finance.rows[0],
      portfolio: portfolio.rows[0],
      travel: travel.rows[0],
      projects_by_stage: byStage.rows,
      top_services: byService.rows,
      pipeline_by_status: pipeline.rows,
    },
  });
});

/**
 * The single worklist that replaces "filter the Payment Schedule on
 * To Invoice". Everything anyone has to act on today, in one place.
 */
dashboardRouter.get('/worklist', async (req, res) => {
  // Every figure below is still computed exactly as it was; only the set of
  // rows it is computed from narrows (#18 Phase 2C). A sales user's totals,
  // counts and lists cover their own records, an admin's cover everything.
  const ownerParams = [];
  const src = scopedSources(scopeOf(req), ownerParams);
  const [stages, vendors, claims, deliveries, gaps] = await Promise.all([
    query(`
      SELECT id, po_number, project_id, client_name, stage_no, stage_name,
             stage_amount, currency, invoice_no, invoice_date, document_id, document_name,
             terms_days, invoice_due_date, stage_status,
             days_overdue, follow_up_action, due_now_amount
      FROM ${src.vPaymentStages}
      WHERE stage_status IN ('To Invoice','Overdue','Partially Paid')
      ORDER BY CASE stage_status WHEN 'Overdue' THEN 0 WHEN 'To Invoice' THEN 1 ELSE 2 END,
               days_overdue DESC, po_number, stage_no`, ownerParams),
    query(`
      SELECT id, vendor_invoice_id, travel_id, vendor_invoice_no, travel_vendor,
             employee_name, invoice_amount, amount_paid, pay_by, payment_status,
             days_overdue, finance_action
      FROM v_travel_vendor_invoices
      WHERE payment_status IN ('Overdue','To Pay','Partially Paid','Enter amount','Enter date')
      ORDER BY CASE payment_status WHEN 'Overdue' THEN 0 ELSE 1 END,
               days_overdue DESC, pay_by NULLS LAST`),
    query(`
      SELECT id, claim_id, travel_id, employee_name, expense_category,
             claim_month, amount_claimed, amount_reimbursed, status, follow_up_action
      FROM v_employee_expense_claims
      WHERE status IN ('Pending approval','Approved - to reimburse','Partly reimbursed')
      ORDER BY CASE status WHEN 'Pending approval' THEN 0 ELSE 1 END, submission_date`),
    query(`
      SELECT project_id, client_name, primary_service, project_manager,
             planned_delivery_date, project_stage,
             CURRENT_DATE - planned_delivery_date AS days_late
      FROM ${src.vProjects}
      WHERE actual_delivery_date IS NULL
        AND planned_delivery_date IS NOT NULL
        AND CURRENT_DATE > planned_delivery_date
      ORDER BY planned_delivery_date`, ownerParams),
    query(`
      SELECT id, quotation_no, client_name, service_quoted, quotation_value, currency
      FROM ${src.vQuotations}
      WHERE status = 'Won - PO Received' AND project_id IS NULL
      ORDER BY quotation_date DESC NULLS LAST`, ownerParams),
  ]);

  res.json({
    data: {
      payment_stages: stages.rows,
      vendor_invoices: vendors.rows,
      expense_claims: claims.rows,
      late_deliveries: deliveries.rows,
      won_without_project: gaps.rows,
    },
  });
});

/**
 * Sector-wise funnel, FX deals and new vs repeat customers, for an
 * optional ?from=&to= range.
 */
dashboardRouter.get('/sales-report', async (req, res) => {
  const period = reportPeriod(req.query);
  const scope = scopeOf(req);
  const [sectors, customers, fx] = await Promise.all([
    sectorReport(period, scope), customerReport(period, scope), fxReport(period, scope),
  ]);
  res.json({ data: { period, sectors, customers, fx } });
});

/**
 * Order intake (won quotations), invoicing & collections and payment status
 * (purchase orders) per month, for an optional ?from=&to= range — the page
 * sends a calendar year, or one month of it.
 */
dashboardRouter.get('/revenue-report', async (req, res) => {
  const period = reportPeriod(req.query);
  res.json({ data: { period, ...(await revenueReport(period, { scope: scopeOf(req) })) } });
});

/** Travel & expense analysis, matching the workbook's third dashboard. */
dashboardRouter.get('/travel', async (req, res) => {
  const [snapshot, byVendor, byStatus, byClaimStatus, byMonth] = await Promise.all([
    query(`
      SELECT COUNT(*)::int AS trips,
             COALESCE(SUM(vendor_cost), 0)         AS vendor_cost,
             COALESCE(SUM(vendor_paid), 0)         AS vendor_paid,
             COALESCE(SUM(employee_claims), 0)     AS employee_claims,
             COALESCE(SUM(employee_reimbursed), 0) AS employee_reimbursed,
             COALESCE(SUM(total_travel_cost), 0)   AS total_cost
      FROM v_travel_logs`),
    query(`
      SELECT COALESCE(arranged_by, 'Not recorded') AS label,
             COUNT(*)::int AS count,
             COALESCE(SUM(total_travel_cost), 0) AS value
      FROM v_travel_logs GROUP BY 1 ORDER BY value DESC, label`),
    query(`
      SELECT payment_status AS label, COUNT(*)::int AS count,
             COALESCE(SUM(invoice_amount), 0) AS value
      FROM v_travel_vendor_invoices GROUP BY 1 ORDER BY 1`),
    query(`
      SELECT status AS label, COUNT(*)::int AS count,
             COALESCE(SUM(amount_claimed), 0) AS value
      FROM v_employee_expense_claims GROUP BY 1 ORDER BY 1`),
    query(`
      SELECT to_char(date_trunc('month', travel_start_date), 'Mon YYYY') AS label,
             date_trunc('month', travel_start_date) AS sort_key,
             COUNT(*)::int AS count,
             COALESCE(SUM(total_travel_cost), 0) AS value
      FROM v_travel_logs
      WHERE travel_start_date IS NOT NULL
      GROUP BY 1, 2 ORDER BY 2`),
  ]);

  res.json({
    data: {
      snapshot: snapshot.rows[0],
      by_vendor: byVendor.rows,
      vendor_invoice_status: byStatus.rows,
      claim_status: byClaimStatus.rows,
      by_month: byMonth.rows,
    },
  });
});
