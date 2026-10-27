-- =====================================================================
-- 095_email_attachment_kinds.sql
-- What kind of thing an email attachment is (docs/inbox-attachments-plan.md
-- step 2), so the Inbox's viewer can show an email forwarded as an
-- attachment and say what a OneDrive link is.
--
--   email_attachments.kind   file       a file (PDF, Word, a picture…)
--                            item       an Outlook item: an email forwarded
--                                       as an attachment
--                            reference  a link to a file in OneDrive or
--                                       SharePoint
--
-- Until now the sync listed files only. A message whose attachments were
-- all items or links was listed with none; its list is read again by the
-- next syncs (attachments_listed_at back to NULL, a few per sync).
-- =====================================================================

ALTER TABLE email_attachments ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'file';
ALTER TABLE email_attachments DROP CONSTRAINT IF EXISTS email_attachments_kind_check;
ALTER TABLE email_attachments ADD CONSTRAINT email_attachments_kind_check CHECK (kind IN ('file','item','reference'));

UPDATE email_messages m SET attachments_listed_at = NULL
 WHERE m.has_attachments AND m.attachments_listed_at IS NOT NULL AND m.removed_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM email_attachments x WHERE x.message_id = m.id);
