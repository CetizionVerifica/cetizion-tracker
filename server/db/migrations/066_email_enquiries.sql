-- =====================================================================
-- 066_email_enquiries.sql
-- New enquiries from email, automatically (docs/email-enquiries-plan.md).
--
-- 1. email_enquiry_decisions: what was decided about one email, and why.
--    An event (the email was read and judged), so it is stored. It holds
--    none of the email's text: who sent it, when, the verdict, and the
--    record it led to. For a quotation read from a PDF we sent, it also
--    keeps the totals printed on that PDF — a fact read from a document,
--    which quotation_totals() falls back on when the quotation has no lines.
-- 2. mailbox_enquiry_backfills: how far the sweep of past mail has got,
--    per mailbox, so a year of mail can be read over several runs.
-- 3. The settings, on by default.
-- 4. quotation_totals(): a quotation with no lines whose totals were read
--    from a PDF keeps those totals instead of being blanked (plan §3.9.7).
--    Every other quotation behaves exactly as before.
-- =====================================================================

CREATE TABLE IF NOT EXISTS email_enquiry_decisions (
  id                   serial PRIMARY KEY,
  account_id           int NOT NULL REFERENCES connected_accounts(id) ON DELETE CASCADE,
  provider_id          text NOT NULL,
  internet_message_id  text,
  conversation_id      text,
  thread_id            int REFERENCES email_threads(id) ON DELETE SET NULL,
  direction            text NOT NULL CHECK (direction IN ('inbound','outbound')),
  from_email           text,
  received_at          timestamptz,
  outcome              text NOT NULL CHECK (outcome IN ('created','linked','not_enquiry')),
  kind                 text NOT NULL,
  confidence           numeric(4,3) CHECK (confidence BETWEEN 0 AND 1),
  method               text NOT NULL CHECK (method IN ('ai','rules')),
  -- How many model calls this decision cost, against the daily ceiling.
  ai_calls             smallint NOT NULL DEFAULT 0 CHECK (ai_calls >= 0),
  enquiry_no           text REFERENCES enquiries(enquiry_no) ON UPDATE CASCADE ON DELETE SET NULL,
  -- The quotation read from the PDF we sent (plan §3.9), and how that went.
  quotation_no         text REFERENCES quotations(quotation_no) ON UPDATE CASCADE ON DELETE SET NULL,
  quotation_extraction text CHECK (quotation_extraction IN ('created','revised','failed')),
  extraction_reason    text,
  printed_subtotal     numeric(16,2),
  printed_tax_total    numeric(16,2),
  printed_total        numeric(16,2),
  decided_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, provider_id)
);

CREATE INDEX IF NOT EXISTS email_enquiry_decisions_message_idx ON email_enquiry_decisions (lower(internet_message_id)) WHERE internet_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS email_enquiry_decisions_conversation_idx ON email_enquiry_decisions (conversation_id) WHERE conversation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS email_enquiry_decisions_enquiry_idx ON email_enquiry_decisions (enquiry_no) WHERE enquiry_no IS NOT NULL;
CREATE INDEX IF NOT EXISTS email_enquiry_decisions_quotation_idx ON email_enquiry_decisions (quotation_no) WHERE quotation_no IS NOT NULL;
CREATE INDEX IF NOT EXISTS email_enquiry_decisions_decided_idx ON email_enquiry_decisions (decided_at);

CREATE TABLE IF NOT EXISTS mailbox_enquiry_backfills (
  account_id  int PRIMARY KEY REFERENCES connected_accounts(id) ON DELETE CASCADE,
  since       timestamptz NOT NULL,
  -- Inbox first, then Sent Items; null once both are read.
  folder      text CHECK (folder IN ('inbox','sentitems')),
  next_link   text,
  scanned     int NOT NULL DEFAULT 0,
  created     int NOT NULL DEFAULT 0,
  linked      int NOT NULL DEFAULT 0,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  last_error  text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO settings (key, value, notes) VALUES
  ('auto_enquiries_enabled', 'true', 'Create enquiries automatically from new client email in connected mailboxes, and read back past mail once per mailbox. Off stops both at the next run; nothing already created is removed.'),
  ('auto_enquiry_min_confidence', '0.7', 'How sure the AI must be (0 to 1) that an email is a new enquiry before one is created. Rules alone always need 0.85.'),
  ('auto_enquiry_backfill_days', '365', 'How far back each mailbox is read once for past enquiries, in days.'),
  ('auto_enquiry_same_sender_days', '30', 'A new email from a client who already has an open enquiry this recent is linked to it instead of making another.'),
  ('auto_enquiry_daily_ai_limit', '1500', 'The most AI calls the email reader may make in one day. Reading past mail stops for the day when it is reached.'),
  ('auto_quotation_min_confidence', '0.8', 'How sure the AI must be (0 to 1) of a quotation read from a PDF before the quotation is created.')
ON CONFLICT (key) DO NOTHING;

-- Totals follow the lines. With lines, quotation_value is the total; without
-- any, the typed quotation_value stands and the totals are blank — unless the
-- totals were read from a PDF (066), in which case those printed figures stand.
CREATE OR REPLACE FUNCTION quotation_totals(p_quotation int) RETURNS void AS $$
DECLARE s numeric; t numeric; n int; gross numeric; disc numeric; threshold numeric; st text; approved_at numeric;
        p_sub numeric; p_tax numeric; p_total numeric;
BEGIN
  SELECT COUNT(*), COALESCE(SUM(amount), 0), COALESCE(SUM(round(amount * gst_rate / 100, 2)), 0), COALESCE(SUM(round(qty * rate, 2)), 0)
    INTO n, s, t, gross FROM quotation_lines WHERE quotation_id = p_quotation;
  IF n = 0 THEN
    -- Read from the PDF we sent (docs/email-enquiries-plan.md §3.9.7): the
    -- printed totals stand until real lines replace them, and come back if
    -- those lines are all removed. Never blanked, never zero.
    SELECT d.printed_subtotal, d.printed_tax_total, d.printed_total INTO p_sub, p_tax, p_total
      FROM email_enquiry_decisions d JOIN quotations q ON q.quotation_no = d.quotation_no
     WHERE q.id = p_quotation AND d.quotation_extraction IN ('created','revised') AND d.printed_total IS NOT NULL
     ORDER BY d.decided_at DESC, d.id DESC LIMIT 1;
    IF FOUND THEN
      UPDATE quotations SET subtotal = p_sub, tax_total = p_tax, total = p_total, quotation_value = p_total, discount_percent = NULL,
             approval_status = CASE WHEN approval_status = 'pending' AND approval_reason IS NULL THEN 'not_needed' ELSE approval_status END
       WHERE id = p_quotation;
      RETURN;
    END IF;
    UPDATE quotations SET subtotal = NULL, tax_total = NULL, total = NULL, discount_percent = NULL,
           approval_status = CASE WHEN approval_status = 'pending' AND approval_reason IS NULL THEN 'not_needed' ELSE approval_status END
     WHERE id = p_quotation;
    RETURN;
  END IF;
  disc := CASE WHEN gross > 0 THEN round((gross - s) / gross * 100, 2) ELSE 0 END;
  threshold := setting_num('discount_approval_threshold_percent', 10);
  SELECT approval_status, approved_discount_percent INTO st, approved_at FROM quotations WHERE id = p_quotation;
  UPDATE quotations
     SET subtotal = s, tax_total = t, total = s + t, quotation_value = s + t, discount_percent = disc,
         approval_status = CASE
           -- Over the threshold needs a decision, and an approval covers
           -- only the discount it was given for: raising it asks again.
           -- This applies to hand-requested exceptions too.
           WHEN disc > threshold AND (st IN ('not_needed', 'rejected')
                OR (st = 'approved' AND disc > COALESCE(approved_at, -1))) THEN 'pending'
           -- otherwise an exception someone asked for by hand keeps its own state
           WHEN approval_reason IS NOT NULL THEN approval_status
           WHEN disc <= threshold AND st IN ('pending', 'rejected') THEN 'not_needed'
           ELSE approval_status END,
         approval_requested_at = CASE WHEN disc > threshold AND (st IN ('not_needed', 'rejected')
                OR (st = 'approved' AND disc > COALESCE(approved_at, -1))) THEN now() ELSE approval_requested_at END
   WHERE id = p_quotation;
END $$ LANGUAGE plpgsql;
