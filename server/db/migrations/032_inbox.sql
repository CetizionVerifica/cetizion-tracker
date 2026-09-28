-- 032 — a shared sales inbox (#30), on top of connected mailboxes (#29).
--
-- Each email thread in a shared mailbox becomes a conversation with an
-- owner, a status and a first-response deadline, and can be turned into an
-- enquiry. Owners are people's names until user accounts (#18).
--
-- Safe on a live database; running it a second time changes nothing.

CREATE TABLE IF NOT EXISTS inboxes (
  id                    serial PRIMARY KEY,
  name                  text NOT NULL,
  account_id            int NOT NULL UNIQUE REFERENCES connected_accounts(id) ON DELETE CASCADE,
  default_assignment    text NOT NULL DEFAULT 'owner_of_company'
                          CHECK (default_assignment IN ('owner_of_company','round_robin','unassigned')),
  members               text[] NOT NULL DEFAULT '{}',
  round_robin_last      text,
  first_response_hours  int,
  signature             text,
  active                boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS inbox_conversations (
  id                 serial PRIMARY KEY,
  inbox_id           int NOT NULL REFERENCES inboxes(id) ON DELETE CASCADE,
  thread_id          int NOT NULL UNIQUE REFERENCES email_threads(id) ON DELETE CASCADE,
  company_id         int REFERENCES companies(id) ON DELETE SET NULL,
  contact_id         int REFERENCES contacts(id) ON DELETE SET NULL,
  from_email         text,
  from_name          text,
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open','pending_client','snoozed','closed')),
  assignee           text,
  priority           text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high')),
  labels             text[] NOT NULL DEFAULT '{}',
  last_inbound_at    timestamptz,
  first_response_at  timestamptz,
  response_due_at    timestamptz,
  snoozed_until      timestamptz,
  closed_at          timestamptz,
  enquiry_no         text REFERENCES enquiries(enquiry_no) ON UPDATE CASCADE ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS inbox_conversations_queue_idx ON inbox_conversations (inbox_id, status, response_due_at);
CREATE INDEX IF NOT EXISTS inbox_conversations_assignee_idx ON inbox_conversations (assignee, status);

CREATE TABLE IF NOT EXISTS canned_responses (
  id          serial PRIMARY KEY,
  name        text NOT NULL,
  body        text NOT NULL,
  owner       text,
  shared      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS inboxes_set_updated_at ON inboxes;
CREATE TRIGGER inboxes_set_updated_at BEFORE UPDATE ON inboxes FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS inbox_conversations_set_updated_at ON inbox_conversations;
CREATE TRIGGER inbox_conversations_set_updated_at BEFORE UPDATE ON inbox_conversations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS canned_responses_set_updated_at ON canned_responses;
CREATE TRIGGER canned_responses_set_updated_at BEFORE UPDATE ON canned_responses FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO canned_responses (name, body, shared)
SELECT v.name, v.body, true FROM (VALUES
  ('Thanks, we will revert', E'Dear {{contact_name}},

Thank you for writing to Cetizion Verifica. We have noted your requirement and {{my_name}} will get back to you within one working day.

Regards,
{{my_name}}'),
  ('Request details for a quote', E'Dear {{contact_name}},

Thank you for your enquiry. To prepare a quotation, could you share the number of sites, the standards in scope and your preferred timeline?

Regards,
{{my_name}}')
) AS v(name, body)
WHERE NOT EXISTS (SELECT 1 FROM canned_responses c WHERE c.name = v.name);
