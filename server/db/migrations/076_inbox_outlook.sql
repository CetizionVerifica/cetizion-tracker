-- =====================================================================
-- 076_inbox_outlook.sql
-- The Inbox works like Outlook, step 1: sync foundations
-- (docs/inbox-outlook-plan.md §3.1, §3.5).
--
-- Everything added here is a fact from the provider, overwritten on each
-- sync and never computed by the tracker; Outlook stays the one source of
-- truth for mail state.
--
--   email_messages.folder_id      which folder the message is in now
--   email_messages.is_read        the mailbox's own read state
--   email_messages.flag_status    notFlagged / flagged / complete
--   email_messages.importance     low / normal / high
--   email_messages.bcc_emails     only on mail we sent
--   email_messages.removed_seen_at   when delta first reported it gone from
--                                    a folder: a move shows it again
--                                    elsewhere; ten minutes without that is
--                                    a delete (removed_at)
--   mail_folder_list              each mailbox's folders, as Outlook has
--                                 them, with Outlook's own unread counts
--   email_attachments             what is attached to a message, metadata
--                                 only: the file stays in Outlook
-- =====================================================================

ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS folder_id text;
ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS is_read boolean;
ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS flag_status text;
ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS importance text;
ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS bcc_emails text[];
ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS removed_seen_at timestamptz;
ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS removed_at timestamptz;
-- When the attachment list was last read from the provider; NULL with
-- has_attachments means it is still to be read (retried by the sync).
ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS attachments_listed_at timestamptz;

-- Whether a mailbox's stored message ids are Graph's immutable ids. Off for
-- every mailbox connected before 076; the first sync after it translates
-- the stored ids once (sync.js translateStoredIds) and switches this on.
ALTER TABLE connected_accounts ADD COLUMN IF NOT EXISTS immutable_ids boolean NOT NULL DEFAULT false;

ALTER TABLE email_messages DROP CONSTRAINT IF EXISTS email_messages_flag_status_check;
ALTER TABLE email_messages ADD CONSTRAINT email_messages_flag_status_check CHECK (flag_status IN ('notFlagged','flagged','complete'));
ALTER TABLE email_messages DROP CONSTRAINT IF EXISTS email_messages_importance_check;
ALTER TABLE email_messages ADD CONSTRAINT email_messages_importance_check CHECK (importance IN ('low','normal','high'));

CREATE INDEX IF NOT EXISTS email_messages_folder_idx ON email_messages (account_id, folder_id, sent_at DESC) WHERE removed_at IS NULL;

CREATE TABLE IF NOT EXISTS mail_folder_list (
  account_id     int NOT NULL REFERENCES connected_accounts(id) ON DELETE CASCADE,
  folder_id      text NOT NULL,
  parent_id      text,
  display_name   text NOT NULL,
  well_known     text,
  unread_count   int NOT NULL DEFAULT 0,
  total_count    int NOT NULL DEFAULT 0,
  synced_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, folder_id)
);

CREATE TABLE IF NOT EXISTS email_attachments (
  id            serial PRIMARY KEY,
  message_id    int NOT NULL REFERENCES email_messages(id) ON DELETE CASCADE,
  provider_id   text NOT NULL,
  -- Withheld (NULL) when the mailbox stores metadata only.
  name          text,
  content_type  text,
  size_bytes    int,
  is_inline     boolean NOT NULL DEFAULT false,
  content_id    text,
  UNIQUE (message_id, provider_id)
);
