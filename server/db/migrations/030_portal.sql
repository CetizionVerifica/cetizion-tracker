-- 030 — a client portal (#47).
--
-- A client contact signs in with a one-time link sent to their email and
-- sees their own company's projects, documents, invoices and certificates,
-- and can write to us. Off by default, switched on per company and per
-- section; access can be withdrawn per contact. Every view, download and
-- message is audited.
--
-- Safe on a live database; running it a second time changes nothing.

ALTER TABLE companies ADD COLUMN IF NOT EXISTS portal_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS portal_sections text[] NOT NULL DEFAULT '{projects,documents,invoices,certificates,contact}';
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS portal_access boolean NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS portal_links (
  id          serial PRIMARY KEY,
  contact_id  int NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  ip          text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS portal_sessions (
  id            text PRIMARY KEY,
  contact_id    int NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  company_id    int NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  last_seen_at  timestamptz,
  ip            text,
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS portal_sessions_contact_idx ON portal_sessions (contact_id);

CREATE TABLE IF NOT EXISTS portal_audit (
  id          bigserial PRIMARY KEY,
  session_id  text,
  contact_id  int REFERENCES contacts(id) ON DELETE SET NULL,
  company_id  int REFERENCES companies(id) ON DELETE CASCADE,
  action      text NOT NULL,
  target      text,
  ip          text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS portal_audit_company_idx ON portal_audit (company_id, created_at DESC);
