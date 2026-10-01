-- 066 — a sign-in belongs to an account, and a sign-out is an event (#18 §3).
--
-- @Hayyan612's review of #83 called missing sign-in events "the biggest
-- gap" in the activity log, "for a table whose stated purpose is the
-- security question". Looking at it properly, the events are not missing —
-- `auth_events` (040) has recorded every success and failure since before
-- the activity log existed, and it is not incidental logging: recentFailures()
-- reads it to decide a lockout, so it is the rate limiter's own store.
--
-- Copying those rows into activity_log would give one event two homes that
-- can disagree. What 040 actually lacks is smaller and more useful:
--
--   1. it keys a sign-in to `username`, the text that was typed into the
--      form. For a failure that is the only thing there is — nobody knows
--      who a wrong password belongs to. For a success it is a spelling of
--      an account we had already resolved, which is the same name-instead-
--      of-an-id problem 063 just took out of the MCP tokens. "Every session
--      this person opened" cannot be asked of it.
--
--   2. it records no sign-out at all, so a session's end is invisible and
--      "were they still signed in at 19:40?" has no answer.
--
-- Safe on a live database: one nullable column, one index, and no data is
-- rewritten. Running it a second time changes nothing.

ALTER TABLE auth_events ADD COLUMN IF NOT EXISTS user_id integer;

-- SET NULL, not CASCADE, and the reasoning is activity_log's (044): cascade
-- would let deleting an account erase every sign-in it ever made, which is
-- the one deletion a security log exists to survive.
ALTER TABLE auth_events DROP CONSTRAINT IF EXISTS auth_events_user_id_fkey;
ALTER TABLE auth_events ADD CONSTRAINT auth_events_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;

-- "Every session this account opened", newest first. Partial, because the
-- rows worth asking that of are the ones that resolved to an account:
-- failures usually have no user_id and the limiter reads them by ip and
-- username, not by this.
CREATE INDEX IF NOT EXISTS auth_events_user_idx
  ON auth_events (user_id, created_at DESC) WHERE user_id IS NOT NULL;

-- `reason` is free text today ('locked', 'bad credentials', NULL for a
-- success). A sign-out is recorded as ok = true with reason = 'signed out',
-- which needs no constraint change and keeps the limiter's queries — which
-- count rows with `ok` false, or take MAX(created_at) WHERE ok — reading
-- exactly as they did.
--
-- Deliberately not backfilled. Historical rows name a typed username and
-- nothing else; resolving them now would be the same guess 063 refused to
-- make for tokens, and a wrong attribution in a security log is worse than
-- an absent one. They stay as they are, and everything from here on carries
-- the id.
