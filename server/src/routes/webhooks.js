/**
 * Webhooks (#49). Admin only (the single admin until #18).
 *
 *   GET    /api/webhooks                       endpoints with delivery counts, and the event types
 *   POST   /api/webhooks                       { name, url, events, min_value, sector, include_personal_data, when_inactive } → secret shown once
 *   PATCH  /api/webhooks/:id
 *   POST   /api/webhooks/:id/rotate-secret     → new secret shown once
 *   DELETE /api/webhooks/:id
 *   POST   /api/webhooks/:id/test              a signed test event, sent now
 *   GET    /api/webhooks/deliveries?endpoint_id=&status=
 *   POST   /api/webhooks/deliveries/:id/replay
 *   POST   /api/webhooks/run                   fan out and send what is due now
 * Public, signed, off unless switched on in Settings:
 *   POST   /api/hooks/enquiries                an enquiry from a website form or n8n
 */
import { Router } from 'express';
import { z } from 'zod';
import { query, transaction } from '../db.js';
import { config } from '../config.js';
import { ApiError } from '../middleware/error.js';
import { sentFields } from '../lib/sentFields.js';
import { claimNextId } from '../lib/sequences.js';
import { checkDestination, deliverOne, EVENT_TYPES, newSecret, releaseHeld, runWebhooks, verify } from '../lib/webhooks.js';

export const webhooksRouter = Router();
export const incomingHooksRouter = Router();

const fields = (parsed) => new ApiError(422, 'Please check the highlighted fields', { fields: Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.'), i.message])) });
const httpsOnly = (u) => {
  try { const x = new URL(u); return x.protocol === 'https:' || (config.nodeEnv !== 'production' && x.protocol === 'http:'); } catch { return false; }
};

const endpointSchema = z.object({
  name: z.string().trim().min(1).max(120),
  url: z.string().trim().url('A full URL').max(2000).refine(httpsOnly, 'The URL must start with https://'),
  events: z.array(z.enum(EVENT_TYPES)).min(1, 'Choose at least one event'),
  min_value: z.coerce.number().min(0).nullish(),
  sector: z.string().trim().max(120).nullish(),
  include_personal_data: z.boolean().default(false),
  active: z.boolean().default(true),
  when_inactive: z.enum(['queue', 'drop']).default('queue'),
});
const PUBLIC = 'id, name, url, events, min_value, sector, include_personal_data, active, when_inactive, created_by, created_at, updated_at';

webhooksRouter.get('/', async (req, res) => {
  const { rows } = await query(
    `SELECT ${PUBLIC.split(', ').map((c) => `w.${c}`).join(', ')},
            COUNT(d.*) FILTER (WHERE d.status = 'succeeded')::int AS succeeded,
            COUNT(d.*) FILTER (WHERE d.status = 'pending')::int AS pending,
            COUNT(d.*) FILTER (WHERE d.status = 'failed')::int AS failed,
            COUNT(d.*) FILTER (WHERE d.status = 'held')::int AS held,
            MAX(d.delivered_at) AS last_delivered_at
       FROM webhook_endpoints w LEFT JOIN webhook_deliveries d ON d.endpoint_id = w.id
      GROUP BY w.id ORDER BY w.name`);
  res.json({ data: rows, event_types: EVENT_TYPES });
});

webhooksRouter.post('/', async (req, res) => {
  const parsed = endpointSchema.safeParse(req.body || {});
  if (!parsed.success) throw fields(parsed);
  const v = parsed.data;
  // Say no at the point the address is typed, not silently at delivery.
  const refused = await checkDestination(v.url, { requireResolvable: false });
  if (refused) throw new ApiError(422, 'Please check the highlighted fields', { fields: { url: refused } });
  const secret = newSecret();
  const { rows: [w] } = await query(
    `INSERT INTO webhook_endpoints (name, url, events, secret, min_value, sector, include_personal_data, active, when_inactive, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${PUBLIC}`,
    [v.name, v.url, v.events, secret, v.min_value ?? null, v.sector || null, v.include_personal_data, v.active, v.when_inactive, req.user?.username || 'admin']);
  res.status(201).json({ data: { ...w, secret } });
});

webhooksRouter.patch('/:id', async (req, res) => {
  const parsed = endpointSchema.partial().safeParse(req.body || {});
  if (!parsed.success) throw fields(parsed);
  const set = Object.entries(sentFields(parsed.data, req.body)).filter(([, x]) => x !== undefined);
  if (!set.length) throw new ApiError(422, 'Nothing to change');
  if (parsed.data.url !== undefined) {
    const refused = await checkDestination(parsed.data.url, { requireResolvable: false });
    if (refused) throw new ApiError(422, 'Please check the highlighted fields', { fields: { url: refused } });
  }
  const id = Number(req.params.id);
  const { rows: [w] } = await query(`UPDATE webhook_endpoints SET ${set.map(([k], i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING ${PUBLIC}`, [id, ...set.map(([, x]) => x)]);
  if (!w) throw new ApiError(404, 'Endpoint not found');
  let released = 0;
  if (parsed.data.active === true) released = await releaseHeld(id);
  if (parsed.data.active === false && w.when_inactive === 'queue') {
    await query(`UPDATE webhook_deliveries SET status = 'held' WHERE endpoint_id = $1 AND status = 'pending'`, [id]);
  }
  if (parsed.data.active === false && w.when_inactive === 'drop') {
    await query(`UPDATE webhook_deliveries SET status = 'failed', last_error = 'Dropped: endpoint turned off' WHERE endpoint_id = $1 AND status IN ('pending','held')`, [id]);
  }
  res.json({ data: { ...w, released } });
});

webhooksRouter.post('/:id/rotate-secret', async (req, res) => {
  const secret = newSecret();
  const { rowCount } = await query('UPDATE webhook_endpoints SET secret = $2 WHERE id = $1', [Number(req.params.id), secret]);
  if (!rowCount) throw new ApiError(404, 'Endpoint not found');
  res.json({ data: { secret } });
});

webhooksRouter.delete('/:id', async (req, res) => {
  await query('DELETE FROM webhook_endpoints WHERE id = $1', [Number(req.params.id)]);
  res.status(204).end();
});

webhooksRouter.post('/:id/test', async (req, res) => {
  const { rows: [w] } = await query('SELECT * FROM webhook_endpoints WHERE id = $1', [Number(req.params.id)]);
  if (!w) throw new ApiError(404, 'Endpoint not found');
  const d = await transaction(async (db) => {
    const { rows: [e] } = await db.query(
      `INSERT INTO webhook_events (event, entity, entity_id, data, dispatched_at) VALUES ('test.ping', 'test', 'ping', $1, now()) RETURNING id`,
      [JSON.stringify({ message: 'A test event from the Cetizion tracker', endpoint: w.name })]);
    const { rows: [row] } = await db.query(
      `INSERT INTO webhook_deliveries (endpoint_id, event_id, idempotency_key) VALUES ($1,$2,$3) RETURNING id`, [w.id, e.id, `test_${e.id}_ep_${w.id}`]);
    return row;
  });
  if (!w.active) throw new ApiError(409, 'The endpoint is turned off');
  res.json({ data: await deliverOne(d.id) });
});

webhooksRouter.get('/deliveries', async (req, res) => {
  const params = []; const where = [];
  if (req.query.endpoint_id) { params.push(Number(req.query.endpoint_id)); where.push(`d.endpoint_id = $${params.length}`); }
  if (req.query.status) { params.push(String(req.query.status).split(',')); where.push(`d.status = ANY($${params.length})`); }
  const { rows } = await query(
    `SELECT d.id, d.endpoint_id, w.name AS endpoint, e.event, e.entity, e.entity_id, e.occurred_at, d.status, d.attempts,
            d.next_attempt_at, d.last_status_code, d.last_response, d.last_error, d.delivered_at, d.idempotency_key
       FROM webhook_deliveries d JOIN webhook_events e ON e.id = d.event_id JOIN webhook_endpoints w ON w.id = d.endpoint_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY d.id DESC LIMIT 200`, params);
  res.json({ data: rows });
});

webhooksRouter.post('/deliveries/:id/replay', async (req, res) => {
  const { rows: [d] } = await query(
    `UPDATE webhook_deliveries SET status = 'pending', attempts = 0, next_attempt_at = now(), last_error = NULL WHERE id = $1 RETURNING id`, [Number(req.params.id)]);
  if (!d) throw new ApiError(404, 'Delivery not found');
  res.json({ data: await deliverOne(d.id) });
});

webhooksRouter.post('/run', async (req, res) => {
  res.json({ data: await runWebhooks() });
});

// ------------------------------------------------------------ incoming (public)

const enquirySchema = z.object({
  client_name: z.string().trim().min(1).max(200),
  contact_person: z.string().trim().max(120).optional(),
  contact_email: z.string().trim().email().max(160).optional(),
  contact_phone: z.string().trim().max(40).optional(),
  service: z.string().trim().max(300).optional(),
  source: z.string().trim().max(120).optional(),
  message: z.string().max(4000).optional(),
});

incomingHooksRouter.post('/enquiries', async (req, res) => {
  const { rows: [s] } = await query(`SELECT value FROM settings WHERE key = 'incoming_enquiries_enabled'`);
  const secret = process.env.INCOMING_WEBHOOK_SECRET || '';
  if (s?.value !== 'true' || !secret) throw new ApiError(404, 'Not found');
  const raw = req.rawBody ? req.rawBody.toString('utf8') : '';
  if (!verify(secret, req.get('x-cetizion-signature'), raw)) throw new ApiError(401, 'Bad signature');
  let body;
  try { body = JSON.parse(raw); } catch { throw new ApiError(400, 'The body must be JSON'); }
  const parsed = enquirySchema.safeParse(body);
  if (!parsed.success) throw fields(parsed);
  const v = parsed.data;
  const enquiry = await transaction(async (db) => {
    const { rows: [src] } = await db.query(`SELECT id FROM lead_sources WHERE lower(name) = lower($1)`, [v.source || 'Website']);
    const no = await claimNextId('enquiry', db);
    const { rows: [e] } = await db.query(
      `INSERT INTO enquiries (enquiry_no, enquiry_date, client_name, contact_person, service, status, source_id, notes)
       VALUES ($1, (now() AT TIME ZONE 'Asia/Kolkata')::date, $2, $3, $4, 'New', $5, $6) RETURNING enquiry_no, company_id, contact_id`,
      [no, v.client_name, v.contact_person || null, v.service || null, src?.id ?? null,
        [v.message, v.contact_email && `Email: ${v.contact_email}`, v.contact_phone && `Phone: ${v.contact_phone}`].filter(Boolean).join('\n') || null]);
    if (e.contact_id && (v.contact_email || v.contact_phone)) {
      await db.query('UPDATE contacts SET email = COALESCE(email, $2), phone = COALESCE(phone, $3) WHERE id = $1', [e.contact_id, v.contact_email || null, v.contact_phone || null]);
    }
    return e;
  });
  res.status(201).json({ data: { enquiry_no: enquiry.enquiry_no } });
});
