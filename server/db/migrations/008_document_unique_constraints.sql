-- 008 — schema.sql makes quotations.document_id and purchase_orders.document_id
-- unique with UNIQUE constraints, but 002 used plain unique indexes of the
-- same names. The rule is the same; the objects are not. This turns each
-- index into its constraint, so an upgraded database matches a fresh one.
--
-- Safe on a live database: no data changes, it only relabels an existing
-- index, and a table that already has the constraint is skipped.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'quotations'::regclass AND conname = 'quotations_document_id_key') THEN
    ALTER TABLE quotations
      ADD CONSTRAINT quotations_document_id_key UNIQUE USING INDEX quotations_document_id_key;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'purchase_orders'::regclass AND conname = 'purchase_orders_document_id_key') THEN
    ALTER TABLE purchase_orders
      ADD CONSTRAINT purchase_orders_document_id_key UNIQUE USING INDEX purchase_orders_document_id_key;
  END IF;
END $$;
