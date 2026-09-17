-- 010 — dated exchange rates.
--
-- Until now Settings held one fx_rate_<CUR> per currency and every report
-- converted with that single value, so last year's figures moved whenever
-- someone edited a rate. Rates are now rows with a date, and a report reads
-- the rate in force on the record's own date: the quotation date for a
-- quotation, the PO date for a PO, the invoice date for an invoice and the
-- payment date for a payment.
--
-- Safe on a live database: the Settings values are carried in as rows
-- effective from the earliest transaction date, so every figure is identical
-- the moment this runs. Nothing before that date exists to convert.

CREATE TABLE IF NOT EXISTS exchange_rates (
  id             serial PRIMARY KEY,
  from_currency  text NOT NULL,
  to_currency    text NOT NULL DEFAULT 'INR' CHECK (to_currency = 'INR'),
  rate           numeric(18,6) NOT NULL CHECK (rate > 0),
  effective_from date NOT NULL,
  source         text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','feed')),
  entered_by     text,
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  -- One rate per currency per day. A correction replaces that day's row.
  UNIQUE (from_currency, to_currency, effective_from)
);

-- The lookup every report makes: newest row on or before a given date.
CREATE INDEX IF NOT EXISTS exchange_rates_lookup_idx
  ON exchange_rates (from_currency, to_currency, effective_from DESC);

DROP TRIGGER IF EXISTS exchange_rates_set_updated_at ON exchange_rates;
CREATE TRIGGER exchange_rates_set_updated_at BEFORE UPDATE ON exchange_rates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Carry the Settings values over, dated early enough to cover every record
-- that exists. A blank or unusable setting stays "not set" and is skipped.
INSERT INTO exchange_rates (from_currency, to_currency, rate, effective_from, source, note)
SELECT substr(s.key, 9),
       'INR',
       btrim(s.value)::numeric,
       LEAST(
         COALESCE((SELECT min(quotation_date) FROM quotations), CURRENT_DATE),
         COALESCE((SELECT min(po_date)        FROM purchase_orders), CURRENT_DATE),
         CURRENT_DATE
       ),
       'manual',
       'Carried over from the single Settings rate. Earlier figures used this same value, so rates before this date are estimates.'
  FROM settings s
 WHERE s.key LIKE 'fx\_rate\_%'
   AND btrim(s.value) ~ '^[0-9]+(\.[0-9]+)?$'
   AND NULLIF(btrim(s.value)::numeric, 0) IS NOT NULL
ON CONFLICT (from_currency, to_currency, effective_from) DO NOTHING;

-- The old settings stay visible but are now read-only in the API; they are
-- removed once the Exchange rates screen has been in use for a while.
UPDATE settings
   SET notes = 'Replaced by Settings -> Exchange rates. Read-only; kept only for reference.'
 WHERE key LIKE 'fx\_rate\_%';
