/**
 * Undo what one email entered (docs/email-auto-entry-plan.md §3.10): a PO
 * registered from a client's email, with its stages, its project and, when
 * the email made them, its quotation and enquiry; or an invoice recorded on
 * a stage from ours. Only while nothing has been recorded against it since:
 * no invoice on a stage, no payment, no reminder sent, no onboarding step
 * started, nothing else pointing at the project or the PO. Otherwise a
 * person unpicks it by hand, and Undo says why it cannot.
 *
 * What left the tracker cannot be called back: a webhook that fired, a
 * notification that was read. The email's decision becomes "undone", so
 * the reader never enters it again.
 */
import { ApiError } from '../../middleware/error.js';

/**
 * The tables pointing at `row` of `table` through a one-column foreign key,
 * other than `allowed` ("table.column"). The first one found, or null.
 * Read from the catalogue, so a table added later blocks Undo rather than
 * losing its rows.
 */
async function pointedAtBy(db, table, row, allowed = []) {
  const { rows: fks } = await db.query(
    `SELECT c.conrelid::regclass::text AS tbl, a.attname AS col, r.attname AS ref
       FROM pg_constraint c
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
       JOIN pg_attribute r ON r.attrelid = c.confrelid AND r.attnum = c.confkey[1]
      WHERE c.contype = 'f' AND c.confrelid = $1::regclass AND array_length(c.conkey, 1) = 1`, [table]);
  for (const { tbl, col, ref } of fks) {
    if (allowed.includes(`${tbl}.${col}`) || row[ref] === null || row[ref] === undefined) continue;
    if (!/^[a-z_][a-z0-9_]*$/.test(tbl) || !/^[a-z_][a-z0-9_]*$/.test(col)) return tbl;
    const { rows } = await db.query(`SELECT 1 FROM ${tbl} WHERE ${col} = $1 LIMIT 1`, [row[ref]]);
    if (rows.length) return tbl;
  }
  return null;
}

const WHAT = {
  payment_stages: 'a payment stage', travel_logs: 'a trip', onboarding_tasks: 'an onboarding step', purchase_orders: 'another PO',
  email_invoice_decisions: 'an invoice read from email', documents: 'a document', project_deliverables: 'a deliverable',
};
const named = (tbl) => WHAT[tbl] || tbl.replace(/_/g, ' ');

// ------------------------------------------------------------ a PO

/** The PO's automatic registration, if Undo may take it back: { decision, project } or { reason }. */
export async function poUndoable(db, poNumber) {
  const { rows: [d] } = await db.query(
    `SELECT d.* FROM email_po_decisions d WHERE d.po_number = $1 AND d.outcome = 'registered' ORDER BY d.decided_at LIMIT 1`, [poNumber]);
  if (!d) return { reason: 'It was not registered automatically from an email.' };
  if (!d.undo_state) return { reason: 'It was registered before Undo existed.' };
  const { rows: [po] } = await db.query('SELECT * FROM purchase_orders WHERE po_number = $1', [poNumber]);
  if (!po) return { reason: 'The PO is no longer in the tracker.' };
  const { rows: stages } = await db.query(
    `SELECT id FROM payment_stages WHERE po_number = $1 AND (invoice_no IS NOT NULL OR amount_received <> 0 OR payment_received_date IS NOT NULL OR reminder_sent_on IS NOT NULL)`, [poNumber]);
  if (stages.length) return { reason: 'A stage of it has an invoice, a payment or a reminder recorded.' };
  const { rows: [{ n: otherPos }] } = await db.query('SELECT count(*)::int AS n FROM purchase_orders WHERE project_id = $1 AND po_number <> $2', [po.project_id, poNumber]);
  if (otherPos) return { reason: 'Its project has another PO.' };
  const { rows: started } = await db.query(`SELECT 1 FROM onboarding_tasks WHERE project_id = $1 AND status <> 'Not Started' LIMIT 1`, [po.project_id]);
  if (started.length) return { reason: 'An onboarding step of its project has been started.' };

  const { rows: [project] } = await db.query('SELECT * FROM projects WHERE project_id = $1', [po.project_id]);
  const blockers = [
    await pointedAtBy(db, 'purchase_orders', po, ['po_services.po_number', 'payment_stages.po_number', 'email_po_decisions.po_number']),
    await pointedAtBy(db, 'projects', project || {}, ['purchase_orders.project_id', 'quotations.project_id', 'onboarding_tasks.project_id', 'project_milestones.project_id']),
  ];
  for (const s of (await db.query('SELECT * FROM payment_stages WHERE po_number = $1', [poNumber])).rows) blockers.push(await pointedAtBy(db, 'payment_stages', s));
  for (const t of (await db.query('SELECT * FROM onboarding_tasks WHERE project_id = $1', [po.project_id])).rows) blockers.push(await pointedAtBy(db, 'onboarding_tasks', t));
  for (const m of (await db.query('SELECT * FROM project_milestones WHERE project_id = $1', [po.project_id])).rows) blockers.push(await pointedAtBy(db, 'project_milestones', m, ['payment_stages.milestone_id']));
  const blocker = blockers.find(Boolean);
  if (blocker) return { reason: `Something has been recorded against it since: ${named(blocker)}.` };
  return { decision: d, po };
}

/**
 * Take the PO back out: its stages, services, onboarding steps, milestones
 * and project; the quotation back as it was (or, when the email made it,
 * the quotation and its enquiry removed, if nothing else uses them).
 * Inside the caller's transaction. Returns what was removed, for the reply.
 */
export async function undoPo(db, poNumber, by) {
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`undo-po:${poNumber}`]);
  const ok = await poUndoable(db, poNumber);
  if (!ok.decision) throw new ApiError(409, `This PO cannot be undone. ${ok.reason}`);
  const { decision: d, po } = ok;
  const state = d.undo_state;

  await db.query('DELETE FROM onboarding_tasks WHERE project_id = $1', [po.project_id]);
  await db.query('DELETE FROM payment_stages WHERE po_number = $1', [poNumber]);
  await db.query('DELETE FROM po_services WHERE po_number = $1', [poNumber]);
  await db.query('DELETE FROM purchase_orders WHERE po_number = $1', [poNumber]);
  await db.query('UPDATE quotations SET project_id = NULL WHERE project_id = $1', [po.project_id]);
  await db.query('DELETE FROM project_milestones WHERE project_id = $1', [po.project_id]);
  await db.query('DELETE FROM projects WHERE project_id = $1', [po.project_id]);

  const removed = { po_number: poNumber, project_id: po.project_id, quotation: null };
  if (state.created_quotation) {
    // Made from the PO: removed too, with the enquiry made with it, unless something else uses them.
    const { rows: [q] } = await db.query('SELECT * FROM quotations WHERE quotation_no = $1', [po.quotation_no]);
    const { rows: enquiries } = await db.query('SELECT * FROM enquiries WHERE quotation_no = $1', [po.quotation_no]);
    // The stage history and the email's own conversation came with them.
    let inUse = q ? await pointedAtBy(db, 'quotations', q, ['quotation_lines.quotation_id', 'quotation_stage_history.quotation_id', 'enquiries.quotation_no', 'email_po_decisions.quotation_no', 'email_enquiry_decisions.quotation_no']) : null;
    for (const en of enquiries) inUse ||= await pointedAtBy(db, 'enquiries', en, ['email_enquiry_decisions.enquiry_no', 'inbox_conversations.enquiry_no']);
    if (q && !inUse) {
      await db.query('DELETE FROM enquiries WHERE quotation_no = $1', [q.quotation_no]);
      await db.query('DELETE FROM quotation_lines WHERE quotation_id = $1', [q.id]);
      await db.query('DELETE FROM quotations WHERE id = $1', [q.id]);
      removed.quotation = 'removed';
    } else if (q) Object.assign(removed, { quotation: 'kept', kept_because: named(inUse) });
  } else if (state.quotation) {
    const b = state.quotation;
    await db.query(
      `UPDATE quotations SET status = $2, stage_id = $3, po_received = $4, project_id = $5, closed_at = $6 WHERE quotation_no = $1`,
      [po.quotation_no, b.status, b.stage_id, b.po_received, b.project_id, b.closed_at]);
    for (const e of state.enquiries || []) {
      await db.query('UPDATE enquiries SET status = $2, converted_at = $3 WHERE enquiry_no = $1', [e.enquiry_no, e.status, e.converted_at]);
    }
    removed.quotation = 'restored';
  }

  // The conversation goes back on the quotation, or on nothing.
  await db.query(
    `UPDATE email_threads SET entity = $2, entity_id = $3 WHERE entity = 'purchase_order' AND entity_id = $1`,
    [poNumber, removed.quotation === 'removed' ? null : 'quotation', removed.quotation === 'removed' ? null : po.quotation_no]);
  await db.query(
    `UPDATE email_po_decisions SET outcome = 'undone', decided_by = $2, settled_at = now(),
            review_note = 'Undone: the PO, its stages and project were removed.' WHERE id = $1`, [d.id, by]);
  return removed;
}

// ------------------------------------------------------------ an invoice

/** The stage's invoice, if it was recorded automatically from email and Undo may take it back. */
export async function invoiceUndoable(db, stageId) {
  const { rows: [d] } = await db.query(
    `SELECT d.* FROM email_invoice_decisions d WHERE d.stage_id = $1 AND d.outcome = 'recorded' ORDER BY d.decided_at DESC LIMIT 1`, [stageId]);
  if (!d) return { reason: 'It was not recorded automatically from an email.' };
  const { rows: [s] } = await db.query('SELECT * FROM payment_stages WHERE id = $1', [stageId]);
  if (!s || s.invoice_no !== d.invoice_no) return { reason: 'The stage has changed since.' };
  if (Number(s.amount_received) !== 0 || s.payment_received_date || s.reminder_sent_on) return { reason: 'A payment or a reminder has been recorded on it since.' };
  return { decision: d, stage: s };
}

/** The stage back to "to invoice": no number, no date, and the emailed PDF off it unless it was there before. */
export async function undoInvoice(db, stageId, by) {
  const ok = await invoiceUndoable(db, stageId);
  if (!ok.decision) throw new ApiError(409, `This invoice cannot be undone. ${ok.reason}`);
  const { decision: d } = ok;
  await db.query(
    `UPDATE payment_stages SET invoice_no = NULL, invoice_date = NULL, document_id = CASE WHEN $2 THEN document_id END WHERE id = $1`,
    [stageId, d.document_kept_existing]);
  await db.query(
    `UPDATE email_invoice_decisions SET outcome = 'undone', decided_by = $2, settled_at = now(),
            review_note = 'Undone: the invoice was taken off the stage.' WHERE id = $1`, [d.id, by]);
  return { stage_id: stageId, invoice_no: d.invoice_no };
}
