-- =====================================================================
-- 071_email_review_reasons.sql
-- Review reasons for an emailed PO or invoice whose client or currency
-- cannot be confirmed, now that the readers stop guessing them.
--
--   email_po_decisions.currency_mismatch   the PO is in another currency
--                                          than the quotation it matches
--   email_po_decisions.no_currency         no currency printed and nothing
--                                          to take it from
--   email_invoice_decisions.client_unknown the invoice names a PO number,
--                                          but its client cannot be confirmed
-- =====================================================================

ALTER TABLE email_po_decisions DROP CONSTRAINT IF EXISTS email_po_decisions_review_reason_check;
ALTER TABLE email_po_decisions ADD CONSTRAINT email_po_decisions_review_reason_check CHECK (review_reason IN
  ('no_match','several_matches','not_to_us','low_confidence','no_po_number',
   'value_mismatch','company_mismatch','amendment','cancellation','multiple_pos','unreadable',
   'no_value','amounts_not_in_pdf','totals_do_not_add_up','bad_currency',
   'currency_mismatch','no_currency'));

ALTER TABLE email_invoice_decisions DROP CONSTRAINT IF EXISTS email_invoice_decisions_review_reason_check;
ALTER TABLE email_invoice_decisions ADD CONSTRAINT email_invoice_decisions_review_reason_check CHECK (review_reason IN
  ('po_not_found','several_pos','amount_not_a_stage','po_without_stages','invoice_no_in_use',
   'not_from_us','low_confidence','credit_note','revised','unreadable',
   'no_invoice_no','amounts_not_in_pdf','totals_do_not_add_up','bad_currency','bad_date',
   'client_unknown'));
