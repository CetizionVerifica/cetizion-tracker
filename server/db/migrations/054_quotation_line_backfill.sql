-- 052 — every quotation made before line items gets one (#23).
--
-- Quotations from before #58 have a service and a value but no lines, so
-- the service-line reports, the PDF and the line editor had nothing to show
-- for them. Each gets one line: the service it was quoted for (linked to the
-- catalogue when the name matches), quantity 1, at its value.
--
-- The value must not move. The totals trigger would restate it as rate plus
-- GST, and the number sales typed before line items was a single figure,
-- so the line carries it whole at 0% GST: the line total is the stored
-- value, and editing the line later recomputes from there. The totals
-- trigger is off while the lines go in, and the quotations' own triggers
-- (webhooks, updated_at, the stage sync) are off while their totals are
-- filled, so the backfill sends no events and restamps nothing.
ALTER TABLE quotation_lines DISABLE TRIGGER quotation_lines_changed;

INSERT INTO quotation_lines (quotation_id, service_id, description, qty, unit, rate, discount_percent, gst_rate, sort_order)
SELECT q.id,
       (SELECT s.id FROM services s WHERE lower(btrim(s.name)) = lower(btrim(q.service_quoted)) LIMIT 1),
       COALESCE(NULLIF(btrim(q.service_quoted), ''), 'Services as quoted'),
       1, 'as quoted', COALESCE(q.quotation_value, 0), 0, 0, 0
  FROM quotations q
 WHERE NOT EXISTS (SELECT 1 FROM quotation_lines l WHERE l.quotation_id = q.id);

ALTER TABLE quotation_lines ENABLE TRIGGER quotation_lines_changed;

ALTER TABLE quotations DISABLE TRIGGER USER;

UPDATE quotations q
   SET subtotal = q.quotation_value, tax_total = 0, total = q.quotation_value, discount_percent = 0
 WHERE q.subtotal IS NULL AND q.quotation_value IS NOT NULL
   AND EXISTS (SELECT 1 FROM quotation_lines l WHERE l.quotation_id = q.id AND l.unit = 'as quoted');

ALTER TABLE quotations ENABLE TRIGGER USER;
