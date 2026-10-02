-- =====================================================================
-- 072_email_reader_capacity.sql
-- The email readers read more at once and more in a day.
--
--   auto_enquiry_daily_ai_limit   1500 → 5000, only where it is still the
--                                 old default: a value an admin chose stays
--   email_reader_concurrency      new: how many emails each reader reads at
--                                 once (1 to 8, default 4)
-- =====================================================================

UPDATE settings
   SET value = '5000',
       notes = 'The most AI calls the email readers (enquiries, quotations, POs, invoices) may make in one day, together. Reading past mail stops for the day when it is reached.'
 WHERE key = 'auto_enquiry_daily_ai_limit' AND value = '1500';

INSERT INTO settings (key, value, notes) VALUES
  ('email_reader_concurrency', '4', 'How many emails each email reader reads at once, 1 to 8. Emails from one client or one conversation are still read one after another, oldest first.')
ON CONFLICT (key) DO NOTHING;
