-- 046 — the invoice series, numbered by financial year.
--
-- Invoices are the one series that cannot be numbered by calendar year.
-- A GST invoice series runs with the Indian financial year, April to
-- March, and is written as the two years it spans: CVPL/26-27/0112. The
-- counter table was built for the other five series, all of which are
-- calendar-year, so its `year` column only accepted four digits.
--
-- Safe on a live database; running it a second time changes nothing.

-- Widening a check never fails on existing rows: every counter already
-- recorded is four digits and stays valid.
ALTER TABLE sequence_counters DROP CONSTRAINT IF EXISTS sequence_counters_year_check;

ALTER TABLE sequence_counters
  ADD CONSTRAINT sequence_counters_year_check
  CHECK (year ~ '^[0-9]{4}$' OR year ~ '^[0-9]{2}-[0-9]{2}$');

-- An invoice number should be unique across the whole series, not just
-- within one purchase order: the statutory requirement is an unbroken,
-- unrepeated sequence for the company.
--
-- But this database has invoice numbers typed in by hand since long before
-- the series existed, and two of them being equal is entirely possible.
-- Every migration here runs inside a transaction, and a migration that
-- throws stops the container on start — which is how production went down
-- this morning. So the index is only created when the data already
-- satisfies it, and a database that does not is left alone with a warning
-- rather than being refused a deploy.
--
-- The duplicates then show up in the warning and can be corrected, and
-- this migration can be re-run by hand afterwards. Until then
-- claimNextId() still never reissues a number, because it takes the
-- highest that exists as its floor.
DO $$
DECLARE
  duplicates int;
  sample text;
BEGIN
  SELECT count(*), string_agg(invoice_no, ', ')
    INTO duplicates, sample
    FROM (
      SELECT invoice_no FROM payment_stages
       WHERE invoice_no IS NOT NULL
       GROUP BY invoice_no HAVING count(*) > 1
       LIMIT 10
    ) AS d;

  IF COALESCE(duplicates, 0) = 0 THEN
    CREATE UNIQUE INDEX IF NOT EXISTS payment_stages_invoice_no_key
      ON payment_stages (invoice_no) WHERE invoice_no IS NOT NULL;
  ELSE
    RAISE WARNING
      'payment_stages has % duplicated invoice number(s) (%). The unique index was not created; correct them and re-run this migration by hand.',
      duplicates, sample;
  END IF;
END
$$;
