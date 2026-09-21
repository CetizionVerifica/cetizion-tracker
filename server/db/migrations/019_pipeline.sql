-- 019 — the quotation pipeline (#25): stages with a probability, lost
-- reasons, expected close dates and a next step, kept in step with the
-- quotation status both ways.
--
-- Safe on a live database; running it a second time changes nothing.

CREATE TABLE IF NOT EXISTS pipeline_stages (
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

CREATE TABLE IF NOT EXISTS lost_reasons (
  id          serial PRIMARY KEY,
  name        text NOT NULL UNIQUE,
  active      boolean NOT NULL DEFAULT true,
  sort_order  int NOT NULL DEFAULT 0
);

INSERT INTO lost_reasons (name, sort_order) VALUES
  ('Price', 1), ('Went with a competitor', 2), ('No budget this year', 3), ('Project cancelled or postponed', 4),
  ('No response', 5), ('Timing', 6), ('Scope changed', 7), ('Quotation expired', 8), ('Other', 9)
ON CONFLICT (name) DO NOTHING;

ALTER TABLE quotations
  ADD COLUMN IF NOT EXISTS stage_id int REFERENCES pipeline_stages(id),
  ADD COLUMN IF NOT EXISTS probability int CHECK (probability BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS expected_close_date date,
  ADD COLUMN IF NOT EXISTS next_step text,
  ADD COLUMN IF NOT EXISTS stage_changed_at timestamptz,
  ADD COLUMN IF NOT EXISTS lost_reason_id int REFERENCES lost_reasons(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS lost_notes text,
  ADD COLUMN IF NOT EXISTS competitor text,
  ADD COLUMN IF NOT EXISTS closed_at timestamptz;

CREATE INDEX IF NOT EXISTS quotations_stage_id_idx ON quotations (stage_id);

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
DROP TRIGGER IF EXISTS c_stage_sync ON quotations;

-- Give every existing quotation its stage, while the trigger is off: it
-- would stamp today as every quotation's stage change, and as the closing
-- date of every won and lost one. The dates come from the records instead
-- (read before this update touches updated_at): the stage from the last
-- change to the row, a win from its PO date, a loss from the last change
-- (nothing records when it was lost).
WITH pick AS (
  SELECT q.id, q.updated_at, q.quotation_date,
         (SELECT ps.id FROM pipeline_stages ps
           WHERE ps.maps_to_status = q.status AND ps.active
           ORDER BY CASE
             WHEN q.status = 'Submitted' AND q.sent_at IS NOT NULL AND ps.name = 'Sent' THEN 0
             WHEN q.status = 'Under Negotiation' AND q.accepted_at IS NOT NULL AND ps.name = 'Verbal yes, awaiting PO' THEN 0
             ELSE 1 END, ps.sort_order
           LIMIT 1) AS stage_id,
         (SELECT min(po.po_date) FROM purchase_orders po
           WHERE po.quotation_no = q.quotation_no
              OR (po.quotation_no IS NULL AND q.project_id IS NOT NULL AND po.project_id = q.project_id)) AS po_date
    FROM quotations q
   WHERE q.stage_id IS NULL
)
UPDATE quotations q
   SET stage_id = ps.id,
       probability = ps.probability,
       stage_changed_at = COALESCE(pick.updated_at, pick.quotation_date::timestamptz),
       closed_at = CASE ps.type
                     WHEN 'won' THEN COALESCE(pick.po_date::timestamptz, pick.updated_at, pick.quotation_date::timestamptz)
                     WHEN 'lost' THEN COALESCE(pick.updated_at, pick.quotation_date::timestamptz)
                   END
  FROM pick JOIN pipeline_stages ps ON ps.id = pick.stage_id
 WHERE q.id = pick.id;

CREATE TRIGGER c_stage_sync BEFORE INSERT OR UPDATE ON quotations
  FOR EACH ROW EXECUTE FUNCTION quotation_stage_sync();

INSERT INTO settings (key, value, notes) VALUES
  ('quotation_expiry_grace_days', '14', 'Days after valid_until before a quotation sent from the tracker is marked lost as expired.')
ON CONFLICT (key) DO NOTHING;
