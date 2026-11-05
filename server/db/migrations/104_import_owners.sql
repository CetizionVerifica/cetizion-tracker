-- =====================================================================
-- 104_import_owners.sql
-- Imported deals belong to their salesperson, so sales users see their POs.
--
-- A sales user sees a purchase order only through a quotation or project
-- they own (auth/ownership.js). The sheet importer wrote sales_person but
-- never owner_user_id, so every imported deal was unowned: on the admin's
-- Orders list and missing from the salesperson's. Migration 096 assigned
-- owners once, to the records that existed then; everything imported after
-- it stayed unowned.
--
-- 1. import_batches.owner_map: the admin's answer, per salesperson name on
--    the sheet, for names that do not match a sales user exactly
--    (import/owners.js). Keyed by the name lower-cased with its spacing
--    collapsed; the value is a users.id, or null for "leave unassigned".
--
-- 2. The same two rules as 096, again, for quotations and projects that are
--    still unowned: the salesperson email, else the name ignoring case and
--    spacing, belongs to exactly one active sales user.
--
-- 3. A project still unowned takes the owner of the quotation it was won
--    from, when its quotations agree on exactly one active sales user. The
--    importer copies the quotation's salesperson onto the project, so this
--    is the same person; it also covers a project whose own name field was
--    left blank.
--
-- As in 096: only rows with no owner and no ownership history, so a record
-- an admin deliberately unassigned keeps that decision, and every
-- assignment is written to ownership_history as a system change.
--
-- Safe to re-run: an assigned row is no longer null.
-- =====================================================================

ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS owner_map jsonb NOT NULL DEFAULT '{}'::jsonb;

WITH matched AS (
  SELECT r.id,
         COALESCE(
           (SELECT max(u.id) FROM users u
             WHERE u.active AND u.role = 'sales'
               AND r.sales_person_email IS NOT NULL AND btrim(r.sales_person_email) <> ''
               AND lower(btrim(u.email)) = lower(btrim(r.sales_person_email))
            HAVING count(*) = 1),
           (SELECT max(u.id) FROM users u
             WHERE u.active AND u.role = 'sales'
               AND r.sales_person IS NOT NULL AND btrim(r.sales_person) <> ''
               AND lower(regexp_replace(btrim(u.name), '\s+', ' ', 'g'))
                 = lower(regexp_replace(btrim(r.sales_person), '\s+', ' ', 'g'))
            HAVING count(*) = 1)
         ) AS owner_id
    FROM quotations r
   WHERE r.owner_user_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM ownership_history h
                      WHERE h.entity_type = 'quotations' AND h.entity_id = r.id)
),
assigned AS (
  UPDATE quotations r
     SET owner_user_id = m.owner_id, updated_at = now()
    FROM matched m
   WHERE r.id = m.id AND m.owner_id IS NOT NULL
  RETURNING r.id, r.owner_user_id
)
INSERT INTO ownership_history (
  entity_type, entity_id,
  new_owner_user_id, new_owner_snapshot_id, new_owner_name,
  changed_by_name, actor_type, reason
)
SELECT 'quotations', a.id, a.owner_user_id, a.owner_user_id, u.name,
       'system', 'system', 'Owner set from the salesperson on the record (104)'
  FROM assigned a JOIN users u ON u.id = a.owner_user_id;

WITH matched AS (
  SELECT r.id,
         (SELECT max(u.id) FROM users u
           WHERE u.active AND u.role = 'sales'
             AND r.sales_person IS NOT NULL AND btrim(r.sales_person) <> ''
             AND lower(regexp_replace(btrim(u.name), '\s+', ' ', 'g'))
               = lower(regexp_replace(btrim(r.sales_person), '\s+', ' ', 'g'))
          HAVING count(*) = 1) AS owner_id
    FROM projects r
   WHERE r.owner_user_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM ownership_history h
                      WHERE h.entity_type = 'projects' AND h.entity_id = r.id)
),
assigned AS (
  UPDATE projects r
     SET owner_user_id = m.owner_id, updated_at = now()
    FROM matched m
   WHERE r.id = m.id AND m.owner_id IS NOT NULL
  RETURNING r.id, r.owner_user_id
)
INSERT INTO ownership_history (
  entity_type, entity_id,
  new_owner_user_id, new_owner_snapshot_id, new_owner_name,
  changed_by_name, actor_type, reason
)
SELECT 'projects', a.id, a.owner_user_id, a.owner_user_id, u.name,
       'system', 'system', 'Owner set from the salesperson on the record (104)'
  FROM assigned a JOIN users u ON u.id = a.owner_user_id;

WITH matched AS (
  SELECT r.id,
         (SELECT max(q.owner_user_id) FROM quotations q
            JOIN users u ON u.id = q.owner_user_id AND u.active AND u.role = 'sales'
           WHERE q.project_id = r.project_id
          HAVING count(DISTINCT q.owner_user_id) = 1) AS owner_id
    FROM projects r
   WHERE r.owner_user_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM ownership_history h
                      WHERE h.entity_type = 'projects' AND h.entity_id = r.id)
),
assigned AS (
  UPDATE projects r
     SET owner_user_id = m.owner_id, updated_at = now()
    FROM matched m
   WHERE r.id = m.id AND m.owner_id IS NOT NULL
  RETURNING r.id, r.owner_user_id
)
INSERT INTO ownership_history (
  entity_type, entity_id,
  new_owner_user_id, new_owner_snapshot_id, new_owner_name,
  changed_by_name, actor_type, reason
)
SELECT 'projects', a.id, a.owner_user_id, a.owner_user_id, u.name,
       'system', 'system', 'Owner taken from the project''s quotation (104)'
  FROM assigned a JOIN users u ON u.id = a.owner_user_id;
