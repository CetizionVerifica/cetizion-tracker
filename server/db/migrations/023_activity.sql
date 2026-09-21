-- 023 — tasks, notes, files and a timeline on every record (#22).
--
-- A record is named by (entity, entity_id): company id, enquiry number,
-- quotation number, project id, PO number, payment stage id, contact id.
-- Owners are people's names until user accounts (#18) arrive.
--
-- Safe on a live database; running it a second time changes nothing.

CREATE TABLE IF NOT EXISTS tasks (
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

CREATE INDEX IF NOT EXISTS tasks_entity_idx ON tasks (entity, entity_id);
CREATE INDEX IF NOT EXISTS tasks_open_idx ON tasks (status, due_at) WHERE status <> 'done';

CREATE TABLE IF NOT EXISTS notes (
  id          serial PRIMARY KEY,
  entity      text NOT NULL CHECK (entity IN ('company','contact','enquiry','quotation','project','purchase_order','payment_stage')),
  entity_id   text NOT NULL,
  body        text NOT NULL,
  author      text,
  pinned      boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notes_entity_idx ON notes (entity, entity_id, created_at DESC);

-- Many files per record, beside the single document field some records carry.
CREATE TABLE IF NOT EXISTS attachments (
  id           serial PRIMARY KEY,
  entity       text NOT NULL CHECK (entity IN ('company','contact','enquiry','quotation','project','purchase_order','payment_stage')),
  entity_id    text NOT NULL,
  document_id  int NOT NULL UNIQUE REFERENCES documents(id),
  label        text,
  uploaded_by  text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS attachments_entity_idx ON attachments (entity, entity_id);

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

DROP TRIGGER IF EXISTS task_stamps ON tasks;
CREATE TRIGGER task_stamps BEFORE INSERT OR UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION task_stamps();
DROP TRIGGER IF EXISTS tasks_set_updated_at ON tasks;
CREATE TRIGGER tasks_set_updated_at BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS notes_set_updated_at ON notes;
CREATE TRIGGER notes_set_updated_at BEFORE UPDATE ON notes FOR EACH ROW EXECUTE FUNCTION set_updated_at();
