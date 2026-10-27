-- =====================================================================
-- 092_personal_mis_ai.sql
-- The AI's own ceiling for the personal daily MIS
-- (/mnt/project-files/plans/mis-report-sender-plan.md §B4.2). Its calls
-- are counted as email_ai_calls purpose 'mis_personal', apart from the
-- email readers' shared ceiling, so ten people's reports cannot stop them.
-- =====================================================================

INSERT INTO settings (key, value, notes) VALUES
  ('personal_mis_ai_limit', '30', 'AI calls a day for the personal daily MIS, apart from the readers'' ceiling.')
ON CONFLICT (key) DO NOTHING;
