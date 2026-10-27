-- =====================================================================
-- 086_travel_import.sql
-- The travel importer (#196 §5): HR's monthly travel workbook, uploaded,
-- reviewed and committed beside the sales importer, in the same tables.
--
--   import_batches.kind         'sales' or 'travel'.
--   import_batches.vendor_id    the travel agency the whole workbook is from.
--   import_batches.source_file  the workbook itself, so a corrected column
--                               mapping can be planned again without another
--                               upload. Dropped with the batch.
--   import_items.step           the travel steps: traveller, trip, segment,
--                               vendor_invoice, invoice_line, credit_note
--                               (and vendor).
--   travel_import_trip_gap_days rows of one traveller further apart than
--                               this are separate trips.
-- =====================================================================

ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'sales' CHECK (kind IN ('sales','travel'));
ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS vendor_id int REFERENCES travel_vendors(id);
ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS source_file bytea;

ALTER TABLE import_items DROP CONSTRAINT IF EXISTS import_items_step_check;
ALTER TABLE import_items ADD CONSTRAINT import_items_step_check CHECK (step IN
  ('quotation','project','purchase_order','service','stage','invoice','receipt',
   'traveller','trip','segment','vendor_invoice','invoice_line','credit_note','vendor'));

INSERT INTO settings (key, value, notes) VALUES
  ('travel_import_trip_gap_days', '7', 'In the travel import, rows for one traveller more than this many days apart are separate trips.')
ON CONFLICT (key) DO NOTHING;
