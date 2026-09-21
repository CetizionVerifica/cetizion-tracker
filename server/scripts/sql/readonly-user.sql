-- A read-only database user for ad-hoc queries and reporting (#34).
-- Run once as the database owner, with a strong password of your own:
--   psql "$DATABASE_URL" -v ro_password="'...'" -f scripts/sql/readonly-user.sql
-- The app keeps its own user; people who only need to look use this one.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tracker_readonly') THEN
    CREATE ROLE tracker_readonly LOGIN;
  END IF;
END $$;

ALTER ROLE tracker_readonly WITH PASSWORD :ro_password;
ALTER ROLE tracker_readonly SET default_transaction_read_only = on;
ALTER ROLE tracker_readonly SET statement_timeout = '60s';
DO $$ BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO tracker_readonly', current_database()); END $$;
GRANT USAGE ON SCHEMA public TO tracker_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO tracker_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO tracker_readonly;
-- Secrets stay out of reach even for readers.
REVOKE SELECT ON connected_accounts, api_tokens, webhook_endpoints, portal_links, portal_sessions FROM tracker_readonly;
-- users holds the password hashes and the team's addresses. A hash is a
-- credential: given one, a password can be attacked offline at leisure.
-- docs/security.md says this account cannot read them, so it must not.
REVOKE SELECT ON users FROM tracker_readonly;
