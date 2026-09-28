/**
 * The timeline of one record (#22): notes, tasks, files, emails and the
 * record's own milestones, newest first, merged from where they already live.
 *
 *   GET /api/timeline?entity=quotation&id=CTZ/QT/2026/012[&kind=note,task,email,file,event]
 *   GET /api/tasks/summary                       counts for the sidebar and the Tasks page
 */
import { Router } from 'express';
import { assertRecordReachable, parentClause, scopeOf } from '../auth/ownership.js';
import { query } from '../db.js';
import { ApiError } from '../middleware/error.js';

export const timelineRouter = Router();
export const taskSummaryRouter = Router();

const TOUCH = { call: 'Call', whatsapp: 'WhatsApp', meeting: 'Meeting', sms: 'SMS', email: 'Email', other: 'Contact' };
const ENTITIES = new Set(['company', 'contact', 'enquiry', 'quotation', 'project', 'purchase_order', 'payment_stage']);

/** The record's own dated milestones, as timeline events. */
async function recordEvents(entity, id) {
  const events = [];
  const push = (at, title, detail = null) => at && events.push({ kind: 'event', at, title, detail });
  if (entity === 'quotation') {
    const { rows: [q] } = await query('SELECT * FROM v_quotations WHERE quotation_no = $1', [id]);
    if (!q) return events;
    push(q.created_at, `Quotation ${q.quotation_no} created`, q.sales_person ? `by ${q.sales_person}` : null);
    push(q.sent_at, 'Sent to the client');
    push(q.accepted_at, 'Accepted by the client', q.accepted_by_name);
    push(q.approval_requested_at, 'Sent for approval', q.approval_reason || (q.discount_percent ? `${Number(q.discount_percent)}% discount` : null));
    push(q.approval_decided_at, `Discount ${q.approval_status}`, q.approval_note);
    push(q.closed_at, q.status === 'Lost' ? `Lost${q.lost_reason ? `: ${q.lost_reason}` : ''}` : `Won${q.project_id ? ` · project ${q.project_id}` : ''}`, q.lost_notes);
    const { rows: revs } = await query('SELECT revision, note, created_by, created_at FROM quotation_revisions WHERE quotation_id = $1', [q.id]);
    for (const r of revs) push(r.created_at, `Revision ${r.revision + 1}`, r.note || (r.created_by ? `by ${r.created_by}` : null));
    const { rows: links } = await query('SELECT * FROM quotation_acceptances WHERE quotation_id = $1', [q.id]);
    for (const l of links) {
      push(l.created_at, 'Acceptance link sent', [l.sent_to, `revision ${l.revision}`, l.created_by ? `by ${l.created_by}` : null].filter(Boolean).join(' · '));
      push(l.viewed_at, 'Client opened the acceptance link', l.view_count > 1 ? `${l.view_count} views` : null);
      if (l.status === 'accepted') push(l.decided_at, `Accepted online by ${l.decided_by_name}`, [l.decided_by_email, l.ip ? `from ${l.ip}` : null, l.pdf_sha256 ? `PDF ${l.pdf_sha256.slice(0, 12)}` : null].filter(Boolean).join(' · '));
      if (l.status === 'changes_requested') push(l.decided_at, `${l.decided_by_name} asked for changes`, l.comments);
    }
    const { rows: pos } = await query('SELECT po_number, po_date, po_value, currency, created_at FROM purchase_orders WHERE quotation_no = $1', [id]);
    for (const p of pos) push(p.created_at, `PO ${p.po_number} registered`, `${p.currency} ${p.po_value}`);
  } else if (entity === 'enquiry') {
    const { rows: [e] } = await query('SELECT * FROM enquiries WHERE enquiry_no = $1', [id]);
    if (!e) return events;
    push(e.created_at, `Enquiry ${e.enquiry_no} logged`, e.sales_person ? `owner ${e.sales_person}` : null);
    push(e.first_responded_at, 'First contact made');
    push(e.converted_at, `Converted${e.quotation_no ? ` to ${e.quotation_no}` : ''}`);
  } else if (entity === 'project') {
    const { rows: [p] } = await query('SELECT * FROM v_projects WHERE project_id = $1', [id]);
    if (!p) return events;
    push(p.created_at, `Project ${p.project_id} registered`);
    push(p.actual_delivery_date, 'Delivered');
    const { rows: pos } = await query('SELECT po_number, po_date, po_value, currency, created_at FROM purchase_orders WHERE project_id = $1', [id]);
    for (const po of pos) push(po.created_at, `PO ${po.po_number} registered`, `${po.currency} ${po.po_value}`);
    const { rows: steps } = await query('SELECT step, completed_date FROM onboarding_tasks WHERE project_id = $1 AND completed_date IS NOT NULL', [id]);
    for (const s of steps) push(s.completed_date, `Checklist: ${s.step}`);
    const { rows: vis } = await query('SELECT title, type, status, starts_at, completed_at, created_at FROM visits WHERE project_id = $1', [id]);
    for (const v of vis) push(v.status === 'done' ? v.completed_at : v.created_at, v.status === 'done' ? `Visit done: ${v.title}` : `Visit ${v.status}: ${v.title}`, `${v.type.replace('_', ' ')} on ${new Date(v.starts_at).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}`);
    const { rows: dels } = await query('SELECT type, reference, title, issued_on, created_at, status, valid_until FROM deliverables WHERE project_id = $1', [id]);
    for (const d of dels) push(d.issued_on || d.created_at, `${d.type.replace('_', ' ')} ${d.reference || d.title} ${d.status === 'draft' ? 'drafted' : 'issued'}`, [d.title, d.valid_until ? `valid until ${d.valid_until}` : null, d.status !== 'issued' ? d.status : null].filter(Boolean).join(' · '));
  } else if (entity === 'purchase_order') {
    const { rows: [po] } = await query('SELECT * FROM v_purchase_orders WHERE po_number = $1', [id]);
    if (!po) return events;
    push(po.created_at, `PO ${po.po_number} registered`, `${po.currency} ${po.po_value}`);
    push(po.actual_initiation_date, 'Work started');
    push(po.actual_delivery_date, 'Delivered');
    const { rows: stages } = await query('SELECT stage_name, invoice_no, invoice_date, amount_received, payment_received_date, reminder_sent_on FROM payment_stages WHERE po_number = $1 ORDER BY stage_no', [id]);
    for (const s of stages) {
      push(s.invoice_date, `Invoice ${s.invoice_no} raised`, s.stage_name);
      if (Number(s.amount_received) > 0) push(s.payment_received_date, `Payment received on ${s.stage_name}`, String(s.amount_received));
      push(s.reminder_sent_on, `Reminder sent for ${s.stage_name}`);
    }
  } else if (entity === 'company') {
    const { rows: [c] } = await query('SELECT * FROM companies WHERE id = $1', [Number(id)]);
    if (!c) return events;
    push(c.created_at, `${c.name} added`);
    const { rows: qs } = await query('SELECT quotation_no, quotation_date, status, created_at FROM quotations WHERE company_id = $1', [c.id]);
    for (const q of qs) push(q.created_at, `Quotation ${q.quotation_no}`, q.status);
    const { rows: es } = await query('SELECT enquiry_no, created_at, status FROM enquiries WHERE company_id = $1', [c.id]);
    for (const e of es) push(e.created_at, `Enquiry ${e.enquiry_no}`, e.status);
    const { rows: ps } = await query('SELECT project_id, created_at FROM projects WHERE company_id = $1', [c.id]);
    for (const p of ps) push(p.created_at, `Project ${p.project_id}`);
  }
  return events;
}

timelineRouter.get('/', async (req, res) => {
  const entity = String(req.query.entity || '');
  const id = String(req.query.id || '');
  if (!ENTITIES.has(entity) || !id) throw new ApiError(422, 'entity and id are required');
  // One gate, in front of everything below (#18 Phase 2C).
  //
  // This endpoint is a composite: seven reads about one record — its notes,
  // tasks, files, emails, mail threads, touches and its own milestones. Put
  // the ownership rule on each of them and it is seven chances to miss one,
  // and the miss is silent. Put it on the record instead and the whole
  // response follows: a quotation this caller may not open has no timeline,
  // and the answer is the same 404 a quotation that does not exist gets.
  //
  // Without this, /api/timeline?entity=quotation&id=<anyone's number> was
  // the way around every other predicate in Phase 2C.
  await assertRecordReachable(scopeOf(req), entity, id);
  const kinds = req.query.kind ? new Set(String(req.query.kind).split(',')) : null;
  const wants = (k) => !kinds || kinds.has(k);
  // Emails are logged against a company or a quotation; a company's timeline shows both.
  const emailWhere = entity === 'company'
    ? `(entity = 'company' AND entity_id = $1) OR (entity = 'quotation' AND entity_id IN (SELECT quotation_no FROM quotations WHERE company_id = $1::int))`
    : `entity = $2 AND entity_id = $1`;
  const [notes, tasks, files, emails, events, threads, touches] = await Promise.all([
    wants('note') ? query('SELECT id, body, author, pinned, created_at, updated_at FROM notes WHERE entity = $2 AND entity_id = $1', [id, entity]) : { rows: [] },
    wants('task') ? query('SELECT * FROM tasks WHERE entity = $2 AND entity_id = $1', [id, entity]) : { rows: [] },
    wants('file') ? query('SELECT a.id, a.label, a.uploaded_by, a.created_at, d.id AS document_id, d.file_name, d.size_bytes, d.content_type FROM attachments a JOIN documents d ON d.id = a.document_id WHERE a.entity = $2 AND a.entity_id = $1', [id, entity]) : { rows: [] },
    wants('email') ? query(`SELECT id, to_email, subject, template, status, reason, sent_by, created_at FROM email_log WHERE ${emailWhere}`, entity === 'company' ? [id] : [id, entity]) : { rows: [] },
    wants('event') ? recordEvents(entity, id) : [],
    wants('email') ? query(`SELECT t.id AS thread_id, t.subject, t.message_count, t.last_message_at, t.last_direction, a.email AS mailbox, a.visibility, ct.name AS contact_name FROM email_threads t JOIN connected_accounts a ON a.id = t.account_id LEFT JOIN contacts ct ON ct.id = t.contact_id WHERE ($2 = 'company' AND t.company_id::text = $1) OR (t.entity = $2 AND t.entity_id = $1)`, [id, entity]) : { rows: [] },
    wants('touch') ? query(`SELECT cm.*, ct.name AS contact_name FROM communications cm LEFT JOIN contacts ct ON ct.id = cm.contact_id WHERE (cm.entity = $2 AND cm.entity_id = $1) OR ($2 = 'company' AND cm.company_id::text = $1)`, [id, entity]) : { rows: [] },
  ]);
  const items = [
    ...notes.rows.map((n) => ({ kind: 'note', at: n.created_at, id: n.id, title: n.pinned ? 'Pinned note' : 'Note', detail: n.body, by: n.author, pinned: n.pinned, record: n })),
    ...tasks.rows.map((t) => ({ kind: 'task', at: t.completed_at || t.created_at, id: t.id, title: `${t.status === 'done' ? 'Done: ' : ''}${t.title}`, detail: [t.type.replace('_', ' '), t.due_at ? `due ${t.due_at}` : null, t.assignee ? `for ${t.assignee}` : null].filter(Boolean).join(' · '), by: t.created_by, record: t })),
    ...files.rows.map((f) => ({ kind: 'file', at: f.created_at, id: f.id, title: f.label || f.file_name, detail: `${f.file_name} · ${Math.round(f.size_bytes / 1024)} KB`, by: f.uploaded_by, document_id: f.document_id, record: f })),
    ...emails.rows.map((e) => ({ kind: 'email', at: e.created_at, id: e.id, title: e.subject, detail: `to ${e.to_email} · ${e.status}${e.reason ? ` (${e.reason})` : ''}`, by: e.sent_by, record: e })),
    ...threads.rows.map((t) => ({ kind: 'email', at: t.last_message_at, id: `thread-${t.thread_id}`, thread_id: t.thread_id, title: t.visibility === 'metadata' ? `Email thread (${t.message_count})` : `${t.subject || '(no subject)'}${t.message_count > 1 ? ` (${t.message_count})` : ''}`, detail: `${t.last_direction === 'inbound' ? 'from' : 'to'} ${t.contact_name || 'the client'} · ${t.mailbox}`, by: null, record: t })),
    ...touches.rows.map((c) => ({ kind: 'touch', at: c.started_at, id: c.id, title: `${TOUCH[c.channel] || c.channel}${c.direction === 'inbound' ? ' from' : ' with'} ${c.contact_name || 'the client'}${c.outcome ? ` · ${c.outcome.replace('_', ' ')}` : ''}`, detail: [c.summary, c.duration_seconds ? `${Math.round(c.duration_seconds / 60)} min` : null, c.attendees ? `with ${c.attendees}` : null].filter(Boolean).join(' · '), by: c.username, record: c })),
    ...events,
  ].sort((a, b) => new Date(b.at) - new Date(a.at));
  res.json({ data: items, open_tasks: tasks.rows.filter((t) => t.status !== 'done').length });
});

/**
 * The counts behind the sidebar badge. Narrowed by exactly the rule
 * /api/tasks is narrowed by (#18 Phase 2C), because the badge and the list
 * it opens have to agree: a "3" over a page showing one task is a bug
 * report, and the number would otherwise be counting records the reader
 * cannot open.
 *
 * "Tasks on records I can reach" is what this counts. "Tasks assigned to
 * me" is a different question — tasks carry a free-text assignee, not a
 * user — and answering it would be a new rule, so it is not answered here.
 */
taskSummaryRouter.get('/summary', async (req, res) => {
  const params = [];
  const mine = parentClause(scopeOf(req), params, { kind: 'entity', alias: 't' });
  const { rows: [r] } = await query(
    `SELECT COUNT(*) FILTER (WHERE status <> 'done')::int AS open,
            COUNT(*) FILTER (WHERE status <> 'done' AND due_at < CURRENT_DATE)::int AS overdue,
            COUNT(*) FILTER (WHERE status <> 'done' AND due_at = CURRENT_DATE)::int AS today,
            COUNT(*) FILTER (WHERE status <> 'done' AND due_at > CURRENT_DATE AND due_at <= CURRENT_DATE + 7)::int AS this_week
       FROM tasks t ${mine ? `WHERE ${mine}` : ''}`, params);
  res.json({ data: r });
});
