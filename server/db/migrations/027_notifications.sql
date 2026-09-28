-- 027 — a notification centre and a daily digest (#44).
--
-- One row per thing a person should know: a task due, a follow-up, an
-- approval waiting, an invoice gone overdue, a renewal opened, a quotation
-- about to expire. The daily job writes them; actions in the app write
-- some as they happen. Addressed to a person where the record names one
-- -- a task's assignee, an enquiry's sales person -- and to NULL,
-- meaning everyone, where it does not. Everyone is the honest default
-- for a backup that failed or an invoice gone overdue: there is no one
-- person those are for.
--
-- Safe on a live database; running it a second time changes nothing.

CREATE TABLE IF NOT EXISTS notifications (
  id          serial PRIMARY KEY,
  -- NULL means everyone. A name here is what the tracker records (a sales
  -- person, an assignee), and the reader is matched on their account name
  -- as well as their sign-in address, so either spelling finds them.
  username    text,
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

-- Who has read what. A notification addressed to nobody is everyone's, and
-- a single read_at on a shared row would mean the first person to look
-- cleared it for the whole team. Read state belongs to the reader, so it
-- lives here rather than on the row. read_at on the row survives for the
-- digest, which asks whether anyone has seen a thing at all.
CREATE TABLE IF NOT EXISTS notification_reads (
  notification_id int NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  reader          text NOT NULL,
  read_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (notification_id, reader)
);

CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (username, read_at, created_at DESC);
-- The same thing is not raised twice on the same day.
CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedupe_key ON notifications (dedupe_key) WHERE dedupe_key IS NOT NULL;

INSERT INTO settings (key, value, notes) VALUES
  ('digest_email', '', 'Where the daily digest goes. Blank: the finance email.'),
  ('quotation_expiry_warning_days', '7', 'Days before a quotation expires at which its owner is told.')
ON CONFLICT (key) DO NOTHING;
