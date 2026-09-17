-- 012 — background jobs and email (#21).
--
-- email_log records every email the tracker composes, whether it was sent,
-- only logged (EMAIL_MODE=log), held back (sandbox, opt-out, kill switch)
-- or failed. job_runs records each scheduled or hand-started job run.
-- Two settings drive the reminders: the kill switch and the interval.
--
-- Safe on a live database; running it a second time changes nothing.

CREATE TABLE IF NOT EXISTS email_log (
  id                   serial PRIMARY KEY,
  to_email             text NOT NULL,
  cc                   text,
  subject              text NOT NULL,
  template             text NOT NULL,
  entity               text,
  entity_id            text,
  status               text NOT NULL DEFAULT 'queued'
                         CHECK (status IN ('queued','sent','failed','suppressed')),
  mode                 text,
  reason               text,
  provider_message_id  text,
  error                text,
  body_text            text,
  body_html            text,
  sent_by              text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  sent_at              timestamptz
);

CREATE INDEX IF NOT EXISTS email_log_entity_idx ON email_log (entity, entity_id);
CREATE INDEX IF NOT EXISTS email_log_created_idx ON email_log (created_at DESC);

CREATE TABLE IF NOT EXISTS job_runs (
  id           serial PRIMARY KEY,
  name         text NOT NULL,
  started_by   text NOT NULL DEFAULT 'schedule',
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  status       text NOT NULL DEFAULT 'running'
                 CHECK (status IN ('running','done','failed')),
  result       jsonb,
  error        text
);

CREATE INDEX IF NOT EXISTS job_runs_name_idx ON job_runs (name, started_at DESC);

INSERT INTO settings (key, value, notes) VALUES
  ('emails_enabled', 'true', 'Kill switch for every automatic email. Set to false to stop reminders and digests without changing the server.'),
  ('reminder_interval_days', '7', 'Days between payment reminders to the same client for the same overdue stage.'),
  ('reminder_grace_days', '3', 'Days after the due date before the first reminder goes out.')
ON CONFLICT (key) DO NOTHING;
