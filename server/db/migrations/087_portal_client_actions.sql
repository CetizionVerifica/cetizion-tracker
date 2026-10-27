-- =====================================================================
-- 087_portal_client_actions.sql
-- The client answers in the portal (#198 phase 2, §4, §5).
--
--   portal_client_actions        what a client said about an invoice or a
--                                PO: confirmed it, raised a query, or told
--                                us they paid. A claim, never a fact: it
--                                writes no payment and changes no stage.
--   portal_client_action_stages  the invoices (payment stages) an action is
--                                about; a payment can cover several.
--   payments.portal_action_id    the payment advice a receipt was matched to.
--   attachments.shared_with_client      a staff file the client may see;
--                                       off by default, so nothing attached
--                                       before this change becomes visible.
--   attachments.uploaded_by_contact_id  set only on a client's own upload.
--   attachments.seen_by_staff_at        when staff first saw a client upload;
--                                       after that the client cannot delete it.
-- =====================================================================

CREATE TABLE IF NOT EXISTS portal_client_actions (
  id           serial PRIMARY KEY,
  company_id   int  NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  contact_id   int  REFERENCES contacts(id) ON DELETE SET NULL,
  kind         text NOT NULL CHECK (kind IN ('confirmed','query','payment_advice')),
  po_number    text REFERENCES purchase_orders(po_number) ON UPDATE CASCADE ON DELETE SET NULL,
  note         text,
  amount       numeric(16,2) CHECK (amount > 0),
  tds_amount   numeric(16,2) NOT NULL DEFAULT 0 CHECK (tds_amount >= 0),
  paid_on      date,
  reference    text,
  document_id  int UNIQUE REFERENCES documents(id),
  thread_id    int REFERENCES email_threads(id) ON DELETE SET NULL,
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open','matched','resolved','rejected')),
  -- Shown to the client when an action is resolved or rejected.
  resolution   text,
  resolved_by  text,
  resolved_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT portal_client_actions_query_says_something CHECK (kind <> 'query' OR note IS NOT NULL),
  CONSTRAINT portal_client_actions_advice_complete CHECK (kind <> 'payment_advice' OR (amount IS NOT NULL AND paid_on IS NOT NULL)),
  CONSTRAINT portal_client_actions_rejection_says_why CHECK (status <> 'rejected' OR resolution IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS portal_client_actions_company_idx ON portal_client_actions (company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS portal_client_actions_open_idx ON portal_client_actions (kind, created_at) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS portal_client_action_stages (
  action_id int NOT NULL REFERENCES portal_client_actions(id) ON DELETE CASCADE,
  stage_id  int NOT NULL REFERENCES payment_stages(id) ON DELETE CASCADE,
  PRIMARY KEY (action_id, stage_id)
);
CREATE INDEX IF NOT EXISTS portal_client_action_stages_stage_idx ON portal_client_action_stages (stage_id);

ALTER TABLE payments ADD COLUMN IF NOT EXISTS portal_action_id int REFERENCES portal_client_actions(id) ON DELETE SET NULL;

ALTER TABLE attachments ADD COLUMN IF NOT EXISTS shared_with_client boolean NOT NULL DEFAULT false;
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS uploaded_by_contact_id int REFERENCES contacts(id) ON DELETE SET NULL;
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS seen_by_staff_at timestamptz;
