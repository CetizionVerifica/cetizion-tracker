-- 018 — whose record is this (#18 Phase 2A).
--
-- Every sales record already names a salesperson, as free text: the
-- `sales_person` column, filled in from the workbook and typed by hand
-- since. It is how the reports group by person and it works well enough for
-- that, because a report can normalise "Ramesh" and "ramesh " into one
-- heading and nobody is harmed if it gets one wrong.
--
-- It cannot answer the question Phase 2 asks. "Show this salesperson only
-- their own records" needs a name that cannot be retyped, cannot be two
-- people, and cannot quietly stop matching when somebody marries or the
-- spelling drifts. That is what a foreign key is for, and users now exists
-- to point at (015).
--
-- So this adds the pointer beside the text rather than replacing it. The
-- two coexist on purpose and for a long time: `sales_person` keeps every
-- historical report producing the figures it produced yesterday, and
-- owner_user_id starts empty and is filled in deliberately.
--
-- Nullable, and left null everywhere. There is no reliable way to turn the
-- existing text into a user — several rows name people who never had an
-- account, some name nobody, and a wrong guess here is worse than a blank,
-- because a blank is visibly unanswered whereas a wrong owner looks like an
-- answer. Phase 2B decides the backfill rules with somebody who knows the
-- business; this migration deliberately writes no row.
--
-- Nothing reads the column yet. Row-level filtering is Phase 2C and lands
-- in one piece, because scoping some endpoints and not others is worse than
-- scoping none: it reads as "this list is filtered" while the next list is
-- not. So after this migration the application behaves exactly as it did
-- before it.
--
-- Safe on a live database: three nullable columns, three foreign keys and
-- three indexes. A nullable column with no default is a catalogue change
-- only — Postgres does not rewrite the table — and running this a second
-- time changes nothing.

ALTER TABLE enquiries  ADD COLUMN IF NOT EXISTS owner_user_id int;
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS owner_user_id int;
ALTER TABLE projects   ADD COLUMN IF NOT EXISTS owner_user_id int;

-- ON DELETE SET NULL, and the reasoning is the same as activity_log's (017).
--
-- CASCADE would mean that deleting a salesperson's account deletes their
-- quotations, enquiries and projects — the company's own sales history,
-- removed as a side effect of tidying up a leaver. RESTRICT would mean the
-- opposite failure: nobody can ever be deleted once they have owned
-- anything, so the users table fills with accounts that cannot be removed.
-- SET NULL keeps the record and forgets only the pointer, which leaves the
-- row in the same state as every row this migration creates — unowned, and
-- visibly so.
--
-- Named explicitly rather than left to Postgres. The name is the one
-- Postgres would have chosen for an inline REFERENCES, which is what
-- schema.sql declares, so a database upgraded through this file and one
-- built from schema.sql carry the same constraint under the same name.
--
-- Dropped first so this file can be re-run, in the style of 016.
ALTER TABLE enquiries  DROP CONSTRAINT IF EXISTS enquiries_owner_user_id_fkey;
ALTER TABLE enquiries  ADD CONSTRAINT enquiries_owner_user_id_fkey
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE quotations DROP CONSTRAINT IF EXISTS quotations_owner_user_id_fkey;
ALTER TABLE quotations ADD CONSTRAINT quotations_owner_user_id_fkey
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE projects   DROP CONSTRAINT IF EXISTS projects_owner_user_id_fkey;
ALTER TABLE projects   ADD CONSTRAINT projects_owner_user_id_fkey
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL;

-- No CHECK tying ownership to users.active. An account is switched off when
-- somebody leaves, and their quotations stay theirs — a constraint saying
-- otherwise would make deactivating a leaver fail against every record they
-- ever owned, or would force those records to be reassigned in the same
-- instant. Whether an *inactive* user may be given something *new* is a
-- rule about assignment, which is Phase 2C's, and belongs in the
-- application where it can say why it refused.

-- One index per table, on the column alone.
--
-- Two things need it, and the second one needs it today. Phase 2C will read
-- `WHERE owner_user_id = $me` on each of these lists, which is the obvious
-- reason. The immediate one is the foreign key itself: Postgres has to find
-- the referencing rows to null them when a user is deleted, and without an
-- index on the referencing side that is a sequential scan of all three
-- tables on every account deletion.
--
-- Single-column only. A composite with status or date would be guessing at
-- Phase 2C's query shapes before they exist, and an unused index is not
-- free — it is maintained on every insert and update to these tables.
CREATE INDEX IF NOT EXISTS enquiries_owner_user_id_idx  ON enquiries  (owner_user_id);
CREATE INDEX IF NOT EXISTS quotations_owner_user_id_idx ON quotations (owner_user_id);
CREATE INDEX IF NOT EXISTS projects_owner_user_id_idx   ON projects   (owner_user_id);
