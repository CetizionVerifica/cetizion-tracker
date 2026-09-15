-- 007 — a quotation belongs to at most one enquiry, now that an enquiry can
-- be linked to a quotation that already exists.
--
-- Safe on a live database: it only adds an index, and running it a second
-- time changes nothing.

CREATE UNIQUE INDEX IF NOT EXISTS enquiries_quotation_no_key
  ON enquiries (quotation_no) WHERE quotation_no IS NOT NULL;
