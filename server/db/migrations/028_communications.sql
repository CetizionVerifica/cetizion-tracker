-- 028 — one-click contact with every touch logged (#31, phase 1).
--
-- communications is the single log of calls, WhatsApp chats, meetings and
-- SMS made from the tracker (email stays in email_log and, later, #29).
-- Each touch stamps last_contacted_at on the contact, the company and the
-- enquiry or quotation it was about. Contacts carry their preferences.
--
-- Safe on a live database; running it a second time changes nothing.

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS whatsapp_number text;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS preferred_channel text;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS best_time_to_call text;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS do_not_contact boolean NOT NULL DEFAULT false;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS whatsapp_opt_in_at timestamptz;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS whatsapp_opt_in_source text;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS last_contacted_at timestamptz;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS last_contacted_at timestamptz;
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS last_contacted_at timestamptz;
ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS last_contacted_at timestamptz;

CREATE TABLE IF NOT EXISTS communications (
  id                 serial PRIMARY KEY,
  channel            text NOT NULL CHECK (channel IN ('call','whatsapp','meeting','sms','email','other')),
  direction          text NOT NULL DEFAULT 'outbound' CHECK (direction IN ('inbound','outbound')),
  outcome            text CHECK (outcome IN ('connected','no_answer','left_message','wrong_number','sent','held')),
  entity             text NOT NULL CHECK (entity IN ('company','contact','enquiry','quotation','project','purchase_order','payment_stage')),
  entity_id          text NOT NULL,
  company_id         int REFERENCES companies(id) ON DELETE SET NULL,
  contact_id         int REFERENCES contacts(id) ON DELETE SET NULL,
  username           text,
  started_at         timestamptz NOT NULL DEFAULT now(),
  duration_seconds   int CHECK (duration_seconds >= 0),
  summary            text,
  attendees          text,
  next_step_task_id  int REFERENCES tasks(id) ON DELETE SET NULL,
  provider           text NOT NULL DEFAULT 'manual',
  provider_ref       text,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS communications_entity_idx ON communications (entity, entity_id, started_at DESC);
CREATE INDEX IF NOT EXISTS communications_company_idx ON communications (company_id, started_at DESC);

-- A touch moves "last contacted" forward on everything it concerns.
CREATE OR REPLACE FUNCTION communication_touch() RETURNS trigger AS $$
BEGIN
  IF NEW.outcome IN ('no_answer','wrong_number') THEN
    RETURN NEW;
  END IF;
  UPDATE contacts SET last_contacted_at = GREATEST(COALESCE(last_contacted_at, NEW.started_at), NEW.started_at) WHERE id = NEW.contact_id;
  UPDATE companies SET last_contacted_at = GREATEST(COALESCE(last_contacted_at, NEW.started_at), NEW.started_at) WHERE id = NEW.company_id;
  IF NEW.entity = 'quotation' THEN
    UPDATE quotations SET last_contacted_at = GREATEST(COALESCE(last_contacted_at, NEW.started_at), NEW.started_at) WHERE quotation_no = NEW.entity_id;
  ELSIF NEW.entity = 'enquiry' THEN
    UPDATE enquiries SET last_contacted_at = GREATEST(COALESCE(last_contacted_at, NEW.started_at), NEW.started_at),
                         first_responded_at = COALESCE(first_responded_at, NEW.started_at)
     WHERE enquiry_no = NEW.entity_id;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS communication_touch ON communications;
CREATE TRIGGER communication_touch AFTER INSERT ON communications FOR EACH ROW EXECUTE FUNCTION communication_touch();

INSERT INTO settings (key, value, notes) VALUES
  ('no_contact_days', '7', 'Open deals and overdue invoices with no touch for this many days are listed under "No contact".')
ON CONFLICT (key) DO NOTHING;
