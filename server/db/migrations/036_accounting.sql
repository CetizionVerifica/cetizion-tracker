-- 036 — accounting integration and GST/TDS reports (#48).
--
-- The books (Zoho Books, Tally, or an export file from either) are read
-- into books_entries, matched against the tracker's invoices and
-- payments, and every difference is listed until someone accepts or
-- fixes it. The books win on invoice and payment fields. Mappings say
-- which customer, item or ledger in the books a tracker record is.
-- With the provider set to none, nothing changes for manual entry.
--
-- Safe on a live database; running it a second time changes nothing.

CREATE TABLE IF NOT EXISTS accounting_mappings (
  id          serial PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('customer','service','ledger','tax')),
  tracker_ref text NOT NULL,
  books_ref   text NOT NULL,
  books_name  text,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, tracker_ref)
);

CREATE TABLE IF NOT EXISTS books_entries (
  id              serial PRIMARY KEY,
  source          text NOT NULL CHECK (source IN ('zoho','tally','file')),
  kind            text NOT NULL CHECK (kind IN ('invoice','payment','credit_note')),
  books_id        text NOT NULL,
  number          text,
  customer_name   text,
  customer_gstin  text,
  company_id      int REFERENCES companies(id) ON DELETE SET NULL,
  entry_date      date,
  due_date        date,
  taxable_amount  numeric(16,2),
  tax_amount      numeric(16,2),
  total_amount    numeric(16,2),
  tds_amount      numeric(16,2),
  currency        text NOT NULL DEFAULT 'INR',
  reference       text,
  status          text,
  raw             jsonb,
  imported_at     timestamptz NOT NULL DEFAULT now(),
  imported_by     text,
  UNIQUE (source, kind, books_id)
);

CREATE INDEX IF NOT EXISTS books_entries_number_idx ON books_entries (kind, upper(regexp_replace(number, '\s', '', 'g')));

CREATE TABLE IF NOT EXISTS reconciliation_items (
  id              serial PRIMARY KEY,
  kind            text NOT NULL CHECK (kind IN ('invoice','payment')),
  match_key       text NOT NULL UNIQUE,
  stage_id        int REFERENCES payment_stages(id) ON DELETE CASCADE,
  payment_id      int REFERENCES payments(id) ON DELETE SET NULL,
  books_entry_id  int REFERENCES books_entries(id) ON DELETE CASCADE,
  status          text NOT NULL CHECK (status IN ('matched','amount_differs','date_differs','missing_in_books','missing_in_tracker','resolved')),
  differences     jsonb NOT NULL DEFAULT '[]'::jsonb,
  note            text,
  resolved_by     text,
  resolved_at     timestamptz,
  checked_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS reconciliation_items_status_idx ON reconciliation_items (status);

CREATE TABLE IF NOT EXISTS accounting_log (
  id          bigserial PRIMARY KEY,
  action      text NOT NULL,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  done_by     text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO settings (key, value, notes) VALUES
  ('accounting_provider', 'none', 'Where the books are: none, zoho, tally or file (export files uploaded by hand).'),
  ('accounting_apply_payments', 'false', 'Record payments found in the books on the matching tracker invoice automatically.'),
  ('company_state_code', '', 'Two-digit GST state code of our registration (e.g. 27 for Maharashtra). Decides CGST+SGST or IGST on draft invoices.')
ON CONFLICT (key) DO NOTHING;
