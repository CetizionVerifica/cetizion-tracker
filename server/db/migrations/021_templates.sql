-- 021 — PO received to project in one step (#26): payment-schedule
-- templates, onboarding templates per service, credit days and milestone
-- triggers on payment stages.
--
-- Safe on a live database; running it a second time changes nothing.

CREATE TABLE IF NOT EXISTS payment_terms_templates (
  id          serial PRIMARY KEY,
  name        text NOT NULL UNIQUE,
  active      boolean NOT NULL DEFAULT true,
  is_default  boolean NOT NULL DEFAULT false,
  sort_order  int NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS payment_terms_template_lines (
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

CREATE INDEX IF NOT EXISTS payment_terms_template_lines_template_idx ON payment_terms_template_lines (template_id, sort_order);

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

CREATE TABLE IF NOT EXISTS onboarding_templates (
  id          serial PRIMARY KEY,
  name        text NOT NULL UNIQUE,
  active      boolean NOT NULL DEFAULT true,
  is_default  boolean NOT NULL DEFAULT false,
  sort_order  int NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS onboarding_template_lines (
  id                serial PRIMARY KEY,
  template_id       int NOT NULL REFERENCES onboarding_templates(id) ON DELETE CASCADE,
  step_no           int NOT NULL,
  stage             text,
  step              text NOT NULL,
  owner_role        text,
  days_after_start  int
);

CREATE INDEX IF NOT EXISTS onboarding_template_lines_template_idx ON onboarding_template_lines (template_id, step_no);

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

-- A service can name its own checklist and payment terms.
ALTER TABLE services
  ADD COLUMN IF NOT EXISTS onboarding_template_id int REFERENCES onboarding_templates(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS payment_terms_template_id int REFERENCES payment_terms_templates(id) ON DELETE SET NULL;

-- Stages: their own credit days, and milestone triggers.
ALTER TABLE payment_stages
  ADD COLUMN IF NOT EXISTS credit_days int CHECK (credit_days >= 0),
  ADD COLUMN IF NOT EXISTS milestone_name text,
  ADD COLUMN IF NOT EXISTS milestone_reached_on date;

ALTER TABLE payment_stages DROP CONSTRAINT IF EXISTS payment_stages_trigger_event_check;
ALTER TABLE payment_stages ADD CONSTRAINT payment_stages_trigger_event_check
  CHECK (trigger_event IN ('On PO Registration','On Delivery','On Milestone','Manual'));
