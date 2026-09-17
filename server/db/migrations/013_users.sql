-- 013 — people, so that records can belong to one of them later (#18).
--
-- Two kinds of row live here, and the difference is `active`:
--
--   A person who signs in    name, email, password_hash, active = true
--   A name from the old data name only: email and password_hash NULL,
--                            active = false. These exist so a historical
--                            "sales_person" string can become a real row
--                            without inventing an email address for
--                            somebody who never had one.
--
-- Nothing signs in against this table yet. The API still authenticates with
-- AUTH_USERNAME / AUTH_PASSWORD from the environment; this migration only
-- puts the accounts in place for that cutover.
--
-- Safe on a live database: it only adds a table, and running it a second
-- time changes nothing.

CREATE TABLE IF NOT EXISTS users (
  id             serial PRIMARY KEY,
  name           text NOT NULL,
  -- Null for an attribution-only row. Never a made-up address: a person
  -- who cannot sign in has no email here, and the partial index below
  -- lets any number of rows be in that state.
  email          text,
  password_hash  text,
  role           text NOT NULL DEFAULT 'sales'
                   CHECK (role IN ('admin','sales')),
  active         boolean NOT NULL DEFAULT true,
  last_login_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_name_not_blank  CHECK (btrim(name) <> ''),
  -- '' would satisfy "email IS NOT NULL" while being no address at all.
  CONSTRAINT users_email_not_blank CHECK (email IS NULL OR btrim(email) <> ''),
  CONSTRAINT users_password_hash_not_blank CHECK (password_hash IS NULL OR btrim(password_hash) <> ''),
  -- The invariant the application depends on: anyone who can sign in has
  -- something to sign in with. Enforced here rather than only in code, so
  -- a later importer, admin screen or hand-written UPDATE cannot skip it.
  CONSTRAINT users_active_needs_login CHECK (
    active = false OR (email IS NOT NULL AND password_hash IS NOT NULL)
  )
);

-- One account per address, however it was typed: A@Example.com and
-- a@example.com are the same person. Partial, so the attribution-only rows
-- (email IS NULL) are not compared with each other at all.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_key ON users (lower(email)) WHERE email IS NOT NULL;

DROP TRIGGER IF EXISTS users_set_updated_at ON users;
CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
