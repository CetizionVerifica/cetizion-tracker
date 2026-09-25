-- Whether anybody has looked at a thread yet.
--
-- The list could say who owns a thread and when it is due, but not the
-- question a shared inbox is actually asked first thing in the morning:
-- has anyone picked this up at all. "No owner" is not the same answer —
-- a thread can be read, understood and left deliberately unassigned.
--
-- Read is recorded once, for the team, not per person. In a shared sales
-- inbox the cost being avoided is two people answering the same client,
-- so the useful fact is that *somebody* has seen it; who, is the second
-- half of the same sentence and is worth storing while we are here. A
-- per-person read state would need a row per person per thread to answer
-- a question nobody on this team has asked.
ALTER TABLE inbox_conversations ADD COLUMN IF NOT EXISTS first_opened_at timestamptz;
ALTER TABLE inbox_conversations ADD COLUMN IF NOT EXISTS first_opened_by text;

-- Everything already in the inbox predates the column. Leaving it NULL
-- would mark months of handled mail as never-seen on the morning this
-- deploys, which is a worse lie than the one it replaces, so anything
-- already closed or already assigned counts as seen.
UPDATE inbox_conversations
   SET first_opened_at = COALESCE(closed_at, updated_at)
 WHERE first_opened_at IS NULL
   AND (status = 'closed' OR assignee IS NOT NULL);
