-- Bulk import holding area.
--
-- A batch is one uploaded file. Its items are the records the importer
-- derived from that file, held here — NOT in the live tables — until an
-- admin has reviewed every step and pressed "Complete and commit".
--
-- Idempotent: applied at API start-up, so an existing database gains
-- these tables without `npm run migrate` (which drops everything).

CREATE TABLE IF NOT EXISTS import_batches (
  id            serial PRIMARY KEY,
  filename      text NOT NULL,
  sheet_name    text,
  status        text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','committed','failed')),
  uploaded_by   text,
  row_count     int NOT NULL DEFAULT 0,
  mapping       jsonb,                 -- column -> field mapping used
  rules         jsonb,                 -- the assumption rules applied
  summary       jsonb,                 -- counts per step, skipped reasons
  ai_model      text,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  committed_at  timestamptz
);

CREATE TABLE IF NOT EXISTS import_items (
  id              serial PRIMARY KEY,
  batch_id        int NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  step            text NOT NULL
                    CHECK (step IN ('quotation','project','purchase_order',
                                    'service','stage','invoice','receipt')),
  seq             int NOT NULL,        -- order within the batch
  source_row      int,                 -- S.No / row number in the sheet
  parent_item_id  int REFERENCES import_items(id) ON DELETE CASCADE,
  action          text NOT NULL DEFAULT 'create'
                    CHECK (action IN ('create','update','skip')),
  included        boolean NOT NULL DEFAULT true,
  payload         jsonb NOT NULL,      -- the record as it will be written
  flags           jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{level, code, message}]
  assumptions     jsonb NOT NULL DEFAULT '[]'::jsonb,   -- ["PO date assumed ..."]
  existing_ref    text,                -- matching live record, if any
  committed_ref   text,                -- id / key written on commit
  error           text,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS import_items_batch_idx ON import_items (batch_id, step, seq);
