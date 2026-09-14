-- 003 — enquiries, logged before anything is quoted. An enquiry marked
-- 'Won - Quotation Sent' gets a quotation created and linked by the API.
--
-- Safe on a live database: it only adds a table, and running it a second
-- time changes nothing.

CREATE TABLE IF NOT EXISTS enquiries (
  id                 serial PRIMARY KEY,
  enquiry_no         text NOT NULL UNIQUE,
  enquiry_date       date,
  client_name        text NOT NULL,
  sector             text,
  contact_person     text,
  sales_person       text,
  sales_person_email text,
  service            text,
  status             text NOT NULL DEFAULT 'In Progress'
                       CHECK (status IN ('In Progress','Declined','Won - Quotation Sent')),
  quotation_no       text REFERENCES quotations(quotation_no)
                       ON UPDATE CASCADE ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS enquiries_status_idx ON enquiries (status);

DROP TRIGGER IF EXISTS enquiries_set_updated_at ON enquiries;
CREATE TRIGGER enquiries_set_updated_at BEFORE UPDATE ON enquiries
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
