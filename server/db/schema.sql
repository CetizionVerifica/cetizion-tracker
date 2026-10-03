-- =====================================================================
--  CETIZION — Sales, Projects, Payments, Travel & Expenses
--  Schema. Mirrors the workbook: one table per "you type here" sheet.
--  Everything the workbook computed with formulas lives in views.sql.
-- =====================================================================

BEGIN;

DROP VIEW IF EXISTS v_quotations, v_projects, v_purchase_orders,
  v_payment_stages, v_travel_logs, v_travel_vendor_invoices, v_enquiries,
  v_employee_expense_claims CASCADE;

DROP TABLE IF EXISTS email_ai_calls, mailbox_invoice_backfills, email_invoice_decisions, mailbox_po_backfills, email_po_decisions, mailbox_enquiry_backfills, email_enquiry_decisions, sector_aliases, follow_up_cycles, sales_targets, ownership_history, holidays, user_sessions, auth_identities, saved_views, activity_log, users, backup_runs, auth_events, api_token_log, api_tokens, accounting_log, reconciliation_items, books_entries, accounting_mappings, portal_audit, portal_sessions, portal_links, webhook_deliveries, webhook_events, webhook_endpoints, visit_assignees, visits, staff_leave, staff, project_costs, canned_responses, inbox_conversations, inboxes, email_blocklist, email_messages, email_threads, mail_folders, connected_accounts, deliverables, quotation_acceptances, communications, notifications, engagements, collection_log, payments, attachments, notes, tasks, quotation_revisions, quotation_lines, email_log, job_runs, import_items, import_batches, employee_expense_claims, travel_vendor_invoices,
  travel_logs, onboarding_tasks, payment_stages, po_services,
  purchase_orders, projects, enquiries, lead_sources, quotations, pipeline_stages, lost_reasons, contacts, companies, expense_categories,
  travel_vendors, services, onboarding_template_lines, onboarding_templates,
  payment_terms_template_lines, payment_terms_templates, settings, exchange_rates, sequence_counters, documents, project_milestones, quotation_stage_history, task_targets CASCADE;

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

-- ---------------------------------------------------------------- holidays
-- Working days (#73): the days nobody at Cetizion works, so a date that
-- counts working days can skip them. Weekends are not listed; the helpers
-- in businessDate.ts already skip Saturday and Sunday.
CREATE TABLE holidays (
  id          serial PRIMARY KEY,
  holiday_on  date NOT NULL UNIQUE,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- India's gazetted holidays for Central Government offices at Delhi/New
-- Delhi, as published by DoPT: 2026 from O.M. F.No.12/2/2023-JCA of
-- 3 July 2025, 2027 from the O.M. of the same number of 16 July 2026. The
-- dates of Id-ul-Fitr, Id-ul-Zuha, Muharram and Milad-un-Nabi follow the
-- moon and can move; correct them in Settings → Holidays when they do.
-- Weekend holidays are kept so the list reads like the published one.
INSERT INTO holidays (holiday_on, name) VALUES
  ('2026-01-26', 'Republic Day'),
  ('2026-03-04', 'Holi'),
  ('2026-03-21', 'Id-ul-Fitr'),
  ('2026-03-26', 'Ram Navami'),
  ('2026-03-31', 'Mahavir Jayanti'),
  ('2026-04-03', 'Good Friday'),
  ('2026-05-01', 'Buddha Purnima'),
  ('2026-05-27', 'Id-ul-Zuha (Bakrid)'),
  ('2026-06-26', 'Muharram'),
  ('2026-08-15', 'Independence Day'),
  ('2026-08-26', 'Milad-un-Nabi'),
  ('2026-09-04', 'Janmashtami'),
  ('2026-10-02', 'Mahatma Gandhi''s Birthday'),
  ('2026-10-20', 'Dussehra'),
  ('2026-11-08', 'Diwali'),
  ('2026-11-24', 'Guru Nanak''s Birthday'),
  ('2026-12-25', 'Christmas Day'),
  ('2027-01-26', 'Republic Day'),
  ('2027-03-10', 'Id-ul-Fitr'),
  ('2027-03-23', 'Holi'),
  ('2027-03-26', 'Good Friday'),
  ('2027-04-15', 'Ram Navami'),
  ('2027-04-19', 'Mahavir Jayanti'),
  ('2027-05-17', 'Id-ul-Zuha (Bakrid)'),
  ('2027-05-20', 'Buddha Purnima'),
  ('2027-06-16', 'Muharram'),
  -- Two holidays on one day in 2027; one row, since a date is a holiday or not.
  ('2027-08-15', 'Independence Day; Milad-un-Nabi'),
  ('2027-08-25', 'Janmashtami'),
  ('2027-10-02', 'Mahatma Gandhi''s Birthday'),
  ('2027-10-09', 'Dussehra'),
  ('2027-10-29', 'Diwali'),
  ('2027-11-14', 'Guru Nanak''s Birthday'),
  ('2027-12-25', 'Christmas Day')
ON CONFLICT (holiday_on) DO NOTHING;

-- How far each reference series has got. A counter only ever goes up, so a
-- number that has been issued is never reissued once its record is deleted.
-- Empty on a fresh database; claimNextId also takes in the highest reference
-- already present, so a seeded or imported database numbers on from there.
CREATE TABLE sequence_counters (
  kind       text NOT NULL,
  -- A calendar year for five of the six series, and a financial year —
  -- '26-27' — for the invoice series, which runs April to March the way a
  -- GST invoice series has to.
  year       text NOT NULL CHECK (year ~ '^[0-9]{4}$' OR year ~ '^[0-9]{2}-[0-9]{2}$'),
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
  payment_terms_template_id int REFERENCES payment_terms_templates(id) ON DELETE SET NULL,
  -- The Reports section's service line for this entry (065). Blank: the
  -- name is matched against the keyword rules in lib/serviceLines.js.
  report_line               text
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
  ('Draft',                   10, 'open',   'Draft',             1, '#94a3b8', 14),
  ('Sent',                    40, 'open',   'Submitted',         2, '#38bdf8', 21),
  ('Negotiation',             60, 'open',   'Under Negotiation', 3, '#f59e0b', 21),
  ('Verbal yes, awaiting PO', 90, 'open',   'Under Negotiation', 4, '#22c55e', 30),
  ('On Hold',                 20, 'paused', 'On Hold',           5, '#a3a3a3', NULL),
  ('Won, PO received',       100, 'won',    'Won - PO Received', 6, '#16a34a', NULL),
  ('Lost',                     0, 'lost',   'Lost',              7, '#ef4444', NULL),
  ('Expired',                  0, 'lost',   'Lost',              8, '#9ca3af', NULL)
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
  portal_enabled boolean NOT NULL DEFAULT false,
  portal_sections text[] NOT NULL DEFAULT '{projects,documents,invoices,certificates,contact}',
  last_contacted_at timestamptz,
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
  whatsapp_number    text,
  preferred_channel  text,
  best_time_to_call  text,
  do_not_contact     boolean NOT NULL DEFAULT false,
  whatsapp_opt_in_at timestamptz,
  whatsapp_opt_in_source text,
  last_contacted_at  timestamptz,
  portal_access      boolean NOT NULL DEFAULT false,
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
  -- The salesperson responsible for this record (#18 Phase 2A). Null
  -- everywhere until Phase 2B decides the backfill; `sales_person` above
  -- stays the free-text name the reports group by. See
  -- migrations/059_record_ownership.sql. The foreign key is declared after
  -- the users table below, which is created later in this file.
  owner_user_id         int,
  originating_user_id          int,
  originating_user_snapshot_id int,
  originating_user_name        text,
  planned_start_date    date,
  planned_delivery_date date,
  estimated_cost        numeric(16,2) CHECK (estimated_cost >= 0),
  percent_complete      numeric(5,4) NOT NULL DEFAULT 0
                          CHECK (percent_complete BETWEEN 0 AND 1),
  remarks               text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX projects_company_id_idx ON projects (company_id);
-- Phase 2C filters these lists by owner, and the foreign key needs it
-- now: without it, deleting a user sequentially scans this table.
CREATE INDEX projects_owner_user_id_idx ON projects (owner_user_id);
CREATE INDEX projects_originating_user_id_idx ON projects (originating_user_id);

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
  -- The salesperson responsible for this record (#18 Phase 2A). Null
  -- everywhere until Phase 2B decides the backfill; `sales_person` above
  -- stays the free-text name the reports group by. See
  -- migrations/059_record_ownership.sql. The foreign key is declared after
  -- the users table below, which is created later in this file.
  owner_user_id      int,
  originating_user_id          int,
  originating_user_snapshot_id int,
  originating_user_name        text,
  quotation_date     date,
  quotation_value    numeric(16,2),
  currency           text NOT NULL DEFAULT 'INR',
  status             text NOT NULL DEFAULT 'Submitted'
                       CONSTRAINT quotations_status_check
                       CHECK (status IN ('Draft','Submitted','Under Negotiation',
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
  last_contacted_at      timestamptz,
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
-- Phase 2C filters these lists by owner, and the foreign key needs it
-- now: without it, deleting a user sequentially scans this table.
CREATE INDEX quotations_owner_user_id_idx ON quotations (owner_user_id);
CREATE INDEX quotations_originating_user_id_idx ON quotations (originating_user_id);
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
                       CHECK (status IN ('New','Contacted','Qualified','Nurture','Converted','Unqualified')),
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
  last_contacted_at      timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  -- The salesperson responsible for this record (#18 Phase 2A). Null
  -- everywhere until Phase 2B decides the backfill; `sales_person` above
  -- stays the free-text name the reports group by. See
  -- migrations/059_record_ownership.sql. The foreign key is declared after
  -- the users table below, which is created later in this file.
  --
  -- Last in this table, and deliberately so. v_enquiries is `SELECT e.*`,
  -- which records in the view's own definition the order the columns are in.
  -- ALTER TABLE can only append, so every database upgraded through 059 and
  -- 062 has these four here, at the end — and scripts/ci/check-migrations.sh
  -- compares the view a fresh schema.sql builds against the view an upgraded
  -- database has. Declaring them up beside sales_person, where they read
  -- best, builds a v_enquiries that no real database matches.
  --
  -- quotations and projects keep theirs beside sales_person because no view
  -- selects * from either of them.
  owner_user_id      int,
  originating_user_id          int,
  originating_user_snapshot_id int,
  originating_user_name        text
);

CREATE INDEX enquiries_company_id_idx ON enquiries (company_id);
CREATE INDEX enquiries_follow_up_idx ON enquiries (next_follow_up_at);
-- Phase 2C filters these lists by owner, and the foreign key needs it
-- now: without it, deleting a user sequentially scans this table.
CREATE INDEX enquiries_owner_user_id_idx ON enquiries (owner_user_id);
CREATE INDEX enquiries_originating_user_id_idx ON enquiries (originating_user_id);
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
  -- A revision names the PO it takes the place of; a cancelled PO will not
  -- go ahead. Either takes a PO out of the sales figures only (migration 051).
  replaces_po_number     text REFERENCES purchase_orders(po_number)
                           ON UPDATE CASCADE ON DELETE SET NULL,
  cancelled              boolean NOT NULL DEFAULT false,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT purchase_orders_not_replacing_itself CHECK (replaces_po_number <> po_number)
);

-- A PO is replaced by one revision at most; a later revision replaces that one.
CREATE UNIQUE INDEX purchase_orders_replaces_key
  ON purchase_orders (replaces_po_number) WHERE replaces_po_number IS NOT NULL;

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

-- A GST invoice series has to be unbroken and unrepeated for the company,
-- not merely unique within one order. Stages not yet invoiced hold NULL,
-- and NULLs do not collide.
--
-- Migration 046 adds this to an existing database only when its data
-- already satisfies it, because a number typed in by hand years ago may
-- be duplicated and a migration that throws stops the container.
CREATE UNIQUE INDEX payment_stages_invoice_no_key
  ON payment_stages (invoice_no) WHERE invoice_no IS NOT NULL;

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
  -- A receipt is positive. An adjustment � someone correcting a total that
  -- was typed too high � is a negative row, so the ledger still adds up to
  -- the figure on the stage. Writing the figure by hand instead left the
  -- correction to be undone by the next receipt.
  amount       numeric(16,2) NOT NULL,
  tds_amount   numeric(16,2) NOT NULL DEFAULT 0 CHECK (tds_amount >= 0),
  -- Nullable on purpose. The route before this one accepted an amount
  -- with no date, and those receipts are carried over as they are: a
  -- missing date stays missing rather than becoming the day of the deploy.
  received_on  date,
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
      VALUES (NEW.stage_id, cur.amount_received, cur.payment_received_date, 'other', 'Opening balance from the stage');
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
  created_at           timestamptz NOT NULL DEFAULT now(),
  -- Written by the payment-reminder job, not a person: not a follow-up.
  automated            boolean NOT NULL DEFAULT false
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
      'travel_vendor_invoices','employee_expense_claims','settings','engagements','exchange_rates',
      'sequence_counters']
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I_set_updated_at BEFORE UPDATE ON %I
         FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------- quotation totals
-- Totals follow the lines. With lines, quotation_value is the total; without
-- any, the typed quotation_value stands and the totals are blank — unless the
-- totals were read from a PDF (066), in which case those printed figures stand.
CREATE OR REPLACE FUNCTION quotation_totals(p_quotation int) RETURNS void AS $$
DECLARE s numeric; t numeric; n int; gross numeric; disc numeric; threshold numeric; st text; approved_at numeric;
        p_sub numeric; p_tax numeric; p_total numeric;
BEGIN
  SELECT COUNT(*), COALESCE(SUM(amount), 0), COALESCE(SUM(round(amount * gst_rate / 100, 2)), 0), COALESCE(SUM(round(qty * rate, 2)), 0)
    INTO n, s, t, gross FROM quotation_lines WHERE quotation_id = p_quotation;
  IF n = 0 THEN
    -- Read from the PDF we sent (docs/email-enquiries-plan.md §3.9.7): the
    -- printed totals stand until real lines replace them, and come back if
    -- those lines are all removed. Never blanked, never zero.
    SELECT d.printed_subtotal, d.printed_tax_total, d.printed_total INTO p_sub, p_tax, p_total
      FROM email_enquiry_decisions d JOIN quotations q ON q.quotation_no = d.quotation_no
     WHERE q.id = p_quotation AND d.quotation_extraction IN ('created','revised') AND d.printed_total IS NOT NULL
     ORDER BY d.decided_at DESC, d.id DESC LIMIT 1;
    IF FOUND THEN
      UPDATE quotations SET subtotal = p_sub, tax_total = p_tax, total = p_total, quotation_value = p_total, discount_percent = NULL,
             approval_status = CASE WHEN approval_status = 'pending' AND approval_reason IS NULL THEN 'not_needed' ELSE approval_status END
       WHERE id = p_quotation;
      RETURN;
    END IF;
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
-- Every stage move, with the loss it leaves or enters (#25).
CREATE TABLE quotation_stage_history (
  id              bigserial PRIMARY KEY,
  quotation_id    int NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  from_stage_id   int REFERENCES pipeline_stages(id) ON DELETE SET NULL,
  to_stage_id     int REFERENCES pipeline_stages(id) ON DELETE SET NULL,
  lost_reason_id  int REFERENCES lost_reasons(id) ON DELETE SET NULL,
  lost_notes      text,
  competitor      text,
  changed_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX quotation_stage_history_quotation_idx ON quotation_stage_history (quotation_id, changed_at);

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
      NEW.stage_id := st.id; NEW.status := st.maps_to_status; NEW.probability := st.probability; stage_changed := true;
    ELSIF NEW.accepted_at IS NULL AND OLD.accepted_at IS NOT NULL AND st.name = 'Verbal yes, awaiting PO' THEN
      SELECT * INTO st FROM pipeline_stages WHERE name = 'Negotiation';
      NEW.stage_id := st.id; NEW.status := st.maps_to_status; NEW.probability := st.probability; stage_changed := true;
    ELSIF NEW.sent_at IS NULL AND OLD.sent_at IS NOT NULL AND st.name = 'Sent' THEN
      SELECT * INTO st FROM pipeline_stages WHERE name = 'Draft';
      NEW.stage_id := st.id; NEW.status := st.maps_to_status; NEW.probability := st.probability; stage_changed := true;
    END IF;
  END IF;

  IF TG_OP = 'INSERT' OR NEW.stage_id IS DISTINCT FROM OLD.stage_id THEN
    NEW.stage_changed_at := now();
    -- Every move is kept (#25), with the loss it leaves or enters: a
    -- reopening clears the reason, notes and competitor from the quotation,
    -- and this is where they stay.
    IF TG_OP = 'UPDATE' THEN
      INSERT INTO quotation_stage_history (quotation_id, from_stage_id, to_stage_id, lost_reason_id, lost_notes, competitor)
      VALUES (NEW.id, OLD.stage_id, NEW.stage_id,
              CASE WHEN st.type = 'lost' THEN NEW.lost_reason_id ELSE OLD.lost_reason_id END,
              CASE WHEN st.type = 'lost' THEN NEW.lost_notes ELSE OLD.lost_notes END,
              CASE WHEN st.type = 'lost' THEN NEW.competitor ELSE OLD.competitor END);
    END IF;
    IF st.type IN ('won', 'lost') THEN
      NEW.closed_at := COALESCE(NEW.closed_at, now());
    ELSE
      NEW.closed_at := NULL;
    END IF;
    -- Reopened: the reason it was lost no longer applies to it; the history keeps it.
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
  ('reminder_levels_days', '3,14,30', 'Days overdue at which the first, second and final reminders go out. After the final one, it repeats at the interval below.')
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

-- Every record a task is on (#22); the task's own entity is its main one,
-- kept here by the trigger below.
CREATE TABLE task_targets (
  task_id    integer NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  entity     text NOT NULL CHECK (entity IN ('company','contact','enquiry','quotation','project','purchase_order','payment_stage')),
  entity_id  text NOT NULL,
  PRIMARY KEY (task_id, entity, entity_id)
);

CREATE INDEX task_targets_entity_idx ON task_targets (entity, entity_id);

-- A project's milestones, and the stages they trigger (#26).
CREATE TABLE project_milestones (
  id          serial PRIMARY KEY,
  project_id  text NOT NULL REFERENCES projects(project_id) ON UPDATE CASCADE ON DELETE CASCADE,
  name        text NOT NULL,
  target_date date,
  reached_on  date,
  sort_order  int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX project_milestones_name_idx ON project_milestones (project_id, lower(name));

ALTER TABLE payment_stages ADD COLUMN IF NOT EXISTS milestone_id int REFERENCES project_milestones(id) ON DELETE SET NULL;

CREATE INDEX payment_stages_milestone_idx ON payment_stages (milestone_id) WHERE milestone_id IS NOT NULL;

-- Reaching a milestone (or taking it back) is recorded once, on the
-- milestone, and every stage it triggers takes the date.
CREATE OR REPLACE FUNCTION milestone_reached() RETURNS trigger AS $$
BEGIN
  UPDATE payment_stages SET milestone_reached_on = NEW.reached_on
   WHERE milestone_id = NEW.id AND milestone_reached_on IS DISTINCT FROM NEW.reached_on;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER milestone_reached AFTER UPDATE OF reached_on ON project_milestones
  FOR EACH ROW EXECUTE FUNCTION milestone_reached();

CREATE TRIGGER project_milestones_set_updated_at BEFORE UPDATE ON project_milestones
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION task_main_target() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (OLD.entity, OLD.entity_id) IS DISTINCT FROM (NEW.entity, NEW.entity_id) THEN
    DELETE FROM task_targets WHERE task_id = NEW.id AND entity = OLD.entity AND entity_id = OLD.entity_id;
  END IF;
  INSERT INTO task_targets (task_id, entity, entity_id) VALUES (NEW.id, NEW.entity, NEW.entity_id)
    ON CONFLICT DO NOTHING;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER task_main_target AFTER INSERT OR UPDATE OF entity, entity_id ON tasks
  FOR EACH ROW EXECUTE FUNCTION task_main_target();

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

-- One-click contact and the touch log (#31)
CREATE TABLE IF NOT EXISTS communications (
  id                 serial PRIMARY KEY,
  channel            text NOT NULL CHECK (channel IN ('call','whatsapp','meeting','sms','email','other')),
  direction          text NOT NULL DEFAULT 'outbound' CHECK (direction IN ('inbound','outbound')),
  outcome            text CHECK (outcome IN ('connected','no_answer','left_message','wrong_number','sent','held')),
  entity             text NOT NULL CHECK (entity IN ('company','contact','enquiry','quotation','project','purchase_order','payment_stage')),
  entity_id          text NOT NULL,
  company_id         int REFERENCES companies(id) ON DELETE SET NULL,
  contact_id         int REFERENCES contacts(id) ON DELETE SET NULL,
  username           text,
  started_at         timestamptz NOT NULL DEFAULT now(),
  duration_seconds   int CHECK (duration_seconds >= 0),
  summary            text,
  attendees          text,
  next_step_task_id  int REFERENCES tasks(id) ON DELETE SET NULL,
  provider           text NOT NULL DEFAULT 'manual',
  provider_ref       text,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS communications_entity_idx ON communications (entity, entity_id, started_at DESC);
CREATE INDEX IF NOT EXISTS communications_company_idx ON communications (company_id, started_at DESC);

-- A touch moves "last contacted" forward on everything it concerns.
CREATE OR REPLACE FUNCTION communication_touch() RETURNS trigger AS $$
BEGIN
  IF NEW.outcome IN ('no_answer','wrong_number') THEN
    RETURN NEW;
  END IF;
  UPDATE contacts SET last_contacted_at = GREATEST(COALESCE(last_contacted_at, NEW.started_at), NEW.started_at) WHERE id = NEW.contact_id;
  UPDATE companies SET last_contacted_at = GREATEST(COALESCE(last_contacted_at, NEW.started_at), NEW.started_at) WHERE id = NEW.company_id;
  IF NEW.entity = 'quotation' THEN
    UPDATE quotations SET last_contacted_at = GREATEST(COALESCE(last_contacted_at, NEW.started_at), NEW.started_at) WHERE quotation_no = NEW.entity_id;
  ELSIF NEW.entity = 'enquiry' THEN
    UPDATE enquiries SET last_contacted_at = GREATEST(COALESCE(last_contacted_at, NEW.started_at), NEW.started_at),
                         first_responded_at = COALESCE(first_responded_at, NEW.started_at)
     WHERE enquiry_no = NEW.entity_id;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS communication_touch ON communications;
CREATE TRIGGER communication_touch AFTER INSERT ON communications FOR EACH ROW EXECUTE FUNCTION communication_touch();

INSERT INTO settings (key, value, notes) VALUES
  ('no_contact_days', '7', 'Open deals and overdue invoices with no touch for this many days are listed under "No contact".')
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
  -- What a person may change about themselves (C20, 049). Role, email and
  -- active are facts about their job and stay on the admin screens.
  phone          text,
  signature      text,
  time_zone      text,
  -- Which emails they want. {} means the defaults, so nobody is silently
  -- unsubscribed from everything by the column arriving.
  notify         jsonb NOT NULL DEFAULT '{}'::jsonb,
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

-- ----------------------------------------------------------- ownership
-- enquiries.owner_user_id, quotations.owner_user_id and
-- projects.owner_user_id, declared with their tables above and pointed at
-- users here because users is created further down this file than they are
-- (see migrations/059_record_ownership.sql).
--
-- ON DELETE SET NULL: deleting a leaver's account must not delete the
-- company's sales history, and must not be refused forever because they
-- once owned a quotation. The record stays and forgets the pointer.
--
-- No constraint ties ownership to users.active — somebody who has left
-- still owned what they owned. Whether an inactive user may be given
-- something new is an application rule, not a database one.
ALTER TABLE enquiries  ADD CONSTRAINT enquiries_owner_user_id_fkey
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE quotations ADD CONSTRAINT quotations_owner_user_id_fkey
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE projects   ADD CONSTRAINT projects_owner_user_id_fkey
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE enquiries  ADD CONSTRAINT enquiries_originating_user_id_fkey
  FOREIGN KEY (originating_user_id) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE quotations ADD CONSTRAINT quotations_originating_user_id_fkey
  FOREIGN KEY (originating_user_id) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE projects   ADD CONSTRAINT projects_originating_user_id_fkey
  FOREIGN KEY (originating_user_id) REFERENCES users(id) ON DELETE SET NULL;

-- Sign in with Microsoft 365 or Google (C18, 048). One person, several ways
-- in. Nothing here creates a person: an identity attaches to a users row an
-- admin has already added. users_active_needs_login above is deliberately
-- unchanged, so a linked provider is an extra door rather than the only one.
CREATE TABLE IF NOT EXISTS auth_identities (
  id            serial PRIMARY KEY,
  user_id       integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider      text NOT NULL CHECK (provider IN ('microsoft', 'google')),
  -- The provider's immutable id for the person. Email can change; this
  -- cannot, so it is what a returning sign-in is matched on.
  subject       text NOT NULL CHECK (btrim(subject) <> ''),
  email         text,
  linked_at     timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS auth_identities_subject_idx ON auth_identities (provider, subject);
CREATE UNIQUE INDEX IF NOT EXISTS auth_identities_user_provider_idx ON auth_identities (user_id, provider);

-- Sessions you can see and end (C20, 049). The cookie still proves who
-- somebody is; this row is what can be taken away, which is what makes
-- "sign out that phone" a real button rather than a list nobody can act on.
CREATE TABLE IF NOT EXISTS user_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  via           text NOT NULL DEFAULT 'password' CHECK (via IN ('password', 'microsoft', 'google')),
  user_agent    text,
  ip            text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz
);
CREATE INDEX IF NOT EXISTS user_sessions_user_idx ON user_sessions (user_id, last_seen_at DESC);

-- ---------------------------------------------------------------------
-- Notifications (#44)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
  id          serial PRIMARY KEY,
  -- NULL means everyone: a failed backup or an overdue invoice is not one
  -- person's. A name here is matched against the reader's account name as
  -- well as their sign-in address.
  username    text,
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

-- #44: cleared by acting on the record, and emailed once.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS resolved_at timestamptz;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS emailed_at timestamptz;

CREATE INDEX IF NOT EXISTS notifications_open_entity_idx ON notifications (entity, entity_id) WHERE resolved_at IS NULL;

-- Who has read what. A notification addressed to nobody is everyone's, and
-- a single read_at on a shared row would mean the first person to look
-- cleared it for the whole team. Read state belongs to the reader, so it
-- lives here rather than on the row. read_at on the row survives for the
-- digest, which asks whether anyone has seen a thing at all.
CREATE TABLE IF NOT EXISTS notification_reads (
  notification_id int NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  reader          text NOT NULL,
  read_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (notification_id, reader)
);

CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (username, read_at, created_at DESC);
-- The same thing is not raised twice on the same day.
CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedupe_key ON notifications (dedupe_key) WHERE dedupe_key IS NOT NULL;

INSERT INTO settings (key, value, notes) VALUES
  ('digest_email', '', 'Where the daily digest goes. Blank: the finance email.'),
  ('quotation_expiry_warning_days', '7', 'Days before a quotation expires at which its owner is told.')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------
-- Client acceptance links (#53)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS quotation_acceptances (
  id                 serial PRIMARY KEY,
  quotation_id       int NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  revision           int NOT NULL DEFAULT 0,
  token_hash         text NOT NULL UNIQUE,
  sent_to            text,
  status             text NOT NULL DEFAULT 'sent'
                       CHECK (status IN ('sent','viewed','accepted','changes_requested','expired','revoked')),
  expires_at         timestamptz NOT NULL,
  viewed_at          timestamptz,
  view_count         int NOT NULL DEFAULT 0,
  decided_at         timestamptz,
  decided_by_name    text,
  decided_by_email   text,
  comments           text,
  ip                 text,
  user_agent         text,
  snapshot           jsonb,
  pdf_sha256         text,
  pdf_document_id    int REFERENCES documents(id),
  created_by         text,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS quotation_acceptances_quotation_idx ON quotation_acceptances (quotation_id, created_at DESC);

INSERT INTO settings (key, value, notes) VALUES
  ('public_app_url', '', 'The address clients use to open acceptance links, e.g. https://tracker.cetizionverifica.com. Blank: the address the app was opened on.'),
  ('acceptance_unviewed_days', '3', 'Days after which an unopened acceptance link is flagged to the owner.')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------
-- Certificates and deliverables (#43)
-- ---------------------------------------------------------------------
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

-- ---------------------------------------------------------------------
-- Connected mailboxes (#29)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS connected_accounts (
  id                 serial PRIMARY KEY,
  username           text NOT NULL,
  provider           text NOT NULL DEFAULT 'microsoft' CHECK (provider IN ('microsoft','imap','test')),
  email              text NOT NULL,
  display_name       text,
  is_shared          boolean NOT NULL DEFAULT false,
  tokens_encrypted   text,
  token_expires_at   timestamptz,
  scopes             text,
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active','needs_reconnect','disconnected')),
  visibility         text NOT NULL DEFAULT 'metadata' CHECK (visibility IN ('metadata','subject','share_everything')),
  import_days        int NOT NULL DEFAULT 30 CHECK (import_days BETWEEN 0 AND 365),
  exclude_internal   boolean NOT NULL DEFAULT true,
  auto_create_contacts boolean NOT NULL DEFAULT true,
  last_synced_at     timestamptz,
  last_error         text,
  -- When its past mail was last read through for enquiries, and for POs.
  -- Kept across a re-run, so the next reader is not held back (069).
  past_enquiries_read_at timestamptz,
  past_pos_read_at   timestamptz,
  -- The owner of a personal mailbox (074, docs/per-user-mailboxes-plan.md):
  -- its records belong to this user, and only they see its mail. Null for
  -- a shared mailbox, or when the owner could not be determined. `username`
  -- is the older, string-matched record of the same thing; nothing new reads it.
  user_id            int REFERENCES users(id) ON DELETE SET NULL,
  connected_by       int REFERENCES users(id) ON DELETE SET NULL,
  -- Which folders the email readers read: every folder (073) or Inbox and
  -- Sent Items only. Personal mailboxes start on inbox_sent.
  read_scope         text NOT NULL DEFAULT 'all' CHECK (read_scope IN ('all','inbox_sent')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT connected_accounts_shared_unowned CHECK (NOT (is_shared AND user_id IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS connected_accounts_email_key ON connected_accounts (lower(email)) WHERE status <> 'disconnected';
CREATE INDEX IF NOT EXISTS connected_accounts_user_idx ON connected_accounts (user_id) WHERE status <> 'disconnected';

CREATE TABLE IF NOT EXISTS mail_folders (
  id                        serial PRIMARY KEY,
  account_id                int NOT NULL REFERENCES connected_accounts(id) ON DELETE CASCADE,
  -- 'inbox', 'sentitems', or the provider's id of any other folder (073).
  folder                    text NOT NULL,
  delta_link                text,
  subscription_id           text,
  subscription_client_state text,
  subscription_expires_at   timestamptz,
  UNIQUE (account_id, folder)
);

CREATE TABLE IF NOT EXISTS email_threads (
  id               serial PRIMARY KEY,
  account_id       int NOT NULL REFERENCES connected_accounts(id) ON DELETE CASCADE,
  conversation_id  text NOT NULL,
  subject          text,
  company_id       int REFERENCES companies(id) ON DELETE SET NULL,
  contact_id       int REFERENCES contacts(id) ON DELETE SET NULL,
  entity           text CHECK (entity IN ('enquiry','quotation','project','purchase_order','payment_stage')),
  entity_id        text,
  first_message_at timestamptz,
  last_message_at  timestamptz,
  message_count    int NOT NULL DEFAULT 0,
  last_direction   text CHECK (last_direction IN ('inbound','outbound')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, conversation_id)
);

CREATE INDEX IF NOT EXISTS email_threads_company_idx ON email_threads (company_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS email_threads_entity_idx ON email_threads (entity, entity_id);

CREATE TABLE IF NOT EXISTS email_messages (
  id                   serial PRIMARY KEY,
  account_id           int NOT NULL REFERENCES connected_accounts(id) ON DELETE CASCADE,
  thread_id            int NOT NULL REFERENCES email_threads(id) ON DELETE CASCADE,
  provider_id          text NOT NULL,
  internet_message_id  text,
  direction            text NOT NULL CHECK (direction IN ('inbound','outbound')),
  from_email           text,
  from_name            text,
  to_emails            text[] NOT NULL DEFAULT '{}',
  cc_emails            text[] NOT NULL DEFAULT '{}',
  subject              text,
  snippet              text,
  body_html            text,
  has_attachments      boolean NOT NULL DEFAULT false,
  sent_at              timestamptz NOT NULL,
  company_id           int REFERENCES companies(id) ON DELETE SET NULL,
  contact_id           int REFERENCES contacts(id) ON DELETE SET NULL,
  sent_from_tracker_by text,
  -- Kept only because its mailbox feeds an Inbox: the filter that would
  -- have dropped it ('internal only', 'blocked sender'), else NULL.
  filtered_as          text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, provider_id)
);

CREATE INDEX IF NOT EXISTS email_messages_thread_idx ON email_messages (thread_id, sent_at);
CREATE INDEX IF NOT EXISTS email_messages_internet_message_idx ON email_messages (account_id, lower(internet_message_id)) WHERE internet_message_id IS NOT NULL;

-- Addresses and domains never synced (newsletters, personal contacts).
CREATE TABLE IF NOT EXISTS email_blocklist (
  id          serial PRIMARY KEY,
  pattern     text NOT NULL UNIQUE,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS connected_accounts_set_updated_at ON connected_accounts;
CREATE TRIGGER connected_accounts_set_updated_at BEFORE UPDATE ON connected_accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A client email moves "last contacted" forward, like a logged touch (#31).
CREATE OR REPLACE FUNCTION email_message_touch() RETURNS trigger AS $$
DECLARE t email_threads%ROWTYPE;
BEGIN
  UPDATE contacts SET last_contacted_at = GREATEST(COALESCE(last_contacted_at, NEW.sent_at), NEW.sent_at) WHERE id = NEW.contact_id;
  UPDATE companies SET last_contacted_at = GREATEST(COALESCE(last_contacted_at, NEW.sent_at), NEW.sent_at) WHERE id = NEW.company_id;
  SELECT * INTO t FROM email_threads WHERE id = NEW.thread_id;
  IF t.entity = 'quotation' THEN
    UPDATE quotations SET last_contacted_at = GREATEST(COALESCE(last_contacted_at, NEW.sent_at), NEW.sent_at) WHERE quotation_no = t.entity_id;
  ELSIF t.entity = 'enquiry' THEN
    UPDATE enquiries SET last_contacted_at = GREATEST(COALESCE(last_contacted_at, NEW.sent_at), NEW.sent_at),
                         first_responded_at = CASE WHEN NEW.direction = 'outbound' THEN COALESCE(first_responded_at, NEW.sent_at) ELSE first_responded_at END
     WHERE enquiry_no = t.entity_id;
  END IF;
  UPDATE email_threads SET message_count = message_count + 1,
         first_message_at = LEAST(COALESCE(first_message_at, NEW.sent_at), NEW.sent_at),
         last_message_at = GREATEST(COALESCE(last_message_at, NEW.sent_at), NEW.sent_at),
         last_direction = CASE WHEN last_message_at IS NULL OR NEW.sent_at >= last_message_at THEN NEW.direction ELSE last_direction END
   WHERE id = NEW.thread_id;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS email_message_touch ON email_messages;
CREATE TRIGGER email_message_touch AFTER INSERT ON email_messages FOR EACH ROW EXECUTE FUNCTION email_message_touch();

INSERT INTO settings (key, value, notes) VALUES
  ('internal_email_domains', 'cetizionverifica.com', 'Our own email domains, comma separated. Mail only between these addresses is never synced.')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------
-- Shared sales inbox (#30)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inboxes (
  id                    serial PRIMARY KEY,
  name                  text NOT NULL,
  account_id            int NOT NULL UNIQUE REFERENCES connected_accounts(id) ON DELETE CASCADE,
  default_assignment    text NOT NULL DEFAULT 'owner_of_company'
                          CHECK (default_assignment IN ('owner_of_company','round_robin','unassigned')),
  members               text[] NOT NULL DEFAULT '{}',
  round_robin_last      text,
  first_response_hours  int,
  signature             text,
  active                boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS inbox_conversations (
  id                 serial PRIMARY KEY,
  inbox_id           int NOT NULL REFERENCES inboxes(id) ON DELETE CASCADE,
  thread_id          int NOT NULL UNIQUE REFERENCES email_threads(id) ON DELETE CASCADE,
  company_id         int REFERENCES companies(id) ON DELETE SET NULL,
  contact_id         int REFERENCES contacts(id) ON DELETE SET NULL,
  from_email         text,
  from_name          text,
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open','pending_client','snoozed','closed')),
  assignee           text,
  priority           text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high')),
  labels             text[] NOT NULL DEFAULT '{}',
  last_inbound_at    timestamptz,
  first_response_at  timestamptz,
  response_due_at    timestamptz,
  snoozed_until      timestamptz,
  closed_at          timestamptz,
  enquiry_no         text REFERENCES enquiries(enquiry_no) ON UPDATE CASCADE ON DELETE SET NULL,
  -- Whether anybody has opened it yet, and who first did. Recorded once
  -- for the team rather than per person: in a shared inbox the cost being
  -- avoided is two people answering the same client, so what matters is
  -- that somebody has seen it. "No owner" is a different fact — a thread
  -- can be read and left deliberately unassigned.
  first_opened_at    timestamptz,
  first_opened_by    text,
  -- The filter that would have dropped it ('internal only', 'blocked sender'),
  -- NULL for client mail. Shown, but no reply clock, notification or enquiry.
  filtered_as        text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS inbox_conversations_queue_idx ON inbox_conversations (inbox_id, status, response_due_at);
CREATE INDEX IF NOT EXISTS inbox_conversations_assignee_idx ON inbox_conversations (assignee, status);

CREATE TABLE IF NOT EXISTS canned_responses (
  id          serial PRIMARY KEY,
  name        text NOT NULL,
  body        text NOT NULL,
  owner       text,
  shared      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS inboxes_set_updated_at ON inboxes;
CREATE TRIGGER inboxes_set_updated_at BEFORE UPDATE ON inboxes FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS inbox_conversations_set_updated_at ON inbox_conversations;
CREATE TRIGGER inbox_conversations_set_updated_at BEFORE UPDATE ON inbox_conversations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS canned_responses_set_updated_at ON canned_responses;
CREATE TRIGGER canned_responses_set_updated_at BEFORE UPDATE ON canned_responses FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO canned_responses (name, body, shared)
SELECT v.name, v.body, true FROM (VALUES
  ('Thanks, we will revert', E'Dear {{contact_name}},

Thank you for writing to Cetizion Verifica. We have noted your requirement and {{my_name}} will get back to you within one working day.

Regards,
{{my_name}}'),
  ('Request details for a quote', E'Dear {{contact_name}},

Thank you for your enquiry. To prepare a quotation, could you share the number of sites, the standards in scope and your preferred timeline?

Regards,
{{my_name}}')
) AS v(name, body)
WHERE NOT EXISTS (SELECT 1 FROM canned_responses c WHERE c.name = v.name);

-- ---------------------------------------------------------------------
-- Project costs (#39)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS project_costs (
  id           serial PRIMARY KEY,
  project_id   text NOT NULL REFERENCES projects(project_id) ON UPDATE CASCADE ON DELETE CASCADE,
  po_number    text REFERENCES purchase_orders(po_number) ON UPDATE CASCADE ON DELETE SET NULL,
  category     text NOT NULL DEFAULT 'subcontractor'
                 CHECK (category IN ('subcontractor','auditor_fee','certification_body','lab_testing','travel','accommodation','materials','other')),
  description  text NOT NULL,
  vendor       text,
  amount       numeric(16,2) CHECK (amount >= 0),
  currency     text NOT NULL DEFAULT 'INR',
  incurred_on  date,
  status       text NOT NULL DEFAULT 'committed' CHECK (status IN ('committed','paid')),
  document_id  int REFERENCES documents(id),
  source       text NOT NULL DEFAULT 'manual',
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS project_costs_project_idx ON project_costs (project_id);

DROP TRIGGER IF EXISTS project_costs_set_updated_at ON project_costs;
CREATE TRIGGER project_costs_set_updated_at BEFORE UPDATE ON project_costs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO settings (key, value, notes) VALUES
  ('margin_alert_percent', '20', 'Projects with a margin below this percentage are flagged red.'),
  ('cost_alert_share_percent', '80', 'When a project''s costs pass this share of its PO value, its manager gets a task.')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------
-- Visits and availability (#42)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS staff (
  id            serial PRIMARY KEY,
  name          text NOT NULL,
  email         text,
  role          text,
  working_days  int[] NOT NULL DEFAULT '{1,2,3,4,5,6}',   -- ISO weekdays, Monday = 1
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS staff_name_key ON staff (lower(btrim(name)));

CREATE TABLE IF NOT EXISTS staff_leave (
  id          serial PRIMARY KEY,
  staff_id    int NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  starts_on   date NOT NULL,
  ends_on     date NOT NULL,
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on >= starts_on)
);

CREATE INDEX IF NOT EXISTS staff_leave_idx ON staff_leave (staff_id, starts_on, ends_on);

CREATE TABLE IF NOT EXISTS visits (
  id                  serial PRIMARY KEY,
  project_id          text REFERENCES projects(project_id) ON UPDATE CASCADE ON DELETE CASCADE,
  po_number           text REFERENCES purchase_orders(po_number) ON UPDATE CASCADE ON DELETE SET NULL,
  company_id          int REFERENCES companies(id) ON DELETE SET NULL,
  contact_id          int REFERENCES contacts(id) ON DELETE SET NULL,
  type                text NOT NULL DEFAULT 'audit' CHECK (type IN ('audit','assessment','training','meeting','follow_up')),
  title               text NOT NULL,
  starts_at           timestamptz NOT NULL,
  ends_at             timestamptz NOT NULL,
  all_day             boolean NOT NULL DEFAULT true,
  location            text,
  city                text,
  state               text,
  status              text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','confirmed','done','cancelled','rescheduled')),
  milestone_stage_id  int REFERENCES payment_stages(id) ON DELETE SET NULL,
  travel_id           text REFERENCES travel_logs(travel_id) ON UPDATE CASCADE ON DELETE SET NULL,
  notify_client       boolean NOT NULL DEFAULT false,
  reminder_sent_at    timestamptz,
  confirmed_at        timestamptz,
  completed_at        timestamptz,
  notes               text,
  created_by          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at >= starts_at)
);

CREATE INDEX IF NOT EXISTS visits_when_idx ON visits (starts_at, ends_at);
CREATE INDEX IF NOT EXISTS visits_project_idx ON visits (project_id);

CREATE TABLE IF NOT EXISTS visit_assignees (
  visit_id  int NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
  staff_id  int NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  role      text NOT NULL DEFAULT 'member' CHECK (role IN ('lead','member')),
  PRIMARY KEY (visit_id, staff_id)
);

CREATE INDEX IF NOT EXISTS visit_assignees_staff_idx ON visit_assignees (staff_id);

DROP TRIGGER IF EXISTS staff_set_updated_at ON staff;
CREATE TRIGGER staff_set_updated_at BEFORE UPDATE ON staff FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS visits_set_updated_at ON visits;
CREATE TRIGGER visits_set_updated_at BEFORE UPDATE ON visits FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The client, contact and stamps follow the project and the status.
CREATE OR REPLACE FUNCTION visit_defaults() RETURNS trigger AS $$
BEGIN
  IF NEW.project_id IS NULL AND NEW.po_number IS NOT NULL THEN
    SELECT project_id INTO NEW.project_id FROM purchase_orders WHERE po_number = NEW.po_number;
  END IF;
  IF NEW.company_id IS NULL AND NEW.project_id IS NOT NULL THEN
    SELECT company_id INTO NEW.company_id FROM projects WHERE project_id = NEW.project_id;
  END IF;
  IF NEW.status = 'confirmed' AND (TG_OP = 'INSERT' OR OLD.status <> 'confirmed') THEN
    NEW.confirmed_at := COALESCE(NEW.confirmed_at, now());
  END IF;
  IF NEW.status = 'done' THEN
    NEW.completed_at := COALESCE(NEW.completed_at, now());
  ELSE
    NEW.completed_at := NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.starts_at IS DISTINCT FROM OLD.starts_at) THEN
    NEW.reminder_sent_at := NULL;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS a_visit_defaults ON visits;
CREATE TRIGGER a_visit_defaults BEFORE INSERT OR UPDATE ON visits FOR EACH ROW EXECUTE FUNCTION visit_defaults();

-- Completing a visit reaches its milestone; the stage becomes invoiceable.
CREATE OR REPLACE FUNCTION visit_milestone() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'done' AND NEW.milestone_stage_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD.status <> 'done' OR OLD.milestone_stage_id IS DISTINCT FROM NEW.milestone_stage_id) THEN
    UPDATE payment_stages
       SET milestone_reached_on = COALESCE(milestone_reached_on, (NEW.ends_at AT TIME ZONE 'Asia/Kolkata')::date)
     WHERE id = NEW.milestone_stage_id;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS b_visit_milestone ON visits;
CREATE TRIGGER b_visit_milestone AFTER INSERT OR UPDATE ON visits FOR EACH ROW EXECUTE FUNCTION visit_milestone();

-- Everyone who has run a project or a trip is a starting list of people.
INSERT INTO staff (name)
SELECT DISTINCT btrim(n) FROM (
  SELECT project_manager AS n FROM projects
  UNION SELECT employee_name FROM travel_logs
) x
WHERE n IS NOT NULL AND btrim(n) <> ''
ON CONFLICT DO NOTHING;

INSERT INTO settings (key, value, notes) VALUES
  ('visit_reminder_days', '1', 'Days before a visit at which the team (and, if chosen, the client) are reminded.')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------
-- Outgoing webhooks (#49)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id                     serial PRIMARY KEY,
  name                   text NOT NULL,
  url                    text NOT NULL,
  events                 text[] NOT NULL DEFAULT '{}',
  secret                 text NOT NULL,
  min_value              numeric(16,2),
  sector                 text,
  include_personal_data  boolean NOT NULL DEFAULT false,
  active                 boolean NOT NULL DEFAULT true,
  when_inactive          text NOT NULL DEFAULT 'queue' CHECK (when_inactive IN ('queue','drop')),
  created_by             text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id             bigserial PRIMARY KEY,
  event          text NOT NULL,
  entity         text,
  entity_id      text,
  value          numeric(16,2),
  company_id     int,
  data           jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  dispatched_at  timestamptz
);

CREATE INDEX IF NOT EXISTS webhook_events_pending_idx ON webhook_events (id) WHERE dispatched_at IS NULL;

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id                bigserial PRIMARY KEY,
  endpoint_id       int NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  event_id          bigint NOT NULL REFERENCES webhook_events(id) ON DELETE CASCADE,
  idempotency_key   text NOT NULL UNIQUE,
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','held','succeeded','failed')),
  attempts          int NOT NULL DEFAULT 0,
  next_attempt_at   timestamptz NOT NULL DEFAULT now(),
  last_status_code  int,
  last_response     text,
  last_error        text,
  delivered_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (endpoint_id, event_id)
);

CREATE INDEX IF NOT EXISTS webhook_deliveries_due_idx ON webhook_deliveries (next_attempt_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS webhook_deliveries_endpoint_idx ON webhook_deliveries (endpoint_id, created_at DESC);

DROP TRIGGER IF EXISTS webhook_endpoints_set_updated_at ON webhook_endpoints;
CREATE TRIGGER webhook_endpoints_set_updated_at BEFORE UPDATE ON webhook_endpoints FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Record one event, if anyone listens, and wake the worker.
CREATE OR REPLACE FUNCTION webhook_emit(p_event text, p_entity text, p_entity_id text, p_value numeric, p_company int, p_data jsonb)
RETURNS void AS $$
BEGIN
  -- A PO or invoice registered from past mail is not news (067,
  -- docs/email-po-plan.md §3.8): the history path turns this on for its
  -- own transaction.
  IF current_setting('app.suppress_webhooks', true) = 'on' THEN
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM webhook_endpoints WHERE (active OR when_inactive = 'queue') AND p_event = ANY(events)) THEN
    RETURN;
  END IF;
  INSERT INTO webhook_events (event, entity, entity_id, value, company_id, data)
  VALUES (p_event, p_entity, p_entity_id, p_value, p_company, COALESCE(p_data, '{}'::jsonb));
  PERFORM pg_notify('webhook_events', p_event);
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION webhook_quotation_events() RETURNS trigger AS $$
DECLARE st pipeline_stages%ROWTYPE; d jsonb;
BEGIN
  d := jsonb_build_object('quotation_no', NEW.quotation_no, 'client_name', NEW.client_name, 'company_id', NEW.company_id,
         'service', NEW.service_quoted, 'status', NEW.status, 'value', NEW.quotation_value, 'currency', NEW.currency,
         'sales_person', NEW.sales_person, 'contact_person', NEW.contact_person, 'revision', NEW.revision, 'valid_until', NEW.valid_until);
  IF NEW.sent_at IS NOT NULL AND OLD.sent_at IS NULL THEN
    PERFORM webhook_emit('quotation.sent', 'quotation', NEW.quotation_no, NEW.quotation_value, NEW.company_id, d);
  END IF;
  IF NEW.stage_id IS DISTINCT FROM OLD.stage_id AND NEW.stage_id IS NOT NULL THEN
    SELECT * INTO st FROM pipeline_stages WHERE id = NEW.stage_id;
    d := d || jsonb_build_object('stage', st.name, 'probability', NEW.probability,
           'previous_stage', (SELECT name FROM pipeline_stages WHERE id = OLD.stage_id));
    PERFORM webhook_emit('quotation.stage_changed', 'quotation', NEW.quotation_no, NEW.quotation_value, NEW.company_id, d);
    IF st.type = 'won' THEN
      PERFORM webhook_emit('quotation.won', 'quotation', NEW.quotation_no, NEW.quotation_value, NEW.company_id, d);
    ELSIF st.type = 'lost' THEN
      PERFORM webhook_emit('quotation.lost', 'quotation', NEW.quotation_no, NEW.quotation_value, NEW.company_id,
        d || jsonb_build_object('lost_reason', (SELECT name FROM lost_reasons WHERE id = NEW.lost_reason_id), 'competitor', NEW.competitor));
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS z_webhook_quotation ON quotations;
CREATE TRIGGER z_webhook_quotation AFTER UPDATE ON quotations FOR EACH ROW EXECUTE FUNCTION webhook_quotation_events();

CREATE OR REPLACE FUNCTION webhook_record_events() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'enquiries' AND TG_OP = 'INSERT' THEN
    PERFORM webhook_emit('enquiry.created', 'enquiry', NEW.enquiry_no, NEW.estimated_value, NEW.company_id,
      jsonb_build_object('enquiry_no', NEW.enquiry_no, 'client_name', NEW.client_name, 'service', NEW.service, 'status', NEW.status,
        'sales_person', NEW.sales_person, 'contact_person', NEW.contact_person, 'estimated_value', NEW.estimated_value, 'currency', NEW.currency));
  ELSIF TG_TABLE_NAME = 'purchase_orders' THEN
    IF TG_OP = 'INSERT' THEN
      PERFORM webhook_emit('po.received', 'purchase_order', NEW.po_number, NEW.po_value,
        (SELECT company_id FROM projects WHERE project_id = NEW.project_id),
        jsonb_build_object('po_number', NEW.po_number, 'project_id', NEW.project_id, 'quotation_no', NEW.quotation_no,
          'po_date', NEW.po_date, 'value', NEW.po_value, 'currency', NEW.currency,
          'client_name', (SELECT client_name FROM projects WHERE project_id = NEW.project_id)));
    ELSIF NEW.actual_delivery_date IS NOT NULL AND OLD.actual_delivery_date IS NULL THEN
      PERFORM webhook_emit('project.delivered', 'project', NEW.project_id, NEW.po_value,
        (SELECT company_id FROM projects WHERE project_id = NEW.project_id),
        jsonb_build_object('project_id', NEW.project_id, 'po_number', NEW.po_number, 'delivered_on', NEW.actual_delivery_date,
          'client_name', (SELECT client_name FROM projects WHERE project_id = NEW.project_id)));
    END IF;
  ELSIF TG_TABLE_NAME = 'payment_stages' THEN
    IF NEW.invoice_no IS NOT NULL AND OLD.invoice_no IS NULL THEN
    PERFORM webhook_emit('invoice.issued', 'payment_stage', NEW.id::text, (SELECT round(NEW.stage_percent * po_value, 2) FROM purchase_orders WHERE po_number = NEW.po_number),
      (SELECT p.company_id FROM purchase_orders po JOIN projects p ON p.project_id = po.project_id WHERE po.po_number = NEW.po_number),
      jsonb_build_object('invoice_no', NEW.invoice_no, 'invoice_date', NEW.invoice_date, 'po_number', NEW.po_number,
        'stage', NEW.stage_name, 'amount', (SELECT round(NEW.stage_percent * po_value, 2) FROM purchase_orders WHERE po_number = NEW.po_number)));
    END IF;
  ELSIF TG_TABLE_NAME = 'payments' AND TG_OP = 'INSERT' THEN
    PERFORM webhook_emit('payment.received', 'payment_stage', NEW.stage_id::text, NEW.amount,
      (SELECT p.company_id FROM payment_stages s JOIN purchase_orders po ON po.po_number = s.po_number JOIN projects p ON p.project_id = po.project_id WHERE s.id = NEW.stage_id),
      jsonb_build_object('stage_id', NEW.stage_id, 'amount', NEW.amount, 'tds_amount', NEW.tds_amount, 'received_on', NEW.received_on,
        'mode', NEW.mode, 'reference', NEW.reference,
        'invoice_no', (SELECT invoice_no FROM payment_stages WHERE id = NEW.stage_id),
        'po_number', (SELECT po_number FROM payment_stages WHERE id = NEW.stage_id)));
  ELSIF TG_TABLE_NAME = 'engagements' THEN
    IF NEW.status = 'renewal_open' AND OLD.status IS DISTINCT FROM 'renewal_open' THEN
    PERFORM webhook_emit('renewal.opened', 'company', NEW.company_id::text, NULL, NEW.company_id,
      jsonb_build_object('client_name', NEW.client_name, 'service', NEW.service_name, 'due_on', NEW.next_due_on, 'owner', NEW.owner,
        'renewal_quotation_no', (SELECT quotation_no FROM quotations WHERE id = NEW.renewal_quotation_id)));
    END IF;
  ELSIF TG_TABLE_NAME = 'visits' AND TG_OP = 'INSERT' THEN
    PERFORM webhook_emit('visit.scheduled', 'project', NEW.project_id, NULL, NEW.company_id,
      jsonb_build_object('visit_id', NEW.id, 'title', NEW.title, 'type', NEW.type, 'starts_at', NEW.starts_at, 'ends_at', NEW.ends_at,
        'project_id', NEW.project_id, 'city', NEW.city, 'status', NEW.status));
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS z_webhook_enquiry ON enquiries;
CREATE TRIGGER z_webhook_enquiry AFTER INSERT ON enquiries FOR EACH ROW EXECUTE FUNCTION webhook_record_events();
DROP TRIGGER IF EXISTS z_webhook_po ON purchase_orders;
CREATE TRIGGER z_webhook_po AFTER INSERT OR UPDATE ON purchase_orders FOR EACH ROW EXECUTE FUNCTION webhook_record_events();
DROP TRIGGER IF EXISTS z_webhook_stage ON payment_stages;
CREATE TRIGGER z_webhook_stage AFTER UPDATE ON payment_stages FOR EACH ROW EXECUTE FUNCTION webhook_record_events();
DROP TRIGGER IF EXISTS z_webhook_payment ON payments;
CREATE TRIGGER z_webhook_payment AFTER INSERT ON payments FOR EACH ROW EXECUTE FUNCTION webhook_record_events();
DROP TRIGGER IF EXISTS z_webhook_engagement ON engagements;
CREATE TRIGGER z_webhook_engagement AFTER UPDATE ON engagements FOR EACH ROW EXECUTE FUNCTION webhook_record_events();
DROP TRIGGER IF EXISTS z_webhook_visit ON visits;
CREATE TRIGGER z_webhook_visit AFTER INSERT ON visits FOR EACH ROW EXECUTE FUNCTION webhook_record_events();

INSERT INTO settings (key, value, notes) VALUES
  ('incoming_enquiries_enabled', 'false', 'Accept enquiries posted to /api/hooks/enquiries with a valid signature (INCOMING_WEBHOOK_SECRET).')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------
-- Client portal (#47)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS portal_links (
  id          serial PRIMARY KEY,
  contact_id  int NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  ip          text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS portal_sessions (
  id            text PRIMARY KEY,
  contact_id    int NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  company_id    int NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  last_seen_at  timestamptz,
  ip            text,
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS portal_sessions_contact_idx ON portal_sessions (contact_id);

CREATE TABLE IF NOT EXISTS portal_audit (
  id          bigserial PRIMARY KEY,
  session_id  text,
  contact_id  int REFERENCES contacts(id) ON DELETE SET NULL,
  company_id  int REFERENCES companies(id) ON DELETE CASCADE,
  action      text NOT NULL,
  target      text,
  ip          text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS portal_audit_company_idx ON portal_audit (company_id, created_at DESC);

-- ---------------------------------------------------------------------
-- Accounting integration (#48)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounting_mappings (
  id          serial PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('customer','service','ledger','tax')),
  tracker_ref text NOT NULL,
  books_ref   text NOT NULL,
  books_name  text,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, tracker_ref)
);

CREATE TABLE IF NOT EXISTS books_entries (
  id              serial PRIMARY KEY,
  source          text NOT NULL CHECK (source IN ('zoho','tally','file')),
  kind            text NOT NULL CHECK (kind IN ('invoice','payment','credit_note')),
  books_id        text NOT NULL,
  number          text,
  customer_name   text,
  customer_gstin  text,
  company_id      int REFERENCES companies(id) ON DELETE SET NULL,
  entry_date      date,
  due_date        date,
  taxable_amount  numeric(16,2),
  tax_amount      numeric(16,2),
  total_amount    numeric(16,2),
  tds_amount      numeric(16,2),
  currency        text NOT NULL DEFAULT 'INR',
  reference       text,
  status          text,
  raw             jsonb,
  imported_at     timestamptz NOT NULL DEFAULT now(),
  imported_by     text,
  UNIQUE (source, kind, books_id)
);

CREATE INDEX IF NOT EXISTS books_entries_number_idx ON books_entries (kind, upper(regexp_replace(number, '\s', '', 'g')));

CREATE TABLE IF NOT EXISTS reconciliation_items (
  id              serial PRIMARY KEY,
  kind            text NOT NULL CHECK (kind IN ('invoice','payment')),
  match_key       text NOT NULL UNIQUE,
  stage_id        int REFERENCES payment_stages(id) ON DELETE CASCADE,
  payment_id      int REFERENCES payments(id) ON DELETE SET NULL,
  books_entry_id  int REFERENCES books_entries(id) ON DELETE CASCADE,
  status          text NOT NULL CHECK (status IN ('matched','amount_differs','date_differs','missing_in_books','missing_in_tracker','resolved')),
  differences     jsonb NOT NULL DEFAULT '[]'::jsonb,
  note            text,
  resolved_by     text,
  resolved_at     timestamptz,
  checked_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS reconciliation_items_status_idx ON reconciliation_items (status);

CREATE TABLE IF NOT EXISTS accounting_log (
  id          bigserial PRIMARY KEY,
  action      text NOT NULL,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  done_by     text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO settings (key, value, notes) VALUES
  ('accounting_provider', 'none', 'Where the books are: none, zoho, tally or file (export files uploaded by hand).'),
  ('accounting_apply_payments', 'false', 'Record payments found in the books on the matching tracker invoice automatically.'),
  ('company_state_code', '', 'Two-digit GST state code of our registration (e.g. 27 for Maharashtra). Decides CGST+SGST or IGST on draft invoices.')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------
-- API tokens for the MCP server (#50)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS api_tokens (
  id            serial PRIMARY KEY,
  name          text NOT NULL,
  token_hash    text NOT NULL UNIQUE,
  token_prefix  text NOT NULL,
  role          text NOT NULL DEFAULT 'sales' CHECK (role IN ('admin','sales')),
  -- role says whose records the token sees; this says whether it may
  -- change any of them. Off unless asked for: a token requested without
  -- saying otherwise is a reading token (#50).
  can_write     boolean NOT NULL DEFAULT false,
  person        text,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  CHECK (role = 'admin' OR person IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS api_token_log (
  id          bigserial PRIMARY KEY,
  token_id    int REFERENCES api_tokens(id) ON DELETE CASCADE,
  tool        text NOT NULL,
  arguments   jsonb,
  ok          boolean NOT NULL DEFAULT true,
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS api_token_log_token_idx ON api_token_log (token_id, created_at DESC);

-- Operational alerts (#38)
INSERT INTO settings (key, value, notes) VALUES
  ('alert_email', '', 'Who is emailed about failed jobs, backups, sign-in attacks, certificates and disk space. Blank: ALERT_EMAIL, else nobody.')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------
-- Sign-in protection (#34)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auth_events (
  id          bigserial PRIMARY KEY,
  username    text,
  ip          text,
  ok          boolean NOT NULL,
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS auth_events_ip_idx ON auth_events (ip, created_at DESC);

INSERT INTO settings (key, value, notes) VALUES
  ('signin_lockout_failures', '10', 'Failed sign-ins for one account from one address, within the lockout window, before it is refused and an alert is raised.'),
  ('signin_lockout_minutes', '15', 'The lockout window, in minutes.')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------
-- Backup records (#33)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS backup_runs (
  id           bigserial PRIMARY KEY,
  kind         text NOT NULL CHECK (kind IN ('backup','verify','drill')),
  ok           boolean NOT NULL,
  started_at   timestamptz,
  finished_at  timestamptz NOT NULL DEFAULT now(),
  size_bytes   bigint,
  location     text,
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
  error        text
);

CREATE INDEX IF NOT EXISTS backup_runs_kind_idx ON backup_runs (kind, finished_at DESC);

INSERT INTO settings (key, value, notes) VALUES
  ('backup_max_age_hours', '8', 'Alert when no successful backup has been recorded for this many hours.'),
  ('backup_verify_max_age_days', '8', 'Alert when the restore check has not passed for this many days.')
ON CONFLICT (key) DO NOTHING;

-- ------------------------------------------------------------- activity
-- What was done, by whom (see migrations/044_activity_log.sql).
-- Append-only: nothing in the application updates or deletes a row here,
-- and the only route over it reads. actor_user_id is null for the shared
-- admin, for a background job, and for an account deleted since — so the
-- record of an act survives the account that made it.
CREATE TABLE IF NOT EXISTS activity_log (
  id             bigserial PRIMARY KEY,
  actor_user_id  integer REFERENCES users(id) ON DELETE SET NULL,
  -- Which authority the request came through, not what the actor may do:
  -- a role changes, this does not.
  actor_type     text NOT NULL
                   CHECK (actor_type IN ('user','shared_admin','system')),
  -- A stable machine key, dotted: 'user.deactivated', 'company.merged'.
  action         text NOT NULL,
  entity_type    text NOT NULL,
  -- text, because some things acted on are named rather than numbered
  -- (a job is 'reminders.payment'), as in email_log.entity_id.
  entity_id      text,
  -- Context only. Never passwords, hashes, cookies, tokens or secrets.
  metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT activity_log_action_not_blank      CHECK (btrim(action) <> ''),
  CONSTRAINT activity_log_entity_type_not_blank CHECK (btrim(entity_type) <> ''),
  CONSTRAINT activity_log_entity_id_not_blank   CHECK (entity_id IS NULL OR btrim(entity_id) <> ''),
  -- A shared admin and a job have no account; a deleted one leaves
  -- actor_type 'user' with a null id, which is allowed.
  CONSTRAINT activity_log_actor_id_needs_user   CHECK (actor_user_id IS NULL OR actor_type = 'user'),
  CONSTRAINT activity_log_metadata_is_object    CHECK (jsonb_typeof(metadata) = 'object')
);

-- The unfiltered listing pages on id DESC, which the primary key already
-- serves. These three back the three supported filters, each carrying the
-- paging column so one index answers both.
CREATE INDEX IF NOT EXISTS activity_log_actor_idx  ON activity_log (actor_user_id, id DESC);
CREATE INDEX IF NOT EXISTS activity_log_action_idx ON activity_log (action, id DESC);
CREATE INDEX IF NOT EXISTS activity_log_entity_idx ON activity_log (entity_type, entity_id, id DESC);

-- -------------------------------------------------------- ownership_history
-- Ownership assignment, reassignment and handover history (#18 Phase 3).
CREATE TABLE IF NOT EXISTS ownership_history (
  id                          bigserial PRIMARY KEY,
  entity_type                 text NOT NULL
                                CHECK (entity_type IN ('enquiries', 'quotations', 'projects')),
  entity_id                   integer NOT NULL,
  previous_owner_user_id      integer,
  previous_owner_snapshot_id  integer,
  previous_owner_name         text,
  new_owner_user_id           integer,
  new_owner_snapshot_id       integer,
  new_owner_name              text,
  changed_by_user_id          integer,
  changed_by_snapshot_id      integer,
  changed_by_name             text,
  actor_type                  text NOT NULL
                                CHECK (actor_type IN ('user', 'shared_admin', 'system')),
  reason                      text NOT NULL,
  created_at                  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ownership_history_prev_owner_fkey
    FOREIGN KEY (previous_owner_user_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT ownership_history_new_owner_fkey
    FOREIGN KEY (new_owner_user_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT ownership_history_changed_by_fkey
    FOREIGN KEY (changed_by_user_id) REFERENCES users(id) ON DELETE SET NULL,

  CONSTRAINT ownership_history_reason_not_blank      CHECK (btrim(reason) <> ''),
  CONSTRAINT ownership_history_entity_type_not_blank CHECK (btrim(entity_type) <> ''),
  CONSTRAINT ownership_history_actor_id_needs_user   CHECK (changed_by_user_id IS NULL OR actor_type = 'user')
);

CREATE INDEX IF NOT EXISTS ownership_history_entity_idx
  ON ownership_history (entity_type, entity_id, id DESC);
CREATE INDEX IF NOT EXISTS ownership_history_new_owner_idx
  ON ownership_history (new_owner_user_id, id DESC);
CREATE INDEX IF NOT EXISTS ownership_history_prev_owner_idx
  ON ownership_history (previous_owner_user_id, id DESC);

-- -------------------------------------------------------- sales_targets
-- Annual sales targets by salesperson and calendar year (#18 Phase 4).
CREATE TABLE IF NOT EXISTS sales_targets (
  id                          serial PRIMARY KEY,
  salesperson_user_id         integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  calendar_year               integer NOT NULL CHECK (calendar_year BETWEEN 2000 AND 2100),
  metric                      text NOT NULL CHECK (btrim(metric) <> ''),
  target_value                numeric(16,2) NOT NULL CHECK (target_value >= 0),
  unit                        text NOT NULL CHECK (unit IN ('count', 'currency', 'percentage')),
  currency                    text CONSTRAINT sales_targets_currency_not_blank
                                CHECK (currency IS NULL OR btrim(currency) <> ''),
  created_by_user_id          integer REFERENCES users(id) ON DELETE SET NULL,
  updated_by_user_id          integer REFERENCES users(id) ON DELETE SET NULL,
  actor_type                  text NOT NULL DEFAULT 'user'
                                CHECK (actor_type IN ('user', 'shared_admin', 'system')),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT sales_targets_unit_currency_check CHECK (
    (unit = 'currency' AND currency IS NOT NULL) OR
    (unit IN ('count', 'percentage') AND currency IS NULL)
  ),
  CONSTRAINT sales_targets_count_integer_check CHECK (
    unit <> 'count' OR (target_value = round(target_value))
  ),
  CONSTRAINT sales_targets_percentage_check CHECK (
    unit <> 'percentage' OR (target_value >= 0 AND target_value <= 100)
  ),
  CONSTRAINT sales_targets_actor_needs_user CHECK (
    created_by_user_id IS NULL OR actor_type = 'user'
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS sales_targets_unique_idx
  ON sales_targets (salesperson_user_id, calendar_year, metric, COALESCE(currency, ''));

CREATE INDEX IF NOT EXISTS sales_targets_lookup_idx
  ON sales_targets (salesperson_user_id, calendar_year);

CREATE INDEX IF NOT EXISTS sales_targets_year_idx
  ON sales_targets (calendar_year);

CREATE TRIGGER sales_targets_set_updated_at BEFORE UPDATE ON sales_targets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------- follow_up_cycles
-- Follow-up reminders to owners and escalation to management
-- (docs/follow-up-escalation-plan.md).
-- A follow-up cycle: one record, one reminder, at most one open at a time.
-- These are events that happened (an email went, a deadline passed), not
-- values derived from other columns, so they are stored, the same way
-- payment_stages.reminder_sent_on is.
CREATE TABLE IF NOT EXISTS follow_up_cycles (
  id                   serial PRIMARY KEY,
  entity               text NOT NULL CHECK (entity IN ('enquiry','quotation','payment_stage')),
  entity_id            text NOT NULL,
  due_on               date NOT NULL,
  -- The person the reminder went to, as things stood then. Not the record's
  -- owner (that is owner_user_id on the record): a reassignment ends the cycle.
  reminded_user_id     int REFERENCES users(id) ON DELETE SET NULL,
  owner_name           text,
  reminded_at          timestamptz,
  reminder_email_id    int REFERENCES email_log(id) ON DELETE SET NULL,
  respond_by           date,
  escalated_at         timestamptz,
  last_escalated_on    date,
  escalation_count     int NOT NULL DEFAULT 0,
  escalation_email_id  int REFERENCES email_log(id) ON DELETE SET NULL,
  resolved_at          timestamptz,
  resolved_reason      text CHECK (resolved_reason IN
                         ('activity','closed','paid','on_hold','promised','rescheduled','reassigned','disabled')),
  created_at           timestamptz NOT NULL DEFAULT now()
);

-- One open cycle per record.
CREATE UNIQUE INDEX IF NOT EXISTS follow_up_cycles_open_key
  ON follow_up_cycles (entity, entity_id) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS follow_up_cycles_reminded_user_idx
  ON follow_up_cycles (reminded_user_id, resolved_at);

INSERT INTO settings (key, value, notes) VALUES
  ('followup_enabled', 'false', 'Email owners about due follow-ups and escalate to management when nothing is logged.'),
  ('followup_enquiry_idle_days', '3', 'Working days an enquiry with no follow-up date may go untouched.'),
  ('followup_quotation_idle_days', '5', 'Working days a sent quotation may go untouched.'),
  ('followup_invoice_overdue_days', '1', 'Days overdue before the owner is asked to follow up an invoice.'),
  ('followup_invoice_idle_days', '5', 'Working days an overdue invoice may go unchased.'),
  ('followup_grace_days', '2', 'Working days after a reminder before management is told.'),
  ('followup_reescalate_days', '5', 'Working days before an escalated item is listed again.'),
  ('followup_escalation_emails', '', 'Management addresses for escalations, besides admin accounts. Comma-separated.'),
  ('followup_cc_owner_on_escalation', 'true', 'Tell the owner when one of their follow-ups is escalated.')
ON CONFLICT (key) DO NOTHING;

-- When an open enquiry counts as at risk on Insights (064).
INSERT INTO settings (key, value, notes) VALUES
  ('enquiry_reply_days', '1', 'Working days a new enquiry may wait for a first reply before it is at risk.'),
  ('enquiry_decision_warn_days', '5', 'Working days before the client''s decision date that an enquiry with no quotation is at risk.')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------
-- Saved views: the pinned list in the sidebar, and every report.
--
-- A view is a resource, a set of filters and a name. That is enough to be
-- three things at once — a sidebar entry with the count behind it, a
-- preset on a list page, and, with `chart` set, a report, because a report
-- here is a filtered list with a summary above it.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS saved_views (
  id          serial PRIMARY KEY,
  -- The resource key the API already knows, e.g. 'payment-stages'. Checked
  -- against the resource registry on write: that registry is the one true
  -- list and it lives in the code.
  resource    text NOT NULL,
  name        text NOT NULL,
  -- The query the list endpoint would have been given. Re-validated
  -- against the resource's declared filters on every read, so a filter
  -- dropped from a resource stops being applied rather than erroring.
  filters     jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Null is everybody's; a username makes it one person's.
  owner       text,
  pinned      boolean NOT NULL DEFAULT false,
  sort_order  int NOT NULL DEFAULT 0,
  -- What the count means, so the sidebar can colour it.
  tone        text CHECK (tone IN ('late', 'waiting', 'settled', 'info')),
  chart       text,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Two views both called "Mine" on the same list is a bug reported later.
CREATE UNIQUE INDEX IF NOT EXISTS saved_views_name_key
  ON saved_views (resource, lower(name), COALESCE(owner, ''));
CREATE INDEX IF NOT EXISTS saved_views_pinned_idx
  ON saved_views (pinned, sort_order) WHERE pinned;

-- The three the sidebar starts with. Rows, not code, so they can be
-- renamed, reordered or unpinned without a deploy. Seeded only into an
-- empty table, so a site that has made its own is left alone.
INSERT INTO saved_views (resource, name, filters, pinned, sort_order, tone, chart)
SELECT * FROM (VALUES
  ('payment-stages', 'Overdue money', '{"stage_status":"Overdue"}'::jsonb, true, 1, 'late', 'ageing'),
  ('payment-stages', 'To invoice',    '{"stage_status":"To Invoice"}'::jsonb, true, 2, 'waiting', NULL),
  ('quotations',     'Open deals',    '{"status":"Draft,Submitted,Under Negotiation"}'::jsonb, true, 3, 'info', NULL)
) AS seed(resource, name, filters, pinned, sort_order, tone, chart)
WHERE NOT EXISTS (SELECT 1 FROM saved_views);

COMMIT;

-- Notifications cleared by acting on their record (#44).
-- Acting on the record clears what the notification asked for (#44). In
-- the database rather than in each route, so a task ticked on the Tasks page,
-- on the timeline or through the MCP tools all count the same.
CREATE OR REPLACE FUNCTION resolve_notifications(p_kinds text[], p_entity text, p_entity_id text) RETURNS void AS $$
  UPDATE notifications SET resolved_at = now()
   WHERE resolved_at IS NULL AND kind = ANY(p_kinds) AND entity = p_entity AND entity_id = p_entity_id;
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION task_resolves_notifications() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'done' AND OLD.status IS DISTINCT FROM 'done' THEN
    UPDATE notifications SET resolved_at = now()
     WHERE resolved_at IS NULL AND dedupe_key LIKE 'task:' || NEW.id || ':%';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enquiry_resolves_notifications() RETURNS trigger AS $$
BEGIN
  -- Followed up: the status moved on, or the next follow-up was set again.
  IF NEW.status IS DISTINCT FROM OLD.status OR NEW.next_follow_up_at IS DISTINCT FROM OLD.next_follow_up_at THEN
    PERFORM resolve_notifications(ARRAY['follow_up'], 'enquiry', NEW.enquiry_no);
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION quotation_resolves_notifications() RETURNS trigger AS $$
BEGIN
  IF OLD.approval_status = 'pending' AND NEW.approval_status IS DISTINCT FROM 'pending' THEN
    PERFORM resolve_notifications(ARRAY['approval'], 'quotation', NEW.quotation_no);
  END IF;
  -- Decided, accepted, extended or revised: the expiry warning and the
  -- unopened-link reminder no longer apply.
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('Won - PO Received', 'Lost')
     OR NEW.accepted_at IS NOT NULL AND OLD.accepted_at IS NULL
     OR NEW.valid_until IS DISTINCT FROM OLD.valid_until
     OR NEW.revision IS DISTINCT FROM OLD.revision THEN
    PERFORM resolve_notifications(ARRAY['expiring', 'acceptance'], 'quotation', NEW.quotation_no);
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION payment_stage_resolves_notifications() RETURNS trigger AS $$
BEGIN
  IF NEW.amount_received IS DISTINCT FROM OLD.amount_received
     AND NEW.amount_received >= (SELECT round(po.po_value * NEW.stage_percent, 2) FROM purchase_orders po WHERE po.po_number = NEW.po_number) THEN
    PERFORM resolve_notifications(ARRAY['invoice_overdue'], 'payment_stage', NEW.id::text);
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION conversation_resolves_notifications() RETURNS trigger AS $$
BEGIN
  -- Answered or closed: the "no reply yet" reminder is done with.
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status <> 'open'
     OR NEW.response_due_at IS NULL AND OLD.response_due_at IS NOT NULL THEN
    UPDATE notifications SET resolved_at = now()
     WHERE resolved_at IS NULL AND kind = 'inbox' AND link = '/inbox?c=' || NEW.id;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER zz_resolve_notifications AFTER UPDATE OF status ON tasks
  FOR EACH ROW EXECUTE FUNCTION task_resolves_notifications();
CREATE TRIGGER zz_resolve_notifications AFTER UPDATE ON enquiries
  FOR EACH ROW EXECUTE FUNCTION enquiry_resolves_notifications();
CREATE TRIGGER zz_resolve_notifications AFTER UPDATE ON quotations
  FOR EACH ROW EXECUTE FUNCTION quotation_resolves_notifications();
CREATE TRIGGER zz_resolve_notifications AFTER UPDATE OF amount_received ON payment_stages
  FOR EACH ROW EXECUTE FUNCTION payment_stage_resolves_notifications();
CREATE TRIGGER zz_resolve_notifications AFTER UPDATE ON inbox_conversations
  FOR EACH ROW EXECUTE FUNCTION conversation_resolves_notifications();

-- ------------------------------------------------------ report categories
-- The categories the Reports section groups free-text sectors and services
-- into (065, docs/sales-report-rework-plan.md §4.3, §4.4). services.report_line
-- is declared with the services table above.
CREATE TABLE IF NOT EXISTS sector_aliases (
  id     serial PRIMARY KEY,
  alias  text NOT NULL CHECK (name_key(alias) IS NOT NULL),
  sector text NOT NULL CHECK (name_key(sector) IS NOT NULL)
);

-- One alias per spelling, ignoring case and spacing the way every report does.
CREATE UNIQUE INDEX IF NOT EXISTS sector_aliases_alias_key ON sector_aliases (name_key(alias));

INSERT INTO sector_aliases (alias, sector) VALUES
  ('Metal', 'Metal Industry'), ('Metals', 'Metal Industry'), ('Steel', 'Metal Industry'),
  ('Aluminium', 'Metal Industry'), ('Aluminum', 'Metal Industry'), ('Copper', 'Metal Industry'),
  ('Mining & Metals', 'Metal Industry'),
  ('Agri', 'Agriculture'), ('Agro', 'Agriculture'), ('Agrochemicals', 'Agriculture'),
  ('Pharma', 'Pharmaceutical'), ('Pharmaceuticals', 'Pharmaceutical')
ON CONFLICT DO NOTHING;

INSERT INTO settings (key, value, notes) VALUES
  ('report_sectors', '["Metal Industry","Agriculture","Pharmaceutical"]',
   'Headline sectors on the Reports page, in order. Everything else is Other. Edit under Settings -> Reports.'),
  ('report_service_lines', '["EcoVadis","ESIA","Climate Change","ESG","HSE","Sustainability","ISO certification","ASI / Copper Mark / LME","Social & supply-chain audits"]',
   'Service lines on the Reports page, in order. Everything else is Other. Edit under Settings -> Reports.')
ON CONFLICT (key) DO NOTHING;

-- ------------------------------------------------------ enquiries from email
-- What was decided about each email the enquiry reader judged, and how far
-- its sweep of past mail has got (066, docs/email-enquiries-plan.md §4.1).
-- quotation_totals() above reads the printed totals here; it is plpgsql, so
-- the table being created later in this file is resolved when it runs.
CREATE TABLE IF NOT EXISTS email_enquiry_decisions (
  id                   serial PRIMARY KEY,
  account_id           int NOT NULL REFERENCES connected_accounts(id) ON DELETE CASCADE,
  provider_id          text NOT NULL,
  internet_message_id  text,
  conversation_id      text,
  thread_id            int REFERENCES email_threads(id) ON DELETE SET NULL,
  direction            text NOT NULL CHECK (direction IN ('inbound','outbound')),
  from_email           text,
  received_at          timestamptz,
  outcome              text NOT NULL CHECK (outcome IN ('created','linked','not_enquiry')),
  kind                 text NOT NULL,
  confidence           numeric(4,3) CHECK (confidence BETWEEN 0 AND 1),
  method               text NOT NULL CHECK (method IN ('ai','rules')),
  -- How many model calls this decision cost, against the daily ceiling.
  ai_calls             smallint NOT NULL DEFAULT 0 CHECK (ai_calls >= 0),
  enquiry_no           text REFERENCES enquiries(enquiry_no) ON UPDATE CASCADE ON DELETE SET NULL,
  -- The quotation read from the PDF we sent (plan §3.9), and how that went.
  quotation_no         text REFERENCES quotations(quotation_no) ON UPDATE CASCADE ON DELETE SET NULL,
  quotation_extraction text CHECK (quotation_extraction IN ('created','revised','failed')),
  extraction_reason    text,
  printed_subtotal     numeric(16,2),
  printed_tax_total    numeric(16,2),
  printed_total        numeric(16,2),
  decided_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, provider_id)
);

CREATE INDEX IF NOT EXISTS email_enquiry_decisions_message_idx ON email_enquiry_decisions (lower(internet_message_id)) WHERE internet_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS email_enquiry_decisions_conversation_idx ON email_enquiry_decisions (conversation_id) WHERE conversation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS email_enquiry_decisions_enquiry_idx ON email_enquiry_decisions (enquiry_no) WHERE enquiry_no IS NOT NULL;
CREATE INDEX IF NOT EXISTS email_enquiry_decisions_quotation_idx ON email_enquiry_decisions (quotation_no) WHERE quotation_no IS NOT NULL;
CREATE INDEX IF NOT EXISTS email_enquiry_decisions_decided_idx ON email_enquiry_decisions (decided_at);

CREATE TABLE IF NOT EXISTS mailbox_enquiry_backfills (
  account_id  int PRIMARY KEY REFERENCES connected_accounts(id) ON DELETE CASCADE,
  since       timestamptz NOT NULL,
  -- 'all': every folder as one stream, oldest first (073). A read begun
  -- before that goes Inbox first, then Sent Items. Null once read.
  folder      text CONSTRAINT mailbox_enquiry_backfills_folder_check CHECK (folder IN ('inbox','sentitems','all')),
  next_link   text,
  -- The date of the last message read, so progress can be shown in days.
  reached     timestamptz,
  scanned     int NOT NULL DEFAULT 0,
  created     int NOT NULL DEFAULT 0,
  linked      int NOT NULL DEFAULT 0,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  last_error  text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO settings (key, value, notes) VALUES
  ('auto_enquiries_enabled', 'true', 'Create enquiries automatically from new client email in connected mailboxes, and read back past mail once per mailbox. Off stops both at the next run; nothing already created is removed.'),
  ('auto_enquiry_min_confidence', '0.7', 'How sure the AI must be (0 to 1) that an email is a new enquiry before one is created. Rules alone always need 0.85.'),
  ('auto_enquiry_backfill_days', '365', 'How far back each mailbox is read once for past enquiries, in days.'),
  ('auto_enquiry_same_sender_days', '30', 'A new email from a client who already has an open enquiry this recent is linked to it instead of making another.'),
  ('auto_enquiry_daily_ai_limit', '5000', 'The most AI calls the email readers (enquiries, quotations, POs, invoices) may make in one day, together. Reading past mail stops for the day when it is reached.'),
  ('email_reader_concurrency', '4', 'How many emails each email reader reads at once, 1 to 8. Emails from one client or one conversation are still read one after another, oldest first.'),
  ('auto_quotation_min_confidence', '0.8', 'How sure the AI must be (0 to 1) of a quotation read from a PDF before the quotation is created.'),
  ('email_read_everything', 'true', 'Read every email in every folder (except Junk, Deleted Items, Drafts and Outbox), replies included: the AI decides what each one is. Off puts back the free rules that skip replies, newsletters, automatic senders and mail with no PO or invoice words, which saves AI calls.'),
  ('personal_mailbox_default_visibility', 'subject', 'What a newly connected personal mailbox stores for the tracker: metadata (who and when), subject, or share_everything. Its owner can change it afterwards; mailboxes already connected keep their setting.')
ON CONFLICT (key) DO NOTHING;

INSERT INTO settings (key, value, notes) VALUES
  ('auto_enquiries_enabled', 'true', 'Create enquiries automatically from new client email in connected mailboxes, and read back past mail once per mailbox. Off stops both at the next run; nothing already created is removed.'),
  ('auto_enquiry_min_confidence', '0.7', 'How sure the AI must be (0 to 1) that an email is a new enquiry before one is created. Rules alone always need 0.85.'),
  ('auto_enquiry_backfill_days', '365', 'How far back each mailbox is read once for past enquiries, in days.'),
  ('auto_enquiry_same_sender_days', '30', 'A new email from a client who already has an open enquiry this recent is linked to it instead of making another.'),
  ('auto_enquiry_daily_ai_limit', '5000', 'The most AI calls the email readers (enquiries, quotations, POs, invoices) may make in one day, together. Reading past mail stops for the day when it is reached.'),
  ('email_reader_concurrency', '4', 'How many emails each email reader reads at once, 1 to 8. Emails from one client or one conversation are still read one after another, oldest first.'),
  ('auto_quotation_min_confidence', '0.8', 'How sure the AI must be (0 to 1) of a quotation read from a PDF before the quotation is created.')
ON CONFLICT (key) DO NOTHING;

-- ------------------------------------------- purchase orders and invoices from email
-- What was decided about each email that might have been a client's PO or
-- our invoice, and how far each sweep of past mail has got (067,
-- docs/email-po-plan.md §4).
CREATE TABLE IF NOT EXISTS email_po_decisions (
  id                   serial PRIMARY KEY,
  account_id           int NOT NULL REFERENCES connected_accounts(id) ON DELETE CASCADE,
  provider_id          text NOT NULL,
  internet_message_id  text,
  conversation_id      text,
  thread_id            int REFERENCES email_threads(id) ON DELETE SET NULL,
  from_email           text,
  received_at          timestamptz,
  outcome              text NOT NULL CHECK (outcome IN
                         ('registered','linked','review','not_po','registered_by_hand','dismissed',
                          -- live mail the AI could not read (an error, or the day's ceiling):
                          -- read again by pos.backfill, and sent to review after a week
                          'retry')),
  document_type        text,
  review_reason        text CHECK (review_reason IN
                         ('no_match','several_matches','not_to_us','low_confidence','no_po_number',
                          'value_mismatch','company_mismatch','amendment','cancellation','multiple_pos','unreadable',
                          -- the PO's own figures failed a check (pdfPurchaseOrder.js checkPo)
                          'no_value','amounts_not_in_pdf','totals_do_not_add_up','bad_currency',
                          -- its client or currency could not be confirmed (071)
                          'currency_mismatch','no_currency')),
  mode                 text CHECK (mode IN ('live','history')),
  confidence           numeric(4,3) CHECK (confidence BETWEEN 0 AND 1),
  method               text NOT NULL CHECK (method IN ('ai','rules')),
  ai_calls             smallint NOT NULL DEFAULT 0 CHECK (ai_calls >= 0),
  po_number            text REFERENCES purchase_orders(po_number) ON UPDATE CASCADE ON DELETE SET NULL,
  quotation_no         text REFERENCES quotations(quotation_no) ON UPDATE CASCADE ON DELETE SET NULL,
  -- The quotations a reviewer is offered (§3.7).
  suggested_quotations text[],
  -- No quotation was on file, so one was made from the PO (§3.3).
  created_quotation    boolean NOT NULL DEFAULT false,
  stages_source        text CHECK (stages_source IN ('po_terms','template','none')),
  -- Who settled it from the review queue, and when: registered by hand or
  -- dismissed. decided_at stays the moment it was read, which the daily AI
  -- ceiling counts by.
  decided_by           text,
  settled_at           timestamptz,
  -- When it was first left for a retry; a week later it goes to review.
  retry_since          timestamptz,
  decided_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, provider_id)
);

CREATE INDEX IF NOT EXISTS email_po_decisions_message_idx ON email_po_decisions (lower(internet_message_id)) WHERE internet_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS email_po_decisions_conversation_idx ON email_po_decisions (conversation_id) WHERE conversation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS email_po_decisions_po_idx ON email_po_decisions (po_number) WHERE po_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS email_po_decisions_quotation_idx ON email_po_decisions (quotation_no) WHERE quotation_no IS NOT NULL;
CREATE INDEX IF NOT EXISTS email_po_decisions_review_idx ON email_po_decisions (decided_at) WHERE outcome = 'review';

CREATE TABLE IF NOT EXISTS mailbox_po_backfills (
  account_id  int PRIMARY KEY REFERENCES connected_accounts(id) ON DELETE CASCADE,
  since       timestamptz NOT NULL,
  next_link   text,
  reached     timestamptz,
  scanned     int NOT NULL DEFAULT 0,
  registered  int NOT NULL DEFAULT 0,
  review      int NOT NULL DEFAULT 0,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  last_error  text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS email_invoice_decisions (
  id                     serial PRIMARY KEY,
  account_id             int NOT NULL REFERENCES connected_accounts(id) ON DELETE CASCADE,
  provider_id            text NOT NULL,
  internet_message_id    text,
  conversation_id        text,
  thread_id              int REFERENCES email_threads(id) ON DELETE SET NULL,
  to_emails              text[],
  sent_at                timestamptz,
  outcome                text NOT NULL CHECK (outcome IN
                           ('recorded','linked','review','not_invoice','recorded_by_hand','dismissed',
                            -- its PO is not in the tracker yet: tried again until auto_invoice_wait_days
                            'waiting')),
  document_type          text,
  review_reason          text CHECK (review_reason IN
                           ('po_not_found','several_pos','amount_not_a_stage','po_without_stages','invoice_no_in_use',
                            'not_from_us','low_confidence','credit_note','revised','unreadable',
                            -- the invoice's own figures failed a check (invoiceDetect.js checkInvoice)
                            'no_invoice_no','amounts_not_in_pdf','totals_do_not_add_up','bad_currency','bad_date',
                            -- it names a PO, but its client could not be confirmed (071)
                            'client_unknown')),
  mode                   text CHECK (mode IN ('live','history')),
  confidence             numeric(4,3) CHECK (confidence BETWEEN 0 AND 1),
  method                 text NOT NULL CHECK (method IN ('ai','rules')),
  ai_calls               smallint NOT NULL DEFAULT 0 CHECK (ai_calls >= 0),
  stage_id               int REFERENCES payment_stages(id) ON DELETE SET NULL,
  po_number              text REFERENCES purchase_orders(po_number) ON UPDATE CASCADE ON DELETE SET NULL,
  -- As printed; the stage holds the one recorded.
  invoice_no             text,
  -- The stage already had a document, so the emailed PDF was not attached.
  document_kept_existing boolean NOT NULL DEFAULT false,
  -- While waiting only: the facts read from the invoice (number, date,
  -- amounts, references; never its text), so a retry needs no second AI
  -- call. Cleared once it is decided.
  reading                jsonb,
  decided_by             text,
  settled_at             timestamptz,
  decided_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, provider_id)
);

CREATE INDEX IF NOT EXISTS email_invoice_decisions_message_idx ON email_invoice_decisions (lower(internet_message_id)) WHERE internet_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS email_invoice_decisions_stage_idx ON email_invoice_decisions (stage_id) WHERE stage_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS email_invoice_decisions_review_idx ON email_invoice_decisions (decided_at) WHERE outcome = 'review';
CREATE INDEX IF NOT EXISTS email_invoice_decisions_waiting_idx ON email_invoice_decisions (decided_at) WHERE outcome = 'waiting';

-- AI calls made outside any decision: a review item read again for its
-- dialog. Counted against the same daily ceiling (aiCallsToday).
CREATE TABLE IF NOT EXISTS email_ai_calls (
  id       serial PRIMARY KEY,
  purpose  text NOT NULL,
  made_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_ai_calls_made_idx ON email_ai_calls (made_at);

CREATE TABLE IF NOT EXISTS mailbox_invoice_backfills (
  account_id  int PRIMARY KEY REFERENCES connected_accounts(id) ON DELETE CASCADE,
  since       timestamptz NOT NULL,
  next_link   text,
  reached     timestamptz,
  scanned     int NOT NULL DEFAULT 0,
  recorded    int NOT NULL DEFAULT 0,
  review      int NOT NULL DEFAULT 0,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  last_error  text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO settings (key, value, notes) VALUES
  ('auto_po_enabled', 'true', 'Register purchase orders automatically from client email in connected mailboxes, and read back past mail once per mailbox. Off stops both at the next run; nothing already registered is removed.'),
  ('auto_po_min_confidence', '0.85', 'How sure the AI must be (0 to 1) of a purchase order read from email before it is registered. Below it, the PO goes to review.'),
  ('auto_po_value_tolerance_percent', '2', 'How far, in percent, a PO''s value may be from its quotation''s and still be registered automatically. Further off goes to review.'),
  ('auto_po_history_after_days', '30', 'A PO or invoice dated more than this many days before it is read is registered as history: no notifications, onboarding, webhooks or client reminders.'),
  ('auto_po_create_quotation_when_missing', 'true', 'When a PO matches no quotation on file, create the quotation (won) and the enquiry (converted) from it, then register.'),
  ('po_portal_senders', '*@ansmtp.ariba.com,*@coupahost.com,*@jaggaer.com', 'Procurement-portal senders whose PO notifications are read even though they are automated. Comma-separated; * matches any text.'),
  ('auto_invoice_enabled', 'true', 'Record invoices we email to clients against the right payment stage, with the PDF. Off stops it at the next run; nothing already recorded is removed.'),
  ('auto_invoice_min_confidence', '0.85', 'How sure the AI must be (0 to 1) of an invoice read from email before it is recorded. Below it, the invoice goes to review.'),
  ('auto_invoice_wait_days', '7', 'How long an invoice whose PO is not in the tracker yet is retried before it goes to review.')
ON CONFLICT (key) DO NOTHING;

-- Every email handed to the PO, invoice or enquiry reader, kept until that
-- reader has finished with it; a failed one is read again later (070).
-- `cand` is how ingest classified it, never its subject or body.
CREATE TABLE IF NOT EXISTS email_reader_queue (
  id              bigserial PRIMARY KEY,
  account_id      int NOT NULL REFERENCES connected_accounts(id) ON DELETE CASCADE,
  provider_id     text NOT NULL,
  reader          text NOT NULL CHECK (reader IN ('po','invoice','enquiry')),
  folder          text,
  sent_at         timestamptz,
  cand            jsonb NOT NULL,
  attempts        int NOT NULL DEFAULT 0,
  last_error      text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  failed_at       timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, provider_id, reader)
);
CREATE INDEX IF NOT EXISTS email_reader_queue_due_idx ON email_reader_queue (account_id, next_attempt_at) WHERE failed_at IS NULL;

-- The PO number as compared: "PO-123" and "po 123" are the same PO.
CREATE INDEX IF NOT EXISTS purchase_orders_po_number_norm_idx
  ON purchase_orders (lower(regexp_replace(po_number, '[^a-zA-Z0-9]', '', 'g')));
