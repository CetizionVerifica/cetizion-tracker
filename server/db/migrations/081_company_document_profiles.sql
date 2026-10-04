-- =====================================================================
-- 081_company_document_profiles.sql
-- What is particular about one client's POs or invoices
-- (docs/email-po-invoice-prompt-plan.md §6; the plan's "078", taken).
--
--   company_document_profiles      a note for the model, the labels the
--                                  client prints, its PO numbers' shape and
--                                  the domains it sends from. Used once an
--                                  admin has approved it.
--   document_profile_corrections   a reviewer settled one of the client's
--                                  items by hand. Three in 90 days, with no
--                                  profile, suggest one (approved_at null).
--   review reason po_number_pattern   a PO number not of the client's shape.
--
-- The four clients the plan read are seeded, each only when exactly one
-- company in the tracker has that name.
-- =====================================================================

CREATE TABLE IF NOT EXISTS company_document_profiles (
  id                 serial PRIMARY KEY,
  company_id         int NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  doc_type           text NOT NULL CHECK (doc_type IN ('po','invoice')),
  sender_domains     text[] NOT NULL DEFAULT '{}',
  po_number_pattern  text,
  label_aliases      text,
  hint               text CHECK (char_length(hint) <= 500),
  approved_by        text,
  approved_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, doc_type)
);

CREATE TABLE IF NOT EXISTS document_profile_corrections (
  id             serial PRIMARY KEY,
  company_id     int NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  doc_type       text NOT NULL CHECK (doc_type IN ('po','invoice')),
  review_reason  text,
  decided_by     text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS document_profile_corrections_idx ON document_profile_corrections (company_id, doc_type, created_at);

ALTER TABLE email_po_decisions DROP CONSTRAINT IF EXISTS email_po_decisions_review_reason_check;
ALTER TABLE email_po_decisions ADD CONSTRAINT email_po_decisions_review_reason_check CHECK (review_reason IN
  ('no_match','several_matches','not_to_us','low_confidence','no_po_number',
   'value_mismatch','company_mismatch','amendment','cancellation','multiple_pos','unreadable',
   'no_value','amounts_not_in_pdf','totals_do_not_add_up','bad_currency',
   'currency_mismatch','no_currency',
   'wrong_gstin',
   'po_number_pattern'));

INSERT INTO company_document_profiles (company_id, doc_type, po_number_pattern, hint, approved_by, approved_at)
SELECT c.id, 'po', s.pattern, s.hint, 'docs/email-po-invoice-prompt-plan.md', now()
  FROM (VALUES
    ('alembic%', '^37\d{8}$', 'SAP purchase orders: amounts are printed with three decimals ("500,000.000"). "YOUR REF" is our quotation. Ignore the goods terms (COA, batch, marine policy); the payment terms are the order''s own.'),
    ('aragen%', '^90\d{8}$', 'One service is printed on two rows, a description row and a code row with the same amount: one line. Nine pages of general terms follow the order; the payment terms are on the order itself ("Invoice Date, 45 days").'),
    ('dasami%', '^DL\d{2}SW', 'Work orders. "Quotation No & Date" is Dasami''s own number, never ours. CGST and SGST are printed separately; the IGST row is blank.'),
    ('hindalco%', '^\d{11}$', 'Oracle purchase orders, addressed to our partner Innovative CSR Solutions. "Our Contact" is Hindalco''s own person. The buyer''s GSTIN is only at the foot of the order.')
  ) AS s(name_like, pattern, hint)
  JOIN companies c ON c.name_key LIKE s.name_like
 WHERE (SELECT count(*) FROM companies x WHERE x.name_key LIKE s.name_like) = 1
ON CONFLICT (company_id, doc_type) DO NOTHING;
