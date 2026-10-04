-- =====================================================================
-- 080_review_notes.sql
-- One line of figures beside a review reason (docs/email-po-invoice-prompt-plan.md
-- §3, §4): a PO number read again with other values ("registered ₹20,00,000,
-- 4 lines; this email ₹24,63,840, 5 lines"), an invoice whose PO date
-- differs from the PO's. Figures only, never the email's text: a decision
-- row keeps none (docs/email-po-plan.md §4).
-- =====================================================================

ALTER TABLE email_po_decisions ADD COLUMN IF NOT EXISTS review_note text;
ALTER TABLE email_invoice_decisions ADD COLUMN IF NOT EXISTS review_note text;
