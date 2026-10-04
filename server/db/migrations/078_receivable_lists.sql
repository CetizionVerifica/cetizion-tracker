-- =====================================================================
-- 078_receivable_lists.sql
-- Finance's Sundry Debtors list, read from a shared mailbox and reconciled
-- with the tracker's receivables in the Daily Sales Briefing
-- (docs/mis-briefing-fix-plan.md §3a).
--
--   receivable_lists        one row per list email read, used or not, so
--                           each is read once and the next day's run spends
--                           no AI call on it again.
--   receivable_list_lines   its rows: client, amount, days, and whether the
--                           row is work pending for invoicing.
--   receivables_list_*      the phrases and senders that find the list.
-- =====================================================================

CREATE TABLE IF NOT EXISTS receivable_lists (
  id           serial PRIMARY KEY,
  account_id   int NOT NULL REFERENCES connected_accounts(id) ON DELETE CASCADE,
  message_id   int REFERENCES email_messages(id) ON DELETE SET NULL,
  provider_id  text NOT NULL,
  received_at  timestamptz NOT NULL,
  -- The date the list is as of: the one printed on it, else the email's.
  list_date    date NOT NULL,
  file_name    text,
  -- How it was read: in code from a spreadsheet, or by the AI from a PDF. Null when nothing could be read.
  method       text CHECK (method IN ('xlsx','ai')),
  status       text NOT NULL CHECK (status IN ('used','rejected')),
  -- Why a list was not used: the rows did not add up to the grand total, an amount not in the file, nothing attached.
  reason       text,
  grand_total  numeric(16,2),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, provider_id)
);
CREATE INDEX IF NOT EXISTS receivable_lists_recent_idx ON receivable_lists (received_at DESC) WHERE status = 'used';

CREATE TABLE IF NOT EXISTS receivable_list_lines (
  id                    serial PRIMARY KEY,
  list_id               int NOT NULL REFERENCES receivable_lists(id) ON DELETE CASCADE,
  line_no               int NOT NULL,
  client                text NOT NULL,
  invoice_no            text,
  amount                numeric(16,2) NOT NULL,
  days                  int,
  pending_for_invoicing boolean NOT NULL DEFAULT false,
  UNIQUE (list_id, line_no)
);

INSERT INTO settings (key, value, notes) VALUES
  ('receivables_list_phrases', 'sundry debtors,debtors,outstanding,receivable', 'Words in the subject or attachment name of Finance''s Sundry Debtors list, comma separated. The newest such email from Finance in the last 14 days is read for the Daily Sales Briefing.'),
  ('receivables_list_senders', 'none', 'Who sends Finance''s Sundry Debtors list: addresses, comma separated. "none": anyone at our own email domains.')
ON CONFLICT (key) DO NOTHING;
