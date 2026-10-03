-- Where mailbox ownership stands after migration 074 (docs/per-user-mailboxes-plan.md §3).
--
-- Read-only. Counts only — no address and no name leaves this query, so it
-- can be pasted into a chat without carrying anybody's personal data.
--
--   psql "$DATABASE_URL" -f db/diagnostics/mailbox-owner-backfill.sql
--
-- The buckets classify the CURRENT state against the rules 074 applied.
-- "could still be matched" should be zero after the migration; a number
-- there means a user was added since it ran, and an admin can assign the
-- mailbox from Settings → Mailboxes → Change owner. "ambiguous" and
-- "unmatched" need a person: nobody, or more than one person, fits.

WITH personal AS (
  SELECT a.id, a.user_id,
         (SELECT count(*) FROM users u WHERE u.active AND lower(u.email) = lower(a.username)) AS by_username,
         (SELECT count(*) FROM users u WHERE u.active AND lower(u.email) = lower(a.email)) AS by_email,
         (SELECT count(*) FROM users u WHERE u.active AND lower(u.name) = lower(a.username)) AS by_name
    FROM connected_accounts a
   WHERE NOT a.is_shared AND a.status <> 'disconnected'
),
classified AS (
  SELECT CASE
           WHEN user_id IS NOT NULL THEN 'owned'
           WHEN by_username = 1 OR by_email = 1 OR by_name = 1 THEN 'could still be matched'
           WHEN by_username > 1 OR by_email > 1 OR by_name > 1 THEN 'ambiguous: more than one user fits'
           ELSE 'unmatched: no active user fits'
         END AS bucket
    FROM personal
)
SELECT bucket, count(*)::int AS mailboxes
  FROM classified
 GROUP BY bucket
 ORDER BY bucket;
