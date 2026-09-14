-- =====================================================================
--  CETIZION — Sales, Projects, Payments, Travel & Expenses
--  Schema. Mirrors the workbook: one table per "you type here" sheet.
--  Everything the workbook computed with formulas lives in views.sql.
-- =====================================================================

BEGIN;

DROP VIEW IF EXISTS v_quotations, v_projects, v_purchase_orders,
  v_payment_stages, v_travel_logs, v_travel_vendor_invoices,
  v_employee_expense_claims CASCADE;

DROP TABLE IF EXISTS employee_expense_claims, travel_vendor_invoices,
  travel_logs, onboarding_tasks, payment_stages, po_services,
  purchase_orders, projects, enquiries, quotations, expense_categories,
  travel_vendors, services, settings, documents CASCADE;

-- ---------------------------------------------------------------------
-- Reference data (the workbook's Settings / Services / Travel Lists tabs)
-- ---------------------------------------------------------------------

CREATE TABLE settings (
  key         text PRIMARY KEY,
  value       text NOT NULL,
  notes       text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- INR for 1 unit of each currency, for the sales report. Blank until set.
INSERT INTO settings (key, value, notes) VALUES
  ('fx_rate_EUR', '', 'INR for 1 EUR. Used to show FX deals in INR on the sales report.'),
  ('fx_rate_USD', '', 'INR for 1 USD. Used to show FX deals in INR on the sales report.'),
  ('fx_rate_GBP', '', 'INR for 1 GBP. Used to show FX deals in INR on the sales report.'),
  ('fx_rate_AED', '', 'INR for 1 AED. Used to show FX deals in INR on the sales report.'),
  ('fx_rate_SGD', '', 'INR for 1 SGD. Used to show FX deals in INR on the sales report.');

CREATE TABLE services (
  id       serial PRIMARY KEY,
  name     text NOT NULL UNIQUE,
  active   boolean NOT NULL DEFAULT true,
  sort_order int NOT NULL DEFAULT 0
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
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Projects  (Project Tracker)
--   Created when a quotation is won. project_id is the human key used
--   everywhere, exactly as in the workbook (PRJ-2026-001).
-- ---------------------------------------------------------------------

CREATE TABLE projects (
  id                    serial PRIMARY KEY,
  project_id            text NOT NULL UNIQUE,
  client_name           text NOT NULL,
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

-- ---------------------------------------------------------------------
-- Quotations  (Sales Tracker)
-- ---------------------------------------------------------------------

CREATE TABLE quotations (
  id                 serial PRIMARY KEY,
  quotation_no       text NOT NULL UNIQUE,
  client_name        text NOT NULL,
  contact_person     text,
  service_quoted     text,
  sector             text,
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
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON quotations (project_id);
CREATE INDEX ON quotations (status);

-- ---------------------------------------------------------------------
-- Enquiries — logged before anything is quoted. Marking one
-- 'Won - Quotation Sent' has the API create and link its quotation.
-- ---------------------------------------------------------------------

CREATE TABLE enquiries (
  id                 serial PRIMARY KEY,
  enquiry_no         text NOT NULL UNIQUE,
  enquiry_date       date,
  client_name        text NOT NULL,
  sector             text,
  contact_person     text,
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

CREATE INDEX ON enquiries (status);

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
  document_id            int UNIQUE REFERENCES documents(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON purchase_orders (project_id);

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
  FOREACH t IN ARRAY ARRAY['projects','quotations','enquiries','purchase_orders',
      'po_services','payment_stages','onboarding_tasks','travel_logs',
      'travel_vendor_invoices','employee_expense_claims','settings']
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I_set_updated_at BEFORE UPDATE ON %I
         FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t);
  END LOOP;
END $$;

COMMIT;
