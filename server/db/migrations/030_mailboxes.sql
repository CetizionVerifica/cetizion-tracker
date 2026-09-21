-- 030 — connected mailboxes: client email synced onto records (#29).
--
-- A person connects their Microsoft 365 mailbox (or a shared one). The
-- worker pulls new mail with Graph delta queries, keeps only threads with
-- people outside the company, matches them to contacts and companies, and
-- links each thread to the client's open deal. Tokens are encrypted at
-- rest; what is stored follows the mailbox's visibility level.
--
-- Safe on a live database; running it a second time changes nothing.

CREATE TABLE IF NOT EXISTS connected_accounts (
  id                 serial PRIMARY KEY,
  username           text NOT NULL,
  provider           text NOT NULL DEFAULT 'microsoft' CHECK (provider IN ('microsoft','imap','test')),
  email              text NOT NULL,
  display_name       text,
  is_shared          boolean NOT NULL DEFAULT false,
  tokens_encrypted   text,
  token_expires_at   timestamptz,
  scopes             text,
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active','needs_reconnect','disconnected')),
  visibility         text NOT NULL DEFAULT 'share_everything' CHECK (visibility IN ('metadata','subject','share_everything')),
  import_days        int NOT NULL DEFAULT 30 CHECK (import_days BETWEEN 0 AND 365),
  exclude_internal   boolean NOT NULL DEFAULT true,
  auto_create_contacts boolean NOT NULL DEFAULT true,
  last_synced_at     timestamptz,
  last_error         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS connected_accounts_email_key ON connected_accounts (lower(email)) WHERE status <> 'disconnected';

CREATE TABLE IF NOT EXISTS mail_folders (
  id                        serial PRIMARY KEY,
  account_id                int NOT NULL REFERENCES connected_accounts(id) ON DELETE CASCADE,
  folder                    text NOT NULL CHECK (folder IN ('inbox','sentitems')),
  delta_link                text,
  subscription_id           text,
  subscription_client_state text,
  subscription_expires_at   timestamptz,
  UNIQUE (account_id, folder)
);

CREATE TABLE IF NOT EXISTS email_threads (
  id               serial PRIMARY KEY,
  account_id       int NOT NULL REFERENCES connected_accounts(id) ON DELETE CASCADE,
  conversation_id  text NOT NULL,
  subject          text,
  company_id       int REFERENCES companies(id) ON DELETE SET NULL,
  contact_id       int REFERENCES contacts(id) ON DELETE SET NULL,
  entity           text CHECK (entity IN ('enquiry','quotation','project','purchase_order','payment_stage')),
  entity_id        text,
  first_message_at timestamptz,
  last_message_at  timestamptz,
  message_count    int NOT NULL DEFAULT 0,
  last_direction   text CHECK (last_direction IN ('inbound','outbound')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, conversation_id)
);

CREATE INDEX IF NOT EXISTS email_threads_company_idx ON email_threads (company_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS email_threads_entity_idx ON email_threads (entity, entity_id);

CREATE TABLE IF NOT EXISTS email_messages (
  id                   serial PRIMARY KEY,
  account_id           int NOT NULL REFERENCES connected_accounts(id) ON DELETE CASCADE,
  thread_id            int NOT NULL REFERENCES email_threads(id) ON DELETE CASCADE,
  provider_id          text NOT NULL,
  internet_message_id  text,
  direction            text NOT NULL CHECK (direction IN ('inbound','outbound')),
  from_email           text,
  from_name            text,
  to_emails            text[] NOT NULL DEFAULT '{}',
  cc_emails            text[] NOT NULL DEFAULT '{}',
  subject              text,
  snippet              text,
  body_html            text,
  has_attachments      boolean NOT NULL DEFAULT false,
  sent_at              timestamptz NOT NULL,
  company_id           int REFERENCES companies(id) ON DELETE SET NULL,
  contact_id           int REFERENCES contacts(id) ON DELETE SET NULL,
  sent_from_tracker_by text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, provider_id)
);

CREATE INDEX IF NOT EXISTS email_messages_thread_idx ON email_messages (thread_id, sent_at);

-- Addresses and domains never synced (newsletters, personal contacts).
CREATE TABLE IF NOT EXISTS email_blocklist (
  id          serial PRIMARY KEY,
  pattern     text NOT NULL UNIQUE,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS connected_accounts_set_updated_at ON connected_accounts;
CREATE TRIGGER connected_accounts_set_updated_at BEFORE UPDATE ON connected_accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A client email moves "last contacted" forward, like a logged touch (#31).
CREATE OR REPLACE FUNCTION email_message_touch() RETURNS trigger AS $$
DECLARE t email_threads%ROWTYPE;
BEGIN
  UPDATE contacts SET last_contacted_at = GREATEST(COALESCE(last_contacted_at, NEW.sent_at), NEW.sent_at) WHERE id = NEW.contact_id;
  UPDATE companies SET last_contacted_at = GREATEST(COALESCE(last_contacted_at, NEW.sent_at), NEW.sent_at) WHERE id = NEW.company_id;
  SELECT * INTO t FROM email_threads WHERE id = NEW.thread_id;
  IF t.entity = 'quotation' THEN
    UPDATE quotations SET last_contacted_at = GREATEST(COALESCE(last_contacted_at, NEW.sent_at), NEW.sent_at) WHERE quotation_no = t.entity_id;
  ELSIF t.entity = 'enquiry' THEN
    UPDATE enquiries SET last_contacted_at = GREATEST(COALESCE(last_contacted_at, NEW.sent_at), NEW.sent_at),
                         first_responded_at = CASE WHEN NEW.direction = 'outbound' THEN COALESCE(first_responded_at, NEW.sent_at) ELSE first_responded_at END
     WHERE enquiry_no = t.entity_id;
  END IF;
  UPDATE email_threads SET message_count = message_count + 1,
         first_message_at = LEAST(COALESCE(first_message_at, NEW.sent_at), NEW.sent_at),
         last_message_at = GREATEST(COALESCE(last_message_at, NEW.sent_at), NEW.sent_at),
         last_direction = CASE WHEN last_message_at IS NULL OR NEW.sent_at >= last_message_at THEN NEW.direction ELSE last_direction END
   WHERE id = NEW.thread_id;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS email_message_touch ON email_messages;
CREATE TRIGGER email_message_touch AFTER INSERT ON email_messages FOR EACH ROW EXECUTE FUNCTION email_message_touch();

INSERT INTO settings (key, value, notes) VALUES
  ('internal_email_domains', 'cetizionverifica.com', 'Our own email domains, comma separated. Mail only between these addresses is never synced.')
ON CONFLICT (key) DO NOTHING;
