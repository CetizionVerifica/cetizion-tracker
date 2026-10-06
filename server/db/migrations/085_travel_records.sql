-- =====================================================================
-- 085_travel_records.sql
-- The travel desk's records (#196 §4): what HR's monthly travel workbook
-- holds, typed once each.
--
--   travel_vendors       the agency's GSTIN, contacts, payment terms and the
--                        prefixes of its invoice numbers (HT/2627/…), which
--                        is how the importer recognises it.
--   trip_types           a Settings list (Chargeable, Non-chargeable,
--                        Marketing, Internal) with a chargeable flag.
--   projects.service_request_no
--                        CV108: how a trip with no PO finds its project.
--   travel_logs          the vendor by id, a project when there is no PO,
--                        the traveller as staff, trip type, origin, booking
--                        date, cancelled, the payment stage that billed it to
--                        the client, and a client label for internal travel.
--   travel_segments      the legs: flights, trains, buses, cabs, hotels.
--   travel_vendor_invoices
--                        a header now: vendor, the PDF, GSTIN as printed,
--                        place of supply; travel_id kept for old rows only.
--   travel_vendor_invoice_lines
--                        one per leg billed, so one invoice covers several
--                        trips and people. The header's total follows them.
--   travel_vendor_credit_notes
--                        credit and cancellation notes against an invoice.
--   attachments          files on trips and vendor invoices, with a kind.
--
-- Existing data: every vendor typed in arranged_by becomes a vendor; every
-- trip gets a type (Chargeable with a PO, Non-chargeable without); every
-- invoice gets its vendor and one line. Invoices recorded twice under one
-- vendor and number (one bill covering two trips, before an invoice could)
-- become one invoice with a line per trip, amounts and payments summed.
-- =====================================================================

-- ---------------------------------------------------------------- vendors
ALTER TABLE travel_vendors
  ADD COLUMN IF NOT EXISTS gstin text,
  ADD COLUMN IF NOT EXISTS pan text,
  ADD COLUMN IF NOT EXISTS contact_name text,
  ADD COLUMN IF NOT EXISTS email text,
  ADD COLUMN IF NOT EXISTS phone text,
  ADD COLUMN IF NOT EXISTS address text,
  ADD COLUMN IF NOT EXISTS payment_terms_days int NOT NULL DEFAULT 30 CHECK (payment_terms_days >= 0),
  ADD COLUMN IF NOT EXISTS invoice_prefixes text[] NOT NULL DEFAULT '{}';

-- ---------------------------------------------------------------- trip types
CREATE TABLE IF NOT EXISTS trip_types (
  id          serial PRIMARY KEY,
  name        text NOT NULL UNIQUE,
  -- Billable to the client: a chargeable trip may name the payment stage
  -- that billed it, and one with no PO or project is flagged.
  chargeable  boolean NOT NULL DEFAULT false,
  active      boolean NOT NULL DEFAULT true,
  sort_order  int NOT NULL DEFAULT 0
);
INSERT INTO trip_types (name, chargeable, sort_order) VALUES
  ('Chargeable', true, 1), ('Non-chargeable', false, 2), ('Marketing', false, 3), ('Internal', false, 4)
ON CONFLICT (name) DO NOTHING;

-- ---------------------------------------------------------------- projects
-- "Service Request No." (CV108, CV 122) only finds a trip's project: kept
-- once, on the project, upper case without spaces.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS service_request_no text;
CREATE OR REPLACE FUNCTION normalise_service_request_no() RETURNS trigger AS $$
BEGIN
  NEW.service_request_no := NULLIF(upper(regexp_replace(COALESCE(NEW.service_request_no, ''), '\s+', '', 'g')), '');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS projects_service_request_no ON projects;
CREATE TRIGGER projects_service_request_no BEFORE INSERT OR UPDATE OF service_request_no ON projects
  FOR EACH ROW EXECUTE FUNCTION normalise_service_request_no();
CREATE UNIQUE INDEX IF NOT EXISTS projects_service_request_no_key ON projects (service_request_no) WHERE service_request_no IS NOT NULL;

-- ---------------------------------------------------------------- trips
ALTER TABLE travel_logs
  ADD COLUMN IF NOT EXISTS vendor_id        int REFERENCES travel_vendors(id),
  ADD COLUMN IF NOT EXISTS project_id       text REFERENCES projects(project_id) ON UPDATE CASCADE,
  ADD COLUMN IF NOT EXISTS staff_id         int REFERENCES staff(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS trip_type_id     int REFERENCES trip_types(id),
  ADD COLUMN IF NOT EXISTS origin           text,
  ADD COLUMN IF NOT EXISTS booking_date     date,
  ADD COLUMN IF NOT EXISTS cancelled        boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS billed_stage_id  int REFERENCES payment_stages(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS client_label     text;
CREATE INDEX IF NOT EXISTS travel_logs_project_idx ON travel_logs (project_id) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS travel_logs_vendor_idx ON travel_logs (vendor_id) WHERE vendor_id IS NOT NULL;

-- Every vendor already typed against a trip, once, by its first spelling.
INSERT INTO travel_vendors (name)
SELECT DISTINCT ON (lower(btrim(t.arranged_by))) btrim(t.arranged_by)
  FROM travel_logs t
 WHERE NULLIF(btrim(t.arranged_by), '') IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM travel_vendors v WHERE lower(v.name) = lower(btrim(t.arranged_by)))
 ORDER BY lower(btrim(t.arranged_by)), t.id
ON CONFLICT (name) DO NOTHING;
UPDATE travel_logs t SET vendor_id = v.id
  FROM travel_vendors v
 WHERE t.vendor_id IS NULL AND lower(v.name) = lower(btrim(t.arranged_by));

/**
 * A trip's own rules, on every write:
 *   the vendor  by id; the old free-text arranged_by finds a vendor of that
 *               name, and arranged_by then always says the vendor's name;
 *   the type    a trip saved without one is Chargeable when it has a PO or
 *               a project, Non-chargeable otherwise (the importer's rule);
 *   the project typed once: with a PO it is the PO's, so a different one is
 *               refused;
 *   billing     only a chargeable trip names the stage that billed it.
 */
CREATE OR REPLACE FUNCTION travel_log_rules() RETURNS trigger AS $$
DECLARE po_project text; is_chargeable boolean;
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
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS travel_logs_rules ON travel_logs;
CREATE TRIGGER travel_logs_rules BEFORE INSERT OR UPDATE ON travel_logs
  FOR EACH ROW EXECUTE FUNCTION travel_log_rules();

UPDATE travel_logs t SET trip_type_id = (SELECT id FROM trip_types WHERE name = CASE WHEN t.po_number IS NOT NULL THEN 'Chargeable' ELSE 'Non-chargeable' END)
 WHERE t.trip_type_id IS NULL;
ALTER TABLE travel_logs ALTER COLUMN trip_type_id SET NOT NULL;

-- ---------------------------------------------------------------- legs
CREATE TABLE IF NOT EXISTS travel_segments (
  id           serial PRIMARY KEY,
  travel_id    text NOT NULL REFERENCES travel_logs(travel_id) ON UPDATE CASCADE ON DELETE CASCADE,
  seq          int NOT NULL DEFAULT 1,
  mode         text NOT NULL CHECK (mode IN ('flight','train','bus','cab','hotel','other')),
  from_place   text,
  -- For a hotel, the city.
  to_place     text,
  -- The journey date; for a hotel, check-in and check-out.
  start_date   date,
  end_date     date,
  start_time   time,
  end_time     time,
  -- Airline, railway, cab company, hotel.
  provider     text,
  service_no   text,
  travel_class text,
  pnr_or_ref   text,
  rooms        int CHECK (rooms > 0),
  guests       int CHECK (guests > 0),
  status       text NOT NULL DEFAULT 'booked' CHECK (status IN ('booked','cancelled','partly_refunded')),
  remarks      text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT travel_segments_hotel_nights CHECK (mode <> 'hotel' OR (end_date IS NOT NULL AND start_date IS NOT NULL AND end_date > start_date))
);
CREATE INDEX IF NOT EXISTS travel_segments_trip_idx ON travel_segments (travel_id, seq);
DROP TRIGGER IF EXISTS travel_segments_set_updated_at ON travel_segments;
CREATE TRIGGER travel_segments_set_updated_at BEFORE UPDATE ON travel_segments FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------- vendor invoices
ALTER TABLE travel_vendor_invoices
  ADD COLUMN IF NOT EXISTS vendor_id               int REFERENCES travel_vendors(id),
  ADD COLUMN IF NOT EXISTS document_id             int UNIQUE REFERENCES documents(id),
  ADD COLUMN IF NOT EXISTS vendor_gstin_on_invoice text,
  ADD COLUMN IF NOT EXISTS place_of_supply         text;
-- The trip an invoice was for, before an invoice could cover several: old rows only.
ALTER TABLE travel_vendor_invoices ALTER COLUMN travel_id DROP NOT NULL;

/** The vendor an invoice falls back to when neither it nor its trip names one: inactive, so never offered. */
CREATE OR REPLACE FUNCTION travel_vendor_not_recorded() RETURNS int AS $$
DECLARE v int;
BEGIN
  SELECT id INTO v FROM travel_vendors WHERE name = 'Vendor not recorded';
  IF v IS NULL THEN
    INSERT INTO travel_vendors (name, active) VALUES ('Vendor not recorded', false)
    ON CONFLICT (name) DO NOTHING RETURNING id INTO v;
    IF v IS NULL THEN SELECT id INTO v FROM travel_vendors WHERE name = 'Vendor not recorded'; END IF;
  END IF;
  RETURN v;
END;
$$ LANGUAGE plpgsql;

UPDATE travel_vendor_invoices vi SET vendor_id = t.vendor_id
  FROM travel_logs t WHERE vi.vendor_id IS NULL AND t.travel_id = vi.travel_id AND t.vendor_id IS NOT NULL;
UPDATE travel_vendor_invoices SET vendor_id = travel_vendor_not_recorded() WHERE vendor_id IS NULL;

CREATE TABLE IF NOT EXISTS travel_vendor_invoice_lines (
  id                 serial PRIMARY KEY,
  vendor_invoice_id  int NOT NULL REFERENCES travel_vendor_invoices(id) ON DELETE CASCADE,
  travel_id          text NOT NULL REFERENCES travel_logs(travel_id) ON UPDATE CASCADE ON DELETE CASCADE,
  segment_id         int REFERENCES travel_segments(id) ON DELETE SET NULL,
  base_fare          numeric(16,2),
  service_charge     numeric(16,2),
  gst_amount         numeric(16,2),
  gst_rate           numeric(5,2),
  -- As the vendor printed it; the importer checks it against fare + charge + GST.
  line_total         numeric(16,2),
  remarks            text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS travel_vendor_invoice_lines_invoice_idx ON travel_vendor_invoice_lines (vendor_invoice_id);
CREATE INDEX IF NOT EXISTS travel_vendor_invoice_lines_trip_idx ON travel_vendor_invoice_lines (travel_id);
DROP TRIGGER IF EXISTS travel_vendor_invoice_lines_set_updated_at ON travel_vendor_invoice_lines;
CREATE TRIGGER travel_vendor_invoice_lines_set_updated_at BEFORE UPDATE ON travel_vendor_invoice_lines FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- One line for every invoice there was, for the trip it was entered against.
INSERT INTO travel_vendor_invoice_lines (vendor_invoice_id, travel_id, line_total)
SELECT vi.id, vi.travel_id, vi.invoice_amount FROM travel_vendor_invoices vi
 WHERE vi.travel_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM travel_vendor_invoice_lines l WHERE l.vendor_invoice_id = vi.id);

-- One bill entered twice (once per trip it covered): one invoice, a line per trip.
DO $$
DECLARE g record; keep int;
BEGIN
  FOR g IN
    SELECT vendor_id, lower(btrim(vendor_invoice_no)) AS no, array_agg(id ORDER BY id) AS ids
      FROM travel_vendor_invoices
     WHERE NULLIF(btrim(vendor_invoice_no), '') IS NOT NULL
     GROUP BY vendor_id, lower(btrim(vendor_invoice_no)) HAVING count(*) > 1
  LOOP
    keep := g.ids[1];
    UPDATE travel_vendor_invoices k SET
           invoice_amount = s.amount, amount_paid = s.paid, payment_date = s.paid_on,
           invoice_date = COALESCE(k.invoice_date, s.dated),
           remarks = NULLIF(concat_ws(' ', k.remarks, 'Merged from ' || s.merged || ': one bill entered once per trip (085).'), ''),
           travel_id = NULL
      FROM (SELECT CASE WHEN count(invoice_amount) > 0 THEN sum(invoice_amount) END AS amount, sum(amount_paid) AS paid,
                   max(payment_date) AS paid_on, min(invoice_date) AS dated,
                   string_agg(vendor_invoice_id, ', ' ORDER BY id) FILTER (WHERE id <> keep) AS merged
              FROM travel_vendor_invoices WHERE id = ANY(g.ids)) s
     WHERE k.id = keep;
    UPDATE travel_vendor_invoice_lines SET vendor_invoice_id = keep WHERE vendor_invoice_id = ANY(g.ids[2:]);
    DELETE FROM travel_vendor_invoices WHERE id = ANY(g.ids[2:]);
    RAISE NOTICE 'Vendor invoice % entered % times: now one invoice with a line per trip', g.no, array_length(g.ids, 1);
  END LOOP;
END $$;

ALTER TABLE travel_vendor_invoices ALTER COLUMN vendor_id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS travel_vendor_invoices_vendor_no_key
  ON travel_vendor_invoices (vendor_id, vendor_invoice_no) WHERE vendor_invoice_no IS NOT NULL;
CREATE INDEX IF NOT EXISTS travel_vendor_invoices_vendor_idx ON travel_vendor_invoices (vendor_id);

/** An invoice's total follows its lines once they carry amounts (like quotation_totals). */
CREATE OR REPLACE FUNCTION travel_invoice_total(p_invoice int) RETURNS void AS $$
  UPDATE travel_vendor_invoices vi SET invoice_amount = s.total
    FROM (SELECT sum(line_total) AS total, count(line_total) AS n
            FROM travel_vendor_invoice_lines WHERE vendor_invoice_id = p_invoice) s
   WHERE vi.id = p_invoice AND s.n > 0 AND vi.invoice_amount IS DISTINCT FROM s.total;
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION travel_invoice_lines_changed() RETURNS trigger AS $$
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') THEN PERFORM travel_invoice_total(OLD.vendor_invoice_id); END IF;
  IF TG_OP IN ('INSERT','UPDATE') AND (TG_OP = 'INSERT' OR NEW.vendor_invoice_id <> OLD.vendor_invoice_id) THEN
    PERFORM travel_invoice_total(NEW.vendor_invoice_id);
  ELSIF TG_OP = 'UPDATE' THEN
    PERFORM travel_invoice_total(NEW.vendor_invoice_id);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS travel_vendor_invoice_lines_total ON travel_vendor_invoice_lines;
CREATE TRIGGER travel_vendor_invoice_lines_total AFTER INSERT OR UPDATE OR DELETE ON travel_vendor_invoice_lines
  FOR EACH ROW EXECUTE FUNCTION travel_invoice_lines_changed();

/**
 * An invoice written the way it always was, against one trip: its vendor
 * from the trip, and its one line. Changing a one-line invoice's amount or
 * trip changes the line; an invoice of several lines is changed through them.
 */
CREATE OR REPLACE FUNCTION travel_invoice_header_before() RETURNS trigger AS $$
BEGIN
  IF NEW.vendor_id IS NULL AND NEW.travel_id IS NOT NULL THEN
    SELECT vendor_id INTO NEW.vendor_id FROM travel_logs WHERE travel_id = NEW.travel_id;
  END IF;
  IF NEW.vendor_id IS NULL THEN NEW.vendor_id := travel_vendor_not_recorded(); END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS travel_vendor_invoices_before ON travel_vendor_invoices;
CREATE TRIGGER travel_vendor_invoices_before BEFORE INSERT OR UPDATE ON travel_vendor_invoices
  FOR EACH ROW EXECUTE FUNCTION travel_invoice_header_before();

CREATE OR REPLACE FUNCTION travel_invoice_header_after() RETURNS trigger AS $$
DECLARE n int;
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN NULL; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.travel_id IS NOT NULL THEN
      INSERT INTO travel_vendor_invoice_lines (vendor_invoice_id, travel_id, line_total) VALUES (NEW.id, NEW.travel_id, NEW.invoice_amount);
    END IF;
    RETURN NULL;
  END IF;
  IF NEW.invoice_amount IS NOT DISTINCT FROM OLD.invoice_amount AND NEW.travel_id IS NOT DISTINCT FROM OLD.travel_id THEN RETURN NULL; END IF;
  SELECT count(*) INTO n FROM travel_vendor_invoice_lines WHERE vendor_invoice_id = NEW.id;
  IF n = 1 THEN
    UPDATE travel_vendor_invoice_lines SET line_total = NEW.invoice_amount, travel_id = COALESCE(NEW.travel_id, travel_id)
     WHERE vendor_invoice_id = NEW.id;
  ELSIF n = 0 AND NEW.travel_id IS NOT NULL THEN
    INSERT INTO travel_vendor_invoice_lines (vendor_invoice_id, travel_id, line_total) VALUES (NEW.id, NEW.travel_id, NEW.invoice_amount);
  ELSIF n > 1 AND NEW.invoice_amount IS DISTINCT FROM OLD.invoice_amount THEN
    RAISE EXCEPTION 'Vendor invoice % has % lines: change the lines, and its total follows', NEW.vendor_invoice_id, n
      USING ERRCODE = 'check_violation', CONSTRAINT = 'travel_vendor_invoices_total_from_lines';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS travel_vendor_invoices_after ON travel_vendor_invoices;
CREATE TRIGGER travel_vendor_invoices_after AFTER INSERT OR UPDATE ON travel_vendor_invoices
  FOR EACH ROW EXECUTE FUNCTION travel_invoice_header_after();

-- ---------------------------------------------------------------- credit notes
CREATE TABLE IF NOT EXISTS travel_vendor_credit_notes (
  id                    serial PRIMARY KEY,
  vendor_id             int NOT NULL REFERENCES travel_vendors(id),
  credit_note_no        text NOT NULL,
  credit_note_date      date,
  against_invoice_id    int REFERENCES travel_vendor_invoices(id) ON DELETE CASCADE,
  -- The leg it cancels or refunds, when it names one.
  segment_id            int REFERENCES travel_segments(id) ON DELETE SET NULL,
  kind                  text NOT NULL DEFAULT 'credit_note' CHECK (kind IN ('credit_note','cancellation_note')),
  -- Money the vendor gives back; what it kept is the cancellation charge.
  refund_amount         numeric(16,2) NOT NULL DEFAULT 0 CHECK (refund_amount >= 0),
  cancellation_charges  numeric(16,2) CHECK (cancellation_charges >= 0),
  remarks               text,
  document_id           int UNIQUE REFERENCES documents(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vendor_id, credit_note_no)
);
CREATE INDEX IF NOT EXISTS travel_vendor_credit_notes_invoice_idx ON travel_vendor_credit_notes (against_invoice_id);
DROP TRIGGER IF EXISTS travel_vendor_credit_notes_set_updated_at ON travel_vendor_credit_notes;
CREATE TRIGGER travel_vendor_credit_notes_set_updated_at BEFORE UPDATE ON travel_vendor_credit_notes FOR EACH ROW EXECUTE FUNCTION set_updated_at();

/** A credit note on a leg marks it: cancelled by a cancellation note, partly refunded by a credit note. */
CREATE OR REPLACE FUNCTION travel_credit_note_marks_leg() RETURNS trigger AS $$
BEGIN
  IF NEW.segment_id IS NOT NULL THEN
    UPDATE travel_segments SET status = CASE NEW.kind WHEN 'cancellation_note' THEN 'cancelled' ELSE 'partly_refunded' END
     WHERE id = NEW.segment_id AND status <> CASE NEW.kind WHEN 'cancellation_note' THEN 'cancelled' ELSE 'partly_refunded' END;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS travel_vendor_credit_notes_mark_leg ON travel_vendor_credit_notes;
CREATE TRIGGER travel_vendor_credit_notes_mark_leg AFTER INSERT OR UPDATE OF segment_id, kind ON travel_vendor_credit_notes
  FOR EACH ROW EXECUTE FUNCTION travel_credit_note_marks_leg();

-- ---------------------------------------------------------------- files
ALTER TABLE attachments DROP CONSTRAINT IF EXISTS attachments_entity_check;
ALTER TABLE attachments ADD CONSTRAINT attachments_entity_check CHECK (entity IN
  ('company','contact','enquiry','quotation','project','purchase_order','payment_stage','travel_log','travel_vendor_invoice'));
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS doc_type text
  CHECK (doc_type IN ('ticket','boarding_pass','vendor_invoice','credit_note','hotel_bill','visa','travel_approval','other'));
