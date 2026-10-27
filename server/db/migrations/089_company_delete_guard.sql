-- =====================================================================
-- 089_company_delete_guard.sql
-- Deleting a company that still has records refuses instead of coming back.
--
-- quotations, enquiries and projects pointed at companies ON DELETE SET
-- NULL. Nulling company_id is an UPDATE, which fires a_link_company, which
-- sees company_id IS NULL and links the record from its client_name again:
-- company_for() finds no company of that name (the old row is gone) and
-- creates a new one. So the delete answered 204 and the same client was
-- back on the list straight away, with a new id and its contacts re-created
-- from the records.
--
-- Those three tables name the client in client_name, so a company behind
-- them cannot be deleted in any meaningful sense: the records would bring it
-- back on their next save even if this trigger were taught to stand aside.
-- The way to get rid of one is to merge it into the company the records
-- really belong to (lib/companies.js moves them first, then deletes). So
-- the delete is refused while records still point at it; the API turns the
-- foreign-key error into a message that says so (middleware/error.js).
--
-- The other references (visits, communications, mail, collections …) keep
-- SET NULL: nothing relinks those, and a company with none of the three
-- above is a stray spelling nobody needs.
-- =====================================================================

ALTER TABLE quotations DROP CONSTRAINT IF EXISTS quotations_company_id_fkey;
ALTER TABLE quotations ADD CONSTRAINT quotations_company_id_fkey
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT;

ALTER TABLE enquiries DROP CONSTRAINT IF EXISTS enquiries_company_id_fkey;
ALTER TABLE enquiries ADD CONSTRAINT enquiries_company_id_fkey
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT;

ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_company_id_fkey;
ALTER TABLE projects ADD CONSTRAINT projects_company_id_fkey
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT;
