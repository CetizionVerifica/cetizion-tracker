-- =====================================================================
-- 070_email_reader_queue.sql
-- Every email handed to the PO, invoice or enquiry reader, kept until
-- that reader has finished with it (src/lib/mailbox/readerQueue.js).
--
-- A sync used to hand its mail to the readers in memory only, after the
-- delta link had moved past it. An email whose reading threw left no
-- decision behind and was never read again. A stored email is queued in
-- the transaction that stores it; a row leaves when its reader is done,
-- and a failed one is read again later, up to a limit.
--
-- `cand` is how ingest classified the email (direction, participants,
-- thread) — never its subject or body: a retry fetches the message again.
-- =====================================================================

CREATE TABLE IF NOT EXISTS email_reader_queue (
  id              bigserial PRIMARY KEY,
  account_id      int NOT NULL REFERENCES connected_accounts(id) ON DELETE CASCADE,
  provider_id     text NOT NULL,
  reader          text NOT NULL CHECK (reader IN ('po','invoice','enquiry')),
  folder          text,
  sent_at         timestamptz,
  cand            jsonb NOT NULL,
  attempts        int NOT NULL DEFAULT 0,
  last_error      text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  failed_at       timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, provider_id, reader)
);
CREATE INDEX IF NOT EXISTS email_reader_queue_due_idx ON email_reader_queue (account_id, next_attempt_at) WHERE failed_at IS NULL;
