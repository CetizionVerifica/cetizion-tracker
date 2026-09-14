-- 004 — exchange rates for the sales report's INR values. One setting per
-- currency, holding the INR value of 1 unit. Blank until someone sets it;
-- the report shows "rate not set" rather than guessing.
--
-- Safe on a live database: existing rates are never overwritten.

INSERT INTO settings (key, value, notes) VALUES
  ('fx_rate_EUR', '', 'INR for 1 EUR. Used to show FX deals in INR on the sales report.'),
  ('fx_rate_USD', '', 'INR for 1 USD. Used to show FX deals in INR on the sales report.'),
  ('fx_rate_GBP', '', 'INR for 1 GBP. Used to show FX deals in INR on the sales report.'),
  ('fx_rate_AED', '', 'INR for 1 AED. Used to show FX deals in INR on the sales report.'),
  ('fx_rate_SGD', '', 'INR for 1 SGD. Used to show FX deals in INR on the sales report.')
ON CONFLICT (key) DO NOTHING;
