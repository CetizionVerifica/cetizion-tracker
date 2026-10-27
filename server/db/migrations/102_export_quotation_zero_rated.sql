-- =====================================================================
-- 102_export_quotation_zero_rated.sql
-- An export quotation (not in INR) is zero-rated, so its stored totals
-- carry no GST. quotation_totals() added GST at each line's rate whatever
-- the currency: a USD 10,000 line stored a total of 11,800, which the PDF,
-- the acceptance page and the email printed under an "IGST @ 0%" line, and
-- which a PO registered from it took as its value.
--
-- Changing a quotation's currency now recomputes its totals too.
--
-- Totals already stored are left as they are: a client may have seen them.
-- They follow the fix the next time a line or the currency changes.
-- =====================================================================

CREATE OR REPLACE FUNCTION quotation_totals(p_quotation int) RETURNS void AS $$
DECLARE s numeric; t numeric; n int; gross numeric; disc numeric; threshold numeric; st text; approved_at numeric;
        p_sub numeric; p_tax numeric; p_total numeric;
BEGIN
  SELECT COUNT(*), COALESCE(SUM(amount), 0), COALESCE(SUM(round(amount * gst_rate / 100, 2)), 0), COALESCE(SUM(round(qty * rate, 2)), 0)
    INTO n, s, t, gross FROM quotation_lines WHERE quotation_id = p_quotation;
  -- An export (not in INR) is zero-rated, whatever rate its lines show (102).
  IF EXISTS (SELECT 1 FROM quotations WHERE id = p_quotation AND upper(currency) <> 'INR') THEN t := 0; END IF;
  IF n = 0 THEN
    -- Read from the PDF we sent (docs/email-enquiries-plan.md §3.9.7): the
    -- printed totals stand until real lines replace them, and come back if
    -- those lines are all removed. Never blanked, never zero.
    SELECT d.printed_subtotal, d.printed_tax_total, d.printed_total INTO p_sub, p_tax, p_total
      FROM email_enquiry_decisions d JOIN quotations q ON q.quotation_no = d.quotation_no
     WHERE q.id = p_quotation AND d.quotation_extraction IN ('created','revised') AND d.printed_total IS NOT NULL
     ORDER BY d.decided_at DESC, d.id DESC LIMIT 1;
    IF FOUND THEN
      UPDATE quotations SET subtotal = p_sub, tax_total = p_tax, total = p_total, quotation_value = p_total, discount_percent = NULL,
             approval_status = CASE WHEN approval_status = 'pending' AND approval_reason IS NULL THEN 'not_needed' ELSE approval_status END
       WHERE id = p_quotation;
      RETURN;
    END IF;
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

-- The currency decides whether there is GST at all, so changing it recomputes (102).
-- Only with lines: without, the totals are the ones typed or printed, and a
-- revision read from email sets them in the same UPDATE as the currency.
CREATE OR REPLACE FUNCTION quotation_currency_changed() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM quotation_lines WHERE quotation_id = NEW.id) THEN PERFORM quotation_totals(NEW.id); END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS quotation_currency_changed ON quotations;
CREATE TRIGGER quotation_currency_changed AFTER UPDATE OF currency ON quotations
  FOR EACH ROW WHEN (NEW.currency IS DISTINCT FROM OLD.currency) EXECUTE FUNCTION quotation_currency_changed();

