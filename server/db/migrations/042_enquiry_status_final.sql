-- 042 — drop the enquiry statuses from before #24.
--
-- Migration 021 renamed the values and widened the CHECK to accept both
-- vocabularies, so that a deploy running the old and new containers at once
-- could not fail on the old words. By the time this runs, several deploys
-- have passed and nothing writes them any more, so the CHECK narrows to the
-- vocabulary the app actually uses.
--
-- Anything still holding an old value is renamed first. There should be
-- none; doing it anyway means this migration cannot fail on a database that
-- took a write from an old container during the swap.

UPDATE enquiries SET status = CASE status
  WHEN 'In Progress' THEN 'Contacted'
  WHEN 'Declined' THEN 'Unqualified'
  WHEN 'Won - Quotation Sent' THEN 'Converted'
  ELSE status END
 WHERE status IN ('In Progress', 'Declined', 'Won - Quotation Sent');

ALTER TABLE enquiries DROP CONSTRAINT IF EXISTS enquiries_status_check;
ALTER TABLE enquiries ADD CONSTRAINT enquiries_status_check
  CHECK (status IN ('New','Contacted','Qualified','Nurture','Converted','Unqualified')) NOT VALID;
ALTER TABLE enquiries VALIDATE CONSTRAINT enquiries_status_check;
