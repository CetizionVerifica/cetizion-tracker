-- 021 — enquiries as leads (#24): qualification statuses, sources,
-- follow-ups, an estimate, and a reason when one is dropped.
--
-- Statuses: New -> Contacted -> Qualified -> Converted, or Unqualified
-- (with a reason) or Nurture (come back later). The old ones map across:
-- In Progress -> Contacted, Declined -> Unqualified,
-- Won - Quotation Sent -> Converted.
--
-- Safe on a live database; running it a second time changes nothing.

CREATE TABLE IF NOT EXISTS lead_sources (
  id          serial PRIMARY KEY,
  name        text NOT NULL UNIQUE,
  active      boolean NOT NULL DEFAULT true,
  sort_order  int NOT NULL DEFAULT 0
);

INSERT INTO lead_sources (name, sort_order) VALUES
  ('Existing client', 1), ('Referral', 2), ('Website', 3), ('Inbound email or call', 4),
  ('Event or webinar', 5), ('Partner or certification body', 6), ('Outreach', 7), ('Other', 8)
ON CONFLICT (name) DO NOTHING;

ALTER TABLE enquiries
  ADD COLUMN IF NOT EXISTS source_id int REFERENCES lead_sources(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS estimated_value numeric(16,2),
  ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'INR',
  ADD COLUMN IF NOT EXISTS expected_decision_date date,
  ADD COLUMN IF NOT EXISTS next_follow_up_at date,
  ADD COLUMN IF NOT EXISTS first_responded_at timestamptz,
  ADD COLUMN IF NOT EXISTS unqualified_reason_id int REFERENCES lost_reasons(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS unqualified_notes text,
  ADD COLUMN IF NOT EXISTS services_interested text,
  ADD COLUMN IF NOT EXISTS notes text,
  ADD COLUMN IF NOT EXISTS converted_at timestamptz;

CREATE INDEX IF NOT EXISTS enquiries_follow_up_idx ON enquiries (next_follow_up_at);

ALTER TABLE enquiries DROP CONSTRAINT IF EXISTS enquiries_status_check;
UPDATE enquiries SET status = CASE status
  WHEN 'In Progress' THEN 'Contacted'
  WHEN 'Declined' THEN 'Unqualified'
  WHEN 'Won - Quotation Sent' THEN 'Converted'
  ELSE status END
 WHERE status IN ('In Progress', 'Declined', 'Won - Quotation Sent');
ALTER TABLE enquiries ALTER COLUMN status SET DEFAULT 'New';
ALTER TABLE enquiries ADD CONSTRAINT enquiries_status_check
  CHECK (status IN ('New','Contacted','Qualified','Nurture','Converted','Unqualified'));

-- Stamps: the first response, the conversion, and a default follow-up date.
CREATE OR REPLACE FUNCTION enquiry_stamps() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status = 'New' AND NEW.status <> 'New' AND NEW.first_responded_at IS NULL THEN
    NEW.first_responded_at := now();
  END IF;
  IF NEW.status = 'Converted' AND (TG_OP = 'INSERT' OR OLD.status <> 'Converted') THEN
    NEW.converted_at := COALESCE(NEW.converted_at, now());
  END IF;
  IF NEW.status IN ('Converted', 'Unqualified') THEN
    NEW.next_follow_up_at := NULL;
  ELSIF NEW.next_follow_up_at IS NULL AND (TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status) THEN
    NEW.next_follow_up_at := CURRENT_DATE + (setting_num('lead_follow_up_default_days', 3))::int;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS c_enquiry_stamps ON enquiries;
CREATE TRIGGER c_enquiry_stamps BEFORE INSERT OR UPDATE ON enquiries
  FOR EACH ROW EXECUTE FUNCTION enquiry_stamps();

INSERT INTO settings (key, value, notes) VALUES
  ('lead_first_response_hours', '24', 'Target hours from a new enquiry to the first contact. Enquiries past it are flagged.'),
  ('lead_follow_up_default_days', '3', 'Days ahead the next follow-up is set when an enquiry is created or moves stage without one.')
ON CONFLICT (key) DO NOTHING;
