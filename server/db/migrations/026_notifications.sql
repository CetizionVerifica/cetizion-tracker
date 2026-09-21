-- 026 — a notification centre and a daily digest (#44).
--
-- One row per thing a person should know: a task due, a follow-up, an
-- approval waiting, an invoice gone overdue, a renewal opened, a quotation
-- about to expire. The daily job writes them; actions in the app write
-- some as they happen. Addressed by username until user accounts (#18).
--
-- Safe on a live database; running it a second time changes nothing.

CREATE TABLE IF NOT EXISTS notifications (
  id          serial PRIMARY KEY,
  username    text NOT NULL DEFAULT 'admin',
  kind        text NOT NULL,
  title       text NOT NULL,
  body        text,
  entity      text,
  entity_id   text,
  link        text,
  dedupe_key  text,
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (username, read_at, created_at DESC);
-- The same thing is not raised twice on the same day.
CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedupe_key ON notifications (dedupe_key) WHERE dedupe_key IS NOT NULL;

INSERT INTO settings (key, value, notes) VALUES
  ('digest_email', '', 'Where the daily digest goes. Blank: the finance email.'),
  ('quotation_expiry_warning_days', '7', 'Days before a quotation expires at which its owner is told.')
ON CONFLICT (key) DO NOTHING;
