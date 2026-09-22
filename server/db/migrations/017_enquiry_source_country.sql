-- 017 — enquiry source and country, for the sales report.

ALTER TABLE enquiries
  ADD COLUMN IF NOT EXISTS source text,
  ADD COLUMN IF NOT EXISTS country text;
