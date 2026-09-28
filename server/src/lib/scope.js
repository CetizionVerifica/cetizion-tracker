/**
 * The two SQL fragments the MCP surface needs, and nothing else.
 *
 * This file used to hold a second, parallel answer to "whose record is
 * this?" — one that matched the free-text `sales_person` column against the
 * signed-in name, wired into the staff routes through `def.visibleTo`,
 * `canSeeRecord`, `onRecordVisibleSql`, `mayWriteOnRecords` and
 * `assertVisible`. All of that is gone. For every session-authenticated
 * route the one ownership truth is `owner_user_id`, in auth/ownership.js.
 *
 * What is left are the fragments MCP still reads: `recordVisibleSql`
 * (lib/mcp/data.js) and `ownProjectSql` (lib/mcp/aggregate.js). MCP is an
 * explicit, temporary exception — an API token carries `{ role, person }`,
 * a name string with no link to users.id, so it has nothing else to match
 * on. Both are unchanged from main, so MCP behaves exactly as it does
 * there.
 *
 * `isAdmin` and `identities` are deliberately NOT exported: they are the
 * inputs these two fragments need and nothing outside this file should be
 * reaching for a name-based identity. Nothing outside server/src/lib/mcp/
 * may import from here.
 *
 * Follow-up: bind MCP API tokens to users.id and migrate MCP authorization
 * from sales_person to owner_user_id. When that lands, this file goes too.
 */

const isAdmin = (req) => !req?.user || req.user.role === 'admin';

const identities = (req) => [...new Set([req?.user?.username, req?.user?.name]
  .filter(Boolean).map((s) => String(s).trim().toLowerCase()))];

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

/**
 * SQL: rows hanging off a project this person owns. Null for an admin.
 *
 * A project milestone is not a record somebody attaches to a deal, so
 * recordVisibleSql above does not reach it — it belongs to the project by
 * a column. It still has to be scoped, and more sharply than most: marking
 * one reached sets milestone_reached_on on every payment stage pointing at
 * it, and a stage triggered "On Milestone" becomes ready to invoice the
 * moment that is not null (views.sql). Unscoped, any signed-in user could
 * make somebody else's project billable.
 *
 * Either name on the project counts. The person who sold it and the person
 * delivering it both have a reason to say a milestone was reached, and the
 * delivery manager is usually the one who knows.
 */
export function ownProjectSql(req, table, params, { column = 'project_id' } = {}) {
  if (isAdmin(req)) return null;
  params.push(identities(req));
  const p = `$${params.length}::text[]`;
  return `EXISTS (SELECT 1 FROM projects op WHERE op.project_id = ${table}.${column}
    AND (lower(btrim(op.sales_person)) = ANY(${p}) OR lower(btrim(op.project_manager)) = ANY(${p})))`;
}
