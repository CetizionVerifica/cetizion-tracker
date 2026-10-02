-- 067 — a target belongs to a period, not to a calendar year (#18 §4).
--
-- 062 keyed sales_targets on `calendar_year`. Issue #18 §4 asks for
-- `period` (month), and the difference is not cosmetic:
--
--   * §6 wants "monthly order intake against target" as a chart. An annual
--     figure cannot be decomposed into one — pro-rating twelfths is an
--     invention, not a target somebody set.
--   * a year target gives no in-year signal. "60% of the way there" in
--     October means nothing without knowing what October was supposed to be.
--   * monthly always rolls up. An annual target is the sum of its months;
--     the reverse is not recoverable.
--
-- The business also does not run on calendar years. The invoice series is
-- already numbered by the Indian financial year (`financialYear()` in
-- lib/sequences.js: '26-27'), so a reporting period here has to be able to
-- be April–March without the schema arguing about it.
--
-- Hence a half-open date range rather than a year number, which expresses
-- a month, a quarter, a calendar year and a financial year with the same
-- two columns and no special cases. `period_type` records which of those
-- was meant, so a UI can show "April 2026" rather than a pair of dates.
--
-- Additive: the columns are added, backfilled, and only then made NOT NULL,
-- so the table is never in a state that rejects its own existing rows.
-- `calendar_year` is kept — #18's rule for a replaced column is that it
-- stays until somebody has checked the replacement.
--
-- Safe on a live database, and safe to re-run.

-- ---------------------------------------------------------------------
-- 1. The period
-- ---------------------------------------------------------------------

ALTER TABLE sales_targets ADD COLUMN IF NOT EXISTS period_start date;
ALTER TABLE sales_targets ADD COLUMN IF NOT EXISTS period_end   date;
ALTER TABLE sales_targets ADD COLUMN IF NOT EXISTS period_type  text;

-- Half-open, [start, end), the same convention validateReportingYear and
-- every KPI query already use. A closed range would need every caller to
-- remember whether the last day is included, and the answer differs between
-- a date and a timestamptz.
UPDATE sales_targets
   SET period_start = make_date(calendar_year, 1, 1),
       period_end   = make_date(calendar_year + 1, 1, 1),
       period_type  = 'year'
 WHERE period_start IS NULL
   AND calendar_year IS NOT NULL;

-- Only after the backfill, so the constraint never has to reject a row the
-- table already held.
ALTER TABLE sales_targets ALTER COLUMN period_start SET NOT NULL;
ALTER TABLE sales_targets ALTER COLUMN period_end   SET NOT NULL;
ALTER TABLE sales_targets ALTER COLUMN period_type  SET NOT NULL;

ALTER TABLE sales_targets DROP CONSTRAINT IF EXISTS sales_targets_period_ordered;
ALTER TABLE sales_targets ADD CONSTRAINT sales_targets_period_ordered
  CHECK (period_end > period_start);

ALTER TABLE sales_targets DROP CONSTRAINT IF EXISTS sales_targets_period_type_check;
ALTER TABLE sales_targets ADD CONSTRAINT sales_targets_period_type_check
  CHECK (period_type IN ('month', 'quarter', 'year'));

-- `calendar_year` becomes derived rather than authoritative, and nullable
-- with it: an April–March target has no single calendar year to name, and
-- forcing one would make the column lie about half its rows.
ALTER TABLE sales_targets ALTER COLUMN calendar_year DROP NOT NULL;

-- ---------------------------------------------------------------------
-- 2. One target per person, per period, per metric
-- ---------------------------------------------------------------------
--
-- The old index keyed on calendar_year, which would forbid twelve monthly
-- intake targets in one year — the very thing this migration exists to
-- allow. It has to go before the new one can mean anything.
--
-- COALESCE on currency for 062's reason: a plain UNIQUE treats two NULLs as
-- distinct, so it would let the same count target be created twice.

DROP INDEX IF EXISTS sales_targets_unique_idx;

-- 062's two lookup indexes go with it. Both are keyed on calendar_year,
-- which is no longer authoritative and which nothing queries by now that a
-- target is found through its period; leaving them would cost a write on
-- every target for a read nobody makes.
DROP INDEX IF EXISTS sales_targets_lookup_idx;
DROP INDEX IF EXISTS sales_targets_year_idx;

CREATE UNIQUE INDEX IF NOT EXISTS sales_targets_period_unique_idx
  ON sales_targets (salesperson_user_id, period_start, period_end, metric, COALESCE(currency, ''));

-- The lookup every report makes: this person's targets overlapping a range.
CREATE INDEX IF NOT EXISTS sales_targets_period_idx
  ON sales_targets (salesperson_user_id, period_start, period_end);

-- ---------------------------------------------------------------------
-- 3. The metrics #18 §4 names
-- ---------------------------------------------------------------------
--
-- §4: "order intake (INR), orders won, quotations sent, collections (INR)".
-- Constrained rather than free text, because a target on a metric nothing
-- computes is a progress bar that never moves and no error anybody sees.
-- `enquiries_created_count` and `follow_up_completion_rate` are carried
-- over from 062's set: the first is computed, and the second is the one
-- metric that honestly reports itself unavailable.
--
-- NOT VALID, then validated: on a live table this takes no lock worth
-- naming, and if an unexpected metric is already stored the validation
-- fails loudly with the row rather than the migration half-applying.

ALTER TABLE sales_targets DROP CONSTRAINT IF EXISTS sales_targets_metric_known;
ALTER TABLE sales_targets ADD CONSTRAINT sales_targets_metric_known CHECK (
  metric IN (
    'order_intake_value',
    'won_quotations_count',
    'quotations_sent_count',
    'collections_value',
    'enquiries_created_count',
    'follow_up_completion_rate'
  )
) NOT VALID;

ALTER TABLE sales_targets VALIDATE CONSTRAINT sales_targets_metric_known;

-- ---------------------------------------------------------------------
-- 4. The stale-quotation threshold
-- ---------------------------------------------------------------------
--
-- #18 §5 defines stale quotations as "open quotations with no status change
-- for more than N days (setting)" and suggests 14. A settings row, so the
-- number is somebody's decision to change rather than a deploy — which is
-- also why it did not have to be decided before this shipped.

INSERT INTO settings (key, value, notes) VALUES
  ('stale_quotation_days', '14', 'Days without pipeline movement before an open quotation is reported as stale.')
ON CONFLICT (key) DO NOTHING;
