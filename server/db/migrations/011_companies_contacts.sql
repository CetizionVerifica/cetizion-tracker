-- 011 — companies and contacts behind the typed client names (#20).
--
-- A client exists once, in companies, keyed on its normalised name. Every
-- quotation, enquiry and project keeps its client_name column (the forms
-- and the importer still write it) and gains company_id, which a trigger
-- fills from the name: the same spelling links to the same company, a new
-- spelling creates one. Contacts work the same way under their company.
--
-- Safe on a live database: creates what is missing, links what is not
-- linked, and running it a second time changes nothing.

CREATE TABLE IF NOT EXISTS companies (
  id          serial PRIMARY KEY,
  name        text NOT NULL,
  name_key    text NOT NULL UNIQUE,
  sector      text,
  gstin       text,
  website     text,
  address     text,
  city        text,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS contacts (
  id                 serial PRIMARY KEY,
  company_id         int NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name               text NOT NULL,
  email              text,
  phone              text,
  role               text,
  is_billing         boolean NOT NULL DEFAULT false,
  opt_out_reminders  boolean NOT NULL DEFAULT false,
  notes              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS contacts_company_id_idx ON contacts (company_id);
CREATE UNIQUE INDEX IF NOT EXISTS contacts_company_name_key
  ON contacts (company_id, lower(regexp_replace(btrim(name), '\s+', ' ', 'g')));

ALTER TABLE quotations
  ADD COLUMN IF NOT EXISTS company_id int REFERENCES companies(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS contact_id int REFERENCES contacts(id) ON DELETE SET NULL;
ALTER TABLE enquiries
  ADD COLUMN IF NOT EXISTS company_id int REFERENCES companies(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS contact_id int REFERENCES contacts(id) ON DELETE SET NULL;
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS company_id int REFERENCES companies(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS quotations_company_id_idx ON quotations (company_id);
CREATE INDEX IF NOT EXISTS enquiries_company_id_idx ON enquiries (company_id);
CREATE INDEX IF NOT EXISTS projects_company_id_idx ON projects (company_id);

-- The grouping key the reports already use for free-text names.
CREATE OR REPLACE FUNCTION name_key(p_name text) RETURNS text AS $$
  SELECT NULLIF(lower(regexp_replace(btrim(p_name), '\s+', ' ', 'g')), '');
$$ LANGUAGE sql IMMUTABLE;

-- The company for a typed name: found by key, or created with that spelling.
CREATE OR REPLACE FUNCTION company_for(p_name text) RETURNS int AS $$
DECLARE k text; cid int;
BEGIN
  k := name_key(p_name);
  IF k IS NULL THEN RETURN NULL; END IF;
  SELECT id INTO cid FROM companies WHERE name_key = k;
  IF cid IS NULL THEN
    INSERT INTO companies (name, name_key) VALUES (regexp_replace(btrim(p_name), '\s+', ' ', 'g'), k)
      ON CONFLICT (name_key) DO UPDATE SET name = companies.name
      RETURNING id INTO cid;
  END IF;
  RETURN cid;
END $$ LANGUAGE plpgsql;

-- The contact of that name at a company: found or created.
CREATE OR REPLACE FUNCTION contact_for(p_company int, p_name text) RETURNS int AS $$
DECLARE k text; cid int;
BEGIN
  k := name_key(p_name);
  IF p_company IS NULL OR k IS NULL THEN RETURN NULL; END IF;
  SELECT id INTO cid FROM contacts WHERE company_id = p_company
    AND lower(regexp_replace(btrim(name), '\s+', ' ', 'g')) = k;
  IF cid IS NULL THEN
    INSERT INTO contacts (company_id, name) VALUES (p_company, regexp_replace(btrim(p_name), '\s+', ' ', 'g'))
      ON CONFLICT (company_id, lower(regexp_replace(btrim(name), '\s+', ' ', 'g'))) DO UPDATE SET name = contacts.name
      RETURNING id INTO cid;
  END IF;
  RETURN cid;
END $$ LANGUAGE plpgsql;

-- companies.name_key always follows companies.name.
CREATE OR REPLACE FUNCTION companies_set_key() RETURNS trigger AS $$
BEGIN
  NEW.name := regexp_replace(btrim(NEW.name), '\s+', ' ', 'g');
  NEW.name_key := name_key(NEW.name);
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- A renamed company renames the client on every record that points at it.
CREATE OR REPLACE FUNCTION companies_rename_records() RETURNS trigger AS $$
BEGIN
  IF NEW.name IS DISTINCT FROM OLD.name THEN
    UPDATE quotations SET client_name = NEW.name WHERE company_id = NEW.id;
    UPDATE enquiries  SET client_name = NEW.name WHERE company_id = NEW.id;
    UPDATE projects   SET client_name = NEW.name WHERE company_id = NEW.id;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- Records link to their company from client_name, and (where the record has
-- one) to their contact from contact_person. A company with no sector yet
-- takes the record's sector.
CREATE OR REPLACE FUNCTION link_company() RETURNS trigger AS $$
DECLARE rec jsonb; changed boolean;
BEGIN
  rec := to_jsonb(NEW);
  IF TG_OP = 'INSERT' THEN
    changed := true;
  ELSE
    changed := NEW.company_id IS NULL OR NEW.client_name IS DISTINCT FROM OLD.client_name;
  END IF;
  IF changed THEN
    NEW.company_id := company_for(NEW.client_name);
  END IF;
  IF NEW.company_id IS NOT NULL AND rec ? 'sector' AND name_key(rec->>'sector') IS NOT NULL THEN
    UPDATE companies SET sector = rec->>'sector' WHERE id = NEW.company_id AND name_key(sector) IS NULL;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION link_contact() RETURNS trigger AS $$
DECLARE changed boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    changed := true;
  ELSE
    changed := NEW.contact_id IS NULL
      OR NEW.contact_person IS DISTINCT FROM OLD.contact_person
      OR NEW.company_id IS DISTINCT FROM OLD.company_id;
  END IF;
  IF changed THEN
    NEW.contact_id := contact_for(NEW.company_id, NEW.contact_person);
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS companies_set_key ON companies;
CREATE TRIGGER companies_set_key BEFORE INSERT OR UPDATE ON companies
  FOR EACH ROW EXECUTE FUNCTION companies_set_key();
DROP TRIGGER IF EXISTS companies_rename_records ON companies;
CREATE TRIGGER companies_rename_records AFTER UPDATE ON companies
  FOR EACH ROW EXECUTE FUNCTION companies_rename_records();
DROP TRIGGER IF EXISTS companies_set_updated_at ON companies;
CREATE TRIGGER companies_set_updated_at BEFORE UPDATE ON companies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS contacts_set_updated_at ON contacts;
CREATE TRIGGER contacts_set_updated_at BEFORE UPDATE ON contacts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Trigger names sort a before b, so the company is linked before the contact.
DROP TRIGGER IF EXISTS a_link_company ON quotations;
CREATE TRIGGER a_link_company BEFORE INSERT OR UPDATE ON quotations FOR EACH ROW EXECUTE FUNCTION link_company();
DROP TRIGGER IF EXISTS b_link_contact ON quotations;
CREATE TRIGGER b_link_contact BEFORE INSERT OR UPDATE ON quotations FOR EACH ROW EXECUTE FUNCTION link_contact();
DROP TRIGGER IF EXISTS a_link_company ON enquiries;
CREATE TRIGGER a_link_company BEFORE INSERT OR UPDATE ON enquiries FOR EACH ROW EXECUTE FUNCTION link_company();
DROP TRIGGER IF EXISTS b_link_contact ON enquiries;
CREATE TRIGGER b_link_contact BEFORE INSERT OR UPDATE ON enquiries FOR EACH ROW EXECUTE FUNCTION link_contact();
DROP TRIGGER IF EXISTS a_link_company ON projects;
CREATE TRIGGER a_link_company BEFORE INSERT OR UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION link_company();

-- Link what is already there. The BEFORE UPDATE triggers do the work.
UPDATE quotations SET company_id = NULL WHERE company_id IS NULL;
UPDATE enquiries  SET company_id = NULL WHERE company_id IS NULL;
UPDATE projects   SET company_id = NULL WHERE company_id IS NULL;
