import { Router } from 'express';
import { query } from '../db.js';
import { isUnrestricted, scopedSources, scopeOf } from '../auth/ownership.js';
import { ApiError } from '../middleware/error.js';
import { dataQuality } from '../lib/dataQuality.js';
import { businessToday, workingDaysBetween } from '../lib/businessDate.ts';
import { payables } from '../lib/payables.js';
import { myToday } from '../lib/myToday.js';

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
  // Every relation below is aliased. For an admin scopedSources hands back a
  // bare view name, where an alias is optional; for a sales user it hands
  // back a parenthesised SELECT, and Postgres refuses a subquery in FROM
  // that has no alias. Unaliased, these queries worked for an admin and
  // failed with a 500 for exactly the people the scoping is for.
  const src = scopedSources(scopeOf(req), ownerParams);
  const [sales, finance, portfolio, travel, byStage, byService, pipeline] = await Promise.all([
    query(`
      SELECT
        COUNT(*)::int                                              AS quotations,
        COUNT(*) FILTER (WHERE status = 'Won - PO Received')::int  AS won,
        COUNT(*) FILTER (WHERE status IN ('Draft','Submitted','Under Negotiation'))::int AS open,
        COUNT(*) FILTER (WHERE status = 'Lost')::int               AS lost,
        COALESCE(SUM(quotation_value) FILTER (WHERE currency = 'INR'), 0) AS value_inr,
        COALESCE(SUM(quotation_value) FILTER (WHERE currency = 'INR'
                 AND status = 'Won - PO Received'), 0)             AS won_value_inr,
        COUNT(*) FILTER (WHERE status = 'Won - PO Received'
                 AND project_id IS NULL)::int                      AS won_without_project
      FROM ${src.vQuotations} q`, ownerParams),
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
      FROM ${src.vPaymentStages} s`, ownerParams),
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
      FROM ${src.vProjects} p`, ownerParams),
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
      FROM ${src.vProjects} p GROUP BY 1 ORDER BY 1`, ownerParams),
    query(`
      SELECT service_quoted AS label, COUNT(*)::int AS count,
             COALESCE(SUM(quotation_value) FILTER (WHERE currency = 'INR'), 0) AS value,
             COUNT(*) FILTER (WHERE status = 'Won - PO Received')::int AS won
      FROM ${src.vQuotations} q
      WHERE service_quoted IS NOT NULL
      GROUP BY 1 ORDER BY count DESC, label LIMIT 12`, ownerParams),
    query(`
      SELECT status AS label, COUNT(*)::int AS count,
             COALESCE(SUM(quotation_value) FILTER (WHERE currency = 'INR'), 0) AS value
      FROM ${src.vQuotations} q GROUP BY 1`, ownerParams),
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
  const [stages, vendors, claims, deliveries, gaps, holidays] = await Promise.all([
    query(`
      SELECT id, po_number, project_id, client_name, stage_no, stage_name,
             stage_amount, currency, invoice_no, invoice_date, document_id, document_name,
             terms_days, invoice_due_date, stage_status,
             days_overdue, follow_up_action, due_now_amount
      FROM ${src.vPaymentStages} s
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
      FROM ${src.vProjects} p
      WHERE actual_delivery_date IS NULL
        AND planned_delivery_date IS NOT NULL
        AND CURRENT_DATE > planned_delivery_date
      ORDER BY planned_delivery_date`, ownerParams),
    query(`
      SELECT id, quotation_no, client_name, service_quoted, quotation_value, currency
      FROM ${src.vQuotations} q
      WHERE status = 'Won - PO Received' AND project_id IS NULL
      ORDER BY quotation_date DESC NULLS LAST`, ownerParams),
    // The holiday calendar is configuration, the same for everybody (#26).
    query(`SELECT holiday_on FROM holidays`),
  ]);

  // Days overdue stay calendar days, as every reminder counts them; this is
  // the same lateness in the days somebody could have acted on it (#73).
  //
  // Both numbers are decided by one clock, on purpose. days_overdue comes
  // from the views as Postgres CURRENT_DATE, which in our containers is
  // UTC, while businessToday() is Asia/Kolkata — so between 00:00 and
  // 05:30 IST they are a day apart, every day. Gating on days_overdue and
  // counting from businessToday() put the two beside each other in one
  // row: "overdue by 1 day" above "2 working days late", for five and a
  // half hours out of every twenty-four. Comparing the due date against
  // the same date the count runs from is what keeps them agreeing.
  const today = businessToday();
  const off = new Set(holidays.rows.map((row) => row.holiday_on));
  const withWorkingDays = (due) => (row) => ({
    ...row,
    working_days_overdue: row[due] && row[due] < today ? workingDaysBetween(row[due], today, off) : null,
  });

  res.json({
    data: {
      payment_stages: stages.rows.map(withWorkingDays('invoice_due_date')),
      vendor_invoices: vendors.rows.map(withWorkingDays('pay_by')),
      expense_claims: claims.rows,
      late_deliveries: deliveries.rows,
      won_without_project: gaps.rows,
    },
  });
});

/**
 * My Today (docs/my-today-plan.md): one person's own work, due today or
 * late, from tasks, enquiry follow-ups, invoices to raise and payments to
 * chase. The rules are in lib/myToday.js.
 *
 *   GET /api/dashboard/my-today[?owner=<user id>][&summary=1][&all=1]
 *
 * Whose day it is:
 *   a sales user   always their own; ?owner= is ignored
 *   an admin       their own, or ?owner=<user id> for cover and one-to-ones
 *   shared login   nobody's until ?owner= names one — there is no person
 *                  behind it — so the answer says so and lists who to pick
 *
 * ?summary=1 is the sidebar badge: the counts only, from the same rules.
 * ?all=1 lists everything late instead of folding the oldest into one row.
 */
dashboardRouter.get('/my-today', async (req, res) => {
  scopeOf(req); // refuses a session that is not what it claims to be
  const viewerUnrestricted = isUnrestricted(req.user);
  const asked = Number(req.query.owner);
  let personId = null;
  if (!viewerUnrestricted) personId = req.user.id;
  else if (req.query.owner !== undefined && req.query.owner !== '' && Number.isSafeInteger(asked) && asked > 0) personId = asked;
  else if (req.user.mode === 'database') personId = req.user.id;

  let person = null;
  if (personId !== null) {
    ({ rows: [person] } = await query('SELECT id, name, email, role FROM users WHERE id = $1', [personId]));
    if (!person) throw new ApiError(404, 'No such person');
  }
  const summary = req.query.summary === '1' || req.query.summary === 'true';
  const day = person ? await myToday({ query }, person, { unfold: req.query.all === '1' || req.query.all === 'true' }) : null;

  if (summary) {
    return res.json({ data: { today: day?.today ?? businessToday(), person: day?.person ?? null, counts: day?.counts ?? null } });
  }
  // The person picker is an admin's; a sales user's would be a staff directory.
  const owners = viewerUnrestricted
    ? (await query('SELECT id, name FROM users WHERE active ORDER BY name')).rows
    : [];
  res.json({
    data: day
      ? { ...day, owners }
      : { today: businessToday(), person: null, needs_person: true, owners, counts: null, late: [], due_today: [], older: null },
  });
});

/**
 * What is missing, and where to fix it (#74): one count per check, each
 * with a link to the list filtered to exactly those records. Read-only.
 */
dashboardRouter.get('/data-quality', async (req, res) => {
  res.json({ data: { checks: await dataQuality() } });
});

/**
 * What we owe travel vendors, aged (#76): every bill still owed, its
 * bucket, and a count and outstanding total per bucket. In rupees.
 */
dashboardRouter.get('/payables', async (req, res) => {
  res.json({ data: await payables() });
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
