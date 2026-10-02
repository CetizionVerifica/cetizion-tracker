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
 * MCP was the last exception, and it is now closed. An API token carries
 * `user_id` (063), so these fragments ask the same question of the same
 * column the web app does. The difference that remains is only where the
 * identity comes from — a bearer token rather than a session cookie.
 *
 * Why this mattered: the old fragments matched a name. Issue #18 opens by
 * counting what that is worth on this data — "4 spellings for 3 people",
 * 19 of 92 quotations with no salesperson at all. A token scoped by name
 * therefore saw a set of records nobody could state precisely: rename a
 * person and their token silently empties; type a name two ways and half
 * their work disappears; and worst, two people whose names normalise to the
 * same string read each other's pipeline. None of those are visible as a
 * failure. They just quietly return the wrong rows.
 *
 * `isAdmin` and `ownerId` are deliberately NOT exported: they are the
 * inputs these fragments need and nothing outside this file should be
 * reaching for a token's identity directly. Nothing outside
 * server/src/lib/mcp/ may import from here.
 */

const isAdmin = (scopeOrReq) => {
  const s = scopeOrReq?.user ?? scopeOrReq;
  return !s || s.role === 'admin';
};

/**
 * The users.id a token acts as, or null.
 *
 * Null for an admin token (it is unrestricted and needs no id) and null for
 * a sales token that predates 063 and was never bound to an account. The
 * second case is the one that matters: a sales token with no user id must
 * see nothing, not everything, so every fragment below treats null as
 * "matches no row" rather than as "no filter". 063 revokes those tokens on
 * sight, so this is a belt-and-braces reading of a state that should not
 * exist.
 */
const ownerId = (scopeOrReq) => {
  const s = scopeOrReq?.user ?? scopeOrReq;
  return Number.isSafeInteger(s?.userId) ? s.userId : null;
};

/** `FALSE`, as a fragment. A sales token we cannot identify sees nothing. */
const NOTHING = 'FALSE';

/**
 * SQL: is this (entity, id) pair one the token may see?
 *
 * Used by the tools that address a record by its natural key — a note, a
 * task, an attachment, a timeline entry all hang off `(entity, entity_id)`
 * text rather than a foreign key.
 *
 * Companies and contacts stay shared master data, reachable when the token
 * owns any record against that company, which is the same rule the web app
 * applies in routes/companies.js. A client's name and sector are not one
 * salesperson's secret; the deals under them are.
 */
export function recordVisibleSql(entityExpr, idExpr, p) {
  const mine = (col) => `${col} = ${p}`;
  const ownsCompany = (companyExpr) => `(EXISTS (SELECT 1 FROM quotations sq WHERE sq.company_id = ${companyExpr} AND ${mine('sq.owner_user_id')})
      OR EXISTS (SELECT 1 FROM enquiries se WHERE se.company_id = ${companyExpr} AND ${mine('se.owner_user_id')})
      OR EXISTS (SELECT 1 FROM projects sp WHERE sp.company_id = ${companyExpr} AND ${mine('sp.owner_user_id')}))`;
  return `(CASE ${entityExpr}
    WHEN 'quotation' THEN EXISTS (SELECT 1 FROM quotations s WHERE s.quotation_no = ${idExpr} AND ${mine('s.owner_user_id')})
    WHEN 'enquiry' THEN EXISTS (SELECT 1 FROM enquiries s WHERE s.enquiry_no = ${idExpr} AND ${mine('s.owner_user_id')})
    WHEN 'project' THEN EXISTS (SELECT 1 FROM projects s WHERE s.project_id = ${idExpr} AND ${mine('s.owner_user_id')})
    WHEN 'purchase_order' THEN EXISTS (SELECT 1 FROM purchase_orders s JOIN projects sp1 ON sp1.project_id = s.project_id
      WHERE s.po_number = ${idExpr} AND ${mine('sp1.owner_user_id')})
    WHEN 'payment_stage' THEN EXISTS (SELECT 1 FROM payment_stages s JOIN purchase_orders spo ON spo.po_number = s.po_number
      JOIN projects sp2 ON sp2.project_id = spo.project_id WHERE s.id::text = ${idExpr} AND ${mine('sp2.owner_user_id')})
    WHEN 'company' THEN EXISTS (SELECT 1 FROM companies s WHERE s.id::text = ${idExpr} AND ${ownsCompany('s.id')})
    WHEN 'contact' THEN EXISTS (SELECT 1 FROM contacts s WHERE s.id::text = ${idExpr} AND ${ownsCompany('s.company_id')})
    ELSE false END)`;
}

/**
 * SQL: rows hanging off a project this token owns. Null for an admin.
 *
 * A project milestone is not a record somebody attaches to a deal, so
 * recordVisibleSql above does not reach it — it belongs to the project by
 * a column. It still has to be scoped, and more sharply than most: marking
 * one reached sets milestone_reached_on on every payment stage pointing at
 * it, and a stage triggered "On Milestone" becomes ready to invoice the
 * moment that is not null (views.sql). Unscoped, any token could make
 * somebody else's project billable.
 *
 * Ownership only, now. The previous rule also accepted `project_manager`,
 * on the reasoning that the person delivering a project has a reason to say
 * a milestone was reached. That was a name match, and it is exactly the
 * widening 060 refused to make in the backfill: the manager who delivers a
 * project is not the salesperson who owns it, and a delivery manager who
 * needs to mark milestones needs an account and an owner row, not a string
 * comparison that also matches whoever shares their name.
 */
export function ownProjectSql(req, table, params, { column = 'project_id' } = {}) {
  if (isAdmin(req)) return null;
  const uid = ownerId(req);
  if (uid === null) return NOTHING;
  params.push(uid);
  const p = `$${params.length}`;
  return `EXISTS (SELECT 1 FROM projects op WHERE op.project_id = ${table}.${column}
    AND op.owner_user_id = ${p})`;
}

/**
 * The fragment for "this record belongs to the token's user", given the
 * owner column on whichever alias the caller is selecting from.
 *
 * Exported here rather than in lib/mcp/data.js so that every answer to
 * "whose record is this?" on the MCP surface is stated in one file.
 */
export function ownerColumnSql(scope, ownerColumn, params) {
  if (isAdmin(scope)) return 'TRUE';
  const uid = ownerId(scope);
  if (uid === null) return NOTHING;
  params.push(uid);
  return `${ownerColumn} = $${params.length}`;
}

/** The same question asked of a company: does the token own anything under it? */
export function ownerCompanySql(scope, companyColumn, params) {
  if (isAdmin(scope)) return 'TRUE';
  const uid = ownerId(scope);
  if (uid === null) return NOTHING;
  params.push(uid);
  const p = `$${params.length}`;
  return `(EXISTS (SELECT 1 FROM quotations oq WHERE oq.company_id = ${companyColumn} AND oq.owner_user_id = ${p})
        OR EXISTS (SELECT 1 FROM enquiries oe WHERE oe.company_id = ${companyColumn} AND oe.owner_user_id = ${p})
        OR EXISTS (SELECT 1 FROM projects op WHERE op.company_id = ${companyColumn} AND op.owner_user_id = ${p}))`;
}
