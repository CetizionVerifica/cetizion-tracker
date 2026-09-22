-- 030 — certificates and deliverables registry (#43).
--
-- What each client holds from us: certificates, scorecards, reports,
-- audit findings and statements, with their reference, dates, scope and
-- file. An issued deliverable with an expiry drives its renewal: the
-- engagement's next due date is the expiry (#28). Superseding keeps the
-- old one, marked. Owners are told at 120, 90 and 30 days.
--
-- Safe on a live database; running it a second time changes nothing.

CREATE TABLE IF NOT EXISTS deliverables (
  id                serial PRIMARY KEY,
  company_id        int REFERENCES companies(id) ON DELETE SET NULL,
  client_name       text NOT NULL,
  project_id        text REFERENCES projects(project_id) ON UPDATE CASCADE ON DELETE SET NULL,
  po_number         text REFERENCES purchase_orders(po_number) ON UPDATE CASCADE ON DELETE SET NULL,
  service_id        int REFERENCES services(id) ON DELETE SET NULL,
  service_name      text,
  type              text NOT NULL DEFAULT 'certificate'
                      CHECK (type IN ('certificate','scorecard','report','audit_finding','statement')),
  reference         text,
  title             text NOT NULL,
  issued_on         date,
  valid_from        date,
  valid_until       date,
  scope             text,
  issuing_body      text,
  status            text NOT NULL DEFAULT 'issued'
                      CHECK (status IN ('draft','issued','expired','withdrawn','superseded')),
  superseded_by_id  int REFERENCES deliverables(id) ON DELETE SET NULL,
  document_id       int REFERENCES documents(id),
  engagement_id     int REFERENCES engagements(id) ON DELETE SET NULL,
  owner             text,
  reminder_level    int NOT NULL DEFAULT 0,
  notes             text,
  created_by        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until >= valid_from)
);

CREATE INDEX IF NOT EXISTS deliverables_company_idx ON deliverables (company_id);
CREATE INDEX IF NOT EXISTS deliverables_expiry_idx ON deliverables (status, valid_until);
CREATE INDEX IF NOT EXISTS deliverables_project_idx ON deliverables (project_id);
CREATE UNIQUE INDEX IF NOT EXISTS deliverables_reference_key ON deliverables (type, lower(reference)) WHERE reference IS NOT NULL AND status <> 'draft';

DROP TRIGGER IF EXISTS deliverables_set_updated_at ON deliverables;
CREATE TRIGGER deliverables_set_updated_at BEFORE UPDATE ON deliverables
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The client follows the project (or the PO's project) when not given.
CREATE OR REPLACE FUNCTION deliverable_defaults() RETURNS trigger AS $$
BEGIN
  IF NEW.project_id IS NULL AND NEW.po_number IS NOT NULL THEN
    SELECT project_id INTO NEW.project_id FROM purchase_orders WHERE po_number = NEW.po_number;
  END IF;
  IF NEW.project_id IS NOT NULL AND (NEW.company_id IS NULL OR NEW.client_name IS NULL OR NEW.client_name = '') THEN
    SELECT COALESCE(NEW.company_id, p.company_id), COALESCE(NULLIF(NEW.client_name, ''), p.client_name)
      INTO NEW.company_id, NEW.client_name FROM projects p WHERE p.project_id = NEW.project_id;
  END IF;
  IF NEW.company_id IS NOT NULL AND (NEW.client_name IS NULL OR NEW.client_name = '') THEN
    SELECT name INTO NEW.client_name FROM companies WHERE id = NEW.company_id;
  END IF;
  IF NEW.service_id IS NOT NULL AND NEW.service_name IS NULL THEN
    SELECT name INTO NEW.service_name FROM services WHERE id = NEW.service_id;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.valid_until IS DISTINCT FROM OLD.valid_until THEN
    NEW.reminder_level := 0;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS a_deliverable_defaults ON deliverables;
CREATE TRIGGER a_deliverable_defaults BEFORE INSERT OR UPDATE ON deliverables
  FOR EACH ROW EXECUTE FUNCTION deliverable_defaults();

INSERT INTO settings (key, value, notes) VALUES
  ('deliverable_reminder_days', '120,90,30', 'Days before a certificate or deliverable expires at which its owner is reminded.')
ON CONFLICT (key) DO NOTHING;
