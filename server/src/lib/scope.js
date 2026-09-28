/**
 * Who may see which record (#18 scoping, as #22 asks of the timeline and of
 * tasks, notes and files).
 *
 * An admin sees everything. A sales user sees a record whose sales person is
 * them — by the email they sign in with or the name on their account, the
 * same two identities the mail scoping (#94) matches on — and what hangs off
 * it: a PO through its project, a payment stage through its PO, a company
 * through any deal of theirs, a contact through that company. The rule is
 * applied in SQL, never by filtering rows afterwards.
 */
import { query } from '../db.js';
import { ApiError } from '../middleware/error.js';

export const isAdmin = (req) => !req?.user || req.user.role === 'admin';

/** The person's names, lowercased, for `= ANY($n)`. */
export const identities = (req) => [...new Set([req?.user?.username, req?.user?.name]
  .filter(Boolean).map((s) => String(s).trim().toLowerCase()))];

/**
 * SQL: may the person in placeholder `p` (a lowercased text[]) see the
 * record named by the two expressions? Qualify the expressions: they are
 * read inside subqueries.
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

/** May this request see the record? Always true for an admin. */
export async function canSeeRecord(req, entity, id, db = { query }) {
  if (isAdmin(req)) return true;
  const { rows } = await db.query(`SELECT ${recordVisibleSql('$1::text', '$2::text', '$3::text[]')} AS ok`,
    [entity, String(id), identities(req)]);
  return rows[0]?.ok === true;
}

/**
 * The visibility clause for a table of things hung on records (tasks,
 * notes, attachments): the record is visible, or the person's own name is in
 * one of `ownColumns` (the task is theirs to do, they wrote the note). Tasks
 * also count any other record they are on. Null for an admin.
 */
export function onRecordVisibleSql(req, table, params, { ownColumns = [], taskTargets = false } = {}) {
  if (isAdmin(req)) return null;
  params.push(identities(req));
  const p = `$${params.length}::text[]`;
  const clauses = [recordVisibleSql(`${table}.entity`, `${table}.entity_id`, p)];
  for (const col of ownColumns) clauses.push(`lower(btrim(${table}.${col})) = ANY(${p})`);
  if (taskTargets) {
    clauses.push(`EXISTS (SELECT 1 FROM task_targets tt WHERE tt.task_id = ${table}.id AND ${recordVisibleSql('tt.entity', 'tt.entity_id', p)})`);
  }
  return `(${clauses.join(' OR ')})`;
}

/**
 * Before a sales user hangs something on a record: they must be able to see
 * it, and every other record a task is put on. 404, not 403, so a record's
 * existence is not confirmed to someone who may not see it.
 */
export async function mayWriteOnRecords(req, input, db = { query }) {
  if (isAdmin(req)) return;
  const targets = [];
  if (input.entity && input.entity_id) targets.push([input.entity, input.entity_id]);
  for (const t of input.targets || []) targets.push([t.entity, t.entity_id]);
  for (const [entity, id] of targets) {
    if (!(await canSeeRecord(req, entity, id, db))) throw new ApiError(404, 'Record not found');
  }
}
