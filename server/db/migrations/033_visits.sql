-- 033 — audit and site-visit scheduling with availability (#42).
--
-- A visit is planned against a project (and PO), assigned to people, and
-- confirmed with the client. Completing it can mark its payment milestone
-- reached, which makes an "On Milestone" stage invoiceable (#26). A trip
-- can be created from it. People have working days and leave, so double
-- bookings and leave clashes are warned about. People are names until
-- user accounts (#18).
--
-- Safe on a live database; running it a second time changes nothing.

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
