-- =====================================================================
-- 069_past_mail_read_once.sql
-- When each mailbox's past mail was last read through, for enquiries and
-- for POs (docs/email-po-plan.md §3.9, §3.10.6).
--
-- The PO reader waits for the enquiry reader, and the invoice reader for
-- the PO reader, by looking at their progress rows. "Re-run" deletes a
-- progress row so the read starts again, and that held the next reader
-- back for days although the records it looks for were already there.
-- These columns survive a re-run: once a mailbox's past mail has been read
-- through, the next reader goes ahead whatever the first is re-reading.
--
-- Filled from progress rows that have finished. A PO row of any kind also
-- means the enquiry read had finished, since the PO read could not start
-- before it.
-- =====================================================================

ALTER TABLE connected_accounts ADD COLUMN IF NOT EXISTS past_enquiries_read_at timestamptz;
ALTER TABLE connected_accounts ADD COLUMN IF NOT EXISTS past_pos_read_at timestamptz;

UPDATE connected_accounts a SET past_enquiries_read_at = b.finished_at
  FROM mailbox_enquiry_backfills b
 WHERE b.account_id = a.id AND b.finished_at IS NOT NULL AND a.past_enquiries_read_at IS NULL;

UPDATE connected_accounts a SET past_enquiries_read_at = p.started_at
  FROM mailbox_po_backfills p
 WHERE p.account_id = a.id AND a.past_enquiries_read_at IS NULL;

UPDATE connected_accounts a SET past_pos_read_at = p.finished_at
  FROM mailbox_po_backfills p
 WHERE p.account_id = a.id AND p.finished_at IS NOT NULL AND a.past_pos_read_at IS NULL;
