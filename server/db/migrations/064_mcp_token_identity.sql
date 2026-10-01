-- 064 — an MCP token is a person, not a spelling (#18 §2, and #89).
--
-- 038 gave a sales token a `person`: the free-text sales-person name used
-- on records, because when it was written there were no accounts to point
-- at. Its own header says so — "until user accounts (#18) the person is the
-- sales-person name used on records". #18 built those accounts, moved every
-- session-authenticated route onto `owner_user_id`, and left MCP as the one
-- surface still matching a name. This closes it.
--
-- Why a name was never safe here. Issue #18 opens by counting what the
-- historical data is worth: four spellings for three people, 19 of 92
-- quotations with no salesperson at all. A token scoped by name therefore
-- saw a set nobody could state precisely, and every way it went wrong was
-- silent:
--
--   * rename somebody and their token quietly returns nothing;
--   * type a name two ways and half their work disappears from it;
--   * two people whose names normalise alike read each other's pipeline.
--
-- None of those raise an error. They return the wrong rows and look fine.
--
-- Safe on a live database: one nullable column, one foreign key, one index,
-- plus a data step that only ever narrows what a token can see. Running it
-- a second time changes nothing.

-- ---------------------------------------------------------------------
-- 1. The identity
-- ---------------------------------------------------------------------

ALTER TABLE api_tokens ADD COLUMN IF NOT EXISTS user_id integer;

-- CASCADE, unlike owner_user_id's SET NULL on the record tables, and the
-- difference is what the row is. A quotation is the company's history and
-- outlives whoever sold it, so it keeps the record and forgets the pointer.
-- A token is a credential belonging to one person; a credential whose owner
-- has been deleted must stop working, not become an unowned key that still
-- opens the door.
ALTER TABLE api_tokens DROP CONSTRAINT IF EXISTS api_tokens_user_id_fkey;
ALTER TABLE api_tokens ADD CONSTRAINT api_tokens_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS api_tokens_user_id_idx ON api_tokens (user_id);

-- ---------------------------------------------------------------------
-- 2. Bind what the data names beyond doubt
-- ---------------------------------------------------------------------
--
-- The same rule as 060 Rule B, and the same guard: an exact name, ignoring
-- case and internal spacing, and only when exactly one account carries it.
-- Two matches binds nothing — a token pointed at the wrong person reads
-- somebody else's pipeline, which is the failure this migration exists to
-- end, not one to introduce while ending it.

UPDATE api_tokens t
   SET user_id = u.id
  FROM users u
 WHERE t.user_id IS NULL
   AND t.role = 'sales'
   AND t.person IS NOT NULL
   AND btrim(t.person) <> ''
   AND lower(regexp_replace(btrim(u.name), '\s+', ' ', 'g'))
     = lower(regexp_replace(btrim(t.person), '\s+', ' ', 'g'))
   AND (SELECT count(*) FROM users c
         WHERE lower(regexp_replace(btrim(c.name), '\s+', ' ', 'g'))
             = lower(regexp_replace(btrim(t.person), '\s+', ' ', 'g'))) = 1;

-- ---------------------------------------------------------------------
-- 3. Revoke what it could not bind
-- ---------------------------------------------------------------------
--
-- A live sales token with no user id has no identity the new fragments can
-- ask about. The application already fails closed on one — lib/scope.js
-- reads a missing id as "matches no row" rather than "no filter" — so this
-- is not what stops it leaking. It is what stops it lying: a token that
-- silently returns nothing looks like a broken integration and gets
-- debugged for an afternoon, whereas a revoked one says what happened and
-- an admin issues a new one against the right account.
--
-- Admin tokens are untouched. They carry no person and never did: they see
-- everything by role, so there is nothing to bind and nothing to revoke.

UPDATE api_tokens
   SET revoked_at = now()
 WHERE revoked_at IS NULL
   AND role = 'sales'
   AND user_id IS NULL;

-- ---------------------------------------------------------------------
-- 4. The invariant, from here on
-- ---------------------------------------------------------------------
--
-- A live sales token has an account behind it. Revoked rows are exempt:
-- they are history, including the rows step 3 has just revoked, and a
-- constraint that refused to hold them would make this migration fail on
-- the exact databases it is written for.
--
-- The 038 CHECK on `person` is deliberately left in place. `person` is not
-- dropped here: it is what the tokens page has always shown, it is how an
-- admin recognises which token is whose, and #18's rule for the free-text
-- columns is that they stay until somebody has checked the migration that
-- replaced them. Dropping it is a later, separate change.

ALTER TABLE api_tokens DROP CONSTRAINT IF EXISTS api_tokens_sales_needs_user;
ALTER TABLE api_tokens ADD CONSTRAINT api_tokens_sales_needs_user CHECK (
  role = 'admin' OR user_id IS NOT NULL OR revoked_at IS NOT NULL
);
