-- 067 — telling a receipt from a balance brought forward (#18 §5).
--
-- §5 wants "Invoiced / collected" per person per period. Both are
-- computable today, and the KPI engine's claim that they are not —
-- "payment_stages stores cumulative balances with only the latest receipt
-- date and cannot be partitioned across calendar years reliably" — predates
-- #27. Since #27 every receipt is its own row in `payments`, with its own
-- `received_on`, and `payments_changed` keeps the stage total in step. A
-- ledger is exactly what partitioning by period needs.
--
-- One wrinkle stops it being a clean sum, and this migration is about
-- naming it rather than hiding it.
--
-- `payments_opening` books a stage's pre-#27 `amount_received` as a single
-- receipt — but only when a *new* receipt arrives on that stage. So the
-- money that predates #27 is in one of three states:
--
--   a real receipt        a row with a date somebody recorded. Attributable.
--   an opening balance    one row carrying a cumulative total, dated with
--                         whatever `payment_received_date` held — the LAST
--                         receipt's date, not the dates of the payments it
--                         adds up. Lands entirely in one period when it may
--                         have arrived across three.
--   not in the ledger     a stage paid before #27 and untouched since has
--                         no `payments` row at all. Its money exists only
--                         as payment_stages.amount_received.
--
-- The second and third are estimates and must be reported as such — #18's
-- acceptance criteria require that "estimated figures ... are labelled as
-- estimated". They are not errors to be cleaned up: the per-receipt history
-- was never recorded and cannot be reconstructed, and inventing dates to
-- spread a lump across periods would be fabrication that looks like data.
--
-- Today an opening balance is identifiable only by matching its `notes`
-- against the exact string the trigger writes. A KPI that decides whether a
-- figure is an estimate by comparing prose is one that silently starts
-- reporting estimates as facts the day somebody edits that sentence.
--
-- Safe on a live database: one column with a default, a backfill that only
-- relabels rows the trigger itself created, and a trigger body changed to
-- set the column it now has. Running it a second time changes nothing.

-- ---------------------------------------------------------------------
-- 1. What kind of row this is
-- ---------------------------------------------------------------------

ALTER TABLE payments ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'receipt';

ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_origin_check;
ALTER TABLE payments ADD CONSTRAINT payments_origin_check
  CHECK (origin IN ('receipt', 'opening_balance', 'adjustment'));

-- 'receipt'          money arriving, on the date it arrived.
-- 'opening_balance'  a cumulative total carried in from before #27, dated
--                    with the last receipt's date. Counts toward a total;
--                    marks any period figure containing it as estimated.
-- 'adjustment'       a negative row correcting a total typed too high. Real
--                    and dated, but not money arriving, so a "collected in
--                    June" figure that nets one off should say so.

-- Existing rows, by the marks they already carry. The prose match is used
-- exactly once — here — to retire itself.
UPDATE payments SET origin = 'opening_balance'
 WHERE origin = 'receipt' AND notes = 'Opening balance from the stage';

UPDATE payments SET origin = 'adjustment'
 WHERE origin = 'receipt' AND (amount < 0 OR notes LIKE 'Adjusted: total set to %');

CREATE INDEX IF NOT EXISTS payments_received_on_idx
  ON payments (received_on) WHERE received_on IS NOT NULL;

-- ---------------------------------------------------------------------
-- 2. The trigger sets it from now on
-- ---------------------------------------------------------------------
--
-- Unchanged except for the column. The guard at the top still reads the
-- notes, because that is what the row it writes carries and rewriting the
-- guard to read `origin` would change behaviour for a row inserted by hand
-- with the old notes and no origin.

CREATE OR REPLACE FUNCTION payments_opening() RETURNS trigger AS $$
DECLARE cur record;
BEGIN
  IF NEW.origin = 'opening_balance' OR NEW.notes = 'Opening balance from the stage' THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM payments WHERE stage_id = NEW.stage_id) THEN
    SELECT amount_received, payment_received_date INTO cur FROM payment_stages WHERE id = NEW.stage_id;
    IF cur.amount_received > 0 THEN
      INSERT INTO payments (stage_id, amount, received_on, mode, notes, origin)
      VALUES (NEW.stage_id, cur.amount_received, cur.payment_received_date, 'other',
              'Opening balance from the stage', 'opening_balance');
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------
-- 3. Deliberately NOT done
-- ---------------------------------------------------------------------
--
-- The third state above — a stage with `amount_received > 0` and no
-- `payments` rows — is not back-booked here. Doing so would mean inventing
-- a ledger row for every historically paid stage in the database, dated
-- from `payment_received_date` and null where that is null, which is a lot
-- of fabricated history to make one query simpler.
--
-- It is left where it is, and the collections KPI reads it from
-- payment_stages and reports it in its own bucket. A figure that says
-- "₹41L collected, of which ₹6L is an estimate and ₹2L cannot be placed in
-- a period at all" is more useful than a single confident number that is
-- quietly wrong, and it is what §5's "labelled as estimated" asks for.
