-- 014 — reference numbers come from a counter, not from max(existing) + 1.
--
-- nextId() read the highest number already in the table and added one, so
-- deleting the newest record handed its reference straight to the next one.
-- CTZ/QT/2026/063 could be issued twice, colliding with whatever had already
-- been sent out under that reference.
--
-- A counter only ever goes up, so a number that has been issued is retired
-- even if its record is deleted.
--
-- Safe on a live database: each series is seeded from the highest number it
-- has actually reached, so the next reference is exactly the one the old code
-- would have produced. Nothing is renumbered and no record is touched.

CREATE TABLE IF NOT EXISTS sequence_counters (
  kind       text NOT NULL,
  year       text NOT NULL CHECK (year ~ '^[0-9]{4}$'),
  last_n     int  NOT NULL DEFAULT 0 CHECK (last_n >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, year)
);

DROP TRIGGER IF EXISTS sequence_counters_set_updated_at ON sequence_counters;
CREATE TRIGGER sequence_counters_set_updated_at BEFORE UPDATE ON sequence_counters
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Seed each series from what it has already reached. Each reference is matched
-- against its OWN pattern, anchored on the prefix: travel_vendor_invoices, for
-- one, holds the vendor's number (HT/26-27/966), not a reference this app
-- issued, and a loose match would read "2627" out of it as a year.
INSERT INTO sequence_counters (kind, year, last_n)
SELECT kind, (m)[1] AS year, MAX((m)[2]::int)
  FROM (
    SELECT 'enquiry'   AS kind, regexp_match(enquiry_no,   '^CTZ/ENQ/([0-9]{4})/([0-9]+)$') AS m FROM enquiries
    UNION ALL
    SELECT 'quotation',        regexp_match(quotation_no,  '^CTZ/QT/([0-9]{4})/([0-9]+)$')  FROM quotations
    UNION ALL
    SELECT 'project',          regexp_match(project_id,    '^PRJ-([0-9]{4})-([0-9]+)$')     FROM projects
    UNION ALL
    SELECT 'travel',           regexp_match(travel_id,     '^TRV-([0-9]{4})-([0-9]+)$')     FROM travel_logs
    UNION ALL
    SELECT 'claim',            regexp_match(claim_id,      '^CLM-([0-9]{4})-([0-9]+)$')     FROM employee_expense_claims
    UNION ALL
    SELECT 'vendor_invoice',   regexp_match(vendor_invoice_id, '^VINV-([0-9]{4})-([0-9]+)$') FROM travel_vendor_invoices
  ) refs
 WHERE m IS NOT NULL
 GROUP BY kind, (m)[1]
ON CONFLICT (kind, year) DO NOTHING;
