-- =====================================================================
-- 063_follow_up_reminders.sql
-- Follow-up reminders to owners and escalation to management
-- (docs/follow-up-escalation-plan.md).
--
-- 1. follow_up_cycles: one row per due -> reminded -> resolved|escalated
--    cycle on an enquiry, quotation or payment stage.
-- 2. collection_log.automated: chasing rows the payment-reminder job wrote
--    are not a person following up.
-- 3. Settings, off by default so deploying emails nobody.
-- =====================================================================

-- A follow-up cycle: one record, one reminder, at most one open at a time.
-- These are events that happened (an email went, a deadline passed), not
-- values derived from other columns, so they are stored, the same way
-- payment_stages.reminder_sent_on is.
CREATE TABLE IF NOT EXISTS follow_up_cycles (
  id                   serial PRIMARY KEY,
  entity               text NOT NULL CHECK (entity IN ('enquiry','quotation','payment_stage')),
  entity_id            text NOT NULL,
  due_on               date NOT NULL,
  -- The person the reminder went to, as things stood then. Not the record's
  -- owner (that is owner_user_id on the record): a reassignment ends the cycle.
  reminded_user_id     int REFERENCES users(id) ON DELETE SET NULL,
  owner_name           text,
  reminded_at          timestamptz,
  reminder_email_id    int REFERENCES email_log(id) ON DELETE SET NULL,
  respond_by           date,
  escalated_at         timestamptz,
  last_escalated_on    date,
  escalation_count     int NOT NULL DEFAULT 0,
  escalation_email_id  int REFERENCES email_log(id) ON DELETE SET NULL,
  resolved_at          timestamptz,
  resolved_reason      text CHECK (resolved_reason IN
                         ('activity','closed','paid','on_hold','promised','rescheduled','reassigned','disabled')),
  created_at           timestamptz NOT NULL DEFAULT now()
);

-- One open cycle per record.
CREATE UNIQUE INDEX IF NOT EXISTS follow_up_cycles_open_key
  ON follow_up_cycles (entity, entity_id) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS follow_up_cycles_reminded_user_idx
  ON follow_up_cycles (reminded_user_id, resolved_at);

-- Chasing rows written by the payment-reminder job are not a person
-- following up. Existing ones are recognised by the summary that job writes.
ALTER TABLE collection_log ADD COLUMN IF NOT EXISTS automated boolean NOT NULL DEFAULT false;
UPDATE collection_log SET automated = true
 WHERE automated = false AND channel = 'email' AND summary LIKE 'Reminder level % emailed to %';

INSERT INTO settings (key, value, notes) VALUES
  ('followup_enabled', 'false', 'Email owners about due follow-ups and escalate to management when nothing is logged.'),
  ('followup_enquiry_idle_days', '3', 'Working days an enquiry with no follow-up date may go untouched.'),
  ('followup_quotation_idle_days', '5', 'Working days a sent quotation may go untouched.'),
  ('followup_invoice_overdue_days', '1', 'Days overdue before the owner is asked to follow up an invoice.'),
  ('followup_invoice_idle_days', '5', 'Working days an overdue invoice may go unchased.'),
  ('followup_grace_days', '2', 'Working days after a reminder before management is told.'),
  ('followup_reescalate_days', '5', 'Working days before an escalated item is listed again.'),
  ('followup_escalation_emails', '', 'Management addresses for escalations, besides admin accounts. Comma-separated.'),
  ('followup_cc_owner_on_escalation', 'true', 'Tell the owner when one of their follow-ups is escalated.')
ON CONFLICT (key) DO NOTHING;
