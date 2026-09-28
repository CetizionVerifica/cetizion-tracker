-- 023 — discount and exception approvals on quotations (#46).
--
-- A quotation whose overall discount passes the threshold in Settings
-- waits for approval before it can be sent; an exception (special terms)
-- can be put up for approval by hand. The check runs whenever the lines
-- change, through quotation_totals().
--
-- Safe on a live database; running it a second time changes nothing.

ALTER TABLE quotations
  ADD COLUMN IF NOT EXISTS discount_percent numeric(5,2),
  ADD COLUMN IF NOT EXISTS approval_status text NOT NULL DEFAULT 'not_needed'
    CHECK (approval_status IN ('not_needed','pending','approved','rejected')),
  ADD COLUMN IF NOT EXISTS approval_reason text,
  ADD COLUMN IF NOT EXISTS approval_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS approval_requested_by text,
  ADD COLUMN IF NOT EXISTS approval_decided_at timestamptz,
  ADD COLUMN IF NOT EXISTS approved_by text,
  ADD COLUMN IF NOT EXISTS approval_note text,
  -- the discount an approval was given for; more than this asks again
  ADD COLUMN IF NOT EXISTS approved_discount_percent numeric(5,2);

INSERT INTO settings (key, value, notes) VALUES
  ('discount_approval_threshold_percent', '10', 'A quotation discounted above this overall % waits for approval before it can be sent.'),
  ('approver_email', '', 'Who is emailed when a quotation needs approval. Blank: the finance email.')
ON CONFLICT (key) DO NOTHING;

-- Totals plus the discount check. Replaces the version from 013.
CREATE OR REPLACE FUNCTION quotation_totals(p_quotation int) RETURNS void AS $$
DECLARE s numeric; t numeric; n int; gross numeric; disc numeric; threshold numeric; st text; approved_at numeric;
BEGIN
  SELECT COUNT(*), COALESCE(SUM(amount), 0), COALESCE(SUM(round(amount * gst_rate / 100, 2)), 0), COALESCE(SUM(round(qty * rate, 2)), 0)
    INTO n, s, t, gross FROM quotation_lines WHERE quotation_id = p_quotation;
  IF n = 0 THEN
    UPDATE quotations SET subtotal = NULL, tax_total = NULL, total = NULL, discount_percent = NULL,
           approval_status = CASE WHEN approval_status = 'pending' AND approval_reason IS NULL THEN 'not_needed' ELSE approval_status END
     WHERE id = p_quotation;
    RETURN;
  END IF;
  disc := CASE WHEN gross > 0 THEN round((gross - s) / gross * 100, 2) ELSE 0 END;
  threshold := setting_num('discount_approval_threshold_percent', 10);
  SELECT approval_status, approved_discount_percent INTO st, approved_at FROM quotations WHERE id = p_quotation;
  UPDATE quotations
     SET subtotal = s, tax_total = t, total = s + t, quotation_value = s + t, discount_percent = disc,
         approval_status = CASE
           -- Over the threshold needs a decision, and an approval covers
           -- only the discount it was given for: raising it asks again.
           -- This applies to hand-requested exceptions too.
           WHEN disc > threshold AND (st IN ('not_needed', 'rejected')
                OR (st = 'approved' AND disc > COALESCE(approved_at, -1))) THEN 'pending'
           -- otherwise an exception someone asked for by hand keeps its own state
           WHEN approval_reason IS NOT NULL THEN approval_status
           WHEN disc <= threshold AND st IN ('pending', 'rejected') THEN 'not_needed'
           ELSE approval_status END,
         approval_requested_at = CASE WHEN disc > threshold AND (st IN ('not_needed', 'rejected')
                OR (st = 'approved' AND disc > COALESCE(approved_at, -1))) THEN now() ELSE approval_requested_at END
   WHERE id = p_quotation;
END $$ LANGUAGE plpgsql;
