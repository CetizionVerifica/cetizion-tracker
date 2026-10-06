-- =====================================================================
-- 082_readers_review_only.sql
-- The rollout of the new PO and invoice prompts (docs/email-po-invoice-prompt-plan.md
-- §7): for two weeks every PO and invoice the readers would register goes
-- to review instead, saying what it would have done, so the readings can be
-- compared with the entries made by hand. Automatic registration is then
-- turned back on client by client.
--
--   email_readers_review_only    'true' here: an existing tracker starts the
--                                rollout on upgrade. A new one starts off.
--   email_readers_auto_clients   the clients registered automatically again,
--                                comma separated ("none": no client yet).
--   review reason review_only    read and checked; held for a person.
-- =====================================================================

INSERT INTO settings (key, value, notes) VALUES
  ('email_readers_review_only', 'true', 'The PO and invoice readers send everything they would register to review instead, saying what they would have done (the rollout of the new prompts). Off: they register as before.'),
  ('email_readers_auto_clients', 'none', 'While the readers are review-only: the clients whose POs and invoices are registered automatically again, comma separated.')
ON CONFLICT (key) DO NOTHING;

ALTER TABLE email_po_decisions DROP CONSTRAINT IF EXISTS email_po_decisions_review_reason_check;
ALTER TABLE email_po_decisions ADD CONSTRAINT email_po_decisions_review_reason_check CHECK (review_reason IN
  ('no_match','several_matches','not_to_us','low_confidence','no_po_number',
   'value_mismatch','company_mismatch','amendment','cancellation','multiple_pos','unreadable',
   'no_value','amounts_not_in_pdf','totals_do_not_add_up','bad_currency',
   'currency_mismatch','no_currency',
   'wrong_gstin',
   'po_number_pattern',
   'review_only'));

ALTER TABLE email_invoice_decisions DROP CONSTRAINT IF EXISTS email_invoice_decisions_review_reason_check;
ALTER TABLE email_invoice_decisions ADD CONSTRAINT email_invoice_decisions_review_reason_check CHECK (review_reason IN
  ('po_not_found','several_pos','amount_not_a_stage','po_without_stages','invoice_no_in_use',
   'not_from_us','low_confidence','credit_note','revised','unreadable',
   'no_invoice_no','amounts_not_in_pdf','totals_do_not_add_up','bad_currency','bad_date',
   'client_unknown',
   'wrong_gstin',
   'po_date_mismatch',
   'review_only'));
