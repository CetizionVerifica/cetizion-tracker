/**
 * The record-visibility SQL the MCP surface uses, and nothing else.
 *
 * This file used to hold a second, parallel answer to "whose record is
 * this?" — one that matched the free-text `sales_person` column against the
 * signed-in name, wired into the staff routes through `def.visibleTo`,
 * `canSeeRecord`, `onRecordVisibleSql`, `mayWriteOnRecords` and
 * `ownProjectSql`. Those are gone. For every session-authenticated route the
 * one ownership truth is `owner_user_id`, in auth/ownership.js.
 *
 * What is left is the one fragment MCP still needs. MCP is an explicit,
 * temporary exception: an API token carries `{ role, person }` — a name
 * string with no link to users.id — so it has nothing else to match on. The
 * fragment is unchanged from main so MCP behaves exactly as it does there.
 *
 * Follow-up: bind MCP API tokens to users.id and migrate MCP authorization
 * from sales_person to owner_user_id. When that lands, this file goes with
 * it. Nothing outside server/src/lib/mcp/ may import from here.
 */

export function recordVisibleSql(entityExpr, idExpr, p) {
  const mine = (col) => `lower(btrim(${col})) = ANY(${p})`;
  const ownsCompany = (companyExpr) => `(EXISTS (SELECT 1 FROM quotations sq WHERE sq.company_id = ${companyExpr} AND ${mine('sq.sales_person')})
      OR EXISTS (SELECT 1 FROM enquiries se WHERE se.company_id = ${companyExpr} AND ${mine('se.sales_person')})
      OR EXISTS (SELECT 1 FROM projects sp WHERE sp.company_id = ${companyExpr} AND ${mine('sp.sales_person')}))`;
  return `(CASE ${entityExpr}
    WHEN 'quotation' THEN EXISTS (SELECT 1 FROM quotations s WHERE s.quotation_no = ${idExpr} AND ${mine('s.sales_person')})
    WHEN 'enquiry' THEN EXISTS (SELECT 1 FROM enquiries s WHERE s.enquiry_no = ${idExpr} AND ${mine('s.sales_person')})
    WHEN 'project' THEN EXISTS (SELECT 1 FROM projects s WHERE s.project_id = ${idExpr} AND ${mine('s.sales_person')})
    WHEN 'purchase_order' THEN EXISTS (SELECT 1 FROM purchase_orders s JOIN projects sp1 ON sp1.project_id = s.project_id
      WHERE s.po_number = ${idExpr} AND ${mine('sp1.sales_person')})
    WHEN 'payment_stage' THEN EXISTS (SELECT 1 FROM payment_stages s JOIN purchase_orders spo ON spo.po_number = s.po_number
      JOIN projects sp2 ON sp2.project_id = spo.project_id WHERE s.id::text = ${idExpr} AND ${mine('sp2.sales_person')})
    WHEN 'company' THEN EXISTS (SELECT 1 FROM companies s WHERE s.id::text = ${idExpr} AND ${ownsCompany('s.id')})
    WHEN 'contact' THEN EXISTS (SELECT 1 FROM contacts s WHERE s.id::text = ${idExpr} AND ${ownsCompany('s.company_id')})
    ELSE false END)`;
}
