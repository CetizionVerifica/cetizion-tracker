-- =====================================================================
--  CETIZION — Sales, Projects, Payments, Travel & Expenses
--  Schema. Mirrors the workbook: one table per "you type here" sheet.
--  Everything the workbook computed with formulas lives in views.sql.
-- =====================================================================

BEGIN;

DROP VIEW IF EXISTS v_quotations, v_projects, v_purchase_orders,
  v_payment_stages, v_travel_logs, v_travel_vendor_invoices,
  v_employee_expense_claims CASCADE;

DROP TABLE IF EXISTS users, notifications, engagements, collection_log, payments, attachments, notes, tasks, quotation_revisions, quotation_lines, email_log, job_runs, import_items, import_batches, employee_expense_claims, travel_vendor_invoices,
  travel_logs, onboarding_tasks, payment_stages, po_services,
  purchase_orders, projects, enquiries, lead_sources, quotations, pipeline_stages, lost_reasons, contacts, companies, expense_categories,
  travel_vendors, services, onboarding_template_lines, onboarding_templates,
  payment_terms_template_lines, payment_terms_templates, settings, exchange_rates, sequence_counters, documents CASCADE;

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

-- ---------------------------------------------------------------------
-- Templates (#26): payment schedules and onboarding checklists
-- ---------------------------------------------------------------------

CREATE TABLE payment_terms_templates (
  id          serial PRIMARY KEY,
  name        text NOT NULL UNIQUE,
  active      boolean NOT NULL DEFAULT true,
  is_default  boolean NOT NULL DEFAULT false,
  sort_order  int NOT NULL DEFAULT 0
);

CREATE TABLE payment_terms_template_lines (
  id              serial PRIMARY KEY,
  template_id     int NOT NULL REFERENCES payment_terms_templates(id) ON DELETE CASCADE,
  sort_order      int NOT NULL DEFAULT 0,
  stage_name      text NOT NULL,
  percent         numeric(5,2) NOT NULL CHECK (percent > 0 AND percent <= 100),
  trigger_event   text NOT NULL DEFAULT 'On PO Registration'
                    CHECK (trigger_event IN ('On PO Registration','On Delivery','On Milestone','Manual')),
  credit_days     int CHECK (credit_days >= 0),
  milestone_name  text
);

CREATE INDEX payment_terms_template_lines_template_idx ON payment_terms_template_lines (template_id, sort_order);

-- Seeded from what production already uses.
INSERT INTO payment_terms_templates (name, is_default, sort_order) VALUES
  ('50% on PO / 50% on delivery', true, 1),
  ('100% on delivery', false, 2),
  ('30% on PO / 70% on delivery', false, 3),
  ('20% on PO / 80% on delivery', false, 4)
ON CONFLICT (name) DO NOTHING;

INSERT INTO payment_terms_template_lines (template_id, sort_order, stage_name, percent, trigger_event)
SELECT t.id, l.sort_order, l.stage_name, l.percent, l.trigger_event
  FROM payment_terms_templates t
  JOIN (VALUES
    ('50% on PO / 50% on delivery', 1, 'Advance (50%)',     50, 'On PO Registration'),
    ('50% on PO / 50% on delivery', 2, 'On delivery (50%)', 50, 'On Delivery'),
    ('100% on delivery',            1, 'Full value (100%)', 100, 'On Delivery'),
    ('30% on PO / 70% on delivery', 1, 'Advance (30%)',     30, 'On PO Registration'),
    ('30% on PO / 70% on delivery', 2, 'On delivery (70%)', 70, 'On Delivery'),
    ('20% on PO / 80% on delivery', 1, 'Advance (20%)',     20, 'On PO Registration'),
    ('20% on PO / 80% on delivery', 2, 'On delivery (80%)', 80, 'On Delivery')
  ) AS l(template, sort_order, stage_name, percent, trigger_event) ON l.template = t.name
 WHERE NOT EXISTS (SELECT 1 FROM payment_terms_template_lines x WHERE x.template_id = t.id);

CREATE TABLE onboarding_templates (
  id          serial PRIMARY KEY,
  name        text NOT NULL UNIQUE,
  active      boolean NOT NULL DEFAULT true,
  is_default  boolean NOT NULL DEFAULT false,
  sort_order  int NOT NULL DEFAULT 0
);

CREATE TABLE onboarding_template_lines (
  id                serial PRIMARY KEY,
  template_id       int NOT NULL REFERENCES onboarding_templates(id) ON DELETE CASCADE,
  step_no           int NOT NULL,
  stage             text,
  step              text NOT NULL,
  owner_role        text,
  days_after_start  int
);

CREATE INDEX onboarding_template_lines_template_idx ON onboarding_template_lines (template_id, step_no);

INSERT INTO onboarding_templates (name, is_default, sort_order) VALUES ('Standard project lifecycle', true, 1)
ON CONFLICT (name) DO NOTHING;

INSERT INTO onboarding_template_lines (template_id, step_no, stage, step, owner_role, days_after_start)
SELECT t.id, l.step_no, l.stage, l.step, l.owner_role, l.days_after_start
  FROM onboarding_templates t
  JOIN (VALUES
    (1,  'Onboarding', 'Purchase order(s) received and registered in the PO Register', 'Sales', 0),
    (2,  'Onboarding', 'Services on each PO listed against the PO', 'Sales', 0),
    (3,  'Onboarding', 'Payment stages for each PO entered in the payment schedule', 'Finance', 1),
    (4,  'Onboarding', 'Finance raises the stage-1 (advance) invoice per the PO payment terms', 'Finance', 2),
    (5,  'Onboarding', 'Project manager and delivery team assigned', 'Delivery', 3),
    (6,  'Onboarding', 'Client kick-off meeting held; scope and delivery date confirmed', 'Delivery', 7),
    (7,  'Execution',  'Fieldwork / assessment / data collection completed', 'Delivery', 30),
    (8,  'Execution',  'Draft deliverable shared with client for review', 'Delivery', 45),
    (9,  'Delivery',   'Final deliverable / report / certificate issued to client', 'Delivery', 60),
    (10, 'Delivery',   'Finance raises the on-delivery stage invoice(s)', 'Finance', 61),
    (11, 'Closure',    'All stage invoices paid on time as per agreed terms - project closed', 'Finance', 90)
  ) AS l(step_no, stage, step, owner_role, days_after_start) ON t.name = 'Standard project lifecycle'
 WHERE NOT EXISTS (SELECT 1 FROM onboarding_template_lines x WHERE x.template_id = t.id);

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
  renewal_lead_days       int NOT NULL DEFAULT 60,
  onboarding_template_id    int REFERENCES onboarding_templates(id) ON DELETE SET NULL,
  payment_terms_template_id int REFERENCES payment_terms_templates(id) ON DELETE SET NULL
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
  -- Approvals (#46)
  discount_percent       numeric(5,2),
  approval_status        text NOT NULL DEFAULT 'not_needed'
                           CHECK (approval_status IN ('not_needed','pending','approved','rejected')),
  approval_reason        text,
  approval_requested_at  timestamptz,
  approval_requested_by  text,
  approval_decided_at    timestamptz,
  approved_by            text,
  approval_note          text,
  approved_discount_percent numeric(5,2),
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
-- Lead sources (#24)
-- ---------------------------------------------------------------------

CREATE TABLE lead_sources (
  id          serial PRIMARY KEY,
  name        text NOT NULL UNIQUE,
  active      boolean NOT NULL DEFAULT true,
  sort_order  int NOT NULL DEFAULT 0
);

INSERT INTO lead_sources (name, sort_order) VALUES
  ('Existing client', 1), ('Referral', 2), ('Website', 3), ('Inbound email or call', 4),
  ('Event or webinar', 5), ('Partner or certification body', 6), ('Outreach', 7), ('Other', 8)
ON CONFLICT (name) DO NOTHING;

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
  status             text NOT NULL DEFAULT 'New'
                       -- The words from before #24 are still accepted while a deploy
                       -- runs both containers: the old one writes them until the swap
                       -- completes. A later migration drops them.
                       CHECK (status IN ('New','Contacted','Qualified','Nurture','Converted','Unqualified',
                                        'In Progress','Declined','Won - Quotation Sent')),
  quotation_no       text REFERENCES quotations(quotation_no)
                       ON UPDATE CASCADE ON DELETE SET NULL,
  -- A lead (#24)
  source_id              int REFERENCES lead_sources(id) ON DELETE SET NULL,
  estimated_value        numeric(16,2),
  currency               text NOT NULL DEFAULT 'INR',
  expected_decision_date date,
  next_follow_up_at      date,
  first_responded_at     timestamptz,
  unqualified_reason_id  int REFERENCES lost_reasons(id) ON DELETE SET NULL,
  unqualified_notes      text,
  services_interested    text,
  notes                  text,
  converted_at           timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX enquiries_company_id_idx ON enquiries (company_id);
CREATE INDEX enquiries_follow_up_idx ON enquiries (next_follow_up_at);
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
                          CHECK (trigger_event IN ('On PO Registration','On Delivery','On Milestone','Manual')),
  stage_percent         numeric(6,4) NOT NULL CHECK (stage_percent > 0),
  invoice_no            text,
  invoice_date          date,
  document_id           int UNIQUE REFERENCES documents(id),
  amount_received       numeric(16,2) NOT NULL DEFAULT 0,
  payment_received_date date,
  reminder_sent_on      date,
  remarks               text,
  -- Per-stage terms and milestone triggers (#26)
  credit_days           int CHECK (credit_days >= 0),
  milestone_name        text,
  milestone_reached_on  date,
  -- Collections (#27)
  on_hold               boolean NOT NULL DEFAULT false,
  hold_reason           text,
  promise_to_pay_date   date,
  reminder_level        int NOT NULL DEFAULT 0,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (po_number, stage_no)
);

CREATE INDEX ON payment_stages (po_number);

-- ---------------------------------------------------------------------
-- Engagements: what a client holds and when it renews (#28)
-- ---------------------------------------------------------------------

CREATE TABLE engagements (
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

CREATE INDEX engagements_due_idx ON engagements (status, next_due_on);
CREATE INDEX engagements_company_idx ON engagements (company_id);
-- One engagement per delivered PO and service.
CREATE UNIQUE INDEX engagements_po_service_key ON engagements (po_number, service_name) WHERE po_number IS NOT NULL;


-- ---------------------------------------------------------------------
-- Payments and the chasing log (#27)
-- ---------------------------------------------------------------------

CREATE TABLE payments (
  id           serial PRIMARY KEY,
  stage_id     int NOT NULL REFERENCES payment_stages(id) ON DELETE CASCADE,
  amount       numeric(16,2) NOT NULL CHECK (amount >= 0),
  tds_amount   numeric(16,2) NOT NULL DEFAULT 0 CHECK (tds_amount >= 0),
  received_on  date NOT NULL,
  mode         text NOT NULL DEFAULT 'bank_transfer'
                 CHECK (mode IN ('bank_transfer','cheque','upi','cash','other')),
  reference    text,
  notes        text,
  recorded_by  text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX payments_stage_idx ON payments (stage_id, received_on);

-- The stage's received total and date follow its payments. TDS counts as
-- settled: the client paid it to the government on our behalf.
CREATE OR REPLACE FUNCTION payments_changed() RETURNS trigger AS $$
DECLARE sid int;
BEGIN
  sid := COALESCE(NEW.stage_id, OLD.stage_id);
  UPDATE payment_stages ps
     SET amount_received = COALESCE((SELECT SUM(amount + tds_amount) FROM payments WHERE stage_id = sid), 0),
         payment_received_date = (SELECT MAX(received_on) FROM payments WHERE stage_id = sid)
   WHERE ps.id = sid;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER payments_changed AFTER INSERT OR UPDATE OR DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION payments_changed();

-- The first receipt on a stage that already carries a received amount
-- (seeded, imported, or typed before receipts existed) first books that
-- amount as an opening receipt, so nothing already received is lost.
CREATE OR REPLACE FUNCTION payments_opening() RETURNS trigger AS $$
DECLARE cur record;
BEGIN
  IF NEW.notes = 'Opening balance from the stage' THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM payments WHERE stage_id = NEW.stage_id) THEN
    SELECT amount_received, payment_received_date INTO cur FROM payment_stages WHERE id = NEW.stage_id;
    IF cur.amount_received > 0 THEN
      INSERT INTO payments (stage_id, amount, received_on, mode, notes)
      VALUES (NEW.stage_id, cur.amount_received, COALESCE(cur.payment_received_date, CURRENT_DATE), 'other', 'Opening balance from the stage');
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER payments_opening BEFORE INSERT ON payments
  FOR EACH ROW EXECUTE FUNCTION payments_opening();

CREATE TABLE collection_log (
  id                   serial PRIMARY KEY,
  stage_id             int REFERENCES payment_stages(id) ON DELETE CASCADE,
  company_id           int REFERENCES companies(id) ON DELETE SET NULL,
  channel              text NOT NULL DEFAULT 'call' CHECK (channel IN ('email','call','whatsapp','meeting','note')),
  happened_at          timestamptz NOT NULL DEFAULT now(),
  by_whom              text,
  summary              text NOT NULL,
  promise_to_pay_date  date,
  next_action_on       date,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX collection_log_stage_idx ON collection_log (stage_id, happened_at DESC);
CREATE INDEX collection_log_company_idx ON collection_log (company_id, happened_at DESC);

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
      'travel_vendor_invoices','employee_expense_claims','settings','engagements']
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
DECLARE s numeric; t numeric; n int; gross numeric; disc numeric; threshold numeric; st text; approved_at numeric;
BEGIN
  SELECT COUNT(*), COALESCE(SUM(amount), 0), COALESCE(SUM(round(amount * gst_rate / 100, 2)), 0), COALESCE(SUM(round(qty * rate, 2)), 0)
    INTO n, s, t, gross FROM quotation_lines WHERE quotation_id = p_quotation;
  IF n = 0 THEN
    UPDATE quotations SET subtotal = NULL, tax_total = NULL, total = NULL, discount_percent = NULL,
           approval_status = CASE WHEN approval_status = 'pending' AND approval_reason IS NULL THEN 'not_needed' ELSE approval_status END
     WHERE id = p_quotation;
    RETURN;
  END IF;
  disc := CASE WHEN gross > 0 THEN round((gross - s) / gross * 100, 2) ELSE 0 END;
  threshold := setting_num('discount_approval_threshold_percent', 10);
  SELECT approval_status, approved_discount_percent INTO st, approved_at FROM quotations WHERE id = p_quotation;
  UPDATE quotations
     SET subtotal = s, tax_total = t, total = s + t, quotation_value = s + t, discount_percent = disc,
         approval_status = CASE
           -- Over the threshold needs a decision, and an approval covers
           -- only the discount it was given for: raising it asks again.
           -- This applies to hand-requested exceptions too.
           WHEN disc > threshold AND (st IN ('not_needed', 'rejected')
                OR (st = 'approved' AND disc > COALESCE(approved_at, -1))) THEN 'pending'
           -- otherwise an exception someone asked for by hand keeps its own state
           WHEN approval_reason IS NOT NULL THEN approval_status
           WHEN disc <= threshold AND st IN ('pending', 'rejected') THEN 'not_needed'
           ELSE approval_status END,
         approval_requested_at = CASE WHEN disc > threshold AND (st IN ('not_needed', 'rejected')
                OR (st = 'approved' AND disc > COALESCE(approved_at, -1))) THEN now() ELSE approval_requested_at END
   WHERE id = p_quotation;
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
    -- Same stage: a send or an acceptance made in this write moves it
    -- forward, and a revision (which clears both) moves it back. Only the
    -- change counts, so a card moved back by hand stays where it was put.
    SELECT * INTO st FROM pipeline_stages WHERE id = NEW.stage_id;
    IF NEW.accepted_at IS NOT NULL AND OLD.accepted_at IS NULL AND st.name IN ('Draft', 'Sent', 'Negotiation') THEN
      SELECT * INTO st FROM pipeline_stages WHERE name = 'Verbal yes, awaiting PO';
      NEW.stage_id := st.id; NEW.status := st.maps_to_status; NEW.probability := st.probability; stage_changed := true;
    ELSIF NEW.sent_at IS NOT NULL AND OLD.sent_at IS NULL AND st.name = 'Draft' THEN
      SELECT * INTO st FROM pipeline_stages WHERE name = 'Sent';
      NEW.stage_id := st.id; NEW.probability := st.probability; stage_changed := true;
    ELSIF NEW.accepted_at IS NULL AND OLD.accepted_at IS NOT NULL AND st.name = 'Verbal yes, awaiting PO' THEN
      SELECT * INTO st FROM pipeline_stages WHERE name = 'Negotiation';
      NEW.stage_id := st.id; NEW.status := st.maps_to_status; NEW.probability := st.probability; stage_changed := true;
    ELSIF NEW.sent_at IS NULL AND OLD.sent_at IS NOT NULL AND st.name = 'Sent' THEN
      SELECT * INTO st FROM pipeline_stages WHERE name = 'Draft';
      NEW.stage_id := st.id; NEW.probability := st.probability; stage_changed := true;
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
      NEW.competitor := NULL;
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

-- ---------------------------------------------------------------- enquiry stamps
-- Stamps: the first response, the conversion, and a default follow-up date.
CREATE OR REPLACE FUNCTION enquiry_stamps() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status = 'New' AND NEW.status <> 'New' AND NEW.first_responded_at IS NULL THEN
    NEW.first_responded_at := now();
  END IF;
  IF NEW.status = 'Converted' AND (TG_OP = 'INSERT' OR OLD.status <> 'Converted') THEN
    NEW.converted_at := COALESCE(NEW.converted_at, now());
  END IF;
  IF NEW.status IN ('Converted', 'Unqualified') THEN
    NEW.next_follow_up_at := NULL;
  ELSIF NEW.next_follow_up_at IS NULL AND (TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status) THEN
    NEW.next_follow_up_at := CURRENT_DATE + (setting_num('lead_follow_up_default_days', 3))::int;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER c_enquiry_stamps BEFORE INSERT OR UPDATE ON enquiries
  FOR EACH ROW EXECUTE FUNCTION enquiry_stamps();

INSERT INTO settings (key, value, notes) VALUES
  ('lead_first_response_hours', '24', 'Target hours from a new enquiry to the first contact. Enquiries past it are flagged.'),
  ('lead_follow_up_default_days', '3', 'Days ahead the next follow-up is set when an enquiry is created or moves stage without one.')
ON CONFLICT (key) DO NOTHING;

INSERT INTO settings (key, value, notes) VALUES
  ('discount_approval_threshold_percent', '10', 'A quotation discounted above this overall % waits for approval before it can be sent.'),
  ('approver_email', '', 'Who is emailed when a quotation needs approval. Blank: the finance email.')
ON CONFLICT (key) DO NOTHING;

INSERT INTO settings (key, value, notes) VALUES
  ('reminder_levels_days', '3,14,30', 'Days overdue at which the first, second and final reminders go out. After the final one, every reminder_interval_days.')
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

-- ---------------------------------------------------------------- activity (#22)
CREATE TABLE tasks (
  id            serial PRIMARY KEY,
  entity        text NOT NULL CHECK (entity IN ('company','contact','enquiry','quotation','project','purchase_order','payment_stage')),
  entity_id     text NOT NULL,
  title         text NOT NULL,
  description   text,
  due_at        date,
  status        text NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','in_progress','done')),
  priority      text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high')),
  type          text NOT NULL DEFAULT 'follow_up' CHECK (type IN ('call','email','meeting','follow_up','document','other')),
  assignee      text,
  created_by    text,
  completed_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX tasks_entity_idx ON tasks (entity, entity_id);
CREATE INDEX tasks_open_idx ON tasks (status, due_at) WHERE status <> 'done';

CREATE TABLE notes (
  id          serial PRIMARY KEY,
  entity      text NOT NULL CHECK (entity IN ('company','contact','enquiry','quotation','project','purchase_order','payment_stage')),
  entity_id   text NOT NULL,
  body        text NOT NULL,
  author      text,
  pinned      boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX notes_entity_idx ON notes (entity, entity_id, created_at DESC);

-- Many files per record, beside the single document field some records carry.
CREATE TABLE attachments (
  id           serial PRIMARY KEY,
  entity       text NOT NULL CHECK (entity IN ('company','contact','enquiry','quotation','project','purchase_order','payment_stage')),
  entity_id    text NOT NULL,
  document_id  int NOT NULL UNIQUE REFERENCES documents(id),
  label        text,
  uploaded_by  text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX attachments_entity_idx ON attachments (entity, entity_id);

-- A task marked done remembers when.
CREATE OR REPLACE FUNCTION task_stamps() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'done' AND (TG_OP = 'INSERT' OR OLD.status <> 'done') THEN
    NEW.completed_at := COALESCE(NEW.completed_at, now());
  ELSIF NEW.status <> 'done' THEN
    NEW.completed_at := NULL;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER task_stamps BEFORE INSERT OR UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION task_stamps();
CREATE TRIGGER tasks_set_updated_at BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER notes_set_updated_at BEFORE UPDATE ON notes FOR EACH ROW EXECUTE FUNCTION set_updated_at();

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
-- ---------------------------------------------------------------------
-- Notifications (#44)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
  id          serial PRIMARY KEY,
  username    text NOT NULL DEFAULT 'admin',
  kind        text NOT NULL,
  title       text NOT NULL,
  body        text,
  entity      text,
  entity_id   text,
  link        text,
  dedupe_key  text,
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (username, read_at, created_at DESC);
-- The same thing is not raised twice on the same day.
CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedupe_key ON notifications (dedupe_key) WHERE dedupe_key IS NOT NULL;

INSERT INTO settings (key, value, notes) VALUES
  ('digest_email', '', 'Where the daily digest goes. Blank: the finance email.'),
  ('quotation_expiry_warning_days', '7', 'Days before a quotation expires at which its owner is told.')
ON CONFLICT (key) DO NOTHING;

COMMIT;
