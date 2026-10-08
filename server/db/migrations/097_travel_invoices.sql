-- =====================================================================
-- 097_travel_invoices.sql
-- The invoice that bills a trip to the client, as a kind of payment
-- stage (#214 §5.1).
--
-- Travel is billed with its own invoice raised on the project or the PO
-- (#214 §9.2). A payment stage could not hold one: its amount is a share
-- of the PO value, and it must belong to a PO. So a travel invoice is
-- made a *kind* of payment stage rather than a table of its own, and
-- everything that already works on a stage works on it untouched —
-- receipts (`payments`), TDS, the Paid/Due/Overdue status, reminders and
-- collections, the client portal, the GST invoice-number series
-- (payment_stages_invoice_no_key) and Accounting reconciliation. A
-- separate table would need every one of those built again.
--
-- ## Nothing existing changes
--
-- `kind` defaults to 'po_stage', `amount` and `project_id` are NULL, so
-- every row already in the table is an ordinary PO stage and every
-- caller that does not know about this — the generic CRUD form, the
-- importer, the email invoice reader — goes on creating ordinary stages
-- exactly as before. The three columns that stop being NOT NULL stay
-- filled for a po_stage by the shape constraint below, which is the same
-- rule the NOT NULLs were enforcing, now stated per kind.
--
-- ## What a travel invoice looks like
--
--   kind          'travel'
--   amount        its own printed total, incl. GST — never a share of
--                 anything. A ₹37,500 travel invoice on a ₹10,00,000 PO
--                 is ₹37,500.
--   stage_percent NULL. It is not a share of the PO.
--   stage_no      NULL. It takes no place in the PO's 1, 2, 3 split, so
--                 the partial unique index below leaves PO numbering
--                 alone and two travel invoices never collide.
--   po_number     the PO it bills against, or NULL
--   project_id    the project it bills against, or NULL
--                 (at least one of the two; with both, the project is
--                 the PO's, filled and checked by the trigger below)
--   trigger_event 'Manual'. The invoice has been raised — there is no
--                 delivery or registration still to wait for, and a
--                 travel invoice reading 'Not Due' because its PO has no
--                 delivery date would be a lie.
-- =====================================================================

ALTER TABLE payment_stages
  ADD COLUMN IF NOT EXISTS kind       text NOT NULL DEFAULT 'po_stage',
  -- A travel invoice's own printed total. NULL on a po_stage, whose
  -- amount is po_value x stage_percent and is never stored.
  ADD COLUMN IF NOT EXISTS amount     numeric(16,2),
  -- The project a travel invoice bills, when it has no PO (#214 §9.2).
  ADD COLUMN IF NOT EXISTS project_id text REFERENCES projects(project_id)
                                             ON UPDATE CASCADE ON DELETE CASCADE;

-- The two kinds, and nothing else. Separate from the shape constraint so
-- that a bad kind says "kind" rather than failing an eight-line CASE.
ALTER TABLE payment_stages DROP CONSTRAINT IF EXISTS payment_stages_kind_check;
ALTER TABLE payment_stages
  ADD CONSTRAINT payment_stages_kind_check CHECK (kind IN ('po_stage', 'travel'));

-- What used to be three NOT NULLs becomes one rule per kind. A po_stage
-- still has all three, so nothing already in the table moves.
ALTER TABLE payment_stages ALTER COLUMN po_number     DROP NOT NULL;
ALTER TABLE payment_stages ALTER COLUMN stage_no      DROP NOT NULL;
ALTER TABLE payment_stages ALTER COLUMN stage_percent DROP NOT NULL;

ALTER TABLE payment_stages DROP CONSTRAINT IF EXISTS payment_stages_kind_shape;
ALTER TABLE payment_stages ADD CONSTRAINT payment_stages_kind_shape CHECK (
  CASE kind
    -- Exactly what the column NOT NULLs and CHECKs said before 097.
    WHEN 'po_stage' THEN po_number     IS NOT NULL
                     AND stage_no      IS NOT NULL AND stage_no > 0
                     AND stage_percent IS NOT NULL AND stage_percent > 0
                     AND amount        IS NULL
                     -- The PO carries the project. Two places to read it
                     -- from is two places for it to disagree.
                     AND project_id    IS NULL
    WHEN 'travel'   THEN (po_number IS NOT NULL OR project_id IS NOT NULL)
                     AND stage_no      IS NULL
                     AND stage_percent IS NULL
                     AND amount        IS NOT NULL AND amount > 0
                     AND trigger_event = 'Manual'
    ELSE false
  END
);

-- The PO's split stays 1, 2, 3 and unique. A travel invoice has no
-- stage_no at all, so it cannot take a number the split needs, and the
-- index no longer has anything to say about it.
ALTER TABLE payment_stages DROP CONSTRAINT IF EXISTS payment_stages_po_number_stage_no_key;
DROP INDEX IF EXISTS payment_stages_po_stage_no_key;
CREATE UNIQUE INDEX payment_stages_po_stage_no_key
  ON payment_stages (po_number, stage_no) WHERE kind = 'po_stage';

-- Read by the project-only travel invoice's own lookups and by
-- v_payment_stages' project resolution.
CREATE INDEX IF NOT EXISTS payment_stages_project_idx
  ON payment_stages (project_id) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS payment_stages_kind_idx
  ON payment_stages (kind) WHERE kind <> 'po_stage';

-- ---------------------------------------------------------------------
-- A travel invoice's project is the PO's, when it has one
-- ---------------------------------------------------------------------
--
-- A CHECK cannot read another table, so the one rule a CHECK could not
-- state lives here: with both a PO and a project, the project must be
-- the PO's. Given only a PO, the project is filled in, so
-- v_payment_stages and the trip rules can both read project_id without
-- having to join through the PO to find out.
CREATE OR REPLACE FUNCTION payment_stage_rules() RETURNS trigger AS $$
DECLARE po_project text;
BEGIN
  IF NEW.kind = 'travel' AND NEW.po_number IS NOT NULL THEN
    SELECT project_id INTO po_project FROM purchase_orders WHERE po_number = NEW.po_number;
    IF NEW.project_id IS NULL THEN
      NEW.project_id := po_project;
    ELSIF NEW.project_id IS DISTINCT FROM po_project THEN
      RAISE EXCEPTION 'Travel invoice % is on PO %, which belongs to project %, not %',
        COALESCE(NEW.invoice_no, '(no number)'), NEW.po_number, po_project, NEW.project_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'payment_stages_project_matches_po';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS payment_stages_rules ON payment_stages;
CREATE TRIGGER payment_stages_rules BEFORE INSERT OR UPDATE ON payment_stages
  FOR EACH ROW EXECUTE FUNCTION payment_stage_rules();

-- ---------------------------------------------------------------------
-- Which invoice may bill a trip
-- ---------------------------------------------------------------------
--
-- Before 097 `billed_stage_id` could point at any payment stage, and the
-- only thing stopping an ordinary PO stage being chosen was the Trip
-- screen's selector. Now the rule is the database's: a trip is billed on
-- a *travel* invoice, and on one raised for its own project.
--
-- A project is resolved the same way on both sides — the record's own,
-- or its PO's — so all four shapes work and no fifth one does:
--
--   PO trip        -> travel invoice on that PO            (same project)
--   PO trip        -> travel invoice on its project        (same project)
--   project trip   -> travel invoice on that project       (same project)
--   project trip   -> travel invoice on one of its POs     (same project)
--   anything       -> another client's travel invoice      refused
--   anything       -> an ordinary po_stage                 refused
--
-- Checked only when the link is being set or changed, never on an
-- unrelated edit, so a trip carrying a pre-097 link to an ordinary stage
-- can still be edited. Those links are left exactly as they are and
-- reported below; moving them is an administrator's job, not a
-- migration's.
CREATE OR REPLACE FUNCTION travel_log_rules() RETURNS trigger AS $$
DECLARE po_project text; is_chargeable boolean;
        st_kind text; st_po text; st_project text; trip_project text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.arranged_by IS DISTINCT FROM OLD.arranged_by AND NEW.vendor_id IS NOT DISTINCT FROM OLD.vendor_id THEN
    NEW.vendor_id := NULL;
  END IF;
  IF NEW.vendor_id IS NULL AND NULLIF(btrim(NEW.arranged_by), '') IS NOT NULL THEN
    SELECT id INTO NEW.vendor_id FROM travel_vendors WHERE lower(name) = lower(btrim(NEW.arranged_by)) ORDER BY id LIMIT 1;
  END IF;
  IF NEW.vendor_id IS NOT NULL THEN
    SELECT name INTO NEW.arranged_by FROM travel_vendors WHERE id = NEW.vendor_id;
  END IF;

  IF NEW.trip_type_id IS NULL THEN
    SELECT id INTO NEW.trip_type_id FROM trip_types
     WHERE active AND chargeable = (NEW.po_number IS NOT NULL OR NEW.project_id IS NOT NULL)
     -- The two the list starts with first, whatever has been added since.
     ORDER BY (name IN ('Chargeable', 'Non-chargeable')) DESC, sort_order, id LIMIT 1;
  END IF;

  IF NEW.po_number IS NOT NULL AND NEW.project_id IS NOT NULL THEN
    SELECT project_id INTO po_project FROM purchase_orders WHERE po_number = NEW.po_number;
    IF po_project IS DISTINCT FROM NEW.project_id THEN
      RAISE EXCEPTION 'Trip % is on PO %, which belongs to project %, not %', NEW.travel_id, NEW.po_number, po_project, NEW.project_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'travel_logs_project_matches_po';
    END IF;
  END IF;

  IF NEW.billed_stage_id IS NOT NULL THEN
    SELECT chargeable INTO is_chargeable FROM trip_types WHERE id = NEW.trip_type_id;
    IF NOT COALESCE(is_chargeable, false) THEN
      RAISE EXCEPTION 'Trip % is not a chargeable trip, so it was not billed to the client', NEW.travel_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'travel_logs_billed_only_chargeable';
    END IF;
  END IF;

  IF NEW.billed_stage_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.billed_stage_id IS DISTINCT FROM OLD.billed_stage_id) THEN
    SELECT kind, po_number, project_id INTO st_kind, st_po, st_project
      FROM payment_stages WHERE id = NEW.billed_stage_id;

    IF st_kind IS DISTINCT FROM 'travel' THEN
      RAISE EXCEPTION 'Trip % can only be billed on a travel invoice; payment stage % is an ordinary PO stage', NEW.travel_id, NEW.billed_stage_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'travel_logs_billed_on_travel_invoice';
    END IF;

    -- Both sides resolved the same way: the record's own project, or the
    -- project of the PO it is on.
    IF st_project IS NULL AND st_po IS NOT NULL THEN
      SELECT project_id INTO st_project FROM purchase_orders WHERE po_number = st_po;
    END IF;
    trip_project := NEW.project_id;
    IF trip_project IS NULL AND NEW.po_number IS NOT NULL THEN
      SELECT project_id INTO trip_project FROM purchase_orders WHERE po_number = NEW.po_number;
    END IF;

    IF st_project IS NULL OR trip_project IS NULL OR st_project IS DISTINCT FROM trip_project THEN
      RAISE EXCEPTION 'Travel invoice % belongs to project %, and trip % to project %', NEW.billed_stage_id, COALESCE(st_project, '(none)'), NEW.travel_id, COALESCE(trip_project, '(none)')
        USING ERRCODE = 'check_violation', CONSTRAINT = 'travel_logs_billed_same_project';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS travel_logs_rules ON travel_logs;
CREATE TRIGGER travel_logs_rules BEFORE INSERT OR UPDATE ON travel_logs
  FOR EACH ROW EXECUTE FUNCTION travel_log_rules();

-- ---------------------------------------------------------------------
-- The links that were made before this rule existed
-- ---------------------------------------------------------------------
--
-- Reported, never rewritten. A trip billed on an ordinary PO stage was a
-- reasonable thing to record when it was the only thing the screen
-- offered, and the figure it points at is real; which travel invoice it
-- should move to is a decision, not something a migration can infer.
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n
    FROM travel_logs t JOIN payment_stages s ON s.id = t.billed_stage_id
   WHERE s.kind <> 'travel';
  IF n > 0 THEN
    RAISE NOTICE 'Travel invoices (097): % trip(s) are billed on an ordinary PO payment stage, set before travel invoices existed. They are left exactly as they are; an administrator can move each onto a travel invoice from the trip page. New links of that shape are refused from now on.', n;
  ELSE
    RAISE NOTICE 'Travel invoices (097): no trip is billed on an ordinary PO payment stage.';
  END IF;
END $$;
