-- =====================================================================
-- 074_mailbox_owner.sql
-- Each salesperson's own mailbox (docs/per-user-mailboxes-plan.md §3).
--
--   connected_accounts.user_id       the owner, a users row. Null for a
--                                    shared mailbox, and for a personal one
--                                    whose owner could not be worked out.
--   connected_accounts.connected_by  who pressed Connect (audit only).
--   connected_accounts.read_scope    which folders the email readers read:
--                                    'all' (every folder, 073) or
--                                    'inbox_sent' (Inbox and Sent Items).
--                                    Personal mailboxes start on inbox_sent
--                                    (plan §10.2); the owner can widen it.
--   personal_mailbox_default_visibility
--                                    what a newly connected personal mailbox
--                                    stores: 'subject', so its owner can at
--                                    least see their own subjects (§0).
--
-- `username` stays for now; nothing new reads it. It goes in a later
-- clean-up once the string matching it fed is gone everywhere.
--
-- The backfill is deterministic, and leaves a mailbox unowned rather than
-- guessing: db/diagnostics/mailbox-owner-backfill.sql lists what it could
-- not place, for an admin to assign under Settings → Mailboxes.
-- =====================================================================

ALTER TABLE connected_accounts ADD COLUMN IF NOT EXISTS user_id int REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE connected_accounts ADD COLUMN IF NOT EXISTS connected_by int REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE connected_accounts ADD COLUMN IF NOT EXISTS read_scope text NOT NULL DEFAULT 'all';

ALTER TABLE connected_accounts DROP CONSTRAINT IF EXISTS connected_accounts_read_scope_check;
ALTER TABLE connected_accounts ADD CONSTRAINT connected_accounts_read_scope_check CHECK (read_scope IN ('all','inbox_sent'));

-- A shared mailbox has no personal owner.
ALTER TABLE connected_accounts DROP CONSTRAINT IF EXISTS connected_accounts_shared_unowned;
ALTER TABLE connected_accounts ADD CONSTRAINT connected_accounts_shared_unowned CHECK (NOT (is_shared AND user_id IS NOT NULL));

CREATE INDEX IF NOT EXISTS connected_accounts_user_idx ON connected_accounts (user_id) WHERE status <> 'disconnected';

-- Backfill, personal mailboxes only, each rule tried in turn and only where
-- it names exactly one active user:
--   1. the user whose login email is the recorded username;
--   2. the user whose login email is the mailbox's own address;
--   3. the one user whose name is the recorded username.
WITH candidates AS (
  SELECT a.id AS account_id,
         (SELECT u.id FROM users u WHERE u.active AND lower(u.email) = lower(a.username)) AS by_username,
         (SELECT u.id FROM users u WHERE u.active AND lower(u.email) = lower(a.email)) AS by_email,
         (SELECT min(u.id) FROM users u WHERE u.active AND lower(u.name) = lower(a.username)
            HAVING count(*) = 1) AS by_name
    FROM connected_accounts a
   WHERE NOT a.is_shared AND a.user_id IS NULL
)
UPDATE connected_accounts a
   SET user_id = COALESCE(c.by_username, c.by_email, c.by_name)
  FROM candidates c
 WHERE c.account_id = a.id AND COALESCE(c.by_username, c.by_email, c.by_name) IS NOT NULL;

-- Whoever connected it is, as far as the record says, whoever it was for.
UPDATE connected_accounts SET connected_by = user_id WHERE connected_by IS NULL AND user_id IS NOT NULL;

-- Personal mailboxes read Inbox and Sent Items only, until their owner says otherwise.
UPDATE connected_accounts SET read_scope = 'inbox_sent' WHERE NOT is_shared AND read_scope = 'all';

INSERT INTO settings (key, value, notes) VALUES
  ('personal_mailbox_default_visibility', 'subject', 'What a newly connected personal mailbox stores for the tracker: metadata (who and when), subject, or share_everything. Its owner can change it afterwards; mailboxes already connected keep their setting.')
ON CONFLICT (key) DO NOTHING;
