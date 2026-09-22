-- 039 — where operational alerts go (#38).
--
-- Failed jobs and backups, bursts of failed sign-ins, an expiring
-- certificate or a full disk are raised in the notification centre, sent
-- to this address, and reported to error tracking when SENTRY_DSN is set.
--
-- Safe on a live database; running it a second time changes nothing.

INSERT INTO settings (key, value, notes) VALUES
  ('alert_email', '', 'Who is emailed about failed jobs, backups, sign-in attacks, certificates and disk space. Blank: ALERT_EMAIL, else nobody.')
ON CONFLICT (key) DO NOTHING;
