-- 001 — the client's sector on each quotation, for the sector-wise report.
--
-- Safe on a live database: it only adds a column, and running it a second
-- time changes nothing.

ALTER TABLE quotations ADD COLUMN IF NOT EXISTS sector text;
