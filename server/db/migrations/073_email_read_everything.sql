-- =====================================================================
-- 073_email_read_everything.sql
-- The email readers read every email, in every folder.
--
--   email_read_everything        new, on: no email is screened out by the
--                                free rules (replies, newsletters, robots,
--                                mail with no PO or invoice words); every
--                                one goes to the AI, which decides. The
--                                duplicate guards stay.
--   mail_folders.folder          any folder of the mailbox, not only Inbox
--                                and Sent Items: Archive and the folders
--                                people file client mail into. Junk Email,
--                                Deleted Items, Drafts and Outbox stay out
--                                (microsoft.js).
--   mailbox_enquiry_backfills    'all': past mail read as one stream across
--                                those folders, oldest first.
--
-- Mail between our own people and from automatic senders is read too, by
-- the readers only (rules.js forReaders): the Inbox keeps filtering it, so
-- a colleague's note never counts as answering a client.
-- =====================================================================

INSERT INTO settings (key, value, notes) VALUES
  ('email_read_everything', 'true', 'Read every email in every folder (except Junk, Deleted Items, Drafts and Outbox), replies included: the AI decides what each one is. Off puts back the free rules that skip replies, newsletters, automatic senders and mail with no PO or invoice words, which saves AI calls.')
ON CONFLICT (key) DO NOTHING;

ALTER TABLE mail_folders DROP CONSTRAINT IF EXISTS mail_folders_folder_check;

ALTER TABLE mailbox_enquiry_backfills DROP CONSTRAINT IF EXISTS mailbox_enquiry_backfills_folder_check;
ALTER TABLE mailbox_enquiry_backfills ADD CONSTRAINT mailbox_enquiry_backfills_folder_check CHECK (folder IN ('inbox','sentitems','all'));

-- A message moved between folders gets a new id from Outlook; it is known
-- again by its Internet Message-ID (sync.js ingestOne).
CREATE INDEX IF NOT EXISTS email_messages_internet_message_idx ON email_messages (account_id, lower(internet_message_id)) WHERE internet_message_id IS NOT NULL;
