-- =====================================================================
-- 064_enquiry_risk_settings.sql
-- When an open enquiry counts as at risk on Insights
-- (docs/insights-dashboard-plan.md §4.3). Settings only: the risk itself is
-- worked out on read, never stored.
-- =====================================================================

INSERT INTO settings (key, value, notes) VALUES
  ('enquiry_reply_days', '1', 'Working days a new enquiry may wait for a first reply before it is at risk.'),
  ('enquiry_decision_warn_days', '5', 'Working days before the client''s decision date that an enquiry with no quotation is at risk.')
ON CONFLICT (key) DO NOTHING;
