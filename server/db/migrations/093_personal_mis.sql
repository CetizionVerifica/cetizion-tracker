-- =====================================================================
-- 093_personal_mis.sql
-- The personal daily MIS goes out
-- (/mnt/project-files/plans/mis-report-sender-plan.md §B2, §B5, §C0).
--
--   report_runs.user_id      whose personal report a run was; null for the
--                            company reports
--   report_runs.ai_checks    what the checks dropped or found missing, and
--                            how many times the AI was asked
--   report_runs.kind         gains 'personal_daily'
--   report_runs_sent_once    one scheduled send per kind, period and person
--   users.daily_mis          false: an admin exempted them
--   users.daily_mis_notice_seen_at   when they acknowledged the notice
--   personal_mis_enabled     the whole feature, off until an admin says
-- =====================================================================

ALTER TABLE report_runs ADD COLUMN IF NOT EXISTS user_id int REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE report_runs ADD COLUMN IF NOT EXISTS ai_checks jsonb;
ALTER TABLE report_runs DROP CONSTRAINT IF EXISTS report_runs_kind_check;
ALTER TABLE report_runs ADD CONSTRAINT report_runs_kind_check CHECK (kind IN ('daily_briefing','weekly_mis','personal_daily'));

DROP INDEX IF EXISTS report_runs_sent_once;
CREATE UNIQUE INDEX IF NOT EXISTS report_runs_sent_once
  ON report_runs (kind, period_from, COALESCE(user_id, 0)) WHERE status = 'sent' AND triggered_by = 'schedule';
CREATE INDEX IF NOT EXISTS report_runs_user_idx ON report_runs (user_id, created_at DESC) WHERE user_id IS NOT NULL;

ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_mis boolean NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_mis_notice_seen_at timestamptz;

INSERT INTO settings (key, value, notes) VALUES
  ('personal_mis_enabled', 'false', 'Send each user''s daily MIS to management from their own mailbox, at 08:40 IST Tuesday to Saturday for the previous working day.')
ON CONFLICT (key) DO NOTHING;
