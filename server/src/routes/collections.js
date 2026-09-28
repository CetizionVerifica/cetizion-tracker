/**
 * Collections (#27): who owes what, for how long, and what was done about it.
 *
 *   GET  /api/collections                      ageing per client, with each open invoiced stage
 *   GET  /api/collections/log?stage_id=|company_id=   the chasing log
 *   POST /api/collections/log                  { stage_id?, company_id?, channel, summary, promise_to_pay_date?, next_action_on?, happened_at? }
 *   POST /api/collections/stages/:id/hold      { on_hold, hold_reason? }   a dispute pauses reminders
 *   GET  /api/collections/stages/:id/payments  the receipts on a stage
 */
import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../auth/middleware.js';
import { query } from '../db.js';
import { ApiError } from '../middleware/error.js';

export const collectionsRouter = Router();

// Money that is not late yet used to land in the same bucket as money a
// month late, because days_overdue is negative before the due date and the
// lookup floored it. It is a different conversation, so it gets its own band.
const BUCKETS = [
  { key: 'not-due', label: 'Not yet due', lo: -1e6, hi: 0 },
  { key: '1-30', label: '1–30 days', lo: 1, hi: 30 },
  { key: '31-60', label: '31–60 days', lo: 31, hi: 60 },
  { key: '61-90', label: '61–90 days', lo: 61, hi: 90 },
  { key: '90+', label: 'Over 90 days', lo: 91, hi: 1e6 },
];
const bucketOf = (days) => (BUCKETS.find((b) => days >= b.lo && days <= b.hi) || BUCKETS[0]).key;
const emptyBuckets = () => Object.fromEntries(BUCKETS.map((b) => [b.key, 0]));

collectionsRouter.get('/', async (req, res) => {
  const { rows } = await query(`
    SELECT ps.*, pr.company_id, COALESCE(c.name, ps.client_name) AS company_name,
           ct.name AS contact_name, ct.email AS contact_email, ct.phone AS contact_phone,
           ROUND(ps.stage_amount - ps.amount_received, 2) AS outstanding,
           lg.happened_at AS last_chased_at, lg.channel AS last_channel, lg.summary AS last_summary, lg.next_action_on
      FROM v_payment_stages ps
      JOIN projects pr ON pr.project_id = ps.project_id
      LEFT JOIN companies c ON c.id = pr.company_id
      LEFT JOIN LATERAL (SELECT name, email, phone FROM contacts WHERE company_id = pr.company_id ORDER BY is_billing DESC, id LIMIT 1) ct ON true
      LEFT JOIN LATERAL (SELECT happened_at, channel, summary, next_action_on FROM collection_log WHERE stage_id = ps.id ORDER BY happened_at DESC LIMIT 1) lg ON true
     WHERE ps.invoice_no IS NOT NULL AND ps.stage_status IN ('Due', 'Overdue', 'Partially Paid')
     ORDER BY ps.days_overdue DESC, ps.invoice_due_date`);
  const clients = new Map();
  const totals = { outstanding: 0, overdue: 0, buckets: emptyBuckets(), on_hold: 0, promised: 0 };
  // Debt in another currency is not converted here — there is no rate on a
  // collections screen and inventing one would be worse — but it is not
  // silently dropped either. It is listed, unconverted, the way Cashflow
  // does it, so a figure that excludes it says so.
  const foreign = [];
  for (const s of rows) {
    const key = s.company_id ?? s.client_name;
    if (!clients.has(key)) clients.set(key, { company_id: s.company_id, company: s.company_name, contact_name: s.contact_name, contact_email: s.contact_email, contact_phone: s.contact_phone, outstanding: 0, overdue: 0, oldest_days: 0, buckets: emptyBuckets(), stages: [], last_chased_at: null, promise_to_pay_date: null });
    const cl = clients.get(key);
    const out = Number(s.outstanding);
    const days = Number(s.days_overdue || 0);
    const inr = s.currency === 'INR';
    const bucket = bucketOf(days);
    cl.stages.push({ ...s, bucket });
    if (inr) { cl.outstanding += out; totals.outstanding += out; if (days > 0) { cl.overdue += out; totals.overdue += out; } cl.buckets[bucket] += out; totals.buckets[bucket] += out; }
    else foreign.push({ ref: `${s.po_number} · ${s.stage_name}`, invoice_no: s.invoice_no, client: s.company_name || s.client_name, currency: s.currency, amount: out, days_overdue: days });
    cl.oldest_days = Math.max(cl.oldest_days, days);
    if (s.last_chased_at && (!cl.last_chased_at || s.last_chased_at > cl.last_chased_at)) cl.last_chased_at = s.last_chased_at;
    if (s.promise_to_pay_date && (!cl.promise_to_pay_date || s.promise_to_pay_date > cl.promise_to_pay_date)) cl.promise_to_pay_date = s.promise_to_pay_date;
    if (s.on_hold) totals.on_hold += inr ? out : 0;
    if (s.promise_to_pay_date) totals.promised += inr ? out : 0;
  }
  const list = [...clients.values()].sort((a, b) => b.overdue - a.overdue || b.outstanding - a.outstanding);
  res.json({ data: { totals, clients: list, buckets: BUCKETS.map(({ key, label }) => ({ key, label })), foreign } });
});

collectionsRouter.get('/log', async (req, res) => {
  const params = []; const where = [];
  if (req.query.stage_id) { params.push(Number(req.query.stage_id)); where.push(`l.stage_id = $${params.length}`); }
  if (req.query.company_id) { params.push(Number(req.query.company_id)); where.push(`l.company_id = $${params.length}`); }
  const { rows } = await query(
    `SELECT l.*, ps.po_number, ps.stage_name, ps.invoice_no, c.name AS company_name
       FROM collection_log l LEFT JOIN payment_stages ps ON ps.id = l.stage_id LEFT JOIN companies c ON c.id = l.company_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY l.happened_at DESC LIMIT 500`, params);
  res.json({ data: rows });
});

const blank = (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const dateStr = z.preprocess(blank, z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').optional().nullable());
const logSchema = z.object({
  stage_id: z.preprocess(blank, z.coerce.number().int().positive().optional().nullable()),
  company_id: z.preprocess(blank, z.coerce.number().int().positive().optional().nullable()),
  channel: z.enum(['email', 'call', 'whatsapp', 'meeting', 'note']).default('call'),
  summary: z.string().trim().min(1, 'Say what happened').max(2000),
  promise_to_pay_date: dateStr,
  next_action_on: dateStr,
  happened_at: z.preprocess(blank, z.string().optional().nullable()),
});

collectionsRouter.post('/log', async (req, res) => {
  const parsed = logSchema.safeParse(req.body || {});
  if (!parsed.success) throw new ApiError(422, 'Please check the highlighted fields', { fields: Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.'), i.message])) });
  const b = parsed.data;
  if (!b.stage_id && !b.company_id) throw new ApiError(422, 'A chase is about a stage or a client');
  let companyId = b.company_id ?? null;
  if (b.stage_id && !companyId) {
    const { rows: [r] } = await query('SELECT pr.company_id FROM payment_stages ps JOIN purchase_orders po ON po.po_number = ps.po_number JOIN projects pr ON pr.project_id = po.project_id WHERE ps.id = $1', [b.stage_id]);
    companyId = r?.company_id ?? null;
  }
  const { rows: [row] } = await query(
    `INSERT INTO collection_log (stage_id, company_id, channel, by_whom, summary, promise_to_pay_date, next_action_on, happened_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, COALESCE($8::timestamptz, now())) RETURNING *`,
    [b.stage_id ?? null, companyId, b.channel, req.user?.username || 'admin', b.summary, b.promise_to_pay_date ?? null, b.next_action_on ?? null, b.happened_at ?? null]);
  // A promise recorded on a stage pauses its reminders until that date.
  if (b.stage_id && b.promise_to_pay_date) await query('UPDATE payment_stages SET promise_to_pay_date = $2 WHERE id = $1', [b.stage_id, b.promise_to_pay_date]);
  res.status(201).json({ data: row });
});

const holdSchema = z.object({ on_hold: z.boolean(), hold_reason: z.string().trim().max(500).optional().nullable() });

// Putting a debt on hold stops the chasing job, so it is the admin's
// call rather than something a salesperson does to their own client.
// Logging a chase stays open — that is the work itself.
collectionsRouter.post('/stages/:id/hold', requireAdmin, async (req, res) => {
  const parsed = holdSchema.safeParse(req.body || {});
  if (!parsed.success) throw new ApiError(422, 'on_hold must be true or false');
  const { rows } = await query('UPDATE payment_stages SET on_hold = $2, hold_reason = CASE WHEN $2 THEN $3 ELSE NULL END WHERE id = $1 RETURNING id, on_hold, hold_reason', [Number(req.params.id), parsed.data.on_hold, parsed.data.hold_reason ?? null]);
  if (!rows.length) throw new ApiError(404, 'Payment stage not found');
  await query(`INSERT INTO collection_log (stage_id, company_id, channel, by_whom, summary)
               SELECT ps.id, pr.company_id, 'note', $2, $3 FROM payment_stages ps JOIN purchase_orders po ON po.po_number = ps.po_number JOIN projects pr ON pr.project_id = po.project_id WHERE ps.id = $1`,
    [rows[0].id, req.user?.username || 'admin', parsed.data.on_hold ? `Put on hold${parsed.data.hold_reason ? `: ${parsed.data.hold_reason}` : ''}` : 'Hold lifted']);
  res.json({ data: rows[0] });
});

collectionsRouter.get('/stages/:id/payments', async (req, res) => {
  const { rows } = await query('SELECT * FROM payments WHERE stage_id = $1 ORDER BY received_on DESC, id DESC', [Number(req.params.id)]);
  res.json({ data: rows });
});
