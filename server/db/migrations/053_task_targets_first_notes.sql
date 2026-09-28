-- 051 — a task on several records, and each record's old remarks as its
-- pinned first note (#22).
--
-- A task has always named one record (tasks.entity, entity_id): "send the
-- revised quotation" belongs to the quotation, but it is also work on the
-- company, and it should show on both timelines. task_targets lists every
-- record a task is on. The task's own entity stays its main record — the
-- Tasks page links there and the reminders name it — and a trigger keeps
-- that one in task_targets, so nothing that inserts a task has to know the
-- table exists.
CREATE TABLE IF NOT EXISTS task_targets (
  task_id    integer NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  entity     text NOT NULL CHECK (entity IN ('company','contact','enquiry','quotation','project','purchase_order','payment_stage')),
  entity_id  text NOT NULL,
  PRIMARY KEY (task_id, entity, entity_id)
);

CREATE INDEX IF NOT EXISTS task_targets_entity_idx ON task_targets (entity, entity_id);

CREATE OR REPLACE FUNCTION task_main_target() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (OLD.entity, OLD.entity_id) IS DISTINCT FROM (NEW.entity, NEW.entity_id) THEN
    DELETE FROM task_targets WHERE task_id = NEW.id AND entity = OLD.entity AND entity_id = OLD.entity_id;
  END IF;
  INSERT INTO task_targets (task_id, entity, entity_id) VALUES (NEW.id, NEW.entity, NEW.entity_id)
    ON CONFLICT DO NOTHING;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS task_main_target ON tasks;
CREATE TRIGGER task_main_target AFTER INSERT OR UPDATE OF entity, entity_id ON tasks
  FOR EACH ROW EXECUTE FUNCTION task_main_target();

INSERT INTO task_targets (task_id, entity, entity_id)
SELECT id, entity, entity_id FROM tasks
ON CONFLICT DO NOTHING;

-- The remarks typed before notes existed become each record's first note,
-- pinned, so the history starts where it really started. The column stays:
-- lists and exports still read it. Run twice, it adds nothing the second time.
INSERT INTO notes (entity, entity_id, body, author, pinned, created_at, updated_at)
SELECT x.entity, x.entity_id, x.body, 'Moved from remarks', true, x.created_at, x.created_at
  FROM (
    SELECT 'quotation' AS entity, quotation_no AS entity_id, remarks AS body, created_at FROM quotations
    UNION ALL SELECT 'project', project_id, remarks, created_at FROM projects
    UNION ALL SELECT 'purchase_order', po_number, remarks, created_at FROM purchase_orders
    UNION ALL SELECT 'payment_stage', id::text, remarks, created_at FROM payment_stages
    UNION ALL SELECT 'company', id::text, notes, created_at FROM companies
    UNION ALL SELECT 'contact', id::text, notes, created_at FROM contacts
    UNION ALL SELECT 'enquiry', enquiry_no, notes, created_at FROM enquiries
  ) x
 WHERE NULLIF(btrim(x.body), '') IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM notes n WHERE n.entity = x.entity AND n.entity_id = x.entity_id AND n.body = x.body);
