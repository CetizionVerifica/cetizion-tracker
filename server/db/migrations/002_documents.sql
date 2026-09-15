-- 002 — one uploaded document per quotation and per purchase order.
--
-- The file itself lives in Cloudinary; this table keeps the reference.
-- Safe on a live database: it only adds, and running it a second time
-- changes nothing.

CREATE TABLE IF NOT EXISTS documents (
  id            serial PRIMARY KEY,
  storage_key   text NOT NULL UNIQUE,
  file_name     text NOT NULL,
  content_type  text NOT NULL,
  size_bytes    int  NOT NULL CHECK (size_bytes > 0),
  created_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE quotations      ADD COLUMN IF NOT EXISTS document_id int REFERENCES documents(id);
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS document_id int REFERENCES documents(id);
ALTER TABLE payment_stages ADD COLUMN IF NOT EXISTS document_id int REFERENCES documents(id);

-- A document belongs to one record, so replacing it can never pull the
-- file out from under another.
CREATE UNIQUE INDEX IF NOT EXISTS quotations_document_id_key      ON quotations (document_id);
CREATE UNIQUE INDEX IF NOT EXISTS purchase_orders_document_id_key ON purchase_orders (document_id);
CREATE UNIQUE INDEX IF NOT EXISTS payment_stages_document_id_key ON payment_stages (document_id);
