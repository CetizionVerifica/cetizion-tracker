/**
 * The timeline of one record (#22): notes, tasks, files, emails and the
 * record's own milestones, newest first, merged from where they already live.
 *
 *   GET /api/timeline?entity=quotation&id=CTZ/QT/2026/012[&kind=note,task,email,file,event]
 *   GET /api/tasks/summary                       counts for the sidebar and the Tasks page
 */
import { Router } from 'express';
import { query } from '../db.js';
import { ApiError } from '../middleware/error.js';

export const timelineRouter = Router();
export const taskSummaryRouter = Router();

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
  const kinds = req.query.kind ? new Set(String(req.query.kind).split(',')) : null;
  const wants = (k) => !kinds || kinds.has(k);
  // Emails are logged against a company or a quotation; a company's timeline shows both.
  const emailWhere = entity === 'company'
    ? `(entity = 'company' AND entity_id = $1) OR (entity = 'quotation' AND entity_id IN (SELECT quotation_no FROM quotations WHERE company_id = $1::int))`
    : `entity = $2 AND entity_id = $1`;
  const [notes, tasks, files, emails, events] = await Promise.all([
    wants('note') ? query('SELECT id, body, author, pinned, created_at, updated_at FROM notes WHERE entity = $2 AND entity_id = $1', [id, entity]) : { rows: [] },
    wants('task') ? query('SELECT * FROM tasks WHERE entity = $2 AND entity_id = $1', [id, entity]) : { rows: [] },
    wants('file') ? query('SELECT a.id, a.label, a.uploaded_by, a.created_at, d.id AS document_id, d.file_name, d.size_bytes, d.content_type FROM attachments a JOIN documents d ON d.id = a.document_id WHERE a.entity = $2 AND a.entity_id = $1', [id, entity]) : { rows: [] },
    wants('email') ? query(`SELECT id, to_email, subject, template, status, reason, sent_by, created_at FROM email_log WHERE ${emailWhere}`, entity === 'company' ? [id] : [id, entity]) : { rows: [] },
    wants('event') ? recordEvents(entity, id) : [],
  ]);
  const items = [
    ...notes.rows.map((n) => ({ kind: 'note', at: n.created_at, id: n.id, title: n.pinned ? 'Pinned note' : 'Note', detail: n.body, by: n.author, pinned: n.pinned, record: n })),
    ...tasks.rows.map((t) => ({ kind: 'task', at: t.completed_at || t.created_at, id: t.id, title: `${t.status === 'done' ? 'Done: ' : ''}${t.title}`, detail: [t.type.replace('_', ' '), t.due_at ? `due ${t.due_at}` : null, t.assignee ? `for ${t.assignee}` : null].filter(Boolean).join(' · '), by: t.created_by, record: t })),
    ...files.rows.map((f) => ({ kind: 'file', at: f.created_at, id: f.id, title: f.label || f.file_name, detail: `${f.file_name} · ${Math.round(f.size_bytes / 1024)} KB`, by: f.uploaded_by, document_id: f.document_id, record: f })),
    ...emails.rows.map((e) => ({ kind: 'email', at: e.created_at, id: e.id, title: e.subject, detail: `to ${e.to_email} · ${e.status}${e.reason ? ` (${e.reason})` : ''}`, by: e.sent_by, record: e })),
    ...events,
  ].sort((a, b) => new Date(b.at) - new Date(a.at));
  res.json({ data: items, open_tasks: tasks.rows.filter((t) => t.status !== 'done').length });
});

taskSummaryRouter.get('/summary', async (req, res) => {
  const { rows: [r] } = await query(
    `SELECT COUNT(*) FILTER (WHERE status <> 'done')::int AS open,
            COUNT(*) FILTER (WHERE status <> 'done' AND due_at < CURRENT_DATE)::int AS overdue,
            COUNT(*) FILTER (WHERE status <> 'done' AND due_at = CURRENT_DATE)::int AS today,
            COUNT(*) FILTER (WHERE status <> 'done' AND due_at > CURRENT_DATE AND due_at <= CURRENT_DATE + 7)::int AS this_week
       FROM tasks`);
  res.json({ data: r });
});
