-- =====================================================================
-- 067_email_purchase_orders.sql
-- Purchase orders and invoices from email (docs/email-po-plan.md §4).
--
-- 1. email_po_decisions: what was decided about one inbound email that
--    might have been a client's PO. Separate from email_enquiry_decisions:
--    a PO email may already have an enquiry decision, and the outcomes
--    differ. No PDF text is stored.
-- 2. email_invoice_decisions: the same for one outbound email that might
--    have been our invoice.
-- 3. mailbox_po_backfills, mailbox_invoice_backfills: how far each sweep of
--    past mail has got, per mailbox (Inbox for POs, Sent Items for invoices).
-- 4. The settings, on by default.
-- 5. webhook_emit() stays quiet while app.suppress_webhooks is on, which the
--    history path sets with set_config(..., true) for its own transaction
--    only: a PO from eight months ago is not news to n8n (§3.8).
-- 6. An index on the PO number as compared: lowercase, letters and digits
--    only, so "PO-123" and "po 123" are found as the same PO. Not unique:
--    existing data may already hold such pairs, so the check is made by
--    registerPurchaseOrder() instead (§4).
-- =====================================================================

CREATE TABLE IF NOT EXISTS email_po_decisions (
  id                   serial PRIMARY KEY,
  account_id           int NOT NULL REFERENCES connected_accounts(id) ON DELETE CASCADE,
  provider_id          text NOT NULL,
  internet_message_id  text,
  conversation_id      text,
  thread_id            int REFERENCES email_threads(id) ON DELETE SET NULL,
  from_email           text,
  received_at          timestamptz,
  outcome              text NOT NULL CHECK (outcome IN
                         ('registered','linked','review','not_po','registered_by_hand','dismissed',
                          -- live mail the AI could not read (an error, or the day's ceiling):
                          -- read again by pos.backfill, and sent to review after a week
                          'retry')),
  document_type        text,
  review_reason        text CHECK (review_reason IN
                         ('no_match','several_matches','not_to_us','low_confidence','no_po_number',
                          'value_mismatch','company_mismatch','amendment','cancellation','multiple_pos','unreadable',
                          -- the PO's own figures failed a check (pdfPurchaseOrder.js checkPo)
                          'no_value','amounts_not_in_pdf','totals_do_not_add_up','bad_currency')),
  mode                 text CHECK (mode IN ('live','history')),
  confidence           numeric(4,3) CHECK (confidence BETWEEN 0 AND 1),
  method               text NOT NULL CHECK (method IN ('ai','rules')),
  ai_calls             smallint NOT NULL DEFAULT 0 CHECK (ai_calls >= 0),
  po_number            text REFERENCES purchase_orders(po_number) ON UPDATE CASCADE ON DELETE SET NULL,
  quotation_no         text REFERENCES quotations(quotation_no) ON UPDATE CASCADE ON DELETE SET NULL,
  -- The quotations a reviewer is offered (§3.7).
  suggested_quotations text[],
  -- No quotation was on file, so one was made from the PO (§3.3).
  created_quotation    boolean NOT NULL DEFAULT false,
  stages_source        text CHECK (stages_source IN ('po_terms','template','none')),
  -- Who settled it from the review queue, and when: registered by hand or
  -- dismissed. decided_at stays the moment it was read, which the daily AI
  -- ceiling counts by.
  decided_by           text,
  settled_at           timestamptz,
  -- When it was first left for a retry; a week later it goes to review.
  retry_since          timestamptz,
  decided_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, provider_id)
);

CREATE INDEX IF NOT EXISTS email_po_decisions_message_idx ON email_po_decisions (lower(internet_message_id)) WHERE internet_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS email_po_decisions_conversation_idx ON email_po_decisions (conversation_id) WHERE conversation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS email_po_decisions_po_idx ON email_po_decisions (po_number) WHERE po_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS email_po_decisions_quotation_idx ON email_po_decisions (quotation_no) WHERE quotation_no IS NOT NULL;
CREATE INDEX IF NOT EXISTS email_po_decisions_review_idx ON email_po_decisions (decided_at) WHERE outcome = 'review';

CREATE TABLE IF NOT EXISTS mailbox_po_backfills (
  account_id  int PRIMARY KEY REFERENCES connected_accounts(id) ON DELETE CASCADE,
  since       timestamptz NOT NULL,
  next_link   text,
  reached     timestamptz,
  scanned     int NOT NULL DEFAULT 0,
  registered  int NOT NULL DEFAULT 0,
  review      int NOT NULL DEFAULT 0,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  last_error  text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS email_invoice_decisions (
  id                     serial PRIMARY KEY,
  account_id             int NOT NULL REFERENCES connected_accounts(id) ON DELETE CASCADE,
  provider_id            text NOT NULL,
  internet_message_id    text,
  conversation_id        text,
  thread_id              int REFERENCES email_threads(id) ON DELETE SET NULL,
  to_emails              text[],
  sent_at                timestamptz,
  outcome                text NOT NULL CHECK (outcome IN
                           ('recorded','linked','review','not_invoice','recorded_by_hand','dismissed',
                            -- its PO is not in the tracker yet: tried again until auto_invoice_wait_days
                            'waiting')),
  document_type          text,
  review_reason          text CHECK (review_reason IN
                           ('po_not_found','several_pos','amount_not_a_stage','po_without_stages','invoice_no_in_use',
                            'not_from_us','low_confidence','credit_note','revised','unreadable',
                            -- the invoice's own figures failed a check (invoiceDetect.js checkInvoice)
                            'no_invoice_no','amounts_not_in_pdf','totals_do_not_add_up','bad_currency','bad_date')),
  mode                   text CHECK (mode IN ('live','history')),
  confidence             numeric(4,3) CHECK (confidence BETWEEN 0 AND 1),
  method                 text NOT NULL CHECK (method IN ('ai','rules')),
  ai_calls               smallint NOT NULL DEFAULT 0 CHECK (ai_calls >= 0),
  stage_id               int REFERENCES payment_stages(id) ON DELETE SET NULL,
  po_number              text REFERENCES purchase_orders(po_number) ON UPDATE CASCADE ON DELETE SET NULL,
  -- As printed; the stage holds the one recorded.
  invoice_no             text,
  -- The stage already had a document, so the emailed PDF was not attached.
  document_kept_existing boolean NOT NULL DEFAULT false,
  -- While waiting only: the facts read from the invoice (number, date,
  -- amounts, references; never its text), so a retry needs no second AI
  -- call. Cleared once it is decided.
  reading                jsonb,
  decided_by             text,
  settled_at             timestamptz,
  decided_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, provider_id)
);

CREATE INDEX IF NOT EXISTS email_invoice_decisions_message_idx ON email_invoice_decisions (lower(internet_message_id)) WHERE internet_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS email_invoice_decisions_stage_idx ON email_invoice_decisions (stage_id) WHERE stage_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS email_invoice_decisions_review_idx ON email_invoice_decisions (decided_at) WHERE outcome = 'review';
CREATE INDEX IF NOT EXISTS email_invoice_decisions_waiting_idx ON email_invoice_decisions (decided_at) WHERE outcome = 'waiting';

-- AI calls made outside any decision: a review item read again for its
-- dialog. Counted against the same daily ceiling (aiCallsToday).
CREATE TABLE IF NOT EXISTS email_ai_calls (
  id       serial PRIMARY KEY,
  purpose  text NOT NULL,
  made_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_ai_calls_made_idx ON email_ai_calls (made_at);

CREATE TABLE IF NOT EXISTS mailbox_invoice_backfills (
  account_id  int PRIMARY KEY REFERENCES connected_accounts(id) ON DELETE CASCADE,
  since       timestamptz NOT NULL,
  next_link   text,
  reached     timestamptz,
  scanned     int NOT NULL DEFAULT 0,
  recorded    int NOT NULL DEFAULT 0,
  review      int NOT NULL DEFAULT 0,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  last_error  text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO settings (key, value, notes) VALUES
  ('auto_po_enabled', 'true', 'Register purchase orders automatically from client email in connected mailboxes, and read back past mail once per mailbox. Off stops both at the next run; nothing already registered is removed.'),
  ('auto_po_min_confidence', '0.85', 'How sure the AI must be (0 to 1) of a purchase order read from email before it is registered. Below it, the PO goes to review.'),
  ('auto_po_value_tolerance_percent', '2', 'How far, in percent, a PO''s value may be from its quotation''s and still be registered automatically. Further off goes to review.'),
  ('auto_po_history_after_days', '30', 'A PO or invoice dated more than this many days before it is read is registered as history: no notifications, onboarding, webhooks or client reminders.'),
  ('auto_po_create_quotation_when_missing', 'true', 'When a PO matches no quotation on file, create the quotation (won) and the enquiry (converted) from it, then register.'),
  ('po_portal_senders', '*@ansmtp.ariba.com,*@coupahost.com,*@jaggaer.com', 'Procurement-portal senders whose PO notifications are read even though they are automated. Comma-separated; * matches any text.'),
  ('auto_invoice_enabled', 'true', 'Record invoices we email to clients against the right payment stage, with the PDF. Off stops it at the next run; nothing already recorded is removed.'),
  ('auto_invoice_min_confidence', '0.85', 'How sure the AI must be (0 to 1) of an invoice read from email before it is recorded. Below it, the invoice goes to review.'),
  ('auto_invoice_wait_days', '7', 'How long an invoice whose PO is not in the tracker yet is retried before it goes to review.')
ON CONFLICT (key) DO NOTHING;

-- Every webhook event goes through here, so one check covers po.received,
-- quotation.won and invoice.issued alike.
CREATE OR REPLACE FUNCTION webhook_emit(p_event text, p_entity text, p_entity_id text, p_value numeric, p_company int, p_data jsonb)
RETURNS void AS $$
BEGIN
  -- A PO or invoice registered from past mail is not news (067,
  -- docs/email-po-plan.md §3.8): the history path turns this on for its
  -- own transaction.
  IF current_setting('app.suppress_webhooks', true) = 'on' THEN
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM webhook_endpoints WHERE (active OR when_inactive = 'queue') AND p_event = ANY(events)) THEN
    RETURN;
  END IF;
  INSERT INTO webhook_events (event, entity, entity_id, value, company_id, data)
  VALUES (p_event, p_entity, p_entity_id, p_value, p_company, COALESCE(p_data, '{}'::jsonb));
  PERFORM pg_notify('webhook_events', p_event);
END $$ LANGUAGE plpgsql;

CREATE INDEX IF NOT EXISTS purchase_orders_po_number_norm_idx
  ON purchase_orders (lower(regexp_replace(po_number, '[^a-zA-Z0-9]', '', 'g')));
