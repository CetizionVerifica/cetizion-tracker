-- =====================================================================
-- 021_sales_targets_and_origin.sql
-- Issue #18 Phase 4: Sales KPI Engine & Annual Targets
--
-- 1. Originating salesperson attribution:
--    Immutable fields on enquiries, quotations and projects:
--    - originating_user_id (references users(id) ON DELETE SET NULL)
--    - originating_user_snapshot_id (preserves identity if user deleted)
--    - originating_user_name (preserves display name if user deleted)
--
-- 2. Annual sales targets:
--    Table sales_targets with uniqueness preventing duplicate count/currency targets
--    and strict metric constraints.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Originating salesperson fields
-- ---------------------------------------------------------------------

ALTER TABLE enquiries  ADD COLUMN IF NOT EXISTS originating_user_id integer;
ALTER TABLE enquiries  ADD COLUMN IF NOT EXISTS originating_user_snapshot_id integer;
ALTER TABLE enquiries  ADD COLUMN IF NOT EXISTS originating_user_name text;

ALTER TABLE quotations ADD COLUMN IF NOT EXISTS originating_user_id integer;
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS originating_user_snapshot_id integer;
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS originating_user_name text;

ALTER TABLE projects   ADD COLUMN IF NOT EXISTS originating_user_id integer;
ALTER TABLE projects   ADD COLUMN IF NOT EXISTS originating_user_snapshot_id integer;
ALTER TABLE projects   ADD COLUMN IF NOT EXISTS originating_user_name text;

ALTER TABLE enquiries  DROP CONSTRAINT IF EXISTS enquiries_originating_user_id_fkey;
ALTER TABLE enquiries  ADD CONSTRAINT enquiries_originating_user_id_fkey
  FOREIGN KEY (originating_user_id) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE quotations DROP CONSTRAINT IF EXISTS quotations_originating_user_id_fkey;
ALTER TABLE quotations ADD CONSTRAINT quotations_originating_user_id_fkey
  FOREIGN KEY (originating_user_id) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE projects   DROP CONSTRAINT IF EXISTS projects_originating_user_id_fkey;
ALTER TABLE projects   ADD CONSTRAINT projects_originating_user_id_fkey
  FOREIGN KEY (originating_user_id) REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS enquiries_originating_user_id_idx
  ON enquiries (originating_user_id);
CREATE INDEX IF NOT EXISTS quotations_originating_user_id_idx
  ON quotations (originating_user_id);
CREATE INDEX IF NOT EXISTS projects_originating_user_id_idx
  ON projects (originating_user_id);

-- ---------------------------------------------------------------------
-- 2. Sales targets table
-- ---------------------------------------------------------------------

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

-- Unique index handles NULL currency correctly (unlike standard UNIQUE constraint in PostgreSQL)
CREATE UNIQUE INDEX IF NOT EXISTS sales_targets_unique_idx
  ON sales_targets (salesperson_user_id, calendar_year, metric, COALESCE(currency, ''));

CREATE INDEX IF NOT EXISTS sales_targets_lookup_idx
  ON sales_targets (salesperson_user_id, calendar_year);

CREATE INDEX IF NOT EXISTS sales_targets_year_idx
  ON sales_targets (calendar_year);

DROP TRIGGER IF EXISTS sales_targets_set_updated_at ON sales_targets;
CREATE TRIGGER sales_targets_set_updated_at BEFORE UPDATE ON sales_targets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
