-- Which filter a conversation would have been dropped by, before the Inbox
-- began keeping every message its shared mailbox receives.
--
-- 'internal only' or 'blocked sender' (lib/mailbox/rules.js classify), NULL
-- for client mail. A conversation with a value is a colleague, a no-reply
-- robot or a sender on the "Never sync" list: it is shown, but it starts no
-- reply clock, sends no notification and is never offered as a new enquiry.
-- A real client message in the same thread clears it.
ALTER TABLE inbox_conversations ADD COLUMN IF NOT EXISTS filtered_as text;

-- The same, per message. A thread a robot or a colleague opened is still
-- new business when the client's first message lands in it, so the
-- enquiry and PO readers ask for the first message with no filtered_as
-- rather than the first message.
ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS filtered_as text;
