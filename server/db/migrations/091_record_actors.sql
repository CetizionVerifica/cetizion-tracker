-- =====================================================================
-- 091_record_actors.sql
-- Who did what in the tracker
-- (/mnt/project-files/plans/mis-report-sender-plan.md §B3.2).
--
--   tasks.completed_by                       who marked a task done, as a
--                                            name like tasks.created_by.
--   quotation_stage_history.changed_by_user_id
--                                            who moved a quotation's stage.
--
-- Both are filled by trigger from the request's actor, which a route sets
-- for its own transaction with set_config('app.actor_user_id' / 'app.actor_name',
-- …, true) (src/lib/recordActs.js). A write with no actor (a job, an email
-- reader, an import) leaves them null: nobody in particular did it.
-- =====================================================================

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS completed_by text;
ALTER TABLE quotation_stage_history ADD COLUMN IF NOT EXISTS changed_by_user_id int REFERENCES users(id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION task_completed_by() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'done' AND (TG_OP = 'INSERT' OR OLD.status <> 'done') THEN
    NEW.completed_by := COALESCE(NEW.completed_by, NULLIF(current_setting('app.actor_name', true), ''));
  ELSIF NEW.status <> 'done' THEN
    NEW.completed_by := NULL;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS task_completed_by ON tasks;
CREATE TRIGGER task_completed_by BEFORE INSERT OR UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION task_completed_by();

CREATE OR REPLACE FUNCTION stage_history_actor() RETURNS trigger AS $$
BEGIN
  NEW.changed_by_user_id := COALESCE(NEW.changed_by_user_id, NULLIF(current_setting('app.actor_user_id', true), '')::int);
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS stage_history_actor ON quotation_stage_history;
CREATE TRIGGER stage_history_actor BEFORE INSERT ON quotation_stage_history FOR EACH ROW EXECUTE FUNCTION stage_history_actor();
