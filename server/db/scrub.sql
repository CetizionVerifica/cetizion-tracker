-- Scrub a copy of production for staging (#35). Never run on production.
--
--   psql "$STAGING_DATABASE_URL" -v ON_ERROR_STOP=1 -f server/db/scrub.sql
--
-- Clients and contacts get realistic fake names, emails and phones;
-- amounts, dates and statuses stay, so reports look right. Anything that
-- could reach the outside world (mailboxes, webhooks, portal, tokens,
-- accounting, email) is switched off, and stored files are cut loose.
-- Triggers are off while it runs, so every copy of a name is set here.

BEGIN;

DO $$
BEGIN
  IF current_database() ILIKE '%prod%' THEN
    RAISE EXCEPTION 'Refusing to scrub a database whose name looks like production (%).', current_database();
  END IF;
END $$;

SET LOCAL session_replication_role = replica;

CREATE TEMP TABLE fake_words (kind text, n int, word text) ON COMMIT DROP;
INSERT INTO fake_words (kind, n, word)
SELECT 'adj', (ordinality - 1)::int, w FROM unnest(ARRAY['Aster','Banyan','Cobalt','Deccan','Everest','Falcon','Garnet','Harbour','Indus','Jasper','Kaveri','Lotus','Meridian','Narmada','Onyx','Peacock','Quartz','Riverstone','Saffron','Teak','Umber','Vega','Willow','Xenon','Yamuna','Zenith','Amber','Bluebell','Cedar']) WITH ORDINALITY AS t(w, ordinality)
UNION ALL SELECT 'noun', (ordinality - 1)::int, w FROM unnest(ARRAY['Metals','Textiles','Pharma','Chemicals','Foods','Polymers','Logistics','Engineering','Ceramics','Paper','Auto Parts','Cables','Glass','Agro','Steel','Packaging','Energy','Apparel','Tyres','Pumps','Alloys','Paints','Plastics','Electronics','Fibres','Castings','Solvents','Minerals','Leather','Spices','Tiles']) WITH ORDINALITY AS t(w, ordinality)
UNION ALL SELECT 'suffix', (ordinality - 1)::int, w FROM unnest(ARRAY['Pvt Ltd','Limited','Industries','India Pvt Ltd','Group']) WITH ORDINALITY AS t(w, ordinality)
UNION ALL SELECT 'first', (ordinality - 1)::int, w FROM unnest(ARRAY['Aarav','Priya','Rohan','Ananya','Vikram','Meera','Arjun','Kavya','Sanjay','Neha','Rahul','Isha','Karan','Pooja','Aditya','Sneha','Nikhil','Divya','Manish','Ritu','Suresh','Anjali','Deepak','Swati','Amit','Nisha','Varun','Shreya','Gaurav','Tanvi','Harish','Lakshmi','Imran','Farah','Joseph','Maria','Gurpreet','Simran','Tenzin','Leela']) WITH ORDINALITY AS t(w, ordinality)
UNION ALL SELECT 'last', (ordinality - 1)::int, w FROM unnest(ARRAY['Sharma','Iyer','Patel','Reddy','Gupta','Nair','Singh','Menon','Rao','Das','Joshi','Kulkarni','Chopra','Bose','Mehta','Pillai','Verma','Shetty','Banerjee','Desai','Kapoor','Mishra','Naidu','Agarwal','Saxena','Pandey','Kaur','Thomas','Fernandes','Khan','Bhat','Ghosh','Chauhan','Malhotra','Trivedi','Sinha','Dutta','Jain','Rathore','Kamath']) WITH ORDINALITY AS t(w, ordinality);

-- No fake word may be a word of a real name, or the fake would give the real one away.
DELETE FROM fake_words w WHERE EXISTS (
  SELECT 1 FROM (
    SELECT name AS v FROM companies UNION ALL SELECT name FROM contacts
    UNION ALL SELECT client_name FROM quotations UNION ALL SELECT contact_person FROM quotations
    UNION ALL SELECT client_name FROM enquiries UNION ALL SELECT contact_person FROM enquiries
    UNION ALL SELECT client_name FROM projects
  ) real_names WHERE lower(v) ~ ('\m' || lower(w.word) || '\M'));
UPDATE fake_words f SET n = r.rn FROM (SELECT kind, word, (row_number() OVER (PARTITION BY kind ORDER BY n) - 1)::int AS rn FROM fake_words) r
 WHERE r.kind = f.kind AND r.word = f.word;
DO $$
BEGIN
  IF (SELECT count(DISTINCT kind) FROM fake_words) < 5 THEN
    RAISE EXCEPTION 'Too many fake words collide with real names; extend the word lists in scrub.sql.';
  END IF;
END $$;

CREATE FUNCTION pg_temp.pick(k text, i bigint) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT word FROM fake_words WHERE kind = k AND n = (abs(i) % (SELECT count(*) FROM fake_words WHERE kind = k))
$$;
-- A plausible company name for an id; duplicates get the id added below.
CREATE FUNCTION pg_temp.company_name(i bigint) RETURNS text LANGUAGE sql STABLE AS $$
  WITH c AS (SELECT (SELECT count(*) FROM fake_words WHERE kind = 'adj') AS a, (SELECT count(*) FROM fake_words WHERE kind = 'noun') AS n)
  SELECT pg_temp.pick('adj', i) || ' ' || pg_temp.pick('noun', i * 7 + i / c.a) || ' ' || pg_temp.pick('suffix', i * 3) FROM c
$$;
CREATE FUNCTION pg_temp.person_name(i bigint) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT pg_temp.pick('first', i * 7) || ' ' || pg_temp.pick('last', i * 13 + 3)
$$;

-- 1. Companies and contacts.
UPDATE companies SET name = pg_temp.company_name(id), gstin = NULL, website = NULL, address = NULL, notes = NULL;
UPDATE companies c SET name = c.name || ' ' || c.id
  FROM (SELECT id, row_number() OVER (PARTITION BY name_key(name) ORDER BY id) AS k FROM companies) d
 WHERE d.id = c.id AND d.k > 1;
UPDATE companies SET name_key = name_key(name);
UPDATE contacts SET
  name = pg_temp.person_name(id) || CASE WHEN EXISTS (SELECT 1 FROM contacts c2 WHERE c2.company_id = contacts.company_id AND c2.id <> contacts.id AND pg_temp.person_name(c2.id) = pg_temp.person_name(contacts.id)) THEN ' ' || id ELSE '' END,
  email = CASE WHEN email IS NULL THEN NULL ELSE 'contact' || id || '@example.test' END,
  phone = CASE WHEN phone IS NULL THEN NULL ELSE '+91 90000 ' || lpad((id % 100000)::text, 5, '0') END,
  whatsapp_number = CASE WHEN whatsapp_number IS NULL THEN NULL ELSE '+91 90000 ' || lpad((id % 100000)::text, 5, '0') END,
  notes = NULL;

-- 2. Every place a client or contact name is copied.
UPDATE quotations q SET client_name = COALESCE(c.name, 'Client Q' || q.id), contact_person = CASE WHEN q.contact_person IS NULL THEN NULL ELSE COALESCE(ct.name, pg_temp.person_name(q.id + 50000)) END,
       accepted_by_name = CASE WHEN q.accepted_by_name IS NULL THEN NULL ELSE COALESCE(ct.name, pg_temp.person_name(q.id + 60000)) END, lost_notes = NULL
  FROM quotations q2 LEFT JOIN companies c ON c.id = q2.company_id LEFT JOIN contacts ct ON ct.id = q2.contact_id WHERE q2.id = q.id;
UPDATE enquiries e SET client_name = COALESCE(c.name, 'Client E' || e.id), contact_person = CASE WHEN e.contact_person IS NULL THEN NULL ELSE COALESCE(ct.name, pg_temp.person_name(e.id + 70000)) END, notes = NULL, unqualified_notes = NULL
  FROM enquiries e2 LEFT JOIN companies c ON c.id = e2.company_id LEFT JOIN contacts ct ON ct.id = e2.contact_id WHERE e2.id = e.id;
UPDATE projects p SET client_name = COALESCE(c.name, 'Client P' || p.id), remarks = NULL
  FROM projects p2 LEFT JOIN companies c ON c.id = p2.company_id WHERE p2.id = p.id;
UPDATE engagements e SET client_name = COALESCE(c.name, 'Client G' || e.id), notes = NULL FROM companies c WHERE c.id = e.company_id;
UPDATE engagements SET client_name = 'Client G' || id WHERE company_id IS NULL;
UPDATE deliverables d SET client_name = COALESCE(c.name, 'Client D' || d.id), scope = NULL, notes = NULL FROM companies c WHERE c.id = d.company_id;
UPDATE deliverables SET client_name = 'Client D' || id WHERE company_id IS NULL;
UPDATE books_entries b SET customer_name = COALESCE(c.name, 'Customer ' || b.id), customer_gstin = NULL, raw = NULL FROM companies c WHERE c.id = b.company_id;
UPDATE books_entries SET customer_name = 'Customer ' || id, customer_gstin = NULL, raw = NULL WHERE company_id IS NULL;
UPDATE inbox_conversations SET from_email = CASE WHEN from_email IS NULL THEN NULL ELSE 'sender' || id || '@example.test' END, from_name = pg_temp.person_name(id + 80000);
UPDATE payment_stages SET remarks = NULL WHERE remarks IS NOT NULL;

-- 3. Free text that may name people or quote them.
UPDATE notes SET body = '[note removed on staging]';
UPDATE communications SET summary = CASE WHEN summary IS NULL THEN NULL ELSE '[summary removed on staging]' END, attendees = NULL;
UPDATE collection_log SET summary = '[removed on staging]';
UPDATE tasks SET description = NULL;
UPDATE email_threads SET subject = '[subject removed]';
UPDATE email_messages SET subject = '[subject removed]', snippet = NULL, body_html = NULL,
       from_email = CASE WHEN direction = 'inbound' THEN 'sender' || id || '@example.test' ELSE from_email END, from_name = NULL,
       to_emails = ARRAY['recipient' || id || '@example.test'], cc_emails = '{}';
UPDATE email_log SET to_email = 'recipient' || id || '@example.test', cc = NULL, body_text = NULL, body_html = NULL;
UPDATE quotation_acceptances SET sent_to = NULL, decided_by_name = CASE WHEN decided_by_name IS NULL THEN NULL ELSE 'Client signatory' END,
       decided_by_email = NULL, ip = NULL, user_agent = NULL, comments = NULL, snapshot = NULL;
UPDATE portal_audit SET ip = NULL;
UPDATE auth_events SET ip = NULL, username = NULL;
DELETE FROM notifications;

-- 4. Nothing on staging may reach the outside world or use production credentials.
UPDATE connected_accounts SET status = 'disconnected', tokens_encrypted = NULL, email = 'mailbox' || id || '@example.test';
DELETE FROM mail_folders;
UPDATE webhook_endpoints SET active = false, when_inactive = 'drop', url = 'https://example.test/webhook/' || id, secret = 'scrubbed';
DELETE FROM webhook_deliveries;
UPDATE companies SET portal_enabled = false;
DELETE FROM portal_sessions; DELETE FROM portal_links;
UPDATE api_tokens SET revoked_at = COALESCE(revoked_at, now());
UPDATE settings SET value = 'false' WHERE key = 'emails_enabled';
UPDATE settings SET value = 'none' WHERE key = 'accounting_provider';
UPDATE settings SET value = '' WHERE key IN ('digest_email', 'alert_email', 'finance_email', 'discount_approver_email', 'public_app_url');
-- Stored files stay in production's storage; staging cannot open them.
UPDATE documents SET storage_key = 'scrubbed-on-staging/' || id, file_name = 'file-' || id || regexp_replace(file_name, '^.*(\.[A-Za-z0-9]{1,5})$|^.*$', '\1');
-- Sessions are signed by staging's own secret, so none from production work.

COMMIT;
