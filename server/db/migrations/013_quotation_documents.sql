-- 013 — quotations as real documents (#23): a service catalogue, line items
-- with GST, validity, revisions, and totals kept in step with the lines.
--
-- Safe on a live database; running it a second time changes nothing.

-- The services list becomes a catalogue.
ALTER TABLE services
  ADD COLUMN IF NOT EXISTS code text,
  ADD COLUMN IF NOT EXISTS sac_code text,
  ADD COLUMN IF NOT EXISTS default_rate numeric(16,2),
  ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'INR',
  ADD COLUMN IF NOT EXISTS gst_rate numeric(5,2) NOT NULL DEFAULT 18,
  ADD COLUMN IF NOT EXISTS unit text NOT NULL DEFAULT 'engagement',
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS renewal_interval_months int,
  ADD COLUMN IF NOT EXISTS renewal_lead_days int NOT NULL DEFAULT 60;

CREATE TABLE IF NOT EXISTS quotation_lines (
  id                serial PRIMARY KEY,
  quotation_id      int NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  service_id        int REFERENCES services(id) ON DELETE SET NULL,
  description       text NOT NULL,
  qty               numeric(12,2) NOT NULL DEFAULT 1 CHECK (qty > 0),
  unit              text,
  rate              numeric(16,2) NOT NULL DEFAULT 0 CHECK (rate >= 0),
  discount_percent  numeric(5,2) NOT NULL DEFAULT 0 CHECK (discount_percent BETWEEN 0 AND 100),
  gst_rate          numeric(5,2) NOT NULL DEFAULT 18 CHECK (gst_rate BETWEEN 0 AND 100),
  amount            numeric(16,2) GENERATED ALWAYS AS (round(qty * rate * (1 - discount_percent / 100), 2)) STORED,
  sort_order        int NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS quotation_lines_quotation_id_idx ON quotation_lines (quotation_id, sort_order, id);

ALTER TABLE quotations
  ADD COLUMN IF NOT EXISTS valid_until date,
  ADD COLUMN IF NOT EXISTS revision int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS terms text,
  ADD COLUMN IF NOT EXISTS place_of_supply_state text,
  ADD COLUMN IF NOT EXISTS subtotal numeric(16,2),
  ADD COLUMN IF NOT EXISTS tax_total numeric(16,2),
  ADD COLUMN IF NOT EXISTS total numeric(16,2),
  ADD COLUMN IF NOT EXISTS sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS accepted_at timestamptz,
  ADD COLUMN IF NOT EXISTS accepted_by_name text;

-- What a quotation looked like before each revision.
CREATE TABLE IF NOT EXISTS quotation_revisions (
  id            serial PRIMARY KEY,
  quotation_id  int NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  revision      int NOT NULL,
  snapshot      jsonb NOT NULL,
  note          text,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS quotation_revisions_quotation_id_idx ON quotation_revisions (quotation_id, revision);

-- Totals follow the lines. With lines, quotation_value is the total; without
-- any, the typed quotation_value stands and the totals are blank.
CREATE OR REPLACE FUNCTION quotation_totals(p_quotation int) RETURNS void AS $$
DECLARE s numeric; t numeric; n int;
BEGIN
  SELECT COUNT(*), COALESCE(SUM(amount), 0), COALESCE(SUM(round(amount * gst_rate / 100, 2)), 0)
    INTO n, s, t FROM quotation_lines WHERE quotation_id = p_quotation;
  IF n = 0 THEN
    UPDATE quotations SET subtotal = NULL, tax_total = NULL, total = NULL WHERE id = p_quotation;
  ELSE
    UPDATE quotations SET subtotal = s, tax_total = t, total = s + t, quotation_value = s + t WHERE id = p_quotation;
  END IF;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION quotation_lines_changed() RETURNS trigger AS $$
BEGIN
  PERFORM quotation_totals(COALESCE(NEW.quotation_id, OLD.quotation_id));
  IF TG_OP = 'UPDATE' AND NEW.quotation_id IS DISTINCT FROM OLD.quotation_id THEN PERFORM quotation_totals(OLD.quotation_id); END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS quotation_lines_changed ON quotation_lines;
CREATE TRIGGER quotation_lines_changed AFTER INSERT OR UPDATE OR DELETE ON quotation_lines
  FOR EACH ROW EXECUTE FUNCTION quotation_lines_changed();
DROP TRIGGER IF EXISTS quotation_lines_set_updated_at ON quotation_lines;
CREATE TRIGGER quotation_lines_set_updated_at BEFORE UPDATE ON quotation_lines
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A new quotation takes its validity and terms from Settings when none were typed.
-- A numeric setting, or the default. views.sql defines the same function;
-- it is here too because triggers call it, and a database built from this
-- file alone (as some tests do) must be able to insert rows.
CREATE OR REPLACE FUNCTION setting_num(p_key text, p_default numeric)
RETURNS numeric AS $$
  SELECT COALESCE(
    (SELECT NULLIF(regexp_replace(value, '[^0-9.\-]', '', 'g'), '')::numeric
       FROM settings WHERE key = p_key),
    p_default);
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION quotation_defaults() RETURNS trigger AS $$
BEGIN
  IF NEW.valid_until IS NULL AND NEW.quotation_date IS NOT NULL THEN
    NEW.valid_until := NEW.quotation_date + (setting_num('quotation_validity_days', 30))::int;
  END IF;
  IF NEW.terms IS NULL THEN
    SELECT NULLIF(value, '') INTO NEW.terms FROM settings WHERE key = 'quotation_terms_default';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS quotation_defaults ON quotations;
CREATE TRIGGER quotation_defaults BEFORE INSERT ON quotations
  FOR EACH ROW EXECUTE FUNCTION quotation_defaults();

INSERT INTO settings (key, value, notes) VALUES
  ('quotation_validity_days', '30', 'How long a quotation stays open for acceptance, from its date. Sets valid_until on new quotations and revisions.'),
  ('gst_rate_default', '18', 'GST % offered on a new quotation line when the service has none.'),
  ('company_name', 'Cetizion Verifica Pvt. Ltd.', 'Printed at the top of quotation PDFs.'),
  ('company_address', '', 'Printed under the company name on quotation PDFs.'),
  ('company_gstin', '', 'Printed on quotation PDFs.'),
  ('quotation_terms_default', 'Payment: 50% advance with the purchase order, 50% on delivery of the final report. Prices exclude GST unless stated. Valid until the date shown.', 'Terms printed on a new quotation; editable per quotation.')
ON CONFLICT (key) DO NOTHING;
