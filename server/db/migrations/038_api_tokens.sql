-- 038 — API tokens and the MCP server (#50).
--
-- A token lets Claude (or another MCP client) read the tracker and make a
-- few guarded notes on it. Only a hash is stored. A sales token sees only
-- the records of the person it names; an admin token sees everything.
-- Every call is logged. Until user accounts (#18) the "person" is the
-- sales-person name used on records.
--
-- Safe on a live database; running it a second time changes nothing.

CREATE TABLE IF NOT EXISTS api_tokens (
  id            serial PRIMARY KEY,
  name          text NOT NULL,
  token_hash    text NOT NULL UNIQUE,
  token_prefix  text NOT NULL,
  role          text NOT NULL DEFAULT 'sales' CHECK (role IN ('admin','sales')),
  person        text,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  CHECK (role = 'admin' OR person IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS api_token_log (
  id          bigserial PRIMARY KEY,
  token_id    int REFERENCES api_tokens(id) ON DELETE CASCADE,
  tool        text NOT NULL,
  arguments   jsonb,
  ok          boolean NOT NULL DEFAULT true,
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS api_token_log_token_idx ON api_token_log (token_id, created_at DESC);
