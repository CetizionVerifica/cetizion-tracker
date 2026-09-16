/**
 * Audit and site-visit scheduling (#42).
 *
 *   GET    /api/visits?from=&to=&staff_id=&project_id=&type=&status=
 *   GET    /api/visits/:id
 *   POST   /api/visits                { ..., assignees: [{staff_id, role}], force }   409 with conflicts unless force
 *   PATCH  /api/visits/:id            same, partial
 *   POST   /api/visits/check          { staff_ids, starts_at, ends_at, exclude } conflicts only
 *   POST   /api/visits/:id/trip       a trip prefilled from the visit (one per lead or chosen person)
 *   GET    /api/visits/capacity?month=YYYY-MM
 *   GET    /api/visits/today
 *   staff:  GET/POST /api/visits/staff, PATCH /api/visits/staff/:id, POST /api/visits/staff/:id/leave, DELETE /api/visits/leave/:id
 */
import { Router } from 'express';
import { z } from 'zod';
import { query, transaction } from '../db.js';
import { ApiError } from '../middleware/error.js';
import { claimNextId } from '../lib/sequences.js';
import { capacity, findConflicts } from '../lib/visits.js';
import { businessToday } from '../lib/businessDate.js';

export const visitsRouter = Router();

const who = (req) => req.user?.username || 'admin';
const fields = (parsed) => new ApiError(422, 'Please check the highlighted fields', { fields: Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.'), i.message])) });
const blank = (v) => (typeof v === 'string' && v.trim() === '' ? null : v);
const opt = (s) => z.preprocess(blank, s.nullable().optional());
const stamp = z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/));

// ------------------------------------------------------------ staff
visitsRouter.get('/staff', async (req, res) => {
  const { rows } = await query(
    `SELECT s.*, COALESCE((SELECT json_agg(l ORDER BY l.starts_on) FROM staff_leave l WHERE l.staff_id = s.id AND l.ends_on >= CURRENT_DATE - 30), '[]') AS leave
       FROM staff s ORDER BY s.active DESC, s.name`);
  res.json({ data: rows });
});

const staffSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: opt(z.string().trim().email()),
  role: opt(z.string().trim().max(120)),
  working_days: z.array(z.number().int().min(1).max(7)).min(1).max(7).optional(),
  active: z.boolean().optional(),
});
visitsRouter.post('/staff', async (req, res) => {
  const parsed = staffSchema.safeParse(req.body || {});
  if (!parsed.success) throw fields(parsed);
  const v = parsed.data;
  const { rows: [s] } = await query('INSERT INTO staff (name, email, role, working_days) VALUES ($1,$2,$3,COALESCE($4, \'{1,2,3,4,5,6}\'::int[])) RETURNING *', [v.name, v.email ?? null, v.role ?? null, v.working_days ?? null])
    .catch((e) => { if (e.code === '23505') throw new ApiError(409, 'Someone with that name is already listed'); throw e; });
  res.status(201).json({ data: s });
});
visitsRouter.patch('/staff/:id', async (req, res) => {
  const parsed = staffSchema.partial().safeParse(req.body || {});
  if (!parsed.success) throw fields(parsed);
  const set = Object.entries(parsed.data).filter(([, x]) => x !== undefined);
  if (!set.length) throw new ApiError(422, 'Nothing to change');
  const { rows: [s] } = await query(`UPDATE staff SET ${set.map(([k], i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`, [Number(req.params.id), ...set.map(([, x]) => x)]);
  if (!s) throw new ApiError(404, 'Not found');
  res.json({ data: s });
});
visitsRouter.post('/staff/:id/leave', async (req, res) => {
  const parsed = z.object({ starts_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), ends_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), reason: opt(z.string().max(200)) }).safeParse(req.body || {});
  if (!parsed.success) throw fields(parsed);
  if (parsed.data.ends_on < parsed.data.starts_on) throw new ApiError(422, 'Please check the highlighted fields', { fields: { ends_on: 'Must be on or after the start' } });
  const { rows: [l] } = await query('INSERT INTO staff_leave (staff_id, starts_on, ends_on, reason) VALUES ($1,$2,$3,$4) RETURNING *', [Number(req.params.id), parsed.data.starts_on, parsed.data.ends_on, parsed.data.reason ?? null]);
  // Visits this leave now clashes with.
  const { rows: clashes } = await query(
    `SELECT v.id, v.title, v.starts_at FROM visits v JOIN visit_assignees va ON va.visit_id = v.id
      WHERE va.staff_id = $1 AND v.status IN ('planned','confirmed') AND (v.starts_at AT TIME ZONE 'Asia/Kolkata')::date <= $3 AND (v.ends_at AT TIME ZONE 'Asia/Kolkata')::date >= $2`,
    [l.staff_id, l.starts_on, l.ends_on]);
  res.status(201).json({ data: l, clashes });
});
visitsRouter.delete('/leave/:id', async (req, res) => {
  await query('DELETE FROM staff_leave WHERE id = $1', [Number(req.params.id)]);
  res.status(204).end();
});

// ------------------------------------------------------------ reads
visitsRouter.get('/capacity', async (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(String(req.query.month)) ? String(req.query.month) : businessToday().slice(0, 7);
  res.json({ data: await capacity(month), month });
});

const LIST = `
  SELECT v.*, p.client_name, co.name AS company_name, ct.name AS contact_name, ps.stage_name AS milestone_stage_name,
         COALESCE((SELECT json_agg(json_build_object('staff_id', s.id, 'name', s.name, 'role', va.role) ORDER BY va.role, s.name)
                     FROM visit_assignees va JOIN staff s ON s.id = va.staff_id WHERE va.visit_id = v.id), '[]') AS assignees
    FROM visits v
    LEFT JOIN projects p ON p.project_id = v.project_id
    LEFT JOIN companies co ON co.id = v.company_id
    LEFT JOIN contacts ct ON ct.id = v.contact_id
    LEFT JOIN payment_stages ps ON ps.id = v.milestone_stage_id`;

visitsRouter.get('/today', async (req, res) => {
  const { rows } = await query(`${LIST} WHERE v.status IN ('planned','confirmed') AND (v.starts_at AT TIME ZONE 'Asia/Kolkata')::date <= $1 AND (v.ends_at AT TIME ZONE 'Asia/Kolkata')::date >= $1 ORDER BY v.starts_at`, [businessToday()]);
  res.json({ data: rows });
});

visitsRouter.get('/', async (req, res) => {
  const params = []; const where = [];
  const add = (sql, v) => { params.push(v); where.push(sql.replaceAll('?', `$${params.length}`)); };
  if (req.query.from) add('v.ends_at >= ?::date', String(req.query.from));
  if (req.query.to) add('v.starts_at < (?::date + 1)', String(req.query.to));
  if (req.query.project_id) add('v.project_id = ?', String(req.query.project_id));
  if (req.query.type) add('v.type = ?', String(req.query.type));
  if (req.query.status) add('v.status = ANY(?)', String(req.query.status).split(','));
  if (req.query.staff_id) add('EXISTS (SELECT 1 FROM visit_assignees va WHERE va.visit_id = v.id AND va.staff_id = ?)', Number(req.query.staff_id));
  const { rows } = await query(`${LIST} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY v.starts_at LIMIT 2000`, params);
  res.json({ data: rows });
});

visitsRouter.get('/:id', async (req, res) => {
  const { rows: [v] } = await query(`${LIST} WHERE v.id = $1`, [Number(req.params.id)]);
  if (!v) throw new ApiError(404, 'Visit not found');
  res.json({ data: v });
});

// ------------------------------------------------------------ writes
const visitSchema = z.object({
  project_id: opt(z.string().trim().max(40)),
  po_number: opt(z.string().trim().max(80)),
  contact_id: opt(z.coerce.number().int().positive()),
  type: z.enum(['audit', 'assessment', 'training', 'meeting', 'follow_up']).default('audit'),
  title: z.string().trim().min(1, 'What is the visit?').max(300),
  starts_at: stamp,
  ends_at: stamp,
  all_day: z.boolean().default(true),
  location: opt(z.string().trim().max(300)),
  city: opt(z.string().trim().max(120)),
  state: opt(z.string().trim().max(120)),
  status: z.enum(['planned', 'confirmed', 'done', 'cancelled', 'rescheduled']).default('planned'),
  milestone_stage_id: opt(z.coerce.number().int().positive()),
  notify_client: z.boolean().default(false),
  notes: opt(z.string().max(4000)),
  assignees: z.array(z.object({ staff_id: z.coerce.number().int().positive(), role: z.enum(['lead', 'member']).default('member') })).max(30).optional(),
  force: z.boolean().optional(),
});
const COLS = ['project_id', 'po_number', 'contact_id', 'type', 'title', 'starts_at', 'ends_at', 'all_day', 'location', 'city', 'state', 'status', 'milestone_stage_id', 'notify_client', 'notes'];

// An all-day visit on dates only covers those whole days, in business time.
function normalise(v) {
  const out = { ...v };
  if (out.starts_at && /^\d{4}-\d{2}-\d{2}$/.test(out.starts_at)) out.starts_at = `${out.starts_at}T09:00:00+05:30`;
  if (out.ends_at && /^\d{4}-\d{2}-\d{2}$/.test(out.ends_at)) out.ends_at = `${out.ends_at}T18:00:00+05:30`;
  for (const k of ['starts_at', 'ends_at']) if (out[k] && /T\d{2}:\d{2}(:\d{2})?$/.test(out[k])) out[k] = `${out[k]}${out[k].length === 16 ? ':00' : ''}+05:30`;
  return out;
}

async function checkMilestone(db, v) {
  if (!v.milestone_stage_id) return;
  const { rows: [s] } = await db.query(`SELECT ps.trigger_event, po.project_id FROM payment_stages ps JOIN purchase_orders po ON po.po_number = ps.po_number WHERE ps.id = $1`, [v.milestone_stage_id]);
  if (!s) throw new ApiError(422, 'Please check the highlighted fields', { fields: { milestone_stage_id: 'Unknown payment stage' } });
  if (v.project_id && s.project_id !== v.project_id) throw new ApiError(422, 'Please check the highlighted fields', { fields: { milestone_stage_id: 'That stage belongs to another project' } });
}

async function save(req, id) {
  const parsed = (id ? visitSchema.partial() : visitSchema).safeParse(req.body || {});
  if (!parsed.success) throw fields(parsed);
  const v = normalise(parsed.data);
  return transaction(async (db) => {
    let current = null;
    if (id) {
      ({ rows: [current] } = await db.query('SELECT * FROM visits WHERE id = $1 FOR UPDATE', [id]));
      if (!current) throw new ApiError(404, 'Visit not found');
    }
    const starts = v.starts_at || current?.starts_at; const ends = v.ends_at || current?.ends_at;
    if (new Date(ends) < new Date(starts)) throw new ApiError(422, 'Please check the highlighted fields', { fields: { ends_at: 'Must be after the start' } });
    if (!id && !v.project_id && !v.po_number) throw new ApiError(422, 'Please check the highlighted fields', { fields: { project_id: 'Which project is the visit for?' } });
    await checkMilestone(db, { ...current, ...v });
    const staffIds = v.assignees ? v.assignees.map((a) => a.staff_id) : (id ? (await db.query('SELECT staff_id FROM visit_assignees WHERE visit_id = $1', [id])).rows.map((r) => r.staff_id) : []);
    const status = v.status || current?.status;
    if (!v.force && ['planned', 'confirmed'].includes(status) && (v.assignees || v.starts_at || v.ends_at)) {
      const conflicts = await findConflicts({ staffIds, startsAt: starts, endsAt: ends, excludeVisitId: id }, db);
      if (conflicts.length) throw new ApiError(409, 'Some people are not free then. Save anyway?', { conflicts });
    }
    const cols = COLS.filter((c) => v[c] !== undefined);
    let row;
    if (id) {
      if (cols.length) ({ rows: [row] } = await db.query(`UPDATE visits SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`, [id, ...cols.map((c) => v[c])]));
      else row = current;
    } else {
      ({ rows: [row] } = await db.query(`INSERT INTO visits (${[...cols, 'created_by'].join(', ')}) VALUES (${[...cols, 'x'].map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`, [...cols.map((c) => v[c]), who(req)]));
    }
    if (v.assignees) {
      await db.query('DELETE FROM visit_assignees WHERE visit_id = $1', [row.id]);
      for (const a of v.assignees) await db.query('INSERT INTO visit_assignees (visit_id, staff_id, role) VALUES ($1,$2,$3) ON CONFLICT (visit_id, staff_id) DO UPDATE SET role = EXCLUDED.role', [row.id, a.staff_id, a.role]);
    }
    return row.id;
  }).catch((err) => {
    if (err.code === '23503') throw new ApiError(422, 'The project, PO, contact or person was not found');
    throw err;
  });
}

visitsRouter.post('/check', async (req, res) => {
  const v = normalise({ starts_at: req.body?.starts_at, ends_at: req.body?.ends_at });
  if (!v.starts_at || !v.ends_at) throw new ApiError(422, 'starts_at and ends_at are required');
  const staffIds = (req.body?.staff_ids || []).map(Number).filter(Boolean);
  res.json({ data: await findConflicts({ staffIds, startsAt: v.starts_at, endsAt: v.ends_at, excludeVisitId: req.body?.exclude ? Number(req.body.exclude) : null }) });
});

visitsRouter.post('/', async (req, res) => {
  const id = await save(req, null);
  const { rows: [v] } = await query(`${LIST} WHERE v.id = $1`, [id]);
  res.status(201).json({ data: v });
});

visitsRouter.patch('/:id', async (req, res) => {
  const id = await save(req, Number(req.params.id));
  const { rows: [v] } = await query(`${LIST} WHERE v.id = $1`, [id]);
  res.json({ data: v });
});

visitsRouter.delete('/:id', async (req, res) => {
  const { rowCount } = await query(`DELETE FROM visits WHERE id = $1 AND status IN ('planned','cancelled')`, [Number(req.params.id)]);
  if (!rowCount) throw new ApiError(422, 'Only planned or cancelled visits can be deleted; cancel a confirmed one instead');
  res.status(204).end();
});

visitsRouter.post('/:id/trip', async (req, res) => {
  const { rows: [v] } = await query(`${LIST} WHERE v.id = $1`, [Number(req.params.id)]);
  if (!v) throw new ApiError(404, 'Visit not found');
  if (v.travel_id) throw new ApiError(409, `Trip ${v.travel_id} already exists for this visit`);
  const person = v.assignees.find((a) => a.staff_id === Number(req.body?.staff_id)) || v.assignees.find((a) => a.role === 'lead') || v.assignees[0];
  if (!person) throw new ApiError(422, 'Assign someone to the visit first');
  const { rows: [po] } = v.po_number ? { rows: [{ po_number: v.po_number }] } : await query('SELECT po_number FROM purchase_orders WHERE project_id = $1 ORDER BY po_date DESC NULLS LAST LIMIT 1', [v.project_id]);
  const trip = await transaction(async (db) => {
    const { rows: [s] } = await db.query('SELECT email FROM staff WHERE id = $1', [person.staff_id]);
    const tid = await claimNextId('travel', db);
    const day = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(d));
    const { rows: [t] } = await db.query(
      `INSERT INTO travel_logs (travel_id, po_number, service_delivered, employee_name, employee_email, purpose, destination, travel_start_date, travel_end_date, remarks)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [tid, po?.po_number || null, v.type === 'audit' ? 'Audit' : v.type.replace('_', ' '), person.name, s?.email || null, `${v.title}${v.client_name ? ` · ${v.client_name}` : ''}`,
        [v.location, v.city, v.state].filter(Boolean).join(', ') || null, day(v.starts_at), day(v.ends_at), `From visit ${v.id}`]);
    await db.query('UPDATE visits SET travel_id = $2 WHERE id = $1', [v.id, t.travel_id]);
    return t;
  });
  res.status(201).json({ data: trip });
});
