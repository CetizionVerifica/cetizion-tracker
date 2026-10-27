-- =====================================================================
-- 099_sales_journey_settings.sql
-- When the Journey board calls a sale slow or stuck, and how long a paid
-- one stays on it (docs/specs/sales-journey, decision D4).
--
-- Settings rows only. The journey itself is v_sales_journey in views.sql,
-- and every step, flag and next action is worked out on read by
-- lib/journey/steps.js, so nothing about a sale's step is stored.
-- =====================================================================

INSERT INTO settings (key, value, notes) VALUES
  ('journey_stuck_enquiry_days', '7', 'Days an enquiry can wait before the Journey board calls it slow; stuck after twice this.'),
  ('journey_stuck_quotation_days', '21', 'Days a quotation can stay open before the Journey board calls it slow; stuck after twice this.'),
  ('journey_unsent_days', '5', 'Days a quotation can stay unsent before the Journey board nudges.'),
  ('journey_stuck_po_days', '30', 'Days a PO can go with nothing invoiced before the Journey board calls it slow; stuck after twice this.'),
  ('journey_paid_visible_days', '30', 'Days a fully paid sale stays on the Journey board.')
ON CONFLICT (key) DO NOTHING;
