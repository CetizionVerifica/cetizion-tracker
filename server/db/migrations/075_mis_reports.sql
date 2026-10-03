-- =====================================================================
-- 075_mis_reports.sql
-- The Daily Sales Briefing and Weekly Sales MIS sent from the tracker
-- (docs/mis-reports-plan.md §4).
--
--   report_runs              one row per report generated: an event, so it
--                            is stored. What was sent, to whom, how, the
--                            PDF kept as a document, the email_log row.
--   email_messages.web_link  Outlook's link to a stored message, a fact from
--                            the provider: "Open in Outlook" on a highlight.
--   mis_* settings           both reports start OFF; switched on at cut-over.
-- =====================================================================

CREATE TABLE IF NOT EXISTS report_runs (
  id            serial PRIMARY KEY,
  kind          text NOT NULL CHECK (kind IN ('daily_briefing','weekly_mis')),
  period_from   date NOT NULL,
  period_to     date NOT NULL,
  status        text NOT NULL CHECK (status IN ('sent','preview','failed','skipped')),
  sent_via      text CHECK (sent_via IN ('graph','smtp','log')),
  recipients    text[],
  document_id   int REFERENCES documents(id),
  email_log_id  int REFERENCES email_log(id) ON DELETE SET NULL,
  ai_used       boolean NOT NULL DEFAULT false,
  error         text,
  -- 'schedule', or the username of whoever pressed Send now / Resend.
  triggered_by  text NOT NULL DEFAULT 'schedule',
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- The schedule sends each period once; Resend is an explicit act and is not bound by this.
CREATE UNIQUE INDEX IF NOT EXISTS report_runs_sent_once
  ON report_runs (kind, period_from) WHERE status = 'sent' AND triggered_by = 'schedule';
CREATE INDEX IF NOT EXISTS report_runs_recent_idx ON report_runs (kind, created_at DESC);

ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS web_link text;

INSERT INTO settings (key, value, notes) VALUES
  ('mis_daily_enabled', 'false', 'Send the Daily Sales Briefing at 08:56 IST every day, for the previous day.'),
  ('mis_weekly_enabled', 'false', 'Send the Weekly Sales MIS every Monday at 08:54 IST, for the previous Monday to Sunday.'),
  ('mis_to', '', 'Recipients of both reports, comma-separated.'),
  ('mis_cc', '', 'Copied on both reports, comma-separated.'),
  ('mis_sender_account_id', '', 'The connected mailbox the reports are sent from (sales@). Blank: the SMTP sender.'),
  ('mis_overdue_days', '7', 'Days after which a pending invoice, PO or quotation is marked Overdue in the reports.')
ON CONFLICT (key) DO NOTHING;
