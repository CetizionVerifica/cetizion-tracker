-- =====================================================================
-- 080_review_notes.sql
-- One line of figures beside a review reason (docs/email-po-invoice-prompt-plan.md
-- §3, §4): a PO number read again with other values ("registered ₹20,00,000,
-- 4 lines; this email ₹24,63,840, 5 lines"), an invoice whose PO date
-- differs from the PO's. Figures only, never the email's text: a decision
-- row keeps none (docs/email-po-plan.md §4).
--
-- Also for invoices (§4, §5):
--   review reason po_date_mismatch   the PO date printed on the invoice is
--                                    not the matched PO's date.
--   split_suggestion                 an invoice for part of a PO with one
--                                    100% stage: the split a reviewer may
--                                    accept with one click, never applied
--                                    automatically.
-- =====================================================================

ALTER TABLE email_po_decisions ADD COLUMN IF NOT EXISTS review_note text;
ALTER TABLE email_invoice_decisions ADD COLUMN IF NOT EXISTS review_note text;
ALTER TABLE email_invoice_decisions ADD COLUMN IF NOT EXISTS split_suggestion jsonb;

ALTER TABLE email_invoice_decisions DROP CONSTRAINT IF EXISTS email_invoice_decisions_review_reason_check;
ALTER TABLE email_invoice_decisions ADD CONSTRAINT email_invoice_decisions_review_reason_check CHECK (review_reason IN
  ('po_not_found','several_pos','amount_not_a_stage','po_without_stages','invoice_no_in_use',
   'not_from_us','low_confidence','credit_note','revised','unreadable',
   'no_invoice_no','amounts_not_in_pdf','totals_do_not_add_up','bad_currency','bad_date',
   'client_unknown',
   'wrong_gstin',
   'po_date_mismatch'));
