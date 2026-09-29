-- 064 — when a deal was decided, not just that it was (#18 §3).
--
-- Issue #18: "Quotations keep only their current status, quotation_date and
-- updated_at. We can't tell when a quotation was won or lost, or who
-- changed it, so there is no won date, no sales cycle length and no
-- handover record. The 44 won quotations have no won date."
--
-- Five KPIs in §5 are defined on that date and cannot be computed without
-- it: orders won ("moved to Won in the period"), order intake, win rate
-- ("decided in the period"), sales cycle ("median days from quotation_date
-- to won_at"), and time-to-decision on enquiries.
--
-- What is already here, and why it is not enough.
--
--   closed_at          set by quotation_stage_sync when the pipeline stage
--                      moves to one of type won/lost. One column for both
--                      outcomes, so "won in June, reopened, lost in August"
--                      reads as a single date with no way to say which it
--                      belongs to — and a win rate needs both halves.
--   quotation_stage_history
--                      every stage move, which is the richer record. It is
--                      keyed on stage_id, so a status set directly — which
--                      the CRUD route, the importer and every older script
--                      do — moves the status and writes no history at all.
--
-- So the derived dates are driven from `status`, the field #18 §5 defines
-- the KPIs on, and they are set by a trigger rather than by the routes.
-- That is the whole point: there are at least four ways a quotation's
-- status changes today (the generic CRUD PATCH, the convert flow, the
-- importer's three-way merge, and the stage sync above), and a rule written
-- in four places is a rule with four chances to be missed. A trigger cannot
-- be bypassed by a code path nobody remembered.
--
-- Safe on a live database: six nullable columns, two indexes, one trigger,
-- and a backfill that only ever fills a null. Running it a second time
-- changes nothing.

-- ---------------------------------------------------------------------
-- 1. The columns
-- ---------------------------------------------------------------------

ALTER TABLE quotations ADD COLUMN IF NOT EXISTS won_at  timestamptz;
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS lost_at timestamptz;

-- Both dates, separately flagged.
--
-- #18's acceptance criteria require that "estimated figures, such as won
-- dates before the history existed, are labelled as estimated". A single
-- flag per row could not say that a quotation won before the history
-- existed and lost after it has one real date and one inferred one.
--
-- NOT NULL with a default rather than nullable: "is this estimated?" always
-- has an answer, and a null third state would be read as false by every
-- caller that forgot to check.
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS won_at_estimated  boolean NOT NULL DEFAULT false;
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS lost_at_estimated boolean NOT NULL DEFAULT false;

ALTER TABLE enquiries  ADD COLUMN IF NOT EXISTS decided_at           timestamptz;
ALTER TABLE enquiries  ADD COLUMN IF NOT EXISTS decided_at_estimated boolean NOT NULL DEFAULT false;

-- The KPI queries filter on a half-open period and group by owner, so the
-- owner leads. A bare date index would be read for "won in Q2" and then the
-- rows filtered by owner one at a time.
CREATE INDEX IF NOT EXISTS quotations_won_at_idx  ON quotations (owner_user_id, won_at)  WHERE won_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS quotations_lost_at_idx ON quotations (owner_user_id, lost_at) WHERE lost_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS enquiries_decided_at_idx ON enquiries (owner_user_id, decided_at) WHERE decided_at IS NOT NULL;

-- ---------------------------------------------------------------------
-- 2. Keeping them, from here on
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION quotation_decision_dates() RETURNS trigger AS $$
BEGIN
  -- Only on a real transition. An UPDATE that touches the value but not the
  -- status — a price correction on a won deal — must not restamp the date
  -- it was won, or every edit would drag the win into the current month.
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'Won - PO Received' THEN
    -- COALESCE, so an explicit date survives. That is what lets an admin
    -- correct a backfilled guess, and what lets the backfill below write a
    -- date through this trigger without it being overwritten by now().
    NEW.won_at := COALESCE(NEW.won_at, now());
    NEW.lost_at := NULL;
    NEW.lost_at_estimated := false;

  ELSIF NEW.status = 'Lost' THEN
    NEW.lost_at := COALESCE(NEW.lost_at, now());
    NEW.won_at := NULL;
    NEW.won_at_estimated := false;

  ELSE
    -- Reopened. A quotation back in negotiation has not been won and has
    -- not been lost, and leaving a stale date behind would put it in a
    -- period's order intake for ever. The stage history keeps what happened;
    -- these two columns say only what is true now.
    --
    -- This is the same reasoning quotation_stage_sync applies to closed_at
    -- and to lost_reason_id, deliberately: two columns describing one deal
    -- that disagree about whether it is open is worse than either answer.
    NEW.won_at := NULL;
    NEW.lost_at := NULL;
    NEW.won_at_estimated := false;
    NEW.lost_at_estimated := false;
  END IF;

  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- BEFORE, so it writes to NEW rather than issuing a second UPDATE, and
-- named to sort after quotation_stage_sync: that one can rewrite NEW.status
-- from the pipeline stage, and this must read the status that actually
-- lands. Postgres fires same-event triggers in name order.
DROP TRIGGER IF EXISTS z_quotation_decision_dates ON quotations;
CREATE TRIGGER z_quotation_decision_dates BEFORE INSERT OR UPDATE ON quotations
  FOR EACH ROW EXECUTE FUNCTION quotation_decision_dates();

CREATE OR REPLACE FUNCTION enquiry_decision_date() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  -- Decided means it stopped being a lead, either way: quoted (Converted)
  -- or turned down (Unqualified). The four open statuses since #24 — New,
  -- Contacted, Qualified, Nurture — are all still in progress.
  IF NEW.status IN ('Converted', 'Unqualified') THEN
    NEW.decided_at := COALESCE(NEW.decided_at, now());
  ELSE
    NEW.decided_at := NULL;
    NEW.decided_at_estimated := false;
  END IF;

  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS z_enquiry_decision_date ON enquiries;
CREATE TRIGGER z_enquiry_decision_date BEFORE INSERT OR UPDATE ON enquiries
  FOR EACH ROW EXECUTE FUNCTION enquiry_decision_date();

-- ---------------------------------------------------------------------
-- 3. The records decided before any of this existed
-- ---------------------------------------------------------------------
--
-- #18 says: "Existing records: where the won date is unknown, use
-- quotation_date and mark the figure as estimated." That is what this does,
-- and the estimated flag is not decoration — a sales cycle computed from it
-- is exactly zero days, which is obviously wrong and must be labelled
-- rather than reported as a fact.
--
-- `closed_at` is preferred where the stage sync happened to record one: it
-- is a real timestamp for a real transition, so it is not an estimate. Only
-- where there is nothing better does quotation_date stand in.
--
-- Written with an UPDATE that sets the date explicitly, which the trigger's
-- COALESCE then leaves alone. Ordinary DML, so it runs inside the migration
-- runner's transaction like everything else.

UPDATE quotations
   SET won_at = COALESCE(closed_at, quotation_date::timestamptz),
       won_at_estimated = (closed_at IS NULL)
 WHERE status = 'Won - PO Received'
   AND won_at IS NULL
   AND COALESCE(closed_at, quotation_date::timestamptz) IS NOT NULL;

UPDATE quotations
   SET lost_at = COALESCE(closed_at, quotation_date::timestamptz),
       lost_at_estimated = (closed_at IS NULL)
 WHERE status = 'Lost'
   AND lost_at IS NULL
   AND COALESCE(closed_at, quotation_date::timestamptz) IS NOT NULL;

-- An enquiry has no closed_at to fall back on, so every backfilled decision
-- date is an estimate, and enquiry_date is the only thing to estimate from.
UPDATE enquiries
   SET decided_at = enquiry_date::timestamptz,
       decided_at_estimated = true
 WHERE status IN ('Converted', 'Unqualified')
   AND decided_at IS NULL
   AND enquiry_date IS NOT NULL;

-- Deliberately not backfilled: a won quotation with no quotation_date and
-- no closed_at. There is nothing to infer from, and a made-up date would be
-- indistinguishable from a real one once the estimated flag was read as
-- "approximately right" rather than "invented". It stays null, and null is
-- the honest answer to "when was this won?" for a record that never said.
