-- =====================================================================
-- 101_super_admin_actor.sql
-- The super admin portal (100_deleted_users.sql), three follow-ups.
--
-- 1. Its acts are recorded as actor_type 'super_admin'. It was recorded as
--    'shared_admin', which made it indistinguishable from the shared
--    AUTH_USERNAME login except by a name in metadata: two credentials with
--    different powers in one bucket. Like the shared admin it is not a
--    users row, so it carries no actor id; the *_needs_user constraints
--    already require that.
--
-- 2. A deleted account's backup size is documents.size_bytes, through
--    backup_document_id. Keeping a copy in deleted_users broke "each fact
--    is typed in exactly one place".
--
-- 3. Deleting an account frees its email address, so it can be given to a
--    new account (somebody rejoining, or a mistaken delete). The address
--    moves from users.email to deleted_users.email: still one place, and
--    the deleted account keeps its name on every record. Accounts already
--    deleted are moved over the same way.
-- =====================================================================

ALTER TABLE activity_log DROP CONSTRAINT IF EXISTS activity_log_actor_type_check;
ALTER TABLE activity_log ADD CONSTRAINT activity_log_actor_type_check
  CHECK (actor_type IN ('user', 'shared_admin', 'super_admin', 'system'));

ALTER TABLE ownership_history DROP CONSTRAINT IF EXISTS ownership_history_actor_type_check;
ALTER TABLE ownership_history ADD CONSTRAINT ownership_history_actor_type_check
  CHECK (actor_type IN ('user', 'shared_admin', 'super_admin', 'system'));

ALTER TABLE deleted_users DROP COLUMN IF EXISTS backup_size_bytes;

ALTER TABLE deleted_users ADD COLUMN IF NOT EXISTS email text
  CONSTRAINT deleted_users_email_not_blank CHECK (email IS NULL OR btrim(email) <> '');

UPDATE deleted_users du SET email = u.email
  FROM users u
 WHERE u.id = du.user_id AND du.email IS NULL AND u.email IS NOT NULL;

UPDATE users u SET email = NULL
  FROM deleted_users du
 WHERE du.user_id = u.id AND u.email IS NOT NULL;
