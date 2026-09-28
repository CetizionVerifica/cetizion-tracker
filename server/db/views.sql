-- =====================================================================
--  CETIZION — computed views
--
--  Every grey "do not type here" column in the workbook is reproduced
--  here as SQL. Nothing derived is ever stored, so the numbers cannot
--  drift the way copied-down formulas do.
--
--  Dependency order:
--    payment_stages -> vendor_invoices -> expense_claims -> travel_logs
--    -> purchase_orders -> projects -> quotations
-- =====================================================================

BEGIN;

DROP VIEW IF EXISTS v_project_profitability, v_companies, v_quotations, v_projects, v_purchase_orders,
  v_payment_stages, v_travel_logs, v_vendor_invoice_ageing, v_travel_vendor_invoices,
  v_employee_expense_claims CASCADE;

-- A numeric setting with a fallback, so a missing/blank row never
-- breaks a view the way a broken cell reference would.
CREATE OR REPLACE FUNCTION setting_num(p_key text, p_default numeric)
RETURNS numeric AS $$
  SELECT COALESCE(
    (SELECT NULLIF(regexp_replace(value, '[^0-9.\-]', '', 'g'), '')::numeric
       FROM settings WHERE key = p_key),
    p_default);
$$ LANGUAGE sql STABLE;

-- ---------------------------------------------------------------------
-- Payment stages — the finance worklist
--   Payment Schedule columns B-G, L-M, P, S-U, X-Z
-- ---------------------------------------------------------------------

CREATE VIEW v_payment_stages AS
SELECT
  ps.id,
  ps.po_number,
  po.project_id,
  pr.client_name,
  po.po_value,
  po.currency,
  COALESCE(ps.credit_days, po.payment_terms_days)        AS terms_days,
  ps.credit_days,
  ps.milestone_name,
  ps.milestone_reached_on,
  ps.on_hold,
  ps.hold_reason,
  ps.promise_to_pay_date,
  ps.reminder_level,
  po.po_date,
  po.actual_delivery_date                                AS delivery_date,
  ps.stage_no,
  ps.stage_name,
  ps.trigger_event,
  ps.stage_percent,
  ROUND(po.po_value * ps.stage_percent, 2)               AS stage_amount,
  ps.invoice_no,
  ps.invoice_date,
  ps.document_id,
  doc.file_name AS document_name,
  ps.amount_received,
  ps.payment_received_date,
  ps.reminder_sent_on,
  ps.remarks,
  b.due_to_invoice,
  b.invoice_due_date,
  s.stage_status,
  d.days_overdue,
  d.invoiced_amount,
  d.due_now_amount,
  d.to_bill_amount,
  d.received_on_invoiced,
  CASE s.stage_status
    WHEN 'To Invoice'     THEN 'FINANCE: raise ' || ps.stage_name || ' invoice'
    WHEN 'Overdue'        THEN 'FOLLOW UP STRICTLY - ' || ps.stage_name
                               || ' overdue by ' || d.days_overdue || ' day(s)'
    WHEN 'Partially Paid' THEN 'Chase balance on ' || ps.stage_name
    WHEN 'Due'            THEN CASE
                                 WHEN b.invoice_due_date IS NOT NULL
                                  AND b.invoice_due_date - CURRENT_DATE <= 7
                                 THEN 'Payment due within 7 days' END
  END                                                    AS follow_up_action,
  CASE s.stage_status
    WHEN 'Overdue'        THEN 'danger'
    WHEN 'To Invoice'     THEN 'warning'
    WHEN 'Partially Paid' THEN 'warning'
    WHEN 'Paid'           THEN 'success'
    ELSE 'neutral'
  END                                                    AS status_tone
FROM payment_stages ps
JOIN purchase_orders po ON po.po_number = ps.po_number
JOIN projects        pr ON pr.project_id = po.project_id
LEFT JOIN documents doc ON doc.id = ps.document_id
-- b: the stage's own facts.  A stage is due to invoice once its trigger
--    has happened (PO registered / delivery recorded / manual).
CROSS JOIN LATERAL (
  SELECT ROUND(po.po_value * ps.stage_percent, 2),
         CASE ps.trigger_event
           WHEN 'On PO Registration' THEN po.po_date IS NOT NULL
           WHEN 'On Delivery'        THEN po.actual_delivery_date IS NOT NULL
           WHEN 'On Milestone'       THEN ps.milestone_reached_on IS NOT NULL
           ELSE true
         END,
         ps.invoice_date + COALESCE(ps.credit_days, po.payment_terms_days)
) b(amount, due_to_invoice, invoice_due_date)
CROSS JOIN LATERAL (
  SELECT CASE
    WHEN NOT b.due_to_invoice                            THEN 'Not Due'
    WHEN ps.invoice_no IS NULL                           THEN 'To Invoice'
    WHEN ps.amount_received >= b.amount AND b.amount > 0 THEN 'Paid'
    WHEN b.invoice_due_date IS NOT NULL
     AND CURRENT_DATE > b.invoice_due_date               THEN 'Overdue'
    WHEN ps.amount_received > 0                          THEN 'Partially Paid'
    ELSE 'Due'
  END
) s(stage_status)
CROSS JOIN LATERAL (
  SELECT CASE WHEN s.stage_status = 'Overdue'
              THEN CURRENT_DATE - b.invoice_due_date ELSE 0 END,
         CASE WHEN ps.invoice_no IS NOT NULL THEN b.amount ELSE 0 END,
         -- Due now is what is owed on an invoice that has been raised, so the
         -- figure reads exactly as it is defined: invoiced - received.
         CASE WHEN ps.invoice_no IS NOT NULL
              THEN GREATEST(b.amount - ps.amount_received, 0) ELSE 0 END,
         -- Still to be billed: the trigger has happened but no invoice exists.
         -- Money to chase, but not money anyone has been asked for yet.
         CASE WHEN b.due_to_invoice AND ps.invoice_no IS NULL
              THEN GREATEST(b.amount - ps.amount_received, 0) ELSE 0 END,
         -- Only collections against an invoice, so received / invoiced is a
         -- real collection rate and cannot exceed 100%.
         CASE WHEN ps.invoice_no IS NOT NULL THEN ps.amount_received ELSE 0 END
) d(days_overdue, invoiced_amount, due_now_amount, to_bill_amount, received_on_invoiced);

-- ---------------------------------------------------------------------
-- Travel vendor invoices
--   Vendor bills within the settings window; finance pays by month-end.
-- ---------------------------------------------------------------------

CREATE VIEW v_travel_vendor_invoices AS
SELECT
  vi.id,
  vi.vendor_invoice_id,
  vi.travel_id,
  tl.po_number,
  po.project_id,
  pr.client_name,
  tl.employee_name,
  tl.travel_end_date,
  tl.arranged_by                                          AS travel_vendor,
  vi.vendor_invoice_no,
  vi.invoice_date,
  vi.invoice_amount,
  vi.payment_terms_days,
  vi.amount_paid,
  vi.payment_date,
  vi.remarks,
  CASE
    WHEN vi.vendor_invoice_no IS NULL OR vi.invoice_date IS NULL
      OR tl.travel_end_date IS NULL                       THEN NULL
    WHEN vi.invoice_date - tl.travel_end_date
           <= setting_num('vendor_invoice_window_days', 15) THEN 'On time'
    ELSE 'Late (' || (vi.invoice_date - tl.travel_end_date) || 'd)'
  END                                                     AS raised_in_time,
  b.pay_by,
  (vi.vendor_invoice_no IS NOT NULL
     AND vi.invoice_amount IS NOT NULL
     AND vi.amount_paid < vi.invoice_amount)              AS finance_to_pay,
  s.payment_status,
  d.days_overdue,
  CASE s.payment_status
    WHEN 'Awaited' THEN 'Awaiting vendor invoice'
      || CASE WHEN tl.travel_end_date IS NOT NULL
                AND CURRENT_DATE > tl.travel_end_date
                     + setting_num('vendor_invoice_window_days', 15)::int
              THEN ' - OVERDUE from vendor' ELSE '' END
    WHEN 'Overdue' THEN 'FINANCE: pay ' || COALESCE(tl.arranged_by, 'vendor')
      || ' NOW - overdue by ' || d.days_overdue || ' day(s)'
    WHEN 'To Pay' THEN 'FINANCE: vendor invoice received - pay '
      || COALESCE(tl.arranged_by, 'vendor')
      || ' by month-end (' || to_char(b.pay_by, 'DD-Mon') || ')'
    WHEN 'Partially Paid' THEN 'FINANCE: pay balance to '
      || COALESCE(tl.arranged_by, 'vendor')
    WHEN 'Enter amount' THEN 'HR: enter the invoice amount'
    WHEN 'Enter date' THEN 'HR: enter the invoice date - it sets the pay-by date'
  END                                                     AS finance_action,
  CASE s.payment_status
    WHEN 'Overdue'        THEN 'danger'
    WHEN 'To Pay'         THEN 'warning'
    WHEN 'Partially Paid' THEN 'warning'
    WHEN 'Enter date'     THEN 'warning'
    WHEN 'Paid'           THEN 'success'
    ELSE 'neutral'
  END                                                     AS status_tone
FROM travel_vendor_invoices vi
JOIN travel_logs          tl ON tl.travel_id  = vi.travel_id
LEFT JOIN purchase_orders po ON po.po_number  = tl.po_number
LEFT JOIN projects        pr ON pr.project_id = po.project_id
-- Vendor bills are settled at the month-end following the invoice date.
CROSS JOIN LATERAL (
  SELECT (date_trunc('month', vi.invoice_date)
            + interval '1 month - 1 day')::date
) b(pay_by)
CROSS JOIN LATERAL (
  SELECT CASE
    WHEN vi.vendor_invoice_no IS NULL        THEN 'Awaited'
    WHEN vi.invoice_amount IS NULL           THEN 'Enter amount'
    WHEN vi.amount_paid >= vi.invoice_amount THEN 'Paid'
    -- No invoice date means no pay-by date, so the bill can never fall
    -- due and would otherwise sit here unnoticed. Chase the date.
    WHEN vi.invoice_date IS NULL             THEN 'Enter date'
    WHEN CURRENT_DATE > b.pay_by             THEN 'Overdue'
    WHEN vi.amount_paid > 0                  THEN 'Partially Paid'
    ELSE 'To Pay'
  END
) s(payment_status)
CROSS JOIN LATERAL (
  SELECT CASE WHEN s.payment_status = 'Overdue'
              THEN CURRENT_DATE - b.pay_by ELSE 0 END
) d(days_overdue);

-- ---------------------------------------------------------------------
-- Vendor payables ageing (#76) — what Cetizion owes travel vendors
--   One row per bill with money still owed, or with no amount to know
--   what is owed. Built on v_travel_vendor_invoices, so pay_by, status
--   and days_overdue are that view's, never recomputed. Vendor bills are
--   recorded in rupees; the table has no currency to mix.
-- ---------------------------------------------------------------------

-- The ageing bucket for a number of days overdue, as its own function so
-- the boundaries can be tested directly: real pay-by dates are month-ends,
-- so no fixture can put a bill exactly 30 days late on any given day.
-- 0 is not overdue (the pay-by day itself included); 30 is still 0-30.
CREATE OR REPLACE FUNCTION payables_bucket(p_days_overdue int)
RETURNS text AS $$
  SELECT CASE
    WHEN p_days_overdue <= 0  THEN 'not due'
    WHEN p_days_overdue <= 30 THEN '0-30'
    WHEN p_days_overdue <= 60 THEN '31-60'
    WHEN p_days_overdue <= 90 THEN '61-90'
    ELSE '90+'
  END;
$$ LANGUAGE sql IMMUTABLE;

CREATE VIEW v_vendor_invoice_ageing AS
SELECT
  v.id,
  v.vendor_invoice_id,
  v.vendor_invoice_no,
  v.travel_id,
  v.travel_vendor,
  v.employee_name,
  v.client_name,
  v.invoice_date,
  v.invoice_amount,
  v.amount_paid,
  -- NULL, not zero, when the amount was never entered: a gap to fill,
  -- not a bill that costs nothing.
  v.invoice_amount - v.amount_paid                        AS outstanding,
  v.pay_by,
  v.payment_status,
  v.days_overdue,
  CASE
    WHEN v.invoice_amount IS NULL THEN 'amount missing'
    -- Owed, but with no invoice date there is no pay-by date to age from.
    WHEN v.pay_by IS NULL         THEN 'date missing'
    ELSE payables_bucket(v.days_overdue)
  END                                                     AS bucket
FROM v_travel_vendor_invoices v
-- Awaited has no bill yet and Paid owes nothing; everything else is owed.
WHERE v.payment_status IN ('To Pay', 'Partially Paid', 'Overdue', 'Enter date', 'Enter amount');

-- ---------------------------------------------------------------------
-- Employee expense claims
-- ---------------------------------------------------------------------

CREATE VIEW v_employee_expense_claims AS
SELECT
  ec.id,
  ec.claim_id,
  ec.travel_id,
  tl.po_number,
  po.project_id,
  pr.client_name,
  tl.employee_name,
  tl.employee_email,
  ec.expense_category,
  ec.claim_month,
  ec.amount_claimed,
  ec.submission_date,
  ec.approval_status,
  ec.approved_by,
  ec.amount_reimbursed,
  ec.reimbursement_date,
  ec.remarks,
  s.status,
  CASE s.status
    WHEN 'Pending approval'      THEN 'HR: review & approve claim'
    WHEN 'Approved - to reimburse'
      THEN 'FINANCE: reimburse ' || tl.employee_name || ' at month-end'
    WHEN 'Partly reimbursed'
      THEN 'Reimburse balance to ' || tl.employee_name
    WHEN 'On hold'               THEN 'HR: resolve hold'
    WHEN 'Rejected'              THEN 'Rejected - no action'
  END                                                     AS follow_up_action,
  CASE s.status
    WHEN 'Approved - to reimburse' THEN 'warning'
    WHEN 'Partly reimbursed'       THEN 'warning'
    WHEN 'Pending approval'        THEN 'info'
    WHEN 'Reimbursed'              THEN 'success'
    WHEN 'Rejected'                THEN 'danger'
    ELSE 'neutral'
  END                                                     AS status_tone
FROM employee_expense_claims ec
JOIN travel_logs          tl ON tl.travel_id  = ec.travel_id
LEFT JOIN purchase_orders po ON po.po_number  = tl.po_number
LEFT JOIN projects        pr ON pr.project_id = po.project_id
CROSS JOIN LATERAL (
  SELECT CASE
    WHEN ec.approval_status = 'Rejected'  THEN 'Rejected'
    WHEN ec.approval_status = 'On Hold'   THEN 'On hold'
    WHEN ec.approval_status = 'Submitted' THEN 'Pending approval'
    WHEN ec.amount_reimbursed >= ec.amount_claimed
     AND ec.amount_claimed > 0            THEN 'Reimbursed'
    WHEN ec.amount_reimbursed > 0         THEN 'Partly reimbursed'
    ELSE 'Approved - to reimburse'
  END
) s(status);

-- ---------------------------------------------------------------------
-- Travel log — the trip, with both cost sides rolled up
-- ---------------------------------------------------------------------

CREATE VIEW v_travel_logs AS
SELECT
  tl.id,
  tl.travel_id,
  tl.po_number,
  po.project_id,
  pr.client_name,
  tl.service_delivered,
  tl.employee_name,
  tl.employee_email,
  tl.purpose,
  tl.destination,
  tl.travel_start_date,
  tl.travel_end_date,
  tl.arranged_by,
  tl.hr_owner,
  tl.hr_owner_email,
  tl.remarks,
  (tl.travel_end_date
     + setting_num('vendor_invoice_window_days', 15)::int) AS vendor_invoice_expected_by,
  v.vendor_cost,
  v.vendor_paid,
  v.vendor_invoice_count,
  c.employee_claims,
  c.employee_reimbursed,
  c.claim_count,
  v.vendor_cost + c.employee_claims                        AS total_travel_cost,
  CASE
    WHEN v.vendor_invoice_count = 0 THEN
      CASE
        WHEN tl.travel_end_date IS NULL THEN 'Awaiting travel'
        WHEN CURRENT_DATE > tl.travel_end_date
               + setting_num('vendor_invoice_window_days', 15)::int
          THEN 'Invoice OVERDUE from vendor'
        ELSE 'Invoice awaited'
      END
    WHEN v.vendor_paid >= v.vendor_cost THEN 'Vendor paid'
    WHEN v.vendor_paid > 0              THEN 'Vendor partly paid'
    ELSE 'Vendor to pay'
  END                                                      AS vendor_invoice_status,
  CASE
    WHEN c.claim_count = 0                            THEN 'No claim'
    WHEN c.employee_reimbursed >= c.employee_claims   THEN 'Reimbursed'
    WHEN c.employee_reimbursed > 0                    THEN 'Partly reimbursed'
    ELSE 'To reimburse'
  END                                                      AS reimbursement_status
FROM travel_logs tl
LEFT JOIN purchase_orders po ON po.po_number  = tl.po_number
LEFT JOIN projects        pr ON pr.project_id = po.project_id
CROSS JOIN LATERAL (
  SELECT COALESCE(SUM(invoice_amount), 0),
         COALESCE(SUM(amount_paid), 0),
         COUNT(*)
  FROM travel_vendor_invoices vi WHERE vi.travel_id = tl.travel_id
) v(vendor_cost, vendor_paid, vendor_invoice_count)
CROSS JOIN LATERAL (
  SELECT COALESCE(SUM(amount_claimed), 0),
         COALESCE(SUM(amount_reimbursed), 0),
         COUNT(*)
  FROM employee_expense_claims ec WHERE ec.travel_id = tl.travel_id
) c(employee_claims, employee_reimbursed, claim_count);

-- ---------------------------------------------------------------------
-- Purchase orders — totals its service lines, stages and trips
-- ---------------------------------------------------------------------

CREATE VIEW v_purchase_orders AS
SELECT
  po.id,
  po.po_number,
  po.project_id,
  po.quotation_no,
  pr.client_name,
  pr.company_id,
  po.created_at,
  po.po_date,
  po.po_value,
  po.currency,
  po.payment_terms_days,
  po.actual_initiation_date,
  po.actual_delivery_date,
  po.project_manager_email,
  po.remarks,
  po.document_id,
  doc.file_name                                       AS document_name,
  -- Revised or cancelled: out of the sales figures, still billed as usual.
  po.replaces_po_number,
  po.cancelled,
  (SELECT r.po_number FROM purchase_orders r
    WHERE r.replaces_po_number = po.po_number)        AS replaced_by_po_number,
  sv.service_count,
  sv.service_value_total,
  st.stage_count,
  st.stages_percent_total,
  st.total_invoiced,
  st.total_received,
  st.balance_due_now,
  st.balance_to_bill,
  st.total_received_invoiced,
  st.overdue_stages,
  st.stages_to_invoice,
  tr.total_travel_cost,
  CASE
    -- A PO with no stages owes nothing only because nothing has been
    -- scheduled: saying "Up to date" hides work that needs setting up.
    WHEN st.stage_count = 0                           THEN 'No stages'
    WHEN st.overdue_stages > 0                        THEN 'Overdue'
    WHEN st.stages_to_invoice > 0                     THEN 'To Invoice'
    WHEN st.paid_stages = st.stage_count              THEN 'Fully Paid'
    WHEN st.balance_due_now <= 0                      THEN 'Up to date'
    ELSE 'Pending'
  END                                                 AS payment_status,
  CASE
    WHEN st.stage_count = 0
      THEN 'Set the payment stages for this PO'
    WHEN st.overdue_stages > 0
      THEN 'FOLLOW UP STRICTLY - ' || st.overdue_stages || ' stage(s) overdue'
    WHEN st.stages_to_invoice > 0
      THEN 'FINANCE: ' || st.stages_to_invoice || ' stage(s) to invoice'
  END                                                 AS follow_up_action
FROM purchase_orders po
JOIN projects pr ON pr.project_id = po.project_id
LEFT JOIN documents doc ON doc.id = po.document_id
CROSS JOIN LATERAL (
  SELECT COUNT(*), COALESCE(SUM(service_value), 0)
  FROM po_services s WHERE s.po_number = po.po_number
) sv(service_count, service_value_total)
CROSS JOIN LATERAL (
  SELECT COUNT(*),
         COALESCE(SUM(stage_percent), 0),
         COALESCE(SUM(invoiced_amount), 0),
         COALESCE(SUM(amount_received), 0),
         COALESCE(SUM(due_now_amount), 0),
         COALESCE(SUM(to_bill_amount), 0),
         COALESCE(SUM(received_on_invoiced), 0),
         COUNT(*) FILTER (WHERE stage_status = 'Overdue'),
         COUNT(*) FILTER (WHERE stage_status = 'To Invoice'),
         COUNT(*) FILTER (WHERE stage_status = 'Paid')
  FROM v_payment_stages ps WHERE ps.po_number = po.po_number
) st(stage_count, stages_percent_total, total_invoiced, total_received,
     balance_due_now, balance_to_bill, total_received_invoiced,
     overdue_stages, stages_to_invoice, paid_stages)
CROSS JOIN LATERAL (
  SELECT COALESCE(SUM(total_travel_cost), 0)
  FROM v_travel_logs tl WHERE tl.po_number = po.po_number
) tr(total_travel_cost);

-- ---------------------------------------------------------------------
-- Projects — rolls up all POs, stages, onboarding and travel
-- ---------------------------------------------------------------------

CREATE VIEW v_projects AS
SELECT
  p.id,
  p.project_id,
  p.client_name,
  p.company_id,
  p.created_at,
  p.primary_service,
  p.project_manager,
  p.project_manager_email,
  p.sales_person,
  p.planned_start_date,
  p.planned_delivery_date,
  p.percent_complete,
  p.remarks,
  p.estimated_cost,
  po.po_count,
  po.total_contract_value,
  po.total_invoiced,
  po.total_received,
  po.balance_due_now,
  po.balance_to_bill,
  po.currency,
  po.total_travel_cost,
  po.actual_initiation_date,
  po.actual_delivery_date,
  CASE WHEN po.actual_delivery_date IS NOT NULL AND p.planned_delivery_date IS NOT NULL
       THEN po.actual_delivery_date - p.planned_delivery_date END AS delivery_variance_days,
  ob.onboarding_percent,
  ob.onboarding_done,
  ob.onboarding_total,
  st.overdue_stages,
  st.stages_to_invoice,
  CASE
    WHEN po.actual_delivery_date IS NOT NULL   THEN 'Delivered'
    WHEN po.actual_initiation_date IS NOT NULL THEN 'In Progress'
    WHEN po.po_count > 0                       THEN 'Onboarding'
    ELSE 'Not Started'
  END                                                       AS project_stage,
  CASE
    WHEN st.overdue_stages > 0                 THEN 'Overdue'
    WHEN st.stages_to_invoice > 0              THEN 'Invoicing pending'
    WHEN po.po_count > 0
     AND po.fully_paid_pos = po.po_count       THEN 'Fully Paid'
    -- POs exist but none has a payment schedule: nothing is owed only because
    -- nothing has been scheduled, the same as on the PO itself.
    WHEN po.po_count > 0 AND st.stage_count = 0 THEN 'No stages'
    WHEN po.balance_due_now <= 0               THEN 'Up to date'
    ELSE 'Pending'
  END                                                       AS payment_status,
  CASE
    WHEN st.overdue_stages > 0
      THEN 'FOLLOW UP STRICTLY - ' || st.overdue_stages
           || ' stage(s) overdue across POs'
    WHEN st.stages_to_invoice > 0
      THEN 'FINANCE: ' || st.stages_to_invoice || ' stage(s) to invoice'
    WHEN po.actual_delivery_date IS NULL
     AND p.planned_delivery_date IS NOT NULL
     AND CURRENT_DATE > p.planned_delivery_date
      THEN 'Delivery overdue - escalate to project manager'
  END                                                       AS follow_up_action
FROM projects p
CROSS JOIN LATERAL (
  SELECT COUNT(*),
         COALESCE(SUM(po_value), 0),
         COALESCE(SUM(total_invoiced), 0),
         COALESCE(SUM(total_received), 0),
         COALESCE(SUM(balance_due_now), 0),
         COALESCE(SUM(balance_to_bill), 0),
         COALESCE(SUM(total_travel_cost), 0),
         -- The one currency every PO on this project uses, or NULL when they
         -- differ: summing across currencies would be meaningless, and
         -- labelling the sum INR would be wrong.
         CASE WHEN COUNT(DISTINCT currency) = 1 THEN MIN(currency) END,
         COUNT(*) FILTER (WHERE payment_status = 'Fully Paid'),
         MIN(actual_initiation_date),
         -- delivered only once every PO on the project has a delivery date
         CASE WHEN COUNT(*) > 0
               AND COUNT(*) FILTER (WHERE actual_delivery_date IS NOT NULL) = COUNT(*)
              THEN MAX(actual_delivery_date) END
  FROM v_purchase_orders v WHERE v.project_id = p.project_id
) po(po_count, total_contract_value, total_invoiced, total_received,
     balance_due_now, balance_to_bill, total_travel_cost, currency, fully_paid_pos,
     actual_initiation_date, actual_delivery_date)
CROSS JOIN LATERAL (
  SELECT COUNT(*) FILTER (WHERE status = 'Done'),
         COUNT(*) FILTER (WHERE status <> 'N/A'),
         COALESCE(COUNT(*) FILTER (WHERE status = 'Done')::numeric
                  / NULLIF(COUNT(*) FILTER (WHERE status <> 'N/A'), 0), 0)
  FROM onboarding_tasks o WHERE o.project_id = p.project_id
) ob(onboarding_done, onboarding_total, onboarding_percent)
CROSS JOIN LATERAL (
  SELECT COUNT(*) FILTER (WHERE stage_status = 'Overdue'),
         COUNT(*) FILTER (WHERE stage_status = 'To Invoice'),
         COUNT(*)
  FROM v_payment_stages ps WHERE ps.project_id = p.project_id
) st(overdue_stages, stages_to_invoice, stage_count);

-- ---------------------------------------------------------------------
-- Quotations — the four "reflected" columns sales sees without
-- touching finance's data
-- ---------------------------------------------------------------------

CREATE VIEW v_quotations AS
SELECT
  q.id,
  q.quotation_no,
  q.client_name,
  q.contact_person,
  q.company_id,
  q.contact_id,
  q.service_quoted,
  q.sector,
  q.country,
  q.sales_person,
  q.sales_person_email,
  q.quotation_date,
  q.quotation_value,
  q.currency,
  q.status,
  q.po_received,
  q.project_id,
  q.remarks,
  q.document_id,
  doc.file_name                               AS document_name,
  q.created_at,
  q.valid_until,
  q.revision,
  q.terms,
  q.place_of_supply_state,
  q.subtotal,
  q.tax_total,
  q.total,
  q.sent_at,
  q.accepted_at,
  q.accepted_by_name,
  (SELECT COUNT(*)::int FROM quotation_lines ql WHERE ql.quotation_id = q.id) AS line_count,
  q.stage_id,
  st.name                                     AS stage,
  st.type                                     AS stage_type,
  st.sort_order                               AS stage_order,
  st.color                                    AS stage_color,
  q.probability,
  ROUND(COALESCE(q.quotation_value, 0) * COALESCE(q.probability, 0) / 100.0, 2) AS weighted_value,
  q.expected_close_date,
  q.next_step,
  q.stage_changed_at,
  q.last_contacted_at,
  GREATEST(0, (CURRENT_DATE - COALESCE(q.stage_changed_at, q.created_at)::date))::int AS days_in_stage,
  (st.rotting_days IS NOT NULL AND st.type = 'open'
     AND CURRENT_DATE - COALESCE(q.stage_changed_at, q.created_at)::date > st.rotting_days) AS stale,
  q.lost_reason_id,
  lr.name                                     AS lost_reason,
  q.lost_notes,
  q.competitor,
  q.closed_at,
  q.discount_percent,
  q.approval_status,
  q.approval_reason,
  q.approval_requested_at,
  q.approval_requested_by,
  q.approval_decided_at,
  q.approved_by,
  q.approval_note,
  CASE WHEN q.valid_until IS NOT NULL AND q.valid_until < CURRENT_DATE
        AND q.status IN ('Submitted','Under Negotiation') THEN true ELSE false END AS expired,
  r.invoiced,
  r.received,
  r.outstanding,
  CASE
    WHEN q.project_id IS NULL                 THEN NULL
    WHEN r.overdue_pos > 0                    THEN 'Overdue'
    WHEN r.to_invoice_pos > 0                 THEN 'Invoicing pending'
    WHEN r.outstanding <= 0 AND r.received > 0 THEN 'Paid'
    WHEN r.outstanding <= 0                   THEN 'No dues'
    ELSE 'Pending'
  END                                         AS payment_status,
  CASE
    WHEN q.project_id IS NULL     THEN NULL
    WHEN r.overdue_pos > 0        THEN 'Payment overdue - finance following up'
    WHEN r.to_invoice_pos > 0     THEN 'Awaiting finance invoice'
    WHEN r.outstanding <= 0 AND r.received > 0 THEN 'All stages paid'
  END                                         AS payment_note
FROM quotations q
LEFT JOIN documents doc ON doc.id = q.document_id
LEFT JOIN pipeline_stages st ON st.id = q.stage_id
LEFT JOIN lost_reasons lr ON lr.id = q.lost_reason_id
LEFT JOIN LATERAL (
  SELECT COALESCE(SUM(total_invoiced), 0),
         COALESCE(SUM(total_received), 0),
         COALESCE(SUM(balance_due_now), 0) + COALESCE(SUM(balance_to_bill), 0),
         COUNT(*) FILTER (WHERE payment_status = 'Overdue'),
         COUNT(*) FILTER (WHERE payment_status = 'To Invoice')
  FROM v_purchase_orders v WHERE v.project_id = q.project_id
) r(invoiced, received, outstanding, overdue_pos, to_invoice_pos) ON true;

-- ---------------------------------------------------------------------
-- Companies — what the tracker holds per client
-- ---------------------------------------------------------------------

CREATE VIEW v_companies AS
SELECT
  c.id,
  c.name,
  c.name_key,
  c.sector,
  c.gstin,
  c.last_contacted_at,
  c.website,
  c.address,
  c.city,
  c.notes,
  c.created_at,
  c.updated_at,
  (SELECT COUNT(*)::int FROM contacts ct WHERE ct.company_id = c.id)                       AS contacts,
  (SELECT COUNT(*)::int FROM enquiries e WHERE e.company_id = c.id)                        AS enquiries,
  (SELECT COUNT(*)::int FROM quotations q WHERE q.company_id = c.id)                       AS quotations,
  (SELECT COUNT(*)::int FROM quotations q WHERE q.company_id = c.id
     AND q.status = 'Won - PO Received')                                                    AS won_quotations,
  (SELECT COUNT(*)::int FROM projects p WHERE p.company_id = c.id)                         AS projects,
  (SELECT COALESCE(SUM(po.po_value), 0) FROM purchase_orders po
     JOIN projects p ON p.project_id = po.project_id
    WHERE p.company_id = c.id AND po.currency = 'INR')                                     AS po_value_inr,
  (SELECT COALESCE(SUM(v.outstanding), 0) FROM v_quotations v WHERE v.company_id = c.id)   AS outstanding,
  (SELECT MAX(d) FROM (
     SELECT MAX(quotation_date) AS d FROM quotations q WHERE q.company_id = c.id
     UNION ALL SELECT MAX(enquiry_date) FROM enquiries e WHERE e.company_id = c.id
     UNION ALL SELECT MAX(po.po_date) FROM purchase_orders po JOIN projects p ON p.project_id = po.project_id WHERE p.company_id = c.id
   ) x)                                                                                    AS last_activity
FROM companies c;

-- ---------------------------------------------------------------------
-- Project profitability (#39): revenue against delivery cost, in INR.
-- Paid cost is money gone; committed is billed or claimed but not yet
-- paid. A cost or PO with no amount or no exchange rate is counted in
-- gaps and left out of the sums, never taken as zero silently.
-- ---------------------------------------------------------------------
CREATE VIEW v_project_profitability AS
-- The rate in force on the PO's own date, from the exchange_rates table
-- the sales reports read. The fx_rate_% settings this used to read were
-- retired by migration 013 and can no longer hold a value: every foreign
-- PO converted to NULL, so the project showed real costs against no
-- revenue and reported a loss it had not made.
WITH fx AS (
  SELECT 'INR'::text AS currency, 1::numeric AS rate, '0001-01-01'::date AS effective_from
  UNION ALL
  SELECT from_currency, rate, effective_from FROM exchange_rates WHERE to_currency = 'INR'
),
po AS (
  SELECT v.project_id,
         SUM(v.po_value * r.rate)        AS revenue,
         SUM(v.total_invoiced * r.rate)  AS invoiced,
         SUM(v.total_received * r.rate)  AS received,
         COUNT(*) FILTER (WHERE r.rate IS NULL) AS revenue_gaps,
         MIN(v.po_date)                  AS first_po_date
    FROM v_purchase_orders v
    LEFT JOIN LATERAL (
      SELECT fx.rate FROM fx
       WHERE fx.currency = v.currency
         AND fx.effective_from <= COALESCE(v.po_date, CURRENT_DATE)
       ORDER BY fx.effective_from DESC
       LIMIT 1
    ) r ON true
   GROUP BY v.project_id
),
trips AS (
  SELECT t.travel_id, p.project_id FROM travel_logs t JOIN purchase_orders p ON p.po_number = t.po_number
),
vendors AS (
  SELECT tr.project_id,
         SUM(vi.amount_paid) AS paid,
         SUM(GREATEST(COALESCE(vi.invoice_amount, vi.amount_paid) - vi.amount_paid, 0)) AS committed,
         COUNT(*) FILTER (WHERE vi.invoice_amount IS NULL) AS gaps
    FROM travel_vendor_invoices vi JOIN trips tr ON tr.travel_id = vi.travel_id
   GROUP BY tr.project_id
),
claims AS (
  SELECT tr.project_id,
         SUM(c.amount_reimbursed) AS paid,
         SUM(GREATEST(c.amount_claimed - c.amount_reimbursed, 0)) FILTER (WHERE c.approval_status <> 'Rejected') AS committed
    FROM employee_expense_claims c JOIN trips tr ON tr.travel_id = c.travel_id
   GROUP BY tr.project_id
),
manual AS (
  SELECT pc.project_id,
         SUM(pc.amount * fx.rate) FILTER (WHERE pc.status = 'paid')      AS paid,
         SUM(pc.amount * fx.rate) FILTER (WHERE pc.status = 'committed') AS committed,
         COUNT(*) FILTER (WHERE pc.amount IS NULL OR fx.rate IS NULL)    AS gaps
    FROM project_costs pc LEFT JOIN fx ON fx.currency = pc.currency
   GROUP BY pc.project_id
),
totals AS (
  SELECT p.project_id,
         COALESCE(po.revenue, 0) AS revenue,
         COALESCE(po.invoiced, 0) AS invoiced,
         COALESCE(po.received, 0) AS received,
         COALESCE(v.paid, 0) AS travel_vendor_paid,
         COALESCE(v.committed, 0) AS travel_vendor_committed,
         COALESCE(c.paid, 0) AS claims_paid,
         COALESCE(c.committed, 0) AS claims_committed,
         COALESCE(m.paid, 0) AS other_paid,
         COALESCE(m.committed, 0) AS other_committed,
         COALESCE(po.revenue_gaps, 0) AS revenue_gaps,
         COALESCE(v.gaps, 0) + COALESCE(m.gaps, 0) AS cost_gaps,
         po.first_po_date
    FROM projects p
    LEFT JOIN po ON po.project_id = p.project_id
    LEFT JOIN vendors v ON v.project_id = p.project_id
    LEFT JOIN claims c ON c.project_id = p.project_id
    LEFT JOIN manual m ON m.project_id = p.project_id
)
SELECT
  p.project_id, p.client_name, p.company_id, p.primary_service, p.sales_person, p.project_manager,
  p.estimated_cost, p.created_at, t.first_po_date,
  round(t.revenue, 2) AS revenue,
  round(t.invoiced, 2) AS invoiced,
  round(t.received, 2) AS received,
  t.travel_vendor_paid, t.travel_vendor_committed, t.claims_paid, t.claims_committed,
  round(t.other_paid, 2) AS other_paid, round(t.other_committed, 2) AS other_committed,
  round(t.travel_vendor_paid + t.claims_paid + t.other_paid, 2) AS cost_paid,
  round(t.travel_vendor_committed + t.claims_committed + t.other_committed, 2) AS cost_committed,
  round(t.travel_vendor_paid + t.claims_paid + t.other_paid + t.travel_vendor_committed + t.claims_committed + t.other_committed, 2) AS total_cost,
  round(t.revenue - (t.travel_vendor_paid + t.claims_paid + t.other_paid + t.travel_vendor_committed + t.claims_committed + t.other_committed), 2) AS margin,
  CASE WHEN t.revenue > 0 THEN round(100 * (t.revenue - (t.travel_vendor_paid + t.claims_paid + t.other_paid + t.travel_vendor_committed + t.claims_committed + t.other_committed)) / t.revenue, 1) END AS margin_percent,
  CASE WHEN p.estimated_cost IS NOT NULL
       THEN round((t.travel_vendor_paid + t.claims_paid + t.other_paid + t.travel_vendor_committed + t.claims_committed + t.other_committed) - p.estimated_cost, 2) END AS cost_variance,
  t.revenue_gaps::int AS revenue_gaps, t.cost_gaps::int AS cost_gaps,
  (t.revenue > 0 AND round(100 * (t.revenue - (t.travel_vendor_paid + t.claims_paid + t.other_paid + t.travel_vendor_committed + t.claims_committed + t.other_committed)) / t.revenue, 1) < setting_num('margin_alert_percent', 20)) AS low_margin
FROM projects p JOIN totals t ON t.project_id = p.project_id;

-- The COMMIT belongs at the end of the file, not in the middle of it.
-- rebuildViews runs this as one multi-statement query: with the commit
-- where it used to be, v_project_profitability was created outside the
-- transaction, so every redeploy had a window in which the view did not
-- exist - the profitability page and the cost-alert job answering
-- "relation does not exist" - and a failure in it left the earlier views
-- committed with the file itself unrecorded.
COMMIT;
