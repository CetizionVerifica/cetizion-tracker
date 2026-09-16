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

DROP VIEW IF EXISTS v_companies, v_quotations, v_projects, v_purchase_orders,
  v_payment_stages, v_travel_logs, v_travel_vendor_invoices,
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
  p.primary_service,
  p.project_manager,
  p.project_manager_email,
  p.sales_person,
  p.planned_start_date,
  p.planned_delivery_date,
  p.percent_complete,
  p.remarks,
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
  GREATEST(0, (CURRENT_DATE - COALESCE(q.stage_changed_at, q.created_at)::date))::int AS days_in_stage,
  (st.rotting_days IS NOT NULL AND st.type = 'open'
     AND CURRENT_DATE - COALESCE(q.stage_changed_at, q.created_at)::date > st.rotting_days) AS stale,
  q.lost_reason_id,
  lr.name                                     AS lost_reason,
  q.lost_notes,
  q.competitor,
  q.closed_at,
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

COMMIT;
