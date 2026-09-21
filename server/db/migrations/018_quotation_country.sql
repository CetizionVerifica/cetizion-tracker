-- 018 — quotation country, for the sales report.

ALTER TABLE quotations
  ADD COLUMN IF NOT EXISTS country text;
