-- My account (C20): where you are signed in, and the fields only you may change.
--
-- Sessions were a signed cookie and nothing else, which is why the app
-- could never show you your own devices or end one of them. The cookie is
-- still the thing that proves who you are; this table is the thing that
-- can be revoked, and it is what makes "sign out everywhere" and "sign out
-- that phone" two different, honest buttons rather than one button and a
-- list you cannot act on.
CREATE TABLE IF NOT EXISTS user_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- How they got in, so a person can tell the Microsoft session on their
  -- laptop from the password one on a phone.
  via           text NOT NULL DEFAULT 'password' CHECK (via IN ('password', 'microsoft', 'google')),
  user_agent    text,
  ip            text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz
);

CREATE INDEX IF NOT EXISTS user_sessions_user_idx
  ON user_sessions (user_id, last_seen_at DESC);

-- The fields a person owns about themselves. Role, email and whether the
-- account is active stay on the admin screens, because they are facts about
-- someone's job rather than about them.
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS signature text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS time_zone text;
-- Which emails they want. An empty object means "the defaults", so nobody
-- is silently unsubscribed from everything by this migration running.
ALTER TABLE users ADD COLUMN IF NOT EXISTS notify jsonb NOT NULL DEFAULT '{}'::jsonb;
