-- 023 — client acceptance of quotations through a link (#53, option A).
--
-- A single-use link per quotation revision. The client opens it without
-- signing in, sees that one quotation, and accepts (typed name and a tick)
-- or asks for changes. The link stops working when the quotation is
-- revised, expires or is closed. Only a hash of the token is stored.
-- What was accepted is kept exactly: a snapshot, the PDF's hash, and the
-- PDF itself when document storage is set up.
--
-- Safe on a live database; running it a second time changes nothing.

CREATE TABLE IF NOT EXISTS quotation_acceptances (
  id                 serial PRIMARY KEY,
  quotation_id       int NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  revision           int NOT NULL DEFAULT 0,
  token_hash         text NOT NULL UNIQUE,
  sent_to            text,
  status             text NOT NULL DEFAULT 'sent'
                       CHECK (status IN ('sent','viewed','accepted','changes_requested','expired','revoked')),
  expires_at         timestamptz NOT NULL,
  viewed_at          timestamptz,
  view_count         int NOT NULL DEFAULT 0,
  decided_at         timestamptz,
  decided_by_name    text,
  decided_by_email   text,
  comments           text,
  ip                 text,
  user_agent         text,
  snapshot           jsonb,
  pdf_sha256         text,
  pdf_document_id    int REFERENCES documents(id),
  created_by         text,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS quotation_acceptances_quotation_idx ON quotation_acceptances (quotation_id, created_at DESC);

INSERT INTO settings (key, value, notes) VALUES
  ('public_app_url', '', 'The address clients use to open acceptance links, e.g. https://tracker.cetizionverifica.com. Blank: the address the app was opened on.'),
  ('acceptance_unviewed_days', '3', 'Days after which an unopened acceptance link is flagged to the owner.')
ON CONFLICT (key) DO NOTHING;
