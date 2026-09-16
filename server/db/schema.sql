-- =====================================================================
--  CETIZION — Sales, Projects, Payments, Travel & Expenses
--  Schema. Mirrors the workbook: one table per "you type here" sheet.
--  Everything the workbook computed with formulas lives in views.sql.
-- =====================================================================

BEGIN;

DROP VIEW IF EXISTS v_quotations, v_projects, v_purchase_orders,
  v_payment_stages, v_travel_logs, v_travel_vendor_invoices,
  v_employee_expense_claims CASCADE;

DROP TABLE IF EXISTS users, quotation_revisions, quotation_lines, email_log, job_runs, import_items, import_batches, employee_expense_claims, travel_vendor_invoices,
  travel_logs, onboarding_tasks, payment_stages, po_services,
  purchase_orders, projects, enquiries, quotations, pipeline_stages, lost_reasons, contacts, companies, expense_categories,
  travel_vendors, services, settings, exchange_rates, sequence_counters, documents CASCADE;

-- ---------------------------------------------------------------------
-- Reference data (the workbook's Settings / Services / Travel Lists tabs)
-- ---------------------------------------------------------------------

CREATE TABLE settings (
  key         text PRIMARY KEY,
  value       text NOT NULL,
  notes       text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Retired: rates now live in exchange_rates below, with the date each one
-- took effect. These rows are read-only and kept only for reference.
INSERT INTO settings (key, value, notes) VALUES
  ('fx_rate_EUR', '', 'Replaced by Settings -> Exchange rates. Read-only; kept only for reference.'),
  ('fx_rate_USD', '', 'Replaced by Settings -> Exchange rates. Read-only; kept only for reference.'),
  ('fx_rate_GBP', '', 'Replaced by Settings -> Exchange rates. Read-only; kept only for reference.'),
  ('fx_rate_AED', '', 'Replaced by Settings -> Exchange rates. Read-only; kept only for reference.'),
  ('fx_rate_SGD', '', 'Replaced by Settings -> Exchange rates. Read-only; kept only for reference.');

-- Dated exchange rates. Every report converts with the rate in force on the
-- record's own date, so last year's figures do not move when a rate changes.
-- The fx_rate_* settings above are read-only and kept only for reference.
CREATE TABLE exchange_rates (
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
CREATE INDEX exchange_rates_lookup_idx
  ON exchange_rates (from_currency, to_currency, effective_from DESC);

-- How far each reference series has got. A counter only ever goes up, so a
-- number that has been issued is never reissued once its record is deleted.
-- Empty on a fresh database; claimNextId also takes in the highest reference
-- already present, so a seeded or imported database numbers on from there.
CREATE TABLE sequence_counters (
  kind       text NOT NULL,
  year       text NOT NULL CHECK (year ~ '^[0-9]{4}$'),
  last_n     int  NOT NULL DEFAULT 0 CHECK (last_n >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, year)
);

CREATE TABLE services (
  id         serial PRIMARY KEY,
  name       text NOT NULL UNIQUE,
  active     boolean NOT NULL DEFAULT true,
  sort_order int NOT NULL DEFAULT 0,
  -- The catalogue (#23): what a line for this service looks like by default.
  code                    text,
  sac_code                text,
  default_rate            numeric(16,2),
  currency                text NOT NULL DEFAULT 'INR',
  gst_rate                numeric(5,2) NOT NULL DEFAULT 18,
  unit                    text NOT NULL DEFAULT 'engagement',
  description             text,
  renewal_interval_months int,
  renewal_lead_days       int NOT NULL DEFAULT 60
);

CREATE TABLE travel_vendors (
  id     serial PRIMARY KEY,
  name   text NOT NULL UNIQUE,
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE expense_categories (
  id     serial PRIMARY KEY,
  name   text NOT NULL UNIQUE,
  active boolean NOT NULL DEFAULT true
);

-- ---------------------------------------------------------------------
-- Documents — the uploaded file behind a quotation or a PO. The file
--   lives in Cloudinary; storage_key is its public_id there.
-- ---------------------------------------------------------------------

CREATE TABLE documents (
  id            serial PRIMARY KEY,
  storage_key   text NOT NULL UNIQUE,
  file_name     text NOT NULL,
  content_type  text NOT NULL,
  size_bytes    int  NOT NULL CHECK (size_bytes > 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- Set when removal starts; a marked document can never be attached.
  purging_at    timestamptz
);

-- ---------------------------------------------------------------------
-- Pipeline stages and lost reasons (#25)
-- ---------------------------------------------------------------------

CREATE TABLE pipeline_stages (
  id              serial PRIMARY KEY,
  name            text NOT NULL UNIQUE,
  probability     int NOT NULL CHECK (probability BETWEEN 0 AND 100),
  type            text NOT NULL CHECK (type IN ('open','paused','won','lost')),
  maps_to_status  text NOT NULL,
  sort_order      int NOT NULL DEFAULT 0,
  color           text,
  rotting_days    int,
  active          boolean NOT NULL DEFAULT true
);

INSERT INTO pipeline_stages (name, probability, type, maps_to_status, sort_order, color, rotting_days) VALUES
  ('Draft',                   10, 'open',   'Submitted',         1, '#94a3b8', 14),
  ('Sent',                    40, 'open',   'Submitted',         2, '#38bdf8', 21),
  ('Negotiation',             60, 'open',   'Under Negotiation', 3, '#f59e0b', 21),
  ('Verbal yes, awaiting PO', 90, 'open',   'Under Negotiation', 4, '#22c55e', 30),
  ('On Hold',                 20, 'paused', 'On Hold',           5, '#a3a3a3', NULL),
  ('Won, PO received',       100, 'won',    'Won - PO Received', 6, '#16a34a', NULL),
  ('Lost',                     0, 'lost',   'Lost',              7, '#ef4444', NULL)
ON CONFLICT (name) DO NOTHING;

CREATE TABLE lost_reasons (
  id          serial PRIMARY KEY,
  name        text NOT NULL UNIQUE,
  active      boolean NOT NULL DEFAULT true,
  sort_order  int NOT NULL DEFAULT 0
);

INSERT INTO lost_reasons (name, sort_order) VALUES
  ('Price', 1), ('Went with a competitor', 2), ('No budget this year', 3), ('Project cancelled or postponed', 4),
  ('No response', 5), ('Timing', 6), ('Scope changed', 7), ('Quotation expired', 8), ('Other', 9)
ON CONFLICT (name) DO NOTHING;

-- ---------------------------------------------------------------------
-- Companies and contacts — a client exists once, keyed on its normalised
-- name; records keep client_name and link to it by trigger (below).
-- ---------------------------------------------------------------------

CREATE TABLE companies (
  id          serial PRIMARY KEY,
  name        text NOT NULL,
  name_key    text NOT NULL UNIQUE,
  sector      text,
  gstin       text,
  website     text,
  address     text,
  city        text,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE contacts (
  id                 serial PRIMARY KEY,
  company_id         int NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name               text NOT NULL,
  email              text,
  phone              text,
  role               text,
  is_billing         boolean NOT NULL DEFAULT false,
  opt_out_reminders  boolean NOT NULL DEFAULT false,
  notes              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX contacts_company_id_idx ON contacts (company_id);
CREATE UNIQUE INDEX contacts_company_name_key
  ON contacts (company_id, lower(regexp_replace(btrim(name), '\s+', ' ', 'g')));

-- ---------------------------------------------------------------------
-- Projects  (Project Tracker)
--   Created when a quotation is won. project_id is the human key used
--   everywhere, exactly as in the workbook (PRJ-2026-001).
-- ---------------------------------------------------------------------

CREATE TABLE projects (
  id                    serial PRIMARY KEY,
  project_id            text NOT NULL UNIQUE,
  client_name           text NOT NULL,
  company_id            int REFERENCES companies(id) ON DELETE SET NULL,
  primary_service       text,
  project_manager       text,
  project_manager_email text,
  sales_person          text,
  planned_start_date    date,
  planned_delivery_date date,
  percent_complete      numeric(5,4) NOT NULL DEFAULT 0
                          CHECK (percent_complete BETWEEN 0 AND 1),
  remarks               text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX projects_company_id_idx ON projects (company_id);

-- ---------------------------------------------------------------------
-- Quotations  (Sales Tracker)
-- ---------------------------------------------------------------------

CREATE TABLE quotations (
  id                 serial PRIMARY KEY,
  quotation_no       text NOT NULL UNIQUE,
  client_name        text NOT NULL,
  company_id         int REFERENCES companies(id) ON DELETE SET NULL,
  contact_person     text,
  contact_id         int REFERENCES contacts(id) ON DELETE SET NULL,
  service_quoted     text,
  sector             text,
  country            text,
  sales_person       text,
  sales_person_email text,
  quotation_date     date,
  quotation_value    numeric(16,2),
  currency           text NOT NULL DEFAULT 'INR',
  status             text NOT NULL DEFAULT 'Submitted'
                       CHECK (status IN ('Submitted','Under Negotiation',
                                         'Won - PO Received','Lost','On Hold')),
  po_received        boolean NOT NULL DEFAULT false,
  project_id         text REFERENCES projects(project_id)
                       ON UPDATE CASCADE ON DELETE SET NULL,
  remarks            text,
  document_id        int UNIQUE REFERENCES documents(id),
  -- A quotation as a document (#23)
  valid_until            date,
  revision               int NOT NULL DEFAULT 0,
  terms                  text,
  place_of_supply_state  text,
  subtotal               numeric(16,2),
  tax_total              numeric(16,2),
  total                  numeric(16,2),
  sent_at                timestamptz,
  accepted_at            timestamptz,
  accepted_by_name       text,
  -- The pipeline (#25)
  stage_id               int REFERENCES pipeline_stages(id),
  probability            int CHECK (probability BETWEEN 0 AND 100),
  expected_close_date    date,
  next_step              text,
  stage_changed_at       timestamptz,
  lost_reason_id         int REFERENCES lost_reasons(id) ON DELETE SET NULL,
  lost_notes             text,
  competitor             text,
  closed_at              timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON quotations (project_id);
CREATE INDEX quotations_company_id_idx ON quotations (company_id);
CREATE INDEX quotations_stage_id_idx ON quotations (stage_id);
CREATE INDEX ON quotations (status);

-- ---------------------------------------------------------------------
-- Quotation lines and revisions (#23)
-- ---------------------------------------------------------------------

CREATE TABLE quotation_lines (
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

CREATE INDEX quotation_lines_quotation_id_idx ON quotation_lines (quotation_id, sort_order, id);


-- What a quotation looked like before each revision.
CREATE TABLE quotation_revisions (
  id            serial PRIMARY KEY,
  quotation_id  int NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  revision      int NOT NULL,
  snapshot      jsonb NOT NULL,
  note          text,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX quotation_revisions_quotation_id_idx ON quotation_revisions (quotation_id, revision);

-- ---------------------------------------------------------------------
-- Enquiries — logged before anything is quoted. Marking one
-- 'Won - Quotation Sent' has the API create and link its quotation.
-- ---------------------------------------------------------------------

CREATE TABLE enquiries (
  id                 serial PRIMARY KEY,
  enquiry_no         text NOT NULL UNIQUE,
  enquiry_date       date,
  client_name        text NOT NULL,
  company_id         int REFERENCES companies(id) ON DELETE SET NULL,
  source             text,
  sector             text,
  country            text,
  contact_person     text,
  contact_id         int REFERENCES contacts(id) ON DELETE SET NULL,
  sales_person       text,
  sales_person_email text,
  service            text,
  status             text NOT NULL DEFAULT 'In Progress'
                       CHECK (status IN ('In Progress','Declined','Won - Quotation Sent')),
  quotation_no       text REFERENCES quotations(quotation_no)
                       ON UPDATE CASCADE ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX enquiries_company_id_idx ON enquiries (company_id);
CREATE INDEX ON enquiries (status);
-- A quotation belongs to at most one enquiry.
CREATE UNIQUE INDEX enquiries_quotation_no_key ON enquiries (quotation_no) WHERE quotation_no IS NOT NULL;

-- ---------------------------------------------------------------------
-- Purchase orders  (PO Register) — a project may hold several
-- ---------------------------------------------------------------------

CREATE TABLE purchase_orders (
  id                     serial PRIMARY KEY,
  po_number              text NOT NULL UNIQUE,
  project_id             text NOT NULL REFERENCES projects(project_id)
                           ON UPDATE CASCADE ON DELETE RESTRICT,
  po_date                date,
  po_value               numeric(16,2) NOT NULL DEFAULT 0,
  currency               text NOT NULL DEFAULT 'INR',
  payment_terms_days     int NOT NULL DEFAULT 30 CHECK (payment_terms_days >= 0),
  actual_initiation_date date,
  actual_delivery_date   date,
  project_manager_email  text,
  remarks                text,
  -- The won quotation this PO fulfils; revenue counts the PO against it, once.
  quotation_no           text REFERENCES quotations(quotation_no)
                           ON UPDATE CASCADE ON DELETE SET NULL,
  document_id            int UNIQUE REFERENCES documents(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON purchase_orders (project_id);
CREATE INDEX purchase_orders_quotation_no_idx ON purchase_orders (quotation_no);

-- Client name is not stored on the PO — it is read from the project,
-- honouring the workbook's "type any fact in exactly one place" rule.

-- ---------------------------------------------------------------------
-- Services on a PO  (PO Services) — one row per service line
-- ---------------------------------------------------------------------

CREATE TABLE po_services (
  id            serial PRIMARY KEY,
  po_number     text NOT NULL REFERENCES purchase_orders(po_number)
                  ON UPDATE CASCADE ON DELETE CASCADE,
  service       text NOT NULL,
  service_value numeric(16,2),
  remarks       text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON po_services (po_number);

-- ---------------------------------------------------------------------
-- Payment stages  (Payment Schedule) — the finance worklist
-- ---------------------------------------------------------------------

CREATE TABLE payment_stages (
  id                    serial PRIMARY KEY,
  po_number             text NOT NULL REFERENCES purchase_orders(po_number)
                          ON UPDATE CASCADE ON DELETE CASCADE,
  stage_no              int NOT NULL CHECK (stage_no > 0),
  stage_name            text NOT NULL,
  trigger_event         text NOT NULL DEFAULT 'On PO Registration'
                          CHECK (trigger_event IN ('On PO Registration',
                                                   'On Delivery','Manual')),
  stage_percent         numeric(6,4) NOT NULL CHECK (stage_percent > 0),
  invoice_no            text,
  invoice_date          date,
  document_id           int UNIQUE REFERENCES documents(id),
  amount_received       numeric(16,2) NOT NULL DEFAULT 0,
  payment_received_date date,
  reminder_sent_on      date,
  remarks               text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (po_number, stage_no)
);

CREATE INDEX ON payment_stages (po_number);

-- ---------------------------------------------------------------------
-- Onboarding / lifecycle checklist  (Onboarding)
-- ---------------------------------------------------------------------

CREATE TABLE onboarding_tasks (
  id             serial PRIMARY KEY,
  project_id     text NOT NULL REFERENCES projects(project_id)
                   ON UPDATE CASCADE ON DELETE CASCADE,
  step_no        int NOT NULL,
  stage          text,
  step           text NOT NULL,
  owner          text,
  owner_email    text,
  target_date    date,
  status         text NOT NULL DEFAULT 'Not Started'
                   CHECK (status IN ('Not Started','In Progress','Done','N/A')),
  completed_date date,
  remarks        text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON onboarding_tasks (project_id);

-- ---------------------------------------------------------------------
-- Travel  (Travel Log) — HR logs the trip once, keyed by travel_id
-- ---------------------------------------------------------------------

CREATE TABLE travel_logs (
  id                serial PRIMARY KEY,
  travel_id         text NOT NULL UNIQUE,
  -- Nullable: internal / non-billable trips are logged without a PO.
  po_number         text REFERENCES purchase_orders(po_number)
                      ON UPDATE CASCADE ON DELETE RESTRICT,
  service_delivered text,
  employee_name     text NOT NULL,
  employee_email    text,
  purpose           text,
  destination       text,
  travel_start_date date,
  travel_end_date   date,
  arranged_by       text,          -- travel vendor
  hr_owner          text DEFAULT 'HR Team',
  hr_owner_email    text DEFAULT 'hr@cetizion.com',
  remarks           text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON travel_logs (po_number);

-- ---------------------------------------------------------------------
-- Travel vendor invoices  (Travel Vendor Invoices)
-- ---------------------------------------------------------------------

CREATE TABLE travel_vendor_invoices (
  id                 serial PRIMARY KEY,
  vendor_invoice_id  text NOT NULL UNIQUE,
  travel_id          text NOT NULL REFERENCES travel_logs(travel_id)
                       ON UPDATE CASCADE ON DELETE CASCADE,
  vendor_invoice_no  text,
  invoice_date       date,
  invoice_amount     numeric(16,2),
  payment_terms_days int NOT NULL DEFAULT 30,
  amount_paid        numeric(16,2) NOT NULL DEFAULT 0,
  payment_date       date,
  remarks            text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON travel_vendor_invoices (travel_id);

-- ---------------------------------------------------------------------
-- Employee expense claims  (Employee Expense Claims)
-- ---------------------------------------------------------------------

CREATE TABLE employee_expense_claims (
  id                  serial PRIMARY KEY,
  claim_id            text NOT NULL UNIQUE,
  travel_id           text NOT NULL REFERENCES travel_logs(travel_id)
                        ON UPDATE CASCADE ON DELETE CASCADE,
  expense_category    text,
  claim_month         text,
  amount_claimed      numeric(16,2) NOT NULL DEFAULT 0,
  submission_date     date,
  approval_status     text NOT NULL DEFAULT 'Submitted'
                        CHECK (approval_status IN ('Submitted','Approved',
                                                   'Rejected','On Hold')),
  approved_by         text,
  amount_reimbursed   numeric(16,2) NOT NULL DEFAULT 0,
  reimbursement_date  date,
  remarks             text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON employee_expense_claims (travel_id);

-- ---------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['companies','contacts','projects','quotations','quotation_lines','enquiries','purchase_orders',
      'po_services','payment_stages','onboarding_tasks','travel_logs',
      'travel_vendor_invoices','employee_expense_claims','settings','exchange_rates',
      'sequence_counters']
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I_set_updated_at BEFORE UPDATE ON %I
         FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------- quotation totals
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

CREATE TRIGGER quotation_lines_changed AFTER INSERT OR UPDATE OR DELETE ON quotation_lines
  FOR EACH ROW EXECUTE FUNCTION quotation_lines_changed();

INSERT INTO settings (key, value, notes) VALUES
  ('quotation_validity_days', '30', 'How long a quotation stays open for acceptance, from its date. Sets valid_until on new quotations and revisions.'),
  ('gst_rate_default', '18', 'GST % offered on a new quotation line when the service has none.'),
  ('company_name', 'Cetizion Verifica Pvt. Ltd.', 'Printed at the top of quotation PDFs.'),
  ('company_address', '', 'Printed under the company name on quotation PDFs.'),
  ('company_gstin', '', 'Printed on quotation PDFs.'),
  ('quotation_terms_default', 'Payment: 50% advance with the purchase order, 50% on delivery of the final report. Prices exclude GST unless stated. Valid until the date shown.', 'Terms printed on a new quotation; editable per quotation.')
ON CONFLICT (key) DO NOTHING;

-- A new quotation takes its validity and terms from Settings when none were typed.
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

CREATE TRIGGER quotation_defaults BEFORE INSERT ON quotations
  FOR EACH ROW EXECUTE FUNCTION quotation_defaults();

-- ---------------------------------------------------------------- pipeline
-- Stage and status agree, whichever one was changed. Moving to a stage sets
-- the status it maps to and takes the stage's probability unless one was
-- given with the move. Changing the status (the form, the importer, a
-- conversion) picks the default stage for it; sending a draft moves it to
-- Sent, and an acceptance moves an open one to Verbal yes.
CREATE OR REPLACE FUNCTION quotation_stage_sync() RETURNS trigger AS $$
DECLARE st pipeline_stages%ROWTYPE; stage_changed boolean; status_changed boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    stage_changed := NEW.stage_id IS NOT NULL;
    status_changed := NOT stage_changed;
  ELSE
    stage_changed := NEW.stage_id IS DISTINCT FROM OLD.stage_id AND NEW.stage_id IS NOT NULL;
    status_changed := NEW.stage_id IS NULL OR NEW.status IS DISTINCT FROM OLD.status;
  END IF;

  IF stage_changed THEN
    SELECT * INTO st FROM pipeline_stages WHERE id = NEW.stage_id;
    NEW.status := st.maps_to_status;
    IF TG_OP = 'INSERT' OR NEW.probability IS NOT DISTINCT FROM OLD.probability OR NEW.probability IS NULL THEN
      NEW.probability := st.probability;
    END IF;
  ELSIF status_changed THEN
    SELECT * INTO st FROM pipeline_stages ps
     WHERE ps.maps_to_status = NEW.status AND ps.active
     ORDER BY CASE
       WHEN NEW.status = 'Submitted' AND NEW.sent_at IS NOT NULL AND ps.name = 'Sent' THEN 0
       WHEN NEW.status = 'Under Negotiation' AND NEW.accepted_at IS NOT NULL AND ps.name = 'Verbal yes, awaiting PO' THEN 0
       ELSE 1 END, ps.sort_order
     LIMIT 1;
    IF st.id IS NOT NULL THEN
      NEW.stage_id := st.id;
      NEW.probability := st.probability;
    END IF;
  ELSE
    -- Same stage: a send or an acceptance can still move it forward.
    SELECT * INTO st FROM pipeline_stages WHERE id = NEW.stage_id;
    IF NEW.sent_at IS NOT NULL AND st.name = 'Draft' THEN
      SELECT * INTO st FROM pipeline_stages WHERE name = 'Sent';
      NEW.stage_id := st.id; NEW.probability := st.probability; stage_changed := true;
    ELSIF NEW.accepted_at IS NOT NULL AND st.name IN ('Draft', 'Sent', 'Negotiation') THEN
      SELECT * INTO st FROM pipeline_stages WHERE name = 'Verbal yes, awaiting PO';
      NEW.stage_id := st.id; NEW.status := st.maps_to_status; NEW.probability := st.probability; stage_changed := true;
    END IF;
  END IF;

  IF TG_OP = 'INSERT' OR NEW.stage_id IS DISTINCT FROM OLD.stage_id THEN
    NEW.stage_changed_at := now();
    IF st.type IN ('won', 'lost') THEN
      NEW.closed_at := COALESCE(NEW.closed_at, now());
    ELSE
      NEW.closed_at := NULL;
    END IF;
    -- Reopened: the reason it was lost no longer applies.
    IF st.type <> 'lost' THEN
      NEW.lost_reason_id := NULL;
      NEW.lost_notes := NULL;
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- Runs after the company link (a_) and before nothing else that matters: c_.
CREATE TRIGGER c_stage_sync BEFORE INSERT OR UPDATE ON quotations
  FOR EACH ROW EXECUTE FUNCTION quotation_stage_sync();

INSERT INTO settings (key, value, notes) VALUES
  ('quotation_expiry_grace_days', '14', 'Days after valid_until before a quotation sent from the tracker is marked lost as expired.')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------- companies
-- The grouping key the reports already use for free-text names.
CREATE OR REPLACE FUNCTION name_key(p_name text) RETURNS text AS $$
  SELECT NULLIF(lower(regexp_replace(btrim(p_name), '\s+', ' ', 'g')), '');
$$ LANGUAGE sql IMMUTABLE;

-- The company for a typed name: found by key, or created with that spelling.
CREATE OR REPLACE FUNCTION company_for(p_name text) RETURNS int AS $$
DECLARE k text; cid int;
BEGIN
  k := name_key(p_name);
  IF k IS NULL THEN RETURN NULL; END IF;
  SELECT id INTO cid FROM companies WHERE name_key = k;
  IF cid IS NULL THEN
    INSERT INTO companies (name, name_key) VALUES (regexp_replace(btrim(p_name), '\s+', ' ', 'g'), k)
      ON CONFLICT (name_key) DO UPDATE SET name = companies.name
      RETURNING id INTO cid;
  END IF;
  RETURN cid;
END $$ LANGUAGE plpgsql;

-- The contact of that name at a company: found or created.
CREATE OR REPLACE FUNCTION contact_for(p_company int, p_name text) RETURNS int AS $$
DECLARE k text; cid int;
BEGIN
  k := name_key(p_name);
  IF p_company IS NULL OR k IS NULL THEN RETURN NULL; END IF;
  SELECT id INTO cid FROM contacts WHERE company_id = p_company
    AND lower(regexp_replace(btrim(name), '\s+', ' ', 'g')) = k;
  IF cid IS NULL THEN
    INSERT INTO contacts (company_id, name) VALUES (p_company, regexp_replace(btrim(p_name), '\s+', ' ', 'g'))
      ON CONFLICT (company_id, lower(regexp_replace(btrim(name), '\s+', ' ', 'g'))) DO UPDATE SET name = contacts.name
      RETURNING id INTO cid;
  END IF;
  RETURN cid;
END $$ LANGUAGE plpgsql;

-- companies.name_key always follows companies.name.
CREATE OR REPLACE FUNCTION companies_set_key() RETURNS trigger AS $$
BEGIN
  NEW.name := regexp_replace(btrim(NEW.name), '\s+', ' ', 'g');
  NEW.name_key := name_key(NEW.name);
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- A renamed company renames the client on every record that points at it.
CREATE OR REPLACE FUNCTION companies_rename_records() RETURNS trigger AS $$
BEGIN
  IF NEW.name IS DISTINCT FROM OLD.name THEN
    UPDATE quotations SET client_name = NEW.name WHERE company_id = NEW.id;
    UPDATE enquiries  SET client_name = NEW.name WHERE company_id = NEW.id;
    UPDATE projects   SET client_name = NEW.name WHERE company_id = NEW.id;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- Records link to their company from client_name, and (where the record has
-- one) to their contact from contact_person. A company with no sector yet
-- takes the record's sector.
CREATE OR REPLACE FUNCTION link_company() RETURNS trigger AS $$
DECLARE rec jsonb; changed boolean;
BEGIN
  rec := to_jsonb(NEW);
  IF TG_OP = 'INSERT' THEN
    changed := true;
  ELSE
    changed := NEW.company_id IS NULL OR NEW.client_name IS DISTINCT FROM OLD.client_name;
  END IF;
  IF changed THEN
    NEW.company_id := company_for(NEW.client_name);
  END IF;
  IF NEW.company_id IS NOT NULL AND rec ? 'sector' AND name_key(rec->>'sector') IS NOT NULL THEN
    UPDATE companies SET sector = rec->>'sector' WHERE id = NEW.company_id AND name_key(sector) IS NULL;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION link_contact() RETURNS trigger AS $$
DECLARE changed boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    changed := true;
  ELSE
    changed := NEW.contact_id IS NULL
      OR NEW.contact_person IS DISTINCT FROM OLD.contact_person
      OR NEW.company_id IS DISTINCT FROM OLD.company_id;
  END IF;
  IF changed THEN
    NEW.contact_id := contact_for(NEW.company_id, NEW.contact_person);
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER companies_set_key BEFORE INSERT OR UPDATE ON companies
  FOR EACH ROW EXECUTE FUNCTION companies_set_key();
CREATE TRIGGER companies_rename_records AFTER UPDATE ON companies
  FOR EACH ROW EXECUTE FUNCTION companies_rename_records();

-- Trigger names sort a before b, so the company is linked before the contact.
CREATE TRIGGER a_link_company BEFORE INSERT OR UPDATE ON quotations FOR EACH ROW EXECUTE FUNCTION link_company();
CREATE TRIGGER b_link_contact BEFORE INSERT OR UPDATE ON quotations FOR EACH ROW EXECUTE FUNCTION link_contact();
CREATE TRIGGER a_link_company BEFORE INSERT OR UPDATE ON enquiries FOR EACH ROW EXECUTE FUNCTION link_company();
CREATE TRIGGER b_link_contact BEFORE INSERT OR UPDATE ON enquiries FOR EACH ROW EXECUTE FUNCTION link_contact();
CREATE TRIGGER a_link_company BEFORE INSERT OR UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION link_company();

-- ---------------------------------------------------------------- email and jobs
-- Every email composed, and every scheduled job run (see migrations/012_email_log.sql).
CREATE TABLE IF NOT EXISTS email_log (
  id                   serial PRIMARY KEY,
  to_email             text NOT NULL,
  cc                   text,
  subject              text NOT NULL,
  template             text NOT NULL,
  entity               text,
  entity_id            text,
  status               text NOT NULL DEFAULT 'queued'
                         CHECK (status IN ('queued','sent','failed','suppressed')),
  mode                 text,
  reason               text,
  provider_message_id  text,
  error                text,
  body_text            text,
  body_html            text,
  sent_by              text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  sent_at              timestamptz
);

CREATE INDEX IF NOT EXISTS email_log_entity_idx ON email_log (entity, entity_id);
CREATE INDEX IF NOT EXISTS email_log_created_idx ON email_log (created_at DESC);

CREATE TABLE IF NOT EXISTS job_runs (
  id           serial PRIMARY KEY,
  name         text NOT NULL,
  started_by   text NOT NULL DEFAULT 'schedule',
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  status       text NOT NULL DEFAULT 'running'
                 CHECK (status IN ('running','done','failed')),
  result       jsonb,
  error        text
);

CREATE INDEX IF NOT EXISTS job_runs_name_idx ON job_runs (name, started_at DESC);

INSERT INTO settings (key, value, notes) VALUES
  ('emails_enabled', 'true', 'Kill switch for every automatic email. Set to false to stop reminders and digests without changing the server.'),
  ('reminder_interval_days', '7', 'Days between payment reminders to the same client for the same overdue stage.'),
  ('reminder_grace_days', '3', 'Days after the due date before the first reminder goes out.')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------- bulk import
-- Holding area for uploaded sales sheets (see migrations/010_import_batches.sql).
CREATE TABLE IF NOT EXISTS import_batches (
  id            serial PRIMARY KEY,
  filename      text NOT NULL,
  sheet_name    text,
  status        text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','committed','failed')),
  uploaded_by   text,
  row_count     int NOT NULL DEFAULT 0,
  mapping       jsonb,                 -- column -> field mapping used
  rules         jsonb,                 -- the assumption rules applied
  summary       jsonb,                 -- counts per step, skipped reasons
  ai_model      text,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  committed_at  timestamptz
);

CREATE TABLE IF NOT EXISTS import_items (
  id              serial PRIMARY KEY,
  batch_id        int NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  step            text NOT NULL
                    CHECK (step IN ('quotation','project','purchase_order',
                                    'service','stage','invoice','receipt')),
  seq             int NOT NULL,        -- order within the batch
  source_row      int,                 -- S.No / row number in the sheet
  parent_item_id  int REFERENCES import_items(id) ON DELETE CASCADE,
  action          text NOT NULL DEFAULT 'create'
                    CHECK (action IN ('create','update','skip')),
  included        boolean NOT NULL DEFAULT true,
  payload         jsonb NOT NULL,      -- the record as it will be written
  flags           jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{level, code, message}]
  assumptions     jsonb NOT NULL DEFAULT '[]'::jsonb,   -- ["PO date assumed ..."]
  existing_ref    text,                -- matching live record, if any
  committed_ref   text,                -- id / key written on commit
  error           text,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS import_items_batch_idx ON import_items (batch_id, step, seq);

-- ---------------------------------------------------------------- people
-- The accounts records will belong to (see migrations/015_users.sql and
-- 016_session_version.sql).
-- `active` tells the two kinds of row apart: someone who signs in has an
-- email and a password hash, an attribution-only name from the old data
-- has neither. Whether this table is the lock depends on AUTH_MODE: in
-- `database` mode a sign-in is checked against these rows, and in the
-- default `shared` mode against AUTH_USERNAME / AUTH_PASSWORD instead.
-- The two never stand in for each other.
CREATE TABLE IF NOT EXISTS users (
  id             serial PRIMARY KEY,
  name           text NOT NULL,
  -- Null for an attribution-only row. Never a made-up address: a person
  -- who cannot sign in has no email here, and the partial index below
  -- lets any number of rows be in that state.
  email          text,
  password_hash  text,
  role           text NOT NULL DEFAULT 'sales'
                   CHECK (role IN ('admin','sales')),
  active         boolean NOT NULL DEFAULT true,
  -- Raised to end every session already signed for this user: a password
  -- reset, or the moment the account is switched off. A cookie carries the
  -- value it was signed with and is only honoured while the two agree.
  -- It only ever goes up, so reactivating an account never hands its old
  -- cookies back. See migrations/016_session_version.sql.
  session_version integer NOT NULL DEFAULT 1,
  last_login_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_name_not_blank  CHECK (btrim(name) <> ''),
  -- '' would satisfy "email IS NOT NULL" while being no address at all.
  CONSTRAINT users_email_not_blank CHECK (email IS NULL OR btrim(email) <> ''),
  CONSTRAINT users_password_hash_not_blank CHECK (password_hash IS NULL OR btrim(password_hash) <> ''),
  -- Only ever upwards: a lowered counter would revive cookies that were
  -- already revoked.
  CONSTRAINT users_session_version_positive CHECK (session_version >= 1),
  -- The invariant the application depends on: anyone who can sign in has
  -- something to sign in with. Enforced here rather than only in code, so
  -- a later importer, admin screen or hand-written UPDATE cannot skip it.
  CONSTRAINT users_active_needs_login CHECK (
    active = false OR (email IS NOT NULL AND password_hash IS NOT NULL)
  )
);

-- One account per address, however it was typed: A@Example.com and
-- a@example.com are the same person. Partial, so the attribution-only rows
-- (email IS NULL) are not compared with each other at all.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_key ON users (lower(email)) WHERE email IS NOT NULL;

CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
