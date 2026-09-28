/**
 * One-click contact and the touch log (#31, phase 1: no providers).
 *
 *   GET  /api/communications/contacts?entity=&id=   who can be reached about a record, with links
 *   POST /api/communications                         log a touch; next_step creates a task
 *   GET  /api/communications?entity=&id=             touches on a record
 *   GET  /api/communications/no-contact?days=        open deals and overdue invoices gone quiet
 */
import { Router } from 'express';
import { z } from 'zod';
import { assertRecordReachable, scopeOf, scopedSources } from '../auth/ownership.js';
import { query, transaction } from '../db.js';
import { ApiError } from '../middleware/error.js';

export const communicationsRouter = Router();

const ENTITIES = ['company', 'contact', 'enquiry', 'quotation', 'project', 'purchase_order', 'payment_stage'];

/** The company (and, where the record names one, the contact) behind a record. */
export async function resolveParties(entity, id, db = { query }) {
  const one = async (sql) => (await db.query(sql, [String(id)])).rows[0] || {};
  switch (entity) {
    case 'company': return { company_id: Number(id) || null, contact_id: null };
    case 'contact': return one('SELECT company_id, id AS contact_id FROM contacts WHERE id::text = $1');
    case 'enquiry': return one('SELECT company_id, contact_id FROM enquiries WHERE enquiry_no = $1');
    case 'quotation': return one('SELECT company_id, contact_id FROM quotations WHERE quotation_no = $1');
    case 'project': return one('SELECT company_id, NULL::int AS contact_id FROM projects WHERE project_id = $1');
    case 'purchase_order': return one('SELECT p.company_id, q.contact_id FROM purchase_orders po JOIN projects p ON p.project_id = po.project_id LEFT JOIN quotations q ON q.quotation_no = po.quotation_no WHERE po.po_number = $1');
    case 'payment_stage': return one('SELECT p.company_id, q.contact_id FROM payment_stages s JOIN purchase_orders po ON po.po_number = s.po_number JOIN projects p ON p.project_id = po.project_id LEFT JOIN quotations q ON q.quotation_no = po.quotation_no WHERE s.id::text = $1');
    default: return {};
  }
}

/** Digits only, with India's 91 added to a bare 10-digit mobile. */
export function phoneDigits(raw) {
  const d = String(raw || '').replace(/\D/g, '').replace(/^0+/, '');
  if (!d) return null;
  return d.length === 10 ? `91${d}` : d;
}

communicationsRouter.get('/contacts', async (req, res) => {
  const entity = String(req.query.entity || ''); const id = String(req.query.id || '');
  if (!ENTITIES.includes(entity) || !id) throw new ApiError(422, 'entity and id are required');
  // Which record is being contacted about is the question ownership answers
  // (#18 Phase 2C). The contacts themselves are the company's and stay
  // shared; naming somebody else's quotation to find out who is behind it is
  // what this refuses.
  await assertRecordReachable(scopeOf(req), entity, id);
  const { company_id, contact_id } = await resolveParties(entity, id);
  if (!company_id) return res.json({ data: { company_id: null, contacts: [] } });
  const { rows } = await query(
    `SELECT id, name, role, email, phone, whatsapp_number, preferred_channel, best_time_to_call, do_not_contact,
            whatsapp_opt_in_at, is_billing, last_contacted_at
       FROM contacts WHERE company_id = $1
      ORDER BY (id = $2) DESC, is_billing DESC, name`, [company_id, contact_id || 0]);
  const contacts = rows.map((c) => {
    const phone = phoneDigits(c.phone);
    const wa = phoneDigits(c.whatsapp_number || c.phone);
    const blocked = c.do_not_contact ? 'Marked do not contact' : null;
    return {
      ...c,
      primary: c.id === contact_id,
      links: {
        email: !blocked && c.email ? `mailto:${c.email}` : null,
        call: !blocked && phone ? `tel:+${phone}` : null,
        whatsapp: !blocked && wa ? `https://wa.me/${wa}` : null,
      },
      blocked,
    };
  });
  res.json({ data: { company_id, contacts } });
});

const touchSchema = z.object({
  entity: z.enum(ENTITIES),
  entity_id: z.string().min(1).max(120),
  channel: z.enum(['call', 'whatsapp', 'meeting', 'sms', 'email', 'other']),
  direction: z.enum(['inbound', 'outbound']).default('outbound'),
  outcome: z.enum(['connected', 'no_answer', 'left_message', 'wrong_number', 'sent', 'held']).nullish(),
  contact_id: z.coerce.number().int().positive().nullish(),
  started_at: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/)).nullish(),
  duration_minutes: z.coerce.number().min(0).max(1440).nullish(),
  summary: z.string().max(4000).nullish(),
  attendees: z.string().max(500).nullish(),
  next_step: z.object({ title: z.string().min(1).max(300), due_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish() }).nullish(),
});

communicationsRouter.post('/', async (req, res) => {
  const parsed = touchSchema.safeParse(req.body || {});
  if (!parsed.success) throw new ApiError(422, 'Please check the highlighted fields', { fields: Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.'), i.message])) });
  const t = parsed.data;
  const who = req.user?.username || 'admin';
  // A touch is logged against a record, so it may only be logged against a
  // record this caller may reach (#18 Phase 2C).
  await assertRecordReachable(scopeOf(req), t.entity, t.entity_id);
  const parties = await resolveParties(t.entity, t.entity_id);
  if (!parties.company_id && t.entity !== 'company') throw new ApiError(404, `No ${t.entity.replace('_', ' ')} ${t.entity_id}`);
  const contactId = t.contact_id ?? parties.contact_id ?? null;
  if (contactId) {
    const { rows: [c] } = await query('SELECT company_id, do_not_contact FROM contacts WHERE id = $1', [contactId]);
    if (!c) throw new ApiError(422, 'Unknown contact');
    if (parties.company_id && c.company_id !== parties.company_id) throw new ApiError(422, 'That contact belongs to another company');
    if (c.do_not_contact && t.direction === 'outbound') throw new ApiError(409, 'This contact is marked do not contact');
  }
  const row = await transaction(async (db) => {
    let taskId = null;
    if (t.next_step) {
      const { rows: [task] } = await db.query(
        `INSERT INTO tasks (entity, entity_id, title, due_at, type, assignee, created_by) VALUES ($1,$2,$3,$4,$5,$6,$6) RETURNING id`,
        [t.entity, t.entity_id, t.next_step.title, t.next_step.due_at || null, t.channel === 'meeting' ? 'meeting' : t.channel === 'call' ? 'call' : 'follow_up', who]);
      taskId = task.id;
    }
    const { rows: [c] } = await db.query(
      `INSERT INTO communications (channel, direction, outcome, entity, entity_id, company_id, contact_id, username, started_at, duration_seconds, summary, attendees, next_step_task_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9::timestamptz, now()),$10,$11,$12,$13) RETURNING *`,
      [t.channel, t.direction, t.outcome || null, t.entity, t.entity_id, parties.company_id || null, contactId, who,
        t.started_at || null, t.duration_minutes == null ? null : Math.round(t.duration_minutes * 60), t.summary || null, t.attendees || null, taskId]);
    return c;
  });
  res.status(201).json({ data: row });
});

communicationsRouter.get('/', async (req, res) => {
  const entity = String(req.query.entity || ''); const id = String(req.query.id || '');
  if (!ENTITIES.includes(entity) || !id) throw new ApiError(422, 'entity and id are required');
  // What was said to a client about a deal is the deal's, so the same gate
  // the timeline uses applies here (#18 Phase 2C).
  await assertRecordReachable(scopeOf(req), entity, id);
  const { rows } = await query(
    `SELECT cm.*, ct.name AS contact_name FROM communications cm LEFT JOIN contacts ct ON ct.id = cm.contact_id
      WHERE (cm.entity = $1 AND cm.entity_id = $2) OR ($1 = 'company' AND cm.company_id::text = $2)
      ORDER BY cm.started_at DESC`, [entity, id]);
  res.json({ data: rows });
});

communicationsRouter.get('/no-contact', async (req, res) => {
  const { rows: [{ value }] } = await query(`SELECT COALESCE((SELECT value FROM settings WHERE key = 'no_contact_days'), '7') AS value`);
  const days = Math.max(1, Number(req.query.days) || Number(value) || 7);
  // A worklist, not a report: every row is a record with its reference on
  // it, to be chased. So it carries the same restriction the dashboard
  // worklist and the record lists carry (#18 Phase 2C) — a salesperson is
  // shown what to chase, not who else is behind. The relations are
  // substituted rather than the queries rewritten, so what counts as "gone
  // quiet" is unchanged. One params array per statement.
  const scope = scopeOf(req);
  const dealParams = [days]; const dealSrc = scopedSources(scope, dealParams);
  const enqParams = [days]; const enqSrc = scopedSources(scope, enqParams);
  const invParams = [days]; const invSrc = scopedSources(scope, invParams);
  const [deals, enquiries, invoices] = await Promise.all([
    query(`SELECT q.quotation_no AS ref, q.client_name, q.sales_person AS owner, q.status,
                  COALESCE(q.last_contacted_at, q.sent_at, q.quotation_date::timestamptz, q.created_at) AS last_touch
             FROM ${dealSrc.quotations} q JOIN pipeline_stages ps ON ps.id = q.stage_id
            WHERE ps.type = 'open'
              AND COALESCE(q.last_contacted_at, q.sent_at, q.quotation_date::timestamptz, q.created_at) < now() - make_interval(days => $1)
            ORDER BY last_touch`, dealParams),
    query(`SELECT e.enquiry_no AS ref, e.client_name, e.sales_person AS owner, e.status,
                  COALESCE(e.last_contacted_at, e.enquiry_date::timestamptz, e.created_at) AS last_touch
             FROM ${enqSrc.enquiries} e WHERE e.status IN ('New','Contacted','Qualified')
              AND COALESCE(e.last_contacted_at, e.enquiry_date::timestamptz, e.created_at) < now() - make_interval(days => $1)
            ORDER BY last_touch`, enqParams),
    query(`SELECT s.id AS ref, s.invoice_no, s.po_number, s.client_name, s.days_overdue, c.last_contacted_at AS last_touch
             FROM ${invSrc.vPaymentStages} s
             JOIN purchase_orders po ON po.po_number = s.po_number JOIN projects p ON p.project_id = po.project_id
             LEFT JOIN companies c ON c.id = p.company_id
            WHERE s.stage_status = 'Overdue'
              AND (c.last_contacted_at IS NULL OR c.last_contacted_at < now() - make_interval(days => $1))
            ORDER BY s.days_overdue DESC`, invParams),
  ]);
  res.json({ data: { days, quotations: deals.rows, enquiries: enquiries.rows, invoices: invoices.rows } });
});
