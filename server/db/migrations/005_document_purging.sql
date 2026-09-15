-- 005 — a document being removed is marked first. While marked, nothing can
-- attach it, and if deleting its file from Cloudinary fails the orphan sweep
-- tries again, so a record can never end up pointing at a missing file.
--
-- Safe on a live database: it only adds a column, and running it a second
-- time changes nothing.

ALTER TABLE documents ADD COLUMN IF NOT EXISTS purging_at timestamptz;
