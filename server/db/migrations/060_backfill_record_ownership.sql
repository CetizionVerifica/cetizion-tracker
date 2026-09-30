-- 060 — fill in the owner where history says it beyond doubt (#18 Phase 2B).
--
-- 059 added owner_user_id to enquiries, quotations and projects and left it
-- null on every row, because there was no safe way to fill it in from a
-- migration that knew nothing about the business. This file fills in the
-- subset where the historical data names somebody exactly, and leaves the
-- rest alone.
--
-- The whole design is one rule: never guess. A null owner is a record whose
-- owner could not be determined, which is a true and useful thing to say. A
-- wrong owner is a lie that looks like an answer, and every later phase —
-- row-level filtering, KPIs, reassignment — would quietly build on it. So
-- every match below is exact, and every ambiguity resolves to "leave it".
--
-- Two rules, in order of how much they prove.
--
--   A. The salesperson's email address matches a user's, ignoring case and
--      surrounding space. An email is an identity; two people do not share
--      one, and the users table enforces that with a unique index on
--      lower(email).
--
--   B. Only when there is no email at all: the salesperson's name matches
--      exactly one user's name, ignoring case and spacing. Weaker, and
--      guarded accordingly — see the note above the name rule.
--
-- Anything else stays null: an email that matches nobody, a name that
-- matches nobody, a name that matches two people, a blank field.
--
-- What this file does not do:
--
--   * overwrite an owner. Every statement is `WHERE owner_user_id IS NULL`,
--     so a correction made by hand, or an assignment made later, survives
--     this file being run again.
--   * create, reactivate, or re-role a user. There is no INSERT here and
--     the users table is only ever read.
--   * touch sales_person, sales_person_email or project_manager. Those stay
--     exactly as they are: they are the business's own record of who sold
--     what, every report still groups by them, and owner_user_id sits
--     beside them rather than replacing them.
--   * change what anybody can see. Row-level filtering is Phase 2C.
--
-- DML only — no DDL at all — so schema.sql is unchanged by this migration
-- and a schema comparison cannot prove any of the above. The data tests in
-- test/ownershipBackfill.test.js are what prove it.
--
-- Safe on a live database and safe to re-run: it only ever moves a row from
-- "no owner" to "this owner", and a second run finds those rows no longer
-- null and skips them.

-- ---------------------------------------------------------------- Rule A
-- Exact email, ignoring case and surrounding space.
--
-- The count guard is belt and braces. users_email_key is a unique index on
-- lower(email), so a second match should be impossible; if the data ever
-- contrives one anyway, this assigns nobody rather than picking whichever
-- row the planner reached first.
--
-- Only enquiries and quotations have a salesperson email column. projects
-- does not — see Rule B.

UPDATE enquiries e
   SET owner_user_id = u.id
  FROM users u
 WHERE e.owner_user_id IS NULL
   AND e.sales_person_email IS NOT NULL
   AND btrim(e.sales_person_email) <> ''
   AND lower(btrim(u.email)) = lower(btrim(e.sales_person_email))
   AND (SELECT count(*) FROM users c
         WHERE lower(btrim(c.email)) = lower(btrim(e.sales_person_email))) = 1;

UPDATE quotations q
   SET owner_user_id = u.id
  FROM users u
 WHERE q.owner_user_id IS NULL
   AND q.sales_person_email IS NOT NULL
   AND btrim(q.sales_person_email) <> ''
   AND lower(btrim(u.email)) = lower(btrim(q.sales_person_email))
   AND (SELECT count(*) FROM users c
         WHERE lower(btrim(c.email)) = lower(btrim(q.sales_person_email))) = 1;

-- ---------------------------------------------------------------- Rule B
-- Exact name, ignoring case and spacing, and only when exactly one user
-- carries that name.
--
-- Weaker than an email, and knowingly so. The historical data records a
-- salesperson as a bare first name — "Ramesh", "Vishnu" — and users.name
-- has no unique index, so two people can share one. Three things keep this
-- from guessing:
--
--   * it runs only where there is no email to go on. A row whose email
--     matches nobody is left alone rather than falling back to the name:
--     an address that resolves to no account is a sign the data is off, and
--     the name beside it is not better evidence for that being wrong.
--   * it assigns only when the count is exactly 1. Two Rameshes and the
--     row stays null for a person to settle.
--   * "ignoring spacing" means collapsing runs of whitespace and trimming
--     the ends, nothing more. No initials, no nicknames, no similarity, no
--     partial matching — the app has a fuzzy name matcher for client names
--     (name_key) and it is deliberately not used here.
--
-- This is also the only rule that can reach projects: that table carries
-- sales_person but no sales_person_email. project_manager and
-- project_manager_email are deliberately not consulted — the manager who
-- delivers a project is not the salesperson who owns it, and treating them
-- as the same person is exactly the kind of guess this file exists to
-- avoid.

UPDATE enquiries e
   SET owner_user_id = u.id
  FROM users u
 WHERE e.owner_user_id IS NULL
   AND (e.sales_person_email IS NULL OR btrim(e.sales_person_email) = '')
   AND e.sales_person IS NOT NULL
   AND btrim(e.sales_person) <> ''
   AND lower(regexp_replace(btrim(u.name), '\s+', ' ', 'g'))
     = lower(regexp_replace(btrim(e.sales_person), '\s+', ' ', 'g'))
   AND (SELECT count(*) FROM users c
         WHERE lower(regexp_replace(btrim(c.name), '\s+', ' ', 'g'))
             = lower(regexp_replace(btrim(e.sales_person), '\s+', ' ', 'g'))) = 1;

UPDATE quotations q
   SET owner_user_id = u.id
  FROM users u
 WHERE q.owner_user_id IS NULL
   AND (q.sales_person_email IS NULL OR btrim(q.sales_person_email) = '')
   AND q.sales_person IS NOT NULL
   AND btrim(q.sales_person) <> ''
   AND lower(regexp_replace(btrim(u.name), '\s+', ' ', 'g'))
     = lower(regexp_replace(btrim(q.sales_person), '\s+', ' ', 'g'))
   AND (SELECT count(*) FROM users c
         WHERE lower(regexp_replace(btrim(c.name), '\s+', ' ', 'g'))
             = lower(regexp_replace(btrim(q.sales_person), '\s+', ' ', 'g'))) = 1;

UPDATE projects p
   SET owner_user_id = u.id
  FROM users u
 WHERE p.owner_user_id IS NULL
   AND p.sales_person IS NOT NULL
   AND btrim(p.sales_person) <> ''
   AND lower(regexp_replace(btrim(u.name), '\s+', ' ', 'g'))
     = lower(regexp_replace(btrim(p.sales_person), '\s+', ' ', 'g'))
   AND (SELECT count(*) FROM users c
         WHERE lower(regexp_replace(btrim(c.name), '\s+', ' ', 'g'))
             = lower(regexp_replace(btrim(p.sales_person), '\s+', ' ', 'g'))) = 1;

-- Nothing here filters on users.active or users.role. Somebody who has left
-- still owned what they sold, and an account that was promoted to admin
-- since does not stop having owned it. An attribution-only row — a name
-- from the old data, with no email and no way to sign in (015) — is exactly
-- what Rule B is for: it is how a historical salesperson becomes a real
-- identity without inventing an address for them.
