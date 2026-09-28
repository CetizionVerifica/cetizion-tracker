-- A purchase order that was revised or cancelled.
--
-- A PO amended after it was registered is entered as a new PO (PO-441-R1),
-- because the original keeps its payment stages, invoices and receipts. The
-- sales figures then counted both: two orders and ₹65L for a single ₹35L
-- order, and a one-off client promoted to "Repeat client". A PO that was
-- cancelled outright was still counted as won business.
--
-- replaces_po_number names the PO a revision takes the place of; cancelled
-- marks an order that will not go ahead. Both only take a PO out of the
-- sales figures (won POs, won value, Win %, repeat clients, FX deals).
-- Billing and collections are untouched: money invoiced or received against
-- the old PO is real, and its stages stay where finance can see them.
--
-- Every existing PO starts with neither, so no figure changes on the day
-- this deploys.
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS replaces_po_number text
  REFERENCES purchase_orders(po_number) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS cancelled boolean NOT NULL DEFAULT false;

DO $$
BEGIN
  ALTER TABLE purchase_orders
    ADD CONSTRAINT purchase_orders_not_replacing_itself CHECK (replaces_po_number <> po_number);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- A PO is replaced by one revision at most; a later revision replaces that one.
CREATE UNIQUE INDEX IF NOT EXISTS purchase_orders_replaces_key
  ON purchase_orders (replaces_po_number) WHERE replaces_po_number IS NOT NULL;
