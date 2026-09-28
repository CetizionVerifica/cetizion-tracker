-- 061 — ownership history and handover audit trail (#18 Phase 3).
--
-- Phase 2A added owner_user_id to enquiries, quotations and projects.
-- Phase 2B backfilled historical ownership where history was certain.
-- Phase 2C enforced row-level authorization so sales users only access
-- records they own.
--
-- Phase 3 introduces administrative ownership management: initial assignment,
-- reassignment between sales representatives, and explicit unassignment.
--
-- Every administrative change to ownership must leave an immutable audit
-- trail recording:
--   - what was changed (entity_type, entity_id)
--   - who owned it before, and who owns it now
--   - who performed the change (database administrator or shared admin)
--   - the business reason given by the administrator
--   - when the handover took place
--
-- Attribution survival across user deletion:
-- Foreign keys to users carry ON DELETE SET NULL so deleting a user does
-- not cascade-delete the company's handover history. However, SET NULL
-- alone would erase the identity of former owners and administrators.
-- Therefore, stable user ID and safe display-name snapshots are recorded
-- alongside the foreign keys.
--
-- No passwords, tokens, hashes or credentials are ever stored here.
--
-- Safe on a live database: creates a new table and its supporting indexes.
-- Re-running this file changes nothing.

CREATE TABLE IF NOT EXISTS ownership_history (
  id                          bigserial PRIMARY KEY,

  -- Which sales resource was reassigned. Only the three ownership-scoped
  -- entities from Phase 2A/2C.
  entity_type                 text NOT NULL
                                CHECK (entity_type IN ('enquiries', 'quotations', 'projects')),

  -- Internal primary key integer of the business record.
  entity_id                   integer NOT NULL,

  -- Previous owner foreign key. Null for initial assignment of an unassigned
  -- record, or if the user account is later deleted (ON DELETE SET NULL).
  previous_owner_user_id      integer,

  -- Immutable attribution snapshot: preserved even if the user is deleted.
  previous_owner_snapshot_id  integer,
  previous_owner_name         text,

  -- New owner foreign key. Null for unassignment, or if the user account
  -- is later deleted (ON DELETE SET NULL).
  new_owner_user_id           integer,

  -- Immutable attribution snapshot: preserved even if the user is deleted.
  new_owner_snapshot_id       integer,
  new_owner_name              text,

  -- The administrator who performed the assignment. Null for legacy shared
  -- admin (who has no users row) or if the admin account is later deleted.
  changed_by_user_id          integer,

  -- Immutable attribution snapshot for the acting admin.
  changed_by_snapshot_id      integer,
  changed_by_name             text,

  -- Which authority the change came through: 'user' for a database admin,
  -- 'shared_admin' for AUTH_MODE=shared, 'system' for system tasks.
  actor_type                  text NOT NULL
                                CHECK (actor_type IN ('user', 'shared_admin', 'system')),

  -- Non-empty mandatory explanation for the ownership transition.
  reason                      text NOT NULL,

  created_at                  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ownership_history_prev_owner_fkey
    FOREIGN KEY (previous_owner_user_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT ownership_history_new_owner_fkey
    FOREIGN KEY (new_owner_user_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT ownership_history_changed_by_fkey
    FOREIGN KEY (changed_by_user_id) REFERENCES users(id) ON DELETE SET NULL,

  CONSTRAINT ownership_history_reason_not_blank      CHECK (btrim(reason) <> ''),
  CONSTRAINT ownership_history_entity_type_not_blank CHECK (btrim(entity_type) <> ''),
  CONSTRAINT ownership_history_actor_id_needs_user   CHECK (changed_by_user_id IS NULL OR actor_type = 'user')
);

-- Index backing parent record timeline queries:
-- "Show ownership history for this quotation, newest first".
CREATE INDEX IF NOT EXISTS ownership_history_entity_idx
  ON ownership_history (entity_type, entity_id, id DESC);

-- Indexes for querying handovers to or from a specific user:
CREATE INDEX IF NOT EXISTS ownership_history_new_owner_idx
  ON ownership_history (new_owner_user_id, id DESC);

CREATE INDEX IF NOT EXISTS ownership_history_prev_owner_idx
  ON ownership_history (previous_owner_user_id, id DESC);
