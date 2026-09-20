-- 033 — outgoing webhooks for n8n and other automation (#49).
--
-- Changes that matter (a quotation sent, won or lost, a PO received, an
-- invoice issued, a payment received...) are written to webhook_events by
-- triggers, fanned out to the endpoints that want them, and delivered by
-- the worker with an HMAC signature, retries with back-off for a day,
-- and a delivery history that can be replayed. Nothing is recorded while
-- no endpoint exists.
--
-- Safe on a live database; running it a second time changes nothing.

CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id                     serial PRIMARY KEY,
  name                   text NOT NULL,
  url                    text NOT NULL,
  events                 text[] NOT NULL DEFAULT '{}',
  secret                 text NOT NULL,
  min_value              numeric(16,2),
  sector                 text,
  include_personal_data  boolean NOT NULL DEFAULT false,
  active                 boolean NOT NULL DEFAULT true,
  when_inactive          text NOT NULL DEFAULT 'queue' CHECK (when_inactive IN ('queue','drop')),
  created_by             text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id             bigserial PRIMARY KEY,
  event          text NOT NULL,
  entity         text,
  entity_id      text,
  value          numeric(16,2),
  company_id     int,
  data           jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  dispatched_at  timestamptz
);

CREATE INDEX IF NOT EXISTS webhook_events_pending_idx ON webhook_events (id) WHERE dispatched_at IS NULL;

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id                bigserial PRIMARY KEY,
  endpoint_id       int NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  event_id          bigint NOT NULL REFERENCES webhook_events(id) ON DELETE CASCADE,
  idempotency_key   text NOT NULL UNIQUE,
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','held','succeeded','failed')),
  attempts          int NOT NULL DEFAULT 0,
  next_attempt_at   timestamptz NOT NULL DEFAULT now(),
  last_status_code  int,
  last_response     text,
  last_error        text,
  delivered_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (endpoint_id, event_id)
);

CREATE INDEX IF NOT EXISTS webhook_deliveries_due_idx ON webhook_deliveries (next_attempt_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS webhook_deliveries_endpoint_idx ON webhook_deliveries (endpoint_id, created_at DESC);

DROP TRIGGER IF EXISTS webhook_endpoints_set_updated_at ON webhook_endpoints;
CREATE TRIGGER webhook_endpoints_set_updated_at BEFORE UPDATE ON webhook_endpoints FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Record one event, if anyone listens, and wake the worker.
CREATE OR REPLACE FUNCTION webhook_emit(p_event text, p_entity text, p_entity_id text, p_value numeric, p_company int, p_data jsonb)
RETURNS void AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM webhook_endpoints WHERE (active OR when_inactive = 'queue') AND p_event = ANY(events)) THEN
    RETURN;
  END IF;
  INSERT INTO webhook_events (event, entity, entity_id, value, company_id, data)
  VALUES (p_event, p_entity, p_entity_id, p_value, p_company, COALESCE(p_data, '{}'::jsonb));
  PERFORM pg_notify('webhook_events', p_event);
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION webhook_quotation_events() RETURNS trigger AS $$
DECLARE st pipeline_stages%ROWTYPE; d jsonb;
BEGIN
  d := jsonb_build_object('quotation_no', NEW.quotation_no, 'client_name', NEW.client_name, 'company_id', NEW.company_id,
         'service', NEW.service_quoted, 'status', NEW.status, 'value', NEW.quotation_value, 'currency', NEW.currency,
         'sales_person', NEW.sales_person, 'contact_person', NEW.contact_person, 'revision', NEW.revision, 'valid_until', NEW.valid_until);
  IF NEW.sent_at IS NOT NULL AND OLD.sent_at IS NULL THEN
    PERFORM webhook_emit('quotation.sent', 'quotation', NEW.quotation_no, NEW.quotation_value, NEW.company_id, d);
  END IF;
  IF NEW.stage_id IS DISTINCT FROM OLD.stage_id AND NEW.stage_id IS NOT NULL THEN
    SELECT * INTO st FROM pipeline_stages WHERE id = NEW.stage_id;
    d := d || jsonb_build_object('stage', st.name, 'probability', NEW.probability,
           'previous_stage', (SELECT name FROM pipeline_stages WHERE id = OLD.stage_id));
    PERFORM webhook_emit('quotation.stage_changed', 'quotation', NEW.quotation_no, NEW.quotation_value, NEW.company_id, d);
    IF st.type = 'won' THEN
      PERFORM webhook_emit('quotation.won', 'quotation', NEW.quotation_no, NEW.quotation_value, NEW.company_id, d);
    ELSIF st.type = 'lost' THEN
      PERFORM webhook_emit('quotation.lost', 'quotation', NEW.quotation_no, NEW.quotation_value, NEW.company_id,
        d || jsonb_build_object('lost_reason', (SELECT name FROM lost_reasons WHERE id = NEW.lost_reason_id), 'competitor', NEW.competitor));
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS z_webhook_quotation ON quotations;
CREATE TRIGGER z_webhook_quotation AFTER UPDATE ON quotations FOR EACH ROW EXECUTE FUNCTION webhook_quotation_events();

CREATE OR REPLACE FUNCTION webhook_record_events() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'enquiries' AND TG_OP = 'INSERT' THEN
    PERFORM webhook_emit('enquiry.created', 'enquiry', NEW.enquiry_no, NEW.estimated_value, NEW.company_id,
      jsonb_build_object('enquiry_no', NEW.enquiry_no, 'client_name', NEW.client_name, 'service', NEW.service, 'status', NEW.status,
        'sales_person', NEW.sales_person, 'contact_person', NEW.contact_person, 'estimated_value', NEW.estimated_value, 'currency', NEW.currency));
  ELSIF TG_TABLE_NAME = 'purchase_orders' THEN
    IF TG_OP = 'INSERT' THEN
      PERFORM webhook_emit('po.received', 'purchase_order', NEW.po_number, NEW.po_value,
        (SELECT company_id FROM projects WHERE project_id = NEW.project_id),
        jsonb_build_object('po_number', NEW.po_number, 'project_id', NEW.project_id, 'quotation_no', NEW.quotation_no,
          'po_date', NEW.po_date, 'value', NEW.po_value, 'currency', NEW.currency,
          'client_name', (SELECT client_name FROM projects WHERE project_id = NEW.project_id)));
    ELSIF NEW.actual_delivery_date IS NOT NULL AND OLD.actual_delivery_date IS NULL THEN
      PERFORM webhook_emit('project.delivered', 'project', NEW.project_id, NEW.po_value,
        (SELECT company_id FROM projects WHERE project_id = NEW.project_id),
        jsonb_build_object('project_id', NEW.project_id, 'po_number', NEW.po_number, 'delivered_on', NEW.actual_delivery_date,
          'client_name', (SELECT client_name FROM projects WHERE project_id = NEW.project_id)));
    END IF;
  ELSIF TG_TABLE_NAME = 'payment_stages' THEN
    IF NEW.invoice_no IS NOT NULL AND OLD.invoice_no IS NULL THEN
    PERFORM webhook_emit('invoice.issued', 'payment_stage', NEW.id::text, (SELECT round(NEW.stage_percent * po_value, 2) FROM purchase_orders WHERE po_number = NEW.po_number),
      (SELECT p.company_id FROM purchase_orders po JOIN projects p ON p.project_id = po.project_id WHERE po.po_number = NEW.po_number),
      jsonb_build_object('invoice_no', NEW.invoice_no, 'invoice_date', NEW.invoice_date, 'po_number', NEW.po_number,
        'stage', NEW.stage_name, 'amount', (SELECT round(NEW.stage_percent * po_value, 2) FROM purchase_orders WHERE po_number = NEW.po_number)));
    END IF;
  ELSIF TG_TABLE_NAME = 'payments' AND TG_OP = 'INSERT' THEN
    PERFORM webhook_emit('payment.received', 'payment_stage', NEW.stage_id::text, NEW.amount,
      (SELECT p.company_id FROM payment_stages s JOIN purchase_orders po ON po.po_number = s.po_number JOIN projects p ON p.project_id = po.project_id WHERE s.id = NEW.stage_id),
      jsonb_build_object('stage_id', NEW.stage_id, 'amount', NEW.amount, 'tds_amount', NEW.tds_amount, 'received_on', NEW.received_on,
        'mode', NEW.mode, 'reference', NEW.reference,
        'invoice_no', (SELECT invoice_no FROM payment_stages WHERE id = NEW.stage_id),
        'po_number', (SELECT po_number FROM payment_stages WHERE id = NEW.stage_id)));
  ELSIF TG_TABLE_NAME = 'engagements' THEN
    IF NEW.status = 'renewal_open' AND OLD.status IS DISTINCT FROM 'renewal_open' THEN
    PERFORM webhook_emit('renewal.opened', 'company', NEW.company_id::text, NULL, NEW.company_id,
      jsonb_build_object('client_name', NEW.client_name, 'service', NEW.service_name, 'due_on', NEW.next_due_on, 'owner', NEW.owner,
        'renewal_quotation_no', (SELECT quotation_no FROM quotations WHERE id = NEW.renewal_quotation_id)));
    END IF;
  ELSIF TG_TABLE_NAME = 'visits' AND TG_OP = 'INSERT' THEN
    PERFORM webhook_emit('visit.scheduled', 'project', NEW.project_id, NULL, NEW.company_id,
      jsonb_build_object('visit_id', NEW.id, 'title', NEW.title, 'type', NEW.type, 'starts_at', NEW.starts_at, 'ends_at', NEW.ends_at,
        'project_id', NEW.project_id, 'city', NEW.city, 'status', NEW.status));
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS z_webhook_enquiry ON enquiries;
CREATE TRIGGER z_webhook_enquiry AFTER INSERT ON enquiries FOR EACH ROW EXECUTE FUNCTION webhook_record_events();
DROP TRIGGER IF EXISTS z_webhook_po ON purchase_orders;
CREATE TRIGGER z_webhook_po AFTER INSERT OR UPDATE ON purchase_orders FOR EACH ROW EXECUTE FUNCTION webhook_record_events();
DROP TRIGGER IF EXISTS z_webhook_stage ON payment_stages;
CREATE TRIGGER z_webhook_stage AFTER UPDATE ON payment_stages FOR EACH ROW EXECUTE FUNCTION webhook_record_events();
DROP TRIGGER IF EXISTS z_webhook_payment ON payments;
CREATE TRIGGER z_webhook_payment AFTER INSERT ON payments FOR EACH ROW EXECUTE FUNCTION webhook_record_events();
DROP TRIGGER IF EXISTS z_webhook_engagement ON engagements;
CREATE TRIGGER z_webhook_engagement AFTER UPDATE ON engagements FOR EACH ROW EXECUTE FUNCTION webhook_record_events();
DROP TRIGGER IF EXISTS z_webhook_visit ON visits;
CREATE TRIGGER z_webhook_visit AFTER INSERT ON visits FOR EACH ROW EXECUTE FUNCTION webhook_record_events();

INSERT INTO settings (key, value, notes) VALUES
  ('incoming_enquiries_enabled', 'false', 'Accept enquiries posted to /api/hooks/enquiries with a valid signature (INCOMING_WEBHOOK_SECRET).')
ON CONFLICT (key) DO NOTHING;
