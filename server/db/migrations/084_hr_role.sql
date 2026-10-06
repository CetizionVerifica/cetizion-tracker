-- =====================================================================
-- 084_hr_role.sql
-- The HR role (#196 §3): the travel desk. HR keeps trips, the travel
-- agency's invoices and credit notes, and the travel import; on the sales
-- side it sees only what linking a trip needs (a PO's number, value and
-- client, a project's id and client, the staff list). The gate is in
-- server/src/lib/authz/policy.js (HR_ROUTES and the hr flags on resources).
-- =====================================================================

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin','sales','hr'));

ALTER TABLE api_tokens DROP CONSTRAINT IF EXISTS api_tokens_role_check;
ALTER TABLE api_tokens ADD CONSTRAINT api_tokens_role_check CHECK (role IN ('admin','sales','hr'));
