-- =====================================================================
-- 096_travel_vendor_payments.sql
-- What the company has actually paid a travel agency, as a ledger (#214).
--
-- Until now a vendor payment was one overwritten figure on the invoice,
-- travel_vendor_invoices.amount_paid with payment_date beside it. A bill
-- settled in two transfers, the UTR, the method, the bank advice and any
-- correction all had nowhere to live: the figure was simply written over,
-- and the activity log was the only trace that it had ever been anything
-- else.
--
-- Payments become rows here, the same way a client's receipts are rows in
-- `payments` (see payments_changed in schema.sql). The two columns stay as
-- a cache this migration's trigger keeps, so every reader of them goes on
-- working untouched: Payables, the cash-flow forecast, the travel
-- dashboard, project profitability, the ageing view, the MCP payables tool,
-- the per-line paid share in v_travel_invoice_lines and the per-trip agency
-- status in v_travel_logs.
--
-- Settlement credit is `amount + tds_amount`, which is the rule the client
-- side already uses: tax deducted at source settles the bill without the
-- money reaching the agency. A bill of 100,000 settled by a 90,000 transfer
-- with 10,000 deducted is paid in full, and the cash that left the business
-- was 90,000.
--
-- ## Legacy rows: preserved, not tidied
--
-- The production data behind these columns could not be measured before
-- this was written, so the backfill below preserves whatever shape each
-- existing figure has rather than normalising it into something a new
-- payment would be allowed to look like:
--
--   a negative figure stays negative      (carried as a correction row, with
--                                          its provenance as the reason)
--   a missing date stays missing          (paid_on is nullable on purpose)
--   a future date stays future            (which is why the future-date rule
--                                          lives in the route, not here)
--   an overpayment stays an overpayment   (allowed by product decision)
--   a zero figure gets no row at all      (so an invoice nobody has paid
--                                          keeps its date and gains no
--                                          misleading "payment")
--
-- Runtime validation for *new* payments lives in routes/workflow.js and is
-- deliberately stricter than anything asserted here. The two must not be
-- conflated: this file records what already happened, that one decides what
-- may happen next.
-- =====================================================================

CREATE TABLE IF NOT EXISTS travel_vendor_payments (
  id                 serial PRIMARY KEY,
  vendor_invoice_id  int NOT NULL REFERENCES travel_vendor_invoices(id) ON DELETE CASCADE,
  -- A payment is positive. A correction — a figure typed too high, or a
  -- cash/TDS split recorded the wrong way round — is a negative row, so the
  -- ledger still adds up to the figure on the invoice. Writing the figure
  -- by hand instead left the correction to be undone by the next payment.
  amount             numeric(16,2) NOT NULL,
  -- Tax deducted at source and owed to the government: it settles the
  -- agency's bill without money reaching the agency. Negative only on a
  -- correction, which is what the constraint below allows and nothing else.
  tds_amount         numeric(16,2) NOT NULL DEFAULT 0,
  -- Nullable on purpose, exactly as payments.received_on is: a legacy
  -- figure with no recorded date keeps having no date rather than acquiring
  -- the day of the deploy.
  paid_on            date,
  mode               text NOT NULL DEFAULT 'bank_transfer'
                       CHECK (mode IN ('bank_transfer', 'upi', 'cheque', 'cash', 'card', 'other')),
  -- The UTR, cheque number or whatever the bank calls it.
  reference          text,
  -- The bank advice or screenshot that evidences this transfer. On the
  -- payment and not on the invoice, so that on a bill settled in three
  -- transfers it is still possible to say which advice proves which one.
  document_id        int REFERENCES documents(id) ON DELETE SET NULL,
  remarks            text,
  -- Required on any row that takes money back off the invoice; the
  -- constraint below is what makes "a correction says why" a fact about the
  -- data rather than a rule one route happens to apply.
  correction_reason  text,
  recorded_by        text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT travel_vendor_payments_signed_rows_need_reason
    CHECK ((amount >= 0 AND tds_amount >= 0)
           OR NULLIF(btrim(correction_reason), '') IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS travel_vendor_payments_invoice_idx
  ON travel_vendor_payments (vendor_invoice_id, paid_on);

-- ---------------------------------------------------------------------
-- The backfill, before the trigger exists
-- ---------------------------------------------------------------------
--
-- Deliberately ordered: the trigger is created *after* this, so the
-- backfill cannot recompute the very figures it is reading. The cache keeps
-- the value it had, the ledger is built to equal it, and the assertion
-- below holds the two against each other before anything else can run.

-- What is actually there, reported rather than assumed: this is the
-- measurement that could not be taken in advance.
DO $$
DECLARE n_total int; n_paid int; n_neg int; n_nodate int; n_future int;
        n_over int; n_noamount int; n_datezero int;
BEGIN
  SELECT count(*),
         count(*) FILTER (WHERE amount_paid > 0),
         count(*) FILTER (WHERE amount_paid < 0),
         count(*) FILTER (WHERE amount_paid <> 0 AND payment_date IS NULL),
         count(*) FILTER (WHERE amount_paid <> 0 AND payment_date > CURRENT_DATE),
         count(*) FILTER (WHERE invoice_amount IS NOT NULL AND amount_paid > invoice_amount),
         count(*) FILTER (WHERE amount_paid <> 0 AND invoice_amount IS NULL),
         count(*) FILTER (WHERE amount_paid = 0 AND payment_date IS NOT NULL)
    INTO n_total, n_paid, n_neg, n_nodate, n_future, n_over, n_noamount, n_datezero
    FROM travel_vendor_invoices;

  RAISE NOTICE 'Vendor payments (096): % invoices; % with a figure to carry over, % negative, % with no date, % dated ahead of today, % over the invoice, % with no invoice amount, % dated but unpaid.',
    n_total, n_paid, n_neg, n_nodate, n_future, n_over, n_noamount, n_datezero;
END $$;

-- One opening row per invoice that carries a figure, in either direction.
-- Nothing is invented: no reference, no proof, no TDS split (0 keeps the
-- settlement exactly equal to what was recorded), and the method is
-- 'other' because the real one was never captured — the same word
-- payments_opening() uses on the client side for the same reason.
INSERT INTO travel_vendor_payments
  (vendor_invoice_id, amount, tds_amount, paid_on, mode, remarks, correction_reason)
SELECT vi.id,
       vi.amount_paid,
       0,
       vi.payment_date,
       'other',
       'Opening balance from the invoice',
       -- A negative legacy figure is carried as it stands. The reason is
       -- its provenance, not somebody's correction: the constraint asks
       -- every row that reduces the invoice to say why it does, and for
       -- these the honest answer is that this is how it was recorded.
       CASE WHEN vi.amount_paid < 0
            THEN 'Legacy opening balance migrated from travel_vendor_invoices (096)' END
  FROM travel_vendor_invoices vi
 WHERE vi.amount_paid <> 0
   AND NOT EXISTS (SELECT 1 FROM travel_vendor_payments p WHERE p.vendor_invoice_id = vi.id);

-- The ledger must add up to what the invoice already said, for every
-- invoice, before the cache is ever recomputed from it. A row that cannot
-- be represented without losing its figure stops the migration and names
-- itself; nothing is clamped, dropped or rounded to make this pass.
DO $$
DECLARE bad record; n int := 0;
BEGIN
  FOR bad IN
    SELECT vi.id, vi.vendor_invoice_id, vi.amount_paid,
           COALESCE((SELECT SUM(p.amount + p.tds_amount) FROM travel_vendor_payments p
                      WHERE p.vendor_invoice_id = vi.id), 0) AS ledger
      FROM travel_vendor_invoices vi
     WHERE vi.amount_paid <> COALESCE((SELECT SUM(p.amount + p.tds_amount) FROM travel_vendor_payments p
                                        WHERE p.vendor_invoice_id = vi.id), 0)
  LOOP
    n := n + 1;
    RAISE WARNING 'Vendor payments (096): invoice % (%) recorded % but its ledger adds to %',
      bad.id, bad.vendor_invoice_id, bad.amount_paid, bad.ledger;
  END LOOP;
  IF n > 0 THEN
    RAISE EXCEPTION 'Vendor payments (096): % invoice(s) could not be carried over without changing the figure recorded against them. Nothing has been migrated.', n;
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- The cache the existing readers use, kept by the ledger
-- ---------------------------------------------------------------------
--
-- amount_paid is the settlement total — cash plus TDS — because that is
-- what every status in views.sql compares against the bill, and a bill
-- settled partly by deduction is still settled. payment_date is the latest
-- date on the ledger, which is what the ageing and the "paid on" column
-- have always meant.
--
-- An invoice with no ledger rows is never touched by this trigger, so an
-- unpaid invoice that happens to carry a date keeps it.
CREATE OR REPLACE FUNCTION travel_vendor_payments_changed() RETURNS trigger AS $$
DECLARE vid int;
BEGIN
  vid := COALESCE(NEW.vendor_invoice_id, OLD.vendor_invoice_id);
  UPDATE travel_vendor_invoices vi
     SET amount_paid = COALESCE((SELECT SUM(amount + tds_amount) FROM travel_vendor_payments
                                  WHERE vendor_invoice_id = vid), 0),
         payment_date = (SELECT MAX(paid_on) FROM travel_vendor_payments
                          WHERE vendor_invoice_id = vid)
   WHERE vi.id = vid;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS travel_vendor_payments_changed ON travel_vendor_payments;
CREATE TRIGGER travel_vendor_payments_changed
  AFTER INSERT OR UPDATE OR DELETE ON travel_vendor_payments
  FOR EACH ROW EXECUTE FUNCTION travel_vendor_payments_changed();
