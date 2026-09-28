-- 055 — project milestones (#26).
--
-- A payment stage could be triggered On Milestone, but nothing recorded a
-- milestone: the date lived on each stage, set by hand on the payment-stage
-- form, so a milestone shared by two POs was two separate facts and the
-- project page had no way to say "this is done". project_milestones holds
-- them per project; a stage points at its milestone, and reaching it stamps
-- the date on every stage it triggers — which is what the invoicing view,
-- the cash-flow forecast and the invoice run already read.
CREATE TABLE IF NOT EXISTS project_milestones (
  id          serial PRIMARY KEY,
  project_id  text NOT NULL REFERENCES projects(project_id) ON UPDATE CASCADE ON DELETE CASCADE,
  name        text NOT NULL,
  target_date date,
  reached_on  date,
  sort_order  int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS project_milestones_name_idx ON project_milestones (project_id, lower(name));

ALTER TABLE payment_stages ADD COLUMN IF NOT EXISTS milestone_id int REFERENCES project_milestones(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS payment_stages_milestone_idx ON payment_stages (milestone_id) WHERE milestone_id IS NOT NULL;

-- Reaching a milestone (or taking it back) is recorded once, on the
-- milestone, and every stage it triggers takes the date.
CREATE OR REPLACE FUNCTION milestone_reached() RETURNS trigger AS $$
BEGIN
  UPDATE payment_stages SET milestone_reached_on = NEW.reached_on
   WHERE milestone_id = NEW.id AND milestone_reached_on IS DISTINCT FROM NEW.reached_on;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS milestone_reached ON project_milestones;
CREATE TRIGGER milestone_reached AFTER UPDATE OF reached_on ON project_milestones
  FOR EACH ROW EXECUTE FUNCTION milestone_reached();

DROP TRIGGER IF EXISTS project_milestones_set_updated_at ON project_milestones;
CREATE TRIGGER project_milestones_set_updated_at BEFORE UPDATE ON project_milestones
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Every On Milestone stage already written gets its milestone: one per
-- project and name, reached when any of its stages was.
INSERT INTO project_milestones (project_id, name, reached_on)
SELECT po.project_id, btrim(ps.milestone_name), max(ps.milestone_reached_on)
  FROM payment_stages ps JOIN purchase_orders po ON po.po_number = ps.po_number
 WHERE NULLIF(btrim(ps.milestone_name), '') IS NOT NULL
 GROUP BY po.project_id, btrim(ps.milestone_name)
ON CONFLICT DO NOTHING;

UPDATE payment_stages ps
   SET milestone_id = m.id
  FROM purchase_orders po, project_milestones m
 WHERE po.po_number = ps.po_number AND m.project_id = po.project_id
   AND lower(m.name) = lower(btrim(ps.milestone_name)) AND ps.milestone_id IS NULL;
