-- 056 — notifications that clear themselves, and a record of which were emailed (#44).
--
-- resolved_at: the thing a notification asked for was done — the task
-- ticked, the approval decided, the invoice paid, the mail answered, the
-- follow-up made. The bell counts it as read for everybody; the history
-- keeps it. emailed_at: the notification went to the people who asked for
-- it by email, so the delivery job sends each one once.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS resolved_at timestamptz;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS emailed_at timestamptz;

CREATE INDEX IF NOT EXISTS notifications_open_entity_idx ON notifications (entity, entity_id) WHERE resolved_at IS NULL;

-- Acting on the record clears what the notification asked for (#44). In
-- the database rather than in each route, so a task ticked on the Tasks page,
-- on the timeline or through the MCP tools all count the same.
CREATE OR REPLACE FUNCTION resolve_notifications(p_kinds text[], p_entity text, p_entity_id text) RETURNS void AS $$
  UPDATE notifications SET resolved_at = now()
   WHERE resolved_at IS NULL AND kind = ANY(p_kinds) AND entity = p_entity AND entity_id = p_entity_id;
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION task_resolves_notifications() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'done' AND OLD.status IS DISTINCT FROM 'done' THEN
    UPDATE notifications SET resolved_at = now()
     WHERE resolved_at IS NULL AND dedupe_key LIKE 'task:' || NEW.id || ':%';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enquiry_resolves_notifications() RETURNS trigger AS $$
BEGIN
  -- Followed up: the status moved on, or the next follow-up was set again.
  IF NEW.status IS DISTINCT FROM OLD.status OR NEW.next_follow_up_at IS DISTINCT FROM OLD.next_follow_up_at THEN
    PERFORM resolve_notifications(ARRAY['follow_up'], 'enquiry', NEW.enquiry_no);
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION quotation_resolves_notifications() RETURNS trigger AS $$
BEGIN
  IF OLD.approval_status = 'pending' AND NEW.approval_status IS DISTINCT FROM 'pending' THEN
    PERFORM resolve_notifications(ARRAY['approval'], 'quotation', NEW.quotation_no);
  END IF;
  -- Decided, accepted, extended or revised: the expiry warning and the
  -- unopened-link reminder no longer apply.
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('Won - PO Received', 'Lost')
     OR NEW.accepted_at IS NOT NULL AND OLD.accepted_at IS NULL
     OR NEW.valid_until IS DISTINCT FROM OLD.valid_until
     OR NEW.revision IS DISTINCT FROM OLD.revision THEN
    PERFORM resolve_notifications(ARRAY['expiring', 'acceptance'], 'quotation', NEW.quotation_no);
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION payment_stage_resolves_notifications() RETURNS trigger AS $$
BEGIN
  IF NEW.amount_received IS DISTINCT FROM OLD.amount_received
     AND NEW.amount_received >= (SELECT round(po.po_value * NEW.stage_percent, 2) FROM purchase_orders po WHERE po.po_number = NEW.po_number) THEN
    PERFORM resolve_notifications(ARRAY['invoice_overdue'], 'payment_stage', NEW.id::text);
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION conversation_resolves_notifications() RETURNS trigger AS $$
BEGIN
  -- Answered or closed: the "no reply yet" reminder is done with.
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status <> 'open'
     OR NEW.response_due_at IS NULL AND OLD.response_due_at IS NOT NULL THEN
    UPDATE notifications SET resolved_at = now()
     WHERE resolved_at IS NULL AND kind = 'inbox' AND link = '/inbox?c=' || NEW.id;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS zz_resolve_notifications ON tasks;
CREATE TRIGGER zz_resolve_notifications AFTER UPDATE OF status ON tasks
  FOR EACH ROW EXECUTE FUNCTION task_resolves_notifications();
DROP TRIGGER IF EXISTS zz_resolve_notifications ON enquiries;
CREATE TRIGGER zz_resolve_notifications AFTER UPDATE ON enquiries
  FOR EACH ROW EXECUTE FUNCTION enquiry_resolves_notifications();
DROP TRIGGER IF EXISTS zz_resolve_notifications ON quotations;
CREATE TRIGGER zz_resolve_notifications AFTER UPDATE ON quotations
  FOR EACH ROW EXECUTE FUNCTION quotation_resolves_notifications();
DROP TRIGGER IF EXISTS zz_resolve_notifications ON payment_stages;
CREATE TRIGGER zz_resolve_notifications AFTER UPDATE OF amount_received ON payment_stages
  FOR EACH ROW EXECUTE FUNCTION payment_stage_resolves_notifications();
DROP TRIGGER IF EXISTS zz_resolve_notifications ON inbox_conversations;
CREATE TRIGGER zz_resolve_notifications AFTER UPDATE ON inbox_conversations
  FOR EACH ROW EXECUTE FUNCTION conversation_resolves_notifications();
