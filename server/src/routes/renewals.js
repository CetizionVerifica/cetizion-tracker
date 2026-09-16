/**
 * Renewals (#28):
 *
 *   GET  /api/renewals                    engagements with their company, quotations and days to due
 *   POST /api/renewals/discover           find newly delivered renewable work now
 *   POST /api/renewals/:id/open           open the renewal quotation now
 *   POST /api/renewals/:id/cancel         { reason } stop tracking this one
 *   POST /api/renewals/manual             { client_name, service_name, valid_until, owner?, notes? } an engagement the tracker never saw delivered
 */
import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { ApiError } from '../middleware/error.js';
import { discoverEngagements, openRenewal } from '../lib/renewals.js';

export const renewalsRouter = Router();

renewalsRouter.get('/', async (req, res) => {
  const params = []; const where = [];
  if (req.query.status) { params.push(String(req.query.status).split(',')); where.push(`e.status = ANY($${params.length})`); }
  if (req.query.company_id) { params.push(Number(req.query.company_id)); where.push(`e.company_id = $${params.length}`); }
  const { rows } = await query(`
    SELECT e.*, c.name AS company_name, sv.renewal_lead_days, sv.renewal_interval_months,
           oq.quotation_no AS original_quotation_no, rq.quotation_no AS renewal_quotation_no, rq.status AS renewal_status,
           rq.quotation_value AS renewal_value, rq.currency AS renewal_currency,
           (e.next_due_on - CURRENT_DATE)::int AS days_to_due
      FROM engagements e
      LEFT JOIN companies c ON c.id = e.company_id
      LEFT JOIN services sv ON sv.id = e.service_id
      LEFT JOIN quotations oq ON oq.id = e.quotation_id
      LEFT JOIN quotations rq ON rq.id = e.renewal_quotation_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY CASE e.status WHEN 'renewal_open' THEN 0 WHEN 'active' THEN 1 ELSE 2 END, e.next_due_on`, params);
  const { rows: [t] } = await query(`
    SELECT COUNT(*) FILTER (WHERE status = 'active')::int AS active,
           COUNT(*) FILTER (WHERE status = 'renewal_open')::int AS open,
           COUNT(*) FILTER (WHERE status = 'active' AND next_due_on <= CURRENT_DATE + 30)::int AS due_30,
           COUNT(*) FILTER (WHERE status = 'active' AND next_due_on <= CURRENT_DATE + 90)::int AS due_90,
           COUNT(*) FILTER (WHERE status = 'renewed')::int AS renewed,
           COUNT(*) FILTER (WHERE status = 'lapsed')::int AS lapsed
      FROM engagements`);
  res.json({ data: rows, totals: t });
});

renewalsRouter.post('/discover', async (req, res) => {
  res.json({ data: await discoverEngagements() });
});

renewalsRouter.post('/:id/open', async (req, res) => {
  try {
    res.status(201).json({ data: await openRenewal(Number(req.params.id), { by: req.user?.username || 'admin' }) });
  } catch (err) {
    throw new ApiError(422, err.message);
  }
});

renewalsRouter.post('/:id/cancel', async (req, res) => {
  const reason = String(req.body?.reason || '').trim();
  const { rows } = await query(`UPDATE engagements SET status = 'cancelled', notes = COALESCE(notes || E'\\n', '') || $2 WHERE id = $1 AND status IN ('active', 'renewal_open') RETURNING id, status`, [Number(req.params.id), reason ? `Cancelled: ${reason}` : 'Cancelled']);
  if (!rows.length) throw new ApiError(404, 'No open engagement with that id');
  res.json({ data: rows[0] });
});

const manualSchema = z.object({
  client_name: z.string().trim().min(1, 'Client is required').max(160),
  service_name: z.string().trim().min(1, 'Service is required').max(300),
  valid_until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
  owner: z.string().trim().max(120).optional().nullable(),
  notes: z.string().trim().max(2000).optional().nullable(),
});

renewalsRouter.post('/manual', async (req, res) => {
  const parsed = manualSchema.safeParse(req.body || {});
  if (!parsed.success) throw new ApiError(422, 'Please check the highlighted fields', { fields: Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.'), i.message])) });
  const b = parsed.data;
  const { rows: [row] } = await query(
    `INSERT INTO engagements (company_id, client_name, service_id, service_name, cycle, valid_until, next_due_on, owner, notes)
     VALUES (company_for($1), $1, (SELECT id FROM services WHERE name_key(name) = name_key($2) LIMIT 1), $2,
             (SELECT COUNT(*)::int + 1 FROM engagements WHERE company_id = company_for($1) AND name_key(service_name) = name_key($2)),
             $3, $3, $4, $5) RETURNING *`,
    [b.client_name, b.service_name, b.valid_until, b.owner ?? null, b.notes ?? null]);
  res.status(201).json({ data: row });
});
