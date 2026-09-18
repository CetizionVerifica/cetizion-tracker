-- 038 — backup records and the restore check (#33).
--
-- The backup and verify scripts (scripts/backup) write a row here after
-- each run, so the deep health check and the ops.watch job (#38) know
-- when the last good backup and the last passed restore check were, and
-- alert when either is too old or a run failed.
--
-- Safe on a live database; running it a second time changes nothing.

CREATE TABLE IF NOT EXISTS backup_runs (
  id           bigserial PRIMARY KEY,
  kind         text NOT NULL CHECK (kind IN ('backup','verify','drill')),
  ok           boolean NOT NULL,
  started_at   timestamptz,
  finished_at  timestamptz NOT NULL DEFAULT now(),
  size_bytes   bigint,
  location     text,
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
  error        text
);

CREATE INDEX IF NOT EXISTS backup_runs_kind_idx ON backup_runs (kind, finished_at DESC);

INSERT INTO settings (key, value, notes) VALUES
  ('backup_max_age_hours', '8', 'Alert when no successful backup has been recorded for this many hours.'),
  ('backup_verify_max_age_days', '8', 'Alert when the restore check has not passed for this many days.')
ON CONFLICT (key) DO NOTHING;
