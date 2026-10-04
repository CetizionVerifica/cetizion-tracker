-- =====================================================================
-- 079_po_addressed_to.sql
-- Our two GSTINs and the partner companies clients also order through
-- (docs/email-po-invoice-prompt-plan.md §1). The plan calls this "077";
-- 077 and 078 are taken by changes made before it.
--
--   purchase_orders.addressed_gstin   the GSTIN the client addressed the PO
--                                     to: one of ours, or a partner's. The
--                                     invoice must be raised from it.
--   purchase_orders.partner_name      set when it was addressed to a partner.
--   review reason wrong_gstin         an invoice raised from another GSTIN
--                                     than its PO was addressed to.
--   company_gstins                    every registration of ours.
--   partner_companies                 one per line: name | GSTIN | other names.
-- =====================================================================

ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS addressed_gstin text;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS partner_name text;

ALTER TABLE email_po_decisions DROP CONSTRAINT IF EXISTS email_po_decisions_review_reason_check;
ALTER TABLE email_po_decisions ADD CONSTRAINT email_po_decisions_review_reason_check CHECK (review_reason IN
  ('no_match','several_matches','not_to_us','low_confidence','no_po_number',
   'value_mismatch','company_mismatch','amendment','cancellation','multiple_pos','unreadable',
   'no_value','amounts_not_in_pdf','totals_do_not_add_up','bad_currency',
   'currency_mismatch','no_currency',
   'wrong_gstin'));

ALTER TABLE email_invoice_decisions DROP CONSTRAINT IF EXISTS email_invoice_decisions_review_reason_check;
ALTER TABLE email_invoice_decisions ADD CONSTRAINT email_invoice_decisions_review_reason_check CHECK (review_reason IN
  ('po_not_found','several_pos','amount_not_a_stage','po_without_stages','invoice_no_in_use',
   'not_from_us','low_confidence','credit_note','revised','unreadable',
   'no_invoice_no','amounts_not_in_pdf','totals_do_not_add_up','bad_currency','bad_date',
   'client_unknown',
   'wrong_gstin'));

INSERT INTO settings (key, value, notes) VALUES
  ('company_gstins', '07AAKCC0860B1Z2,09AAKCC0860B1ZY', 'Every GSTIN we are registered under (Delhi, UP), comma separated. The email readers take a PO addressed to, or an invoice raised from, any of them.'),
  ('partner_companies', 'Innovative CSR Solutions India Pvt. Ltd. | 07AACCI8342L1ZA', 'Companies clients also order through, one per line: name | GSTIN | other names, comma separated. A PO addressed to one is registered as ours, marked as through it.')
ON CONFLICT (key) DO NOTHING;
