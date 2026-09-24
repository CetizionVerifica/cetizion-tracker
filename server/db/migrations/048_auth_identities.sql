-- Sign in with Microsoft 365 or Google (C18/C20).
--
-- One person, several ways in. A user row is still the person; an identity
-- is a door into it. Nothing here creates people: an identity can only ever
-- attach to a users row an admin has already added and left active, which
-- is what "restricted to accounts an admin has added" means in practice.
--
-- The users_active_needs_login CHECK is deliberately left alone. An active
-- account still needs a password, so linking a provider adds a way in
-- rather than replacing the one that works when a provider is down.
CREATE TABLE IF NOT EXISTS auth_identities (
  id            serial PRIMARY KEY,
  user_id       integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider      text NOT NULL CHECK (provider IN ('microsoft', 'google')),
  -- The provider's own immutable id for the person. Email can change;
  -- this cannot, so it is what a returning sign-in is matched on.
  subject       text NOT NULL CHECK (btrim(subject) <> ''),
  email         text,
  linked_at     timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz
);

-- One provider account signs in one person, never two.
CREATE UNIQUE INDEX IF NOT EXISTS auth_identities_subject_idx
  ON auth_identities (provider, subject);

-- And one person has at most one account per provider, so "unlink Google"
-- is unambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS auth_identities_user_provider_idx
  ON auth_identities (user_id, provider);
