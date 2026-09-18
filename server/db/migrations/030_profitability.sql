-- 030 — project profitability: delivery cost against PO value (#39).
--
-- Costs that have nowhere to live today (subcontractors, external
-- auditors, certification-body and lab fees) get their own table; travel
-- vendor bills and expense claims are already tracked. A planned cost on
-- the project lets planned and actual be compared. The margin itself is a
-- view (views.sql), rebuilt on every upgrade.
--
-- Safe on a live database; running it a second time changes nothing.

ALTER TABLE projects ADD COLUMN IF NOT EXISTS estimated_cost numeric(16,2) CHECK (estimated_cost >= 0);

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
