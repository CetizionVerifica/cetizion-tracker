-- 006 — each purchase order names the won quotation it fulfils, so revenue
-- counts a PO once, against that quotation, even when a project holds
-- several won quotations or already had POs when another was won into it.
--
-- Existing POs are linked where their project has exactly one won quotation;
-- any other PO stays unlinked and the revenue report flags it.
--
-- Safe on a live database: it adds a column and fills only empty links, so
-- running it a second time changes nothing it has already set.

ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS quotation_no text
  REFERENCES quotations(quotation_no) ON UPDATE CASCADE ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS purchase_orders_quotation_no_idx ON purchase_orders (quotation_no);

UPDATE purchase_orders p
   SET quotation_no = won.quotation_no
  FROM (SELECT project_id, min(quotation_no) AS quotation_no
          FROM quotations
         WHERE status = 'Won - PO Received' AND project_id IS NOT NULL
         GROUP BY project_id
        HAVING count(*) = 1) won
 WHERE p.project_id = won.project_id
   AND p.quotation_no IS NULL;
