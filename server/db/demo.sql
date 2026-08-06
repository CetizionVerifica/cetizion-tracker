-- The workbook's own worked example (PO-77310 / PO-77455), kept
-- out of seed.sql so the real data stays clean. Optional:
--   npm run seed:demo

BEGIN;

INSERT INTO purchase_orders (po_number, project_id, po_date, po_value, payment_terms_days, actual_initiation_date, project_manager_email, remarks) VALUES
  ('PO-77310', 'PRJ-2026-001', '2026-05-20', 250000, 30, '2026-05-25', 'diksha@cetizion.com', 'Workbook example'),
  ('PO-77455', 'PRJ-2026-001', '2026-06-02', 150000, 45, NULL, 'diksha@cetizion.com', 'Workbook example');

INSERT INTO po_services (po_number, service, service_value, remarks) VALUES
  ('PO-77310', 'GHG report preparation', 150000, 'Workbook example'),
  ('PO-77310', 'Assurance', 100000, 'Workbook example'),
  ('PO-77455', 'Supply chain audit', 150000, 'Workbook example');

INSERT INTO payment_stages (po_number, stage_no, stage_name, trigger_event, stage_percent, invoice_no, invoice_date, amount_received, remarks) VALUES
  ('PO-77310', 1, 'Advance (50%)', 'On PO Registration', 0.5, 'CTZ/INV/2026/021', '2026-05-26', 100000, 'Workbook example'),
  ('PO-77310', 2, 'On delivery (50%)', 'On Delivery', 0.5, NULL, NULL, 0, 'Workbook example'),
  ('PO-77455', 1, 'Advance (50%)', 'On PO Registration', 0.5, NULL, NULL, 0, 'Workbook example'),
  ('PO-77455', 2, 'On delivery (50%)', 'On Delivery', 0.5, NULL, NULL, 0, 'Workbook example');


COMMIT;
