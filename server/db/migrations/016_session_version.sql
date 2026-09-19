-- 016 — a revocation counter, so an admin can end somebody's session now (#18).
--
-- Sessions are a signed cookie rather than a row, which is why there has
-- been nothing to revoke: a cookie is good for twelve hours and the API had
-- no way to say "not that one". Switching an account off already took
-- effect on the next request, because `active` is re-read every time; a
-- password reset did not, and that is the gap. Somebody whose password was
-- changed because it had leaked went on using the tracker with the old
-- cookie until it expired.
--
-- The counter closes it. A cookie carries the value it was signed with, the
-- row carries the current one, and a request is only somebody's while the
-- two agree. Raising it here invalidates every cookie already issued for
-- that user and nothing else — no table to sweep, no other session touched.
--
-- Starting at 1 rather than 0 so "has a session version" and "has not been
-- revoked" never look the same as a missing column read as zero.
--
-- Safe on a live database: it adds one NOT NULL column with a default, which
-- Postgres 11 and later fill in without rewriting the table, and running it
-- a second time changes nothing.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS session_version integer NOT NULL DEFAULT 1;

-- A counter that only ever goes up. Reactivating an account must not hand
-- its old cookies back, so nothing is allowed to lower this; the constraint
-- says so to anything that writes the table, not only to this application.
ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_session_version_positive;
ALTER TABLE users
  ADD CONSTRAINT users_session_version_positive CHECK (session_version >= 1);
