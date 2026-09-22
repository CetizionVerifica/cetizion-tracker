-- 025 â€” collections (#27): every receipt as its own row, a chasing log,
-- disputes on hold, promises to pay, and escalating reminder levels.
--
-- Safe on a live database; running it a second time changes nothing.

CREATE TABLE IF NOT EXISTS payments (
  id           serial PRIMARY KEY,
  stage_id     int NOT NULL REFERENCES payment_stages(id) ON DELETE CASCADE,
  -- A receipt is positive. An adjustment — someone correcting a total that
  -- was typed too high — is a negative row, so the ledger still adds up to
  -- the figure on the stage. Writing the figure by hand instead left the
  -- correction to be undone by the next receipt.
  amount       numeric(16,2) NOT NULL,
  tds_amount   numeric(16,2) NOT NULL DEFAULT 0 CHECK (tds_amount >= 0),
  -- Nullable on purpose. The route before this one accepted an amount
  -- with no date, and those receipts are carried over as they are: a
  -- missing date stays missing rather than becoming the day of the deploy.
  received_on  date,
  mode         text NOT NULL DEFAULT 'bank_transfer'
                 CHECK (mode IN ('bank_transfer','cheque','upi','cash','other')),
  reference    text,
  notes        text,
  recorded_by  text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS payments_stage_idx ON payments (stage_id, received_on);

-- The stage's received total and date follow its payments. TDS counts as
-- settled: the client paid it to the government on our behalf.
CREATE OR REPLACE FUNCTION payments_changed() RETURNS trigger AS $$
DECLARE sid int;
BEGIN
  sid := COALESCE(NEW.stage_id, OLD.stage_id);
  UPDATE payment_stages ps
     SET amount_received = COALESCE((SELECT SUM(amount + tds_amount) FROM payments WHERE stage_id = sid), 0),
         payment_received_date = (SELECT MAX(received_on) FROM payments WHERE stage_id = sid)
   WHERE ps.id = sid;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS payments_changed ON payments;
CREATE TRIGGER payments_changed AFTER INSERT OR UPDATE OR DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION payments_changed();

-- The first receipt on a stage that already carries a received amount
-- (seeded, imported, or typed before receipts existed) first books that
-- amount as an opening receipt, so nothing already received is lost.
CREATE OR REPLACE FUNCTION payments_opening() RETURNS trigger AS $$
DECLARE cur record;
BEGIN
  IF NEW.notes = 'Opening balance from the stage' THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM payments WHERE stage_id = NEW.stage_id) THEN
    SELECT amount_received, payment_received_date INTO cur FROM payment_stages WHERE id = NEW.stage_id;
    IF cur.amount_received > 0 THEN
      INSERT INTO payments (stage_id, amount, received_on, mode, notes)
      VALUES (NEW.stage_id, cur.amount_received, cur.payment_received_date, 'other', 'Opening balance from the stage');
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS payments_opening ON payments;
CREATE TRIGGER payments_opening BEFORE INSERT ON payments
  FOR EACH ROW EXECUTE FUNCTION payments_opening();

ALTER TABLE payment_stages
  ADD COLUMN IF NOT EXISTS on_hold boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS hold_reason text,
  ADD COLUMN IF NOT EXISTS promise_to_pay_date date,
  ADD COLUMN IF NOT EXISTS reminder_level int NOT NULL DEFAULT 0;

-- Start every overdue invoice at the level its age has already earned, less
-- one, so the first run sends the reminder it deserves and then keeps to the
-- interval. Left at 0, an invoice ninety days overdue would have walked up
-- the levels one run at a time: three emails to the client on three
-- consecutive mornings, the first of them the day this deploys.
UPDATE payment_stages ps
   SET reminder_level = GREATEST(earned.n - 1, 0)
  FROM (
    SELECT s.id,
           (SELECT COUNT(*) FROM unnest(string_to_array(
                  COALESCE((SELECT value FROM settings WHERE key = 'reminder_levels_days'), '3,14,30'), ',')) AS d
             WHERE CURRENT_DATE - (s.invoice_date + COALESCE(s.credit_days, po.payment_terms_days)) >= btrim(d)::int) AS n
      FROM payment_stages s
      JOIN purchase_orders po ON po.po_number = s.po_number
     WHERE s.invoice_no IS NOT NULL AND s.invoice_date IS NOT NULL
       AND s.amount_received < ROUND(po.po_value * s.stage_percent, 2)
  ) AS earned
 WHERE ps.id = earned.id AND earned.n > 1;

-- What was received before payments existed becomes one opening receipt per stage.
INSERT INTO payments (stage_id, amount, received_on, mode, notes)
SELECT ps.id, ps.amount_received, ps.payment_received_date, 'other', 'Opening balance from the stage'
  FROM payment_stages ps
 WHERE ps.amount_received > 0 AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.stage_id = ps.id);

CREATE TABLE IF NOT EXISTS collection_log (
  id                   serial PRIMARY KEY,
  stage_id             int REFERENCES payment_stages(id) ON DELETE CASCADE,
  company_id           int REFERENCES companies(id) ON DELETE SET NULL,
  channel              text NOT NULL DEFAULT 'call' CHECK (channel IN ('email','call','whatsapp','meeting','note')),
  happened_at          timestamptz NOT NULL DEFAULT now(),
  by_whom              text,
  summary              text NOT NULL,
  promise_to_pay_date  date,
  next_action_on       date,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS collection_log_stage_idx ON collection_log (stage_id, happened_at DESC);
CREATE INDEX IF NOT EXISTS collection_log_company_idx ON collection_log (company_id, happened_at DESC);

INSERT INTO settings (key, value, notes) VALUES
  ('reminder_levels_days', '3,14,30', 'Days overdue at which the first, second and final reminders go out. After the final one, every reminder_interval_days.')
ON CONFLICT (key) DO NOTHING;
