-- =====================================================================
-- 088_portal_emails.sql
-- The emails that bring clients into the portal (#198 phase 3, G6).
--
--   portal_notify_new_invoice   when an invoice is recorded, its company's
--                               portal contacts are told it is in the
--                               portal (decision 4: on by default).
--   portal_link_in_reminders    payment reminders to a portal contact end
--                               with the portal's address.
--
-- Both only for a company with the portal switched on; an admin turns
-- either off in Settings → Client portal.
-- =====================================================================

INSERT INTO settings (key, value, notes) VALUES
  ('portal_notify_new_invoice', 'true', 'Email a client''s portal contacts when an invoice is recorded for them, with the portal''s address. Only for clients with the portal and its Invoices section on.'),
  ('portal_link_in_reminders', 'true', 'End payment reminders with the client portal''s address, when the client can sign in to it.')
ON CONFLICT (key) DO NOTHING;
