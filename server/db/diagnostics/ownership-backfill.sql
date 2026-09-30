-- Where ownership stands, and why the rest is unassigned (#18 Phase 2B).
--
-- Read-only. Counts only — no name, no email, no record identifier leaves
-- this query, so it can be run and pasted somewhere without carrying
-- anybody's personal data with it.
--
--   npm run ownership:backfill -- --dry-run      (formatted)
--   psql "$DATABASE_URL" -f db/diagnostics/ownership-backfill.sql
--
-- Deliberately not an API endpoint. It is an operator's question asked once
-- before Phase 2C, not a feature; a route would need authorisation, a
-- response shape and a test suite to tell somebody something they can read
-- off the database directly.
--
-- The buckets classify the CURRENT state against the same rules migration
-- 019 uses, so after a backfill the two "could still be matched" rows
-- should both be zero. A number there means somebody has been added to the
-- users table since the backfill ran, and re-running 019 would now claim
-- those records.

WITH norm AS (
  SELECT 'enquiries' AS tbl, owner_user_id,
         nullif(btrim(sales_person_email), '') AS email,
         nullif(lower(regexp_replace(btrim(sales_person), '\s+', ' ', 'g')), '') AS name
    FROM enquiries
  UNION ALL
  SELECT 'quotations', owner_user_id,
         nullif(btrim(sales_person_email), ''),
         nullif(lower(regexp_replace(btrim(sales_person), '\s+', ' ', 'g')), '')
    FROM quotations
  UNION ALL
  -- projects has no salesperson email column, so every row here is
  -- name-only by construction.
  SELECT 'projects', owner_user_id,
         NULL,
         nullif(lower(regexp_replace(btrim(sales_person), '\s+', ' ', 'g')), '')
    FROM projects
),
classified AS (
  SELECT n.tbl,
         n.owner_user_id IS NOT NULL AS owned,
         n.email IS NOT NULL         AS has_email,
         n.name IS NOT NULL          AS has_name,
         (SELECT count(*) FROM users u WHERE lower(btrim(u.email)) = lower(n.email)) AS email_hits,
         (SELECT count(*) FROM users u
           WHERE lower(regexp_replace(btrim(u.name), '\s+', ' ', 'g')) = n.name)     AS name_hits
    FROM norm n
)
-- Driven off a fixed list of the three tables rather than off the rows, so
-- a table with nothing in it reports zeroes instead of disappearing from
-- the output — a missing line reads as a broken query, not an empty table.
SELECT t.tbl AS table_name,
       count(c.tbl)                                                    AS total,
       count(*) FILTER (WHERE owned)                                   AS owned,
       count(*) FILTER (WHERE NOT owned AND has_email AND email_hits = 1) AS email_would_match,
       count(*) FILTER (WHERE NOT owned AND NOT has_email AND has_name AND name_hits = 1) AS name_would_match,
       count(*) FILTER (WHERE NOT owned AND NOT has_email AND has_name AND name_hits > 1) AS name_ambiguous,
       count(*) FILTER (WHERE NOT owned AND has_email AND email_hits <> 1) AS email_matches_nobody,
       count(*) FILTER (WHERE NOT owned AND NOT has_email AND (NOT has_name OR name_hits = 0)) AS no_signal
  FROM (VALUES ('enquiries'), ('quotations'), ('projects')) AS t(tbl)
  LEFT JOIN classified c ON c.tbl = t.tbl
 GROUP BY t.tbl
 ORDER BY t.tbl;
