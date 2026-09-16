-- 009 — an invoice document on each payment stage.
--
-- Declared the way schema.sql declares it, so the unique constraint and the
-- foreign key get the same names as in a fresh database.
--
-- For a while this column was added by an edit to 002, which made it unique
-- with a plain index instead of the constraint. A database upgraded then
-- already has the column; the index is turned into the constraint here.
--
-- Safe on a live database: it only adds a column, and each step is skipped
-- when its work is already done.

ALTER TABLE payment_stages
  ADD COLUMN IF NOT EXISTS document_id int UNIQUE REFERENCES documents(id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'payment_stages'::regclass AND conname = 'payment_stages_document_id_key') THEN
    ALTER TABLE payment_stages
      ADD CONSTRAINT payment_stages_document_id_key UNIQUE USING INDEX payment_stages_document_id_key;
  END IF;
END $$;
