-- =====================================================================
-- 103_mcp_oauth.sql
-- The tracker as a claude.ai custom connector (#249).
--
-- claude.ai cannot send a pasted `ctz_` token; it signs in through OAuth
-- 2.1. The tracker is its own authorization server for one resource,
-- /api/mcp: the existing sign-in proves who the person is, they approve
-- once, and the tokens it issues are bound to their users row.
--
-- No role or person is copied onto a grant or a token. Both are read from
-- users on every call, so a role changed or an account switched off is in
-- force on the next request (CLAUDE.md, rules 1 and 2).
-- =====================================================================

-- A client that registered itself (RFC 7591). Only redirect URIs on the
-- server's allowlist are accepted, so registering one gains nothing but a
-- place to send a code back to Claude.
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id                 text PRIMARY KEY,
  -- Null for a public client (token_endpoint_auth_method 'none').
  client_secret_hash        text,
  client_secret_expires_at  timestamptz,
  client_name               text,
  redirect_uris             text[] NOT NULL,
  -- The rest of what the client registered, returned as it was given.
  metadata                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                timestamptz NOT NULL DEFAULT now()
);

-- One person's approval of one client. Disconnecting revokes it, and every
-- token issued under it stops with it.
CREATE TABLE IF NOT EXISTS oauth_grants (
  id            serial PRIMARY KEY,
  user_id       int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id     text NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  -- Off unless the person ticked it on the consent screen, as for tokens.
  can_write     boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);

CREATE INDEX IF NOT EXISTS oauth_grants_user_idx ON oauth_grants (user_id);

-- An authorization request, from the moment Claude sends the browser here
-- until its code is exchanged. The request id is what the consent screen
-- holds; the code exists only once the person has approved.
CREATE TABLE IF NOT EXISTS oauth_requests (
  id_hash         text PRIMARY KEY,
  client_id       text NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  redirect_uri    text NOT NULL,
  code_challenge  text NOT NULL,
  state           text,
  scopes          text[] NOT NULL DEFAULT '{}',
  resource        text NOT NULL,
  expires_at      timestamptz NOT NULL,
  grant_id        int REFERENCES oauth_grants(id) ON DELETE CASCADE,
  code_hash       text UNIQUE,
  decided_at      timestamptz,
  used_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Access tokens (an hour) and refresh tokens (thirty days, replaced on every
-- use). Opaque and hashed, so revoking one bites on the next call.
CREATE TABLE IF NOT EXISTS oauth_tokens (
  id           bigserial PRIMARY KEY,
  token_hash   text NOT NULL UNIQUE,
  grant_id     int NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('access', 'refresh')),
  resource     text NOT NULL,
  expires_at   timestamptz NOT NULL,
  -- A refresh token that has been exchanged points at the one that replaced
  -- it. Presenting it again is a stolen copy, and the whole grant is revoked.
  replaced_by  bigint REFERENCES oauth_tokens(id) ON DELETE SET NULL,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS oauth_tokens_grant_idx ON oauth_tokens (grant_id);

-- A tool call made through a connector is logged like one made with a token.
ALTER TABLE api_token_log ADD COLUMN IF NOT EXISTS grant_id int REFERENCES oauth_grants(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS api_token_log_grant_idx ON api_token_log (grant_id, created_at DESC);

INSERT INTO settings (key, value, notes) VALUES
  ('mcp_connector_roles', 'admin,sales', 'Who may connect Claude (claude.ai) to the tracker with their own sign-in: admin, sales, both, or none to switch the connector off.')
ON CONFLICT (key) DO NOTHING;
