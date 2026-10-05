-- =====================================================================
-- 077_my_today.sql
-- My Today (docs/my-today-plan.md): one person's own list for the day.
--
-- Three settings, editable by an admin like the others. Automatic reminder
-- rows in collection_log already carry their marker (automated, 063), so
-- nothing else changes shape.
-- =====================================================================

INSERT INTO settings (key, value, notes) VALUES
  ('my_today_grace_working_days', '2', 'My Today: working days an item may be late and still sit under Due today, with a "late" label.'),
  ('my_today_chase_after_days', '7', 'My Today: calendar days past its due date before an unpaid invoice needs a chase.'),
  ('my_today_rechase_days', '7', 'My Today: days until a chase logged without a next date comes back.')
ON CONFLICT (key) DO NOTHING;
