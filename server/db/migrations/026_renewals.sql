-- 026 — renewals for recurring services (#28).
--
-- An engagement records what a client holds (a rating, a certificate, a
-- yearly report) and when it comes round again. It is created when a PO
-- with a renewable service is delivered; the daily job opens a renewal
-- quotation ahead of the due date and follows what happens to it.
--
-- Safe on a live database; running it a second time changes nothing.

CREATE TABLE IF NOT EXISTS engagements (
  id                     serial PRIMARY KEY,
  company_id             int REFERENCES companies(id) ON DELETE SET NULL,
  client_name            text NOT NULL,
  service_id             int REFERENCES services(id) ON DELETE SET NULL,
  service_name           text NOT NULL,
  project_id             text REFERENCES projects(project_id) ON UPDATE CASCADE ON DELETE SET NULL,
  po_number              text REFERENCES purchase_orders(po_number) ON UPDATE CASCADE ON DELETE SET NULL,
  quotation_id           int REFERENCES quotations(id) ON DELETE SET NULL,
  cycle                  int NOT NULL DEFAULT 1,
  started_on             date,
  valid_until            date,
  next_due_on            date NOT NULL,
  status                 text NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active','renewal_open','renewed','lapsed','cancelled')),
  renewal_quotation_id   int REFERENCES quotations(id) ON DELETE SET NULL,
  renewal_opened_at      timestamptz,
  owner                  text,
  notes                  text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS engagements_due_idx ON engagements (status, next_due_on);
CREATE INDEX IF NOT EXISTS engagements_company_idx ON engagements (company_id);
-- One engagement per delivered PO and service.
CREATE UNIQUE INDEX IF NOT EXISTS engagements_po_service_key ON engagements (po_number, service_name) WHERE po_number IS NOT NULL;

DROP TRIGGER IF EXISTS engagements_set_updated_at ON engagements;
CREATE TRIGGER engagements_set_updated_at BEFORE UPDATE ON engagements
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The renewal interval of the services Cetizion sells most, as a starting
-- point; admins set the real ones on the catalogue.
UPDATE services SET renewal_interval_months = 12
 WHERE renewal_interval_months IS NULL
   AND (name ILIKE '%ecovadis%' OR name ILIKE '%surveillance%' OR name ILIKE '%sustainability report%' OR name ILIKE '%GHG%');
