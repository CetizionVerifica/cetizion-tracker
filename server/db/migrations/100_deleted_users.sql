-- =====================================================================
-- 100_deleted_users.sql
-- Accounts deleted from the super admin portal, each with the Excel backup
-- of what they owned, made and checked before the deletion.
--
-- Deleting archives the account rather than removing its row: it is
-- switched off, loses its password, and drops out of the user lists, but
-- the users row stays so every record, report and sales target that names
-- it keeps doing so. The records belong to the company, not the person.
-- A row here is what "deleted" means; nothing else marks it.
--
-- The backup lives in documents (private Cloudinary storage, served only
-- through the API). RESTRICT, and documents.js counts this table as
-- attaching a file, so neither a delete nor the daily purge can remove a
-- backup while its row is here.
-- =====================================================================

CREATE TABLE IF NOT EXISTS deleted_users (
  id                   serial PRIMARY KEY,
  user_id              integer NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
  deleted_at           timestamptz NOT NULL DEFAULT now(),
  -- The super admin is not a users row, so it is recorded by name.
  deleted_by           text NOT NULL CHECK (btrim(deleted_by) <> ''),
  -- Who took over their open records.
  replacement_user_id  integer REFERENCES users(id) ON DELETE SET NULL,
  backup_document_id   integer NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
  backup_sha256        text NOT NULL CHECK (backup_sha256 ~ '^[0-9a-f]{64}$'),
  backup_size_bytes    integer NOT NULL CHECK (backup_size_bytes > 0),
  -- What the backup held and what the deletion did, as counted at the time.
  summary              jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(summary) = 'object')
);

CREATE INDEX IF NOT EXISTS deleted_users_deleted_at_idx ON deleted_users (deleted_at DESC);
