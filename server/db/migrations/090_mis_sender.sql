-- =====================================================================
-- 090_mis_sender.sql
-- Who the scheduled reports are sent from
-- (/mnt/project-files/plans/mis-report-sender-plan.md, Part A).
--
--   connected_accounts.may_send_reports   a personal mailbox's owner allows
--                                         the reports to be sent from it.
--                                         A shared mailbox needs no switch.
--   email_log.from_email                  the From address an email carried.
--   report_runs.sent_from / sent_through  the From a report carried, and the
--                                         mailbox it went through (null for
--                                         SMTP).
--   mis_sender_address, mis_sender_name   Send As address and display name.
-- =====================================================================

ALTER TABLE connected_accounts ADD COLUMN IF NOT EXISTS may_send_reports boolean NOT NULL DEFAULT false;
ALTER TABLE email_log ADD COLUMN IF NOT EXISTS from_email text;
ALTER TABLE report_runs ADD COLUMN IF NOT EXISTS sent_from text;
ALTER TABLE report_runs ADD COLUMN IF NOT EXISTS sent_through int REFERENCES connected_accounts(id) ON DELETE SET NULL;

INSERT INTO settings (key, value, notes) VALUES
  ('mis_sender_address', 'none', 'Send the reports as this address: Send As in Exchange for a mailbox, or one of EMAIL_FROM_ALLOWED for SMTP. none: the mailbox''s own address.'),
  ('mis_sender_name', 'none', 'The display name on the reports'' From. none: the name the address already has.')
ON CONFLICT (key) DO NOTHING;

UPDATE settings SET notes = 'The connected mailbox the reports are sent through: a shared one, or a personal one whose owner allowed it. none: the SMTP sender.'
 WHERE key = 'mis_sender_account_id';
