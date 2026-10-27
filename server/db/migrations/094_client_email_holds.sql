-- =====================================================================
-- 094_client_email_holds.sql
-- An admin can hold back the emails that would reach a client, on their
-- own, while the team's emails go out as usual (lib/clientEmails.js).
--
--   client_emails_hold_all   'true' holds every client email
--   client_emails_held       JSON list of the kinds held one by one
--
-- Held emails are written to email_log as suppressed, with the reason.
-- =====================================================================

INSERT INTO settings (key, value, notes) VALUES
  ('client_emails_hold_all', 'false', 'Hold every email that would go to a client: logged, never sent. Set under Settings, Client emails.'),
  ('client_emails_held', '[]', 'The kinds of client email held one by one, as a JSON list. Set under Settings, Client emails.')
ON CONFLICT (key) DO NOTHING;
