-- 017 — an activity log, so an admin can ask what was done and by whom (#18).
--
-- Until now the tracker kept records of things (quotations, emails, job
-- runs) but no record of *acts*. "Who switched Sam's account off, and
-- when?" had no answer anywhere: the users row shows the state it is in
-- now, and the previous state is simply gone. The same is true of a company
-- merge, which rewrites the client name on every record of two companies
-- and deletes one of them, with no undo and nothing saying who asked for it.
--
-- One generic table rather than a history table per resource. The rows this
-- phase writes are a handful of admin and security events, but ownership,
-- reassignment and salesperson timelines are all the same shape — an actor,
-- an act, a thing acted on — and splitting them across tables later is a
-- migration, whereas adding an `action` string is not.
--
-- Append-only. Nothing in the application updates or deletes a row here,
-- and no route exposes either: see src/routes/activity.js, which is read
-- and admin-only. That is an application rule, deliberately not a database
-- trigger — a retention policy, when there is one, has to be able to delete.
--
-- Safe on a live database: it only adds a table, and running it a second
-- time changes nothing.

CREATE TABLE IF NOT EXISTS activity_log (
  -- bigserial, not serial. Every other table here counts records a person
  -- typed; this one counts acts, it is retained indefinitely (see the
  -- retention note in docs/issue-18-activity-log.md), and running out of
  -- ids on an audit trail is not a failure anybody wants to discover.
  id             bigserial PRIMARY KEY,

  -- The database account that acted, when there was one. Nullable on
  -- purpose, and three different things make it null:
  --
  --   shared mode    AUTH_MODE=shared has no users row to point at, and
  --                  inventing one would put a fake person in the table
  --                  that an admin screen would then list.
  --   system         a scheduled job acts as nobody.
  --   deleted since  ON DELETE SET NULL below.
  --
  -- actor_type tells the first two apart; the third keeps its actor_type
  -- and loses its id, which is the honest record of what happened.
  actor_user_id  integer REFERENCES users(id) ON DELETE SET NULL,

  -- Not ON DELETE CASCADE, and not RESTRICT. Cascade would let deleting an
  -- account erase everything that account ever did — the one deletion an
  -- audit trail exists to survive. Restrict would make the audit trail
  -- forbid ordinary administration.

  -- Who the actor was, as a classification rather than an identity. Never
  -- the role: a role is what somebody may do today and it changes, whereas
  -- this says which authority the request came through, which cannot.
  actor_type     text NOT NULL
                   CHECK (actor_type IN ('user','shared_admin','system')),

  -- A stable machine key, dotted: 'user.deactivated', 'company.merged'.
  -- Prose belongs in the UI that reads this, not in the column a filter
  -- matches on.
  action         text NOT NULL,

  entity_type    text NOT NULL,
  -- text, not integer. Most resources here key on a serial, but jobs are
  -- named ('reminders.payment') and documents are keyed by string, and a
  -- column that cannot hold them would push those events out of the table
  -- or into metadata where nothing can filter on them. email_log.entity_id
  -- is text for the same reason.
  entity_id      text,

  -- Context, and only context: what changed, what it changed from. Never
  -- the material that would let somebody act as the person audited. The
  -- helper in src/lib/activity.js drops secret-looking keys before they
  -- reach this column as a backstop; the real rule is that callers do not
  -- pass them.
  metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at     timestamptz NOT NULL DEFAULT now(),
  -- No updated_at, and no trigger. A row here is never updated.

  CONSTRAINT activity_log_action_not_blank      CHECK (btrim(action) <> ''),
  CONSTRAINT activity_log_entity_type_not_blank CHECK (btrim(entity_type) <> ''),
  -- '' would satisfy "entity_id IS NOT NULL" while naming nothing.
  CONSTRAINT activity_log_entity_id_not_blank   CHECK (entity_id IS NULL OR btrim(entity_id) <> ''),
  -- A shared admin and a job have no database account, so an id on either
  -- would be somebody else's. The reverse is allowed: actor_type 'user'
  -- with a null id is what a deleted account leaves behind.
  CONSTRAINT activity_log_actor_id_needs_user   CHECK (actor_user_id IS NULL OR actor_type = 'user'),
  -- jsonb accepts 3, "x" and null as whole documents. The readers here all
  -- expect an object, and a scalar would only be found by whoever read the
  -- row back.
  CONSTRAINT activity_log_metadata_is_object    CHECK (jsonb_typeof(metadata) = 'object')
);

-- Indexes. Only the ones the read endpoint's own queries need:
--
-- The unfiltered listing is ORDER BY id DESC with a `id < $before` cursor,
-- and the primary key's index already serves both — so there is no separate
-- created_at index. id and created_at agree on order anyway, because the
-- sequence is taken at insert.
--
-- The three below each back one supported filter, and each carries id DESC
-- as its second column so the filter and the paging are answered by one
-- index rather than a filter followed by a sort.

-- ?actor_user_id= — "everything this person did", the timeline Phase 2 wants.
CREATE INDEX IF NOT EXISTS activity_log_actor_idx  ON activity_log (actor_user_id, id DESC);

-- ?action= — "every password reset", the security question this table is for.
CREATE INDEX IF NOT EXISTS activity_log_action_idx ON activity_log (action, id DESC);

-- ?entity_type=&entity_id= — "this record's history". Left-prefixed, so a
-- filter on entity_type alone uses the same index.
CREATE INDEX IF NOT EXISTS activity_log_entity_idx ON activity_log (entity_type, entity_id, id DESC);
