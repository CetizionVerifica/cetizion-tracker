-- =====================================================================
-- 083_email_auto_entry.sql
-- Quotations, POs and invoices entered from email reliably
-- (docs/email-auto-entry-plan.md).
--
--   quotations.printed_no            the number printed on the PDF we sent,
--                                    when the tracker numbered the quotation
--                                    otherwise (§3.4). A PO quoting it back
--                                    ("YOUR REF: QTN-04/2026") finds it.
--                                    Back-filled from the remarks the email
--                                    reader wrote: "Printed number: …".
--   purchase_orders.client_vendor_code
--                                    our supplier code at the client (§2.2).
--   review reason bad_gstin          a GSTIN whose check character does not
--                                    fit: misread (§3.7).
--   review reason readers_disagree   an image PDF, read twice by two models,
--                                    the readings differing (§3.7).
--   email_triage                     what one quick call said each email is,
--                                    before the readers read it (§3.8).
--   stages_source quotation_terms    the PO named only a trigger, so the
--                                    quotation's split was used (§3.6).
-- =====================================================================

ALTER TABLE quotations ADD COLUMN IF NOT EXISTS printed_no text;
CREATE INDEX IF NOT EXISTS quotations_printed_no_idx ON quotations (upper(printed_no)) WHERE printed_no IS NOT NULL;

UPDATE quotations
   SET printed_no = substring(remarks FROM 'Printed number: ([^ ]+?)\.?( |$)')
 WHERE printed_no IS NULL AND remarks ~ 'Printed number: ';

ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS client_vendor_code text;

ALTER TABLE email_po_decisions DROP CONSTRAINT IF EXISTS email_po_decisions_review_reason_check;
ALTER TABLE email_po_decisions ADD CONSTRAINT email_po_decisions_review_reason_check CHECK (review_reason IN
  ('no_match','several_matches','not_to_us','low_confidence','no_po_number',
   'value_mismatch','company_mismatch','amendment','cancellation','multiple_pos','unreadable',
   'no_value','amounts_not_in_pdf','totals_do_not_add_up','bad_currency',
   'currency_mismatch','no_currency',
   'wrong_gstin',
   'po_number_pattern',
   'review_only',
   'bad_gstin','readers_disagree'));

ALTER TABLE email_po_decisions DROP CONSTRAINT IF EXISTS email_po_decisions_stages_source_check;
ALTER TABLE email_po_decisions ADD CONSTRAINT email_po_decisions_stages_source_check CHECK (stages_source IN ('po_terms','quotation_terms','template','none'));

ALTER TABLE email_invoice_decisions DROP CONSTRAINT IF EXISTS email_invoice_decisions_review_reason_check;
ALTER TABLE email_invoice_decisions ADD CONSTRAINT email_invoice_decisions_review_reason_check CHECK (review_reason IN
  ('po_not_found','several_pos','amount_not_a_stage','po_without_stages','invoice_no_in_use',
   'not_from_us','low_confidence','credit_note','revised','unreadable',
   'no_invoice_no','amounts_not_in_pdf','totals_do_not_add_up','bad_currency','bad_date',
   'client_unknown',
   'wrong_gstin',
   'po_date_mismatch',
   'review_only',
   'bad_gstin','readers_disagree'));

-- One quick AI call sorts each email before the readers read it (§3.8).
CREATE TABLE IF NOT EXISTS email_triage (
  id                   serial PRIMARY KEY,
  account_id           int NOT NULL REFERENCES connected_accounts(id) ON DELETE CASCADE,
  provider_id          text NOT NULL,
  internet_message_id  text,
  direction            text NOT NULL CHECK (direction IN ('inbound','outbound')),
  label                text NOT NULL CHECK (label IN ('enquiry','quotation_sent','client_po','po_change','our_invoice','payment_advice','other')),
  confidence           numeric(4,3) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  decided_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, provider_id)
);
CREATE INDEX IF NOT EXISTS email_triage_message_idx ON email_triage (lower(internet_message_id)) WHERE internet_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS email_triage_decided_idx ON email_triage (decided_at);

INSERT INTO settings (key, value, notes) VALUES
  ('email_triage_enabled', 'true', 'Sort each email with one quick AI call before the PO, invoice and enquiry readers read it, so the thorough reading is spent only on business documents. Off: every reader reads as before.')
ON CONFLICT (key) DO NOTHING;
