-- =====================================================================
-- 096_owner_from_salesperson.sql
-- Records an admin created for a salesperson now belong to that person.
--
-- The forms label the salesperson as the record's Owner, but an admin's
-- save left owner_user_id null, and an unowned record is visible to admins
-- only. So an enquiry, quotation or project an admin entered for, say,
-- Madhuri Pogir showed on the admin's list and not on hers. New saves now
-- assign the owner (lib/salespersonOwner.js); this file does the same for
-- the records saved before that, with the same two rules:
--
--   1. the salesperson email belongs to exactly one active sales user;
--   2. otherwise the name, ignoring case and spacing, belongs to exactly
--      one active sales user.
--
-- Only rows with no owner and no ownership history: a record an admin has
-- deliberately unassigned keeps that decision. Each assignment is written
-- to ownership_history, as a system change, like any other.
--
-- DML only, and safe to re-run: an assigned row is no longer null.
-- =====================================================================

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
    FROM enquiries r
   WHERE r.owner_user_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM ownership_history h
                      WHERE h.entity_type = 'enquiries' AND h.entity_id = r.id)
),
assigned AS (
  UPDATE enquiries r
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
SELECT 'enquiries', a.id, a.owner_user_id, a.owner_user_id, u.name,
       'system', 'system', 'Owner set from the salesperson on the record (096)'
  FROM assigned a JOIN users u ON u.id = a.owner_user_id;

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
       'system', 'system', 'Owner set from the salesperson on the record (096)'
  FROM assigned a JOIN users u ON u.id = a.owner_user_id;

WITH matched AS (
  SELECT r.id,
         COALESCE(
           (SELECT max(u.id) FROM users u
             WHERE u.active AND u.role = 'sales'
               AND NULL::text IS NOT NULL AND btrim(NULL::text) <> ''
               AND lower(btrim(u.email)) = lower(btrim(NULL::text))
            HAVING count(*) = 1),
           (SELECT max(u.id) FROM users u
             WHERE u.active AND u.role = 'sales'
               AND r.sales_person IS NOT NULL AND btrim(r.sales_person) <> ''
               AND lower(regexp_replace(btrim(u.name), '\s+', ' ', 'g'))
                 = lower(regexp_replace(btrim(r.sales_person), '\s+', ' ', 'g'))
            HAVING count(*) = 1)
         ) AS owner_id
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
       'system', 'system', 'Owner set from the salesperson on the record (096)'
  FROM assigned a JOIN users u ON u.id = a.owner_user_id;
