-- Two settings that an admin could edit all afternoon without changing
-- anything, and one note that names a column instead of saying the thing.
--
-- default_advance_percent / default_delivery_percent were seeded before
-- payment-terms templates (#26) existed. Since #26 a new PO takes its
-- splits from the template marked default, and the fixed fallback is
-- written into the dialog, not read from here. Nothing in server/src or
-- web/src reads either key, so they are offered, editable, and inert.
-- The Settings pane stops listing them either way; this stops a fresh
-- database creating them again.
DELETE FROM settings WHERE key IN ('default_advance_percent', 'default_delivery_percent');

-- Settings notes are shown to admins verbatim now, so a trailing
-- "every reminder_interval_days" reads as a leaked machine name directly
-- above the row that says the same thing in English.
UPDATE settings
   SET notes = 'Days overdue at which the first, second and final reminders go out. After the final one, it repeats at the interval below.'
 WHERE key = 'reminder_levels_days'
   AND notes LIKE '%reminder_interval_days%';
