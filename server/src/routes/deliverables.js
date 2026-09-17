/**
 * The certificates and deliverables register (#43).
 *
 *   GET    /api/deliverables?company_id=&project_id=&type=&status=&service=&expiring=90&q=
 *   GET    /api/deliverables/:id
 *   POST   /api/deliverables                 issue (or draft) one
 *   PATCH  /api/deliverables/:id
 *   POST   /api/deliverables/:id/supersede   { ...the new one }  keeps the old, marked
 *   POST   /api/deliverables/:id/withdraw    { reason }          the engagement lapses
 *   DELETE /api/deliverables/:id             drafts only
 */
import { Router } from 'express';
import { z } from 'zod';
import { query, transaction } from '../db.js';
import { ApiError } from '../middleware/error.js';
import { lockAttachableDocument } from '../lib/documents.js';
import { syncEngagement } from '../lib/deliverables.js';
import { sentFields } from '../lib/sentFields.js';

export const deliverablesRouter = Router();

const blank = (v) => (typeof v === 'string' && v.trim() === '' ? null : v);
const opt = (s) => z.preprocess(blank, s.nullable().optional());
const day = () => opt(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date'));

const schema = z.object({
  company_id: opt(z.coerce.number().int().positive()),
  client_name: opt(z.string().trim().max(200)),
  project_id: opt(z.string().trim().max(60)),
  po_number: opt(z.string().trim().max(80)),
  service_id: opt(z.coerce.number().int().positive()),
  service_name: opt(z.string().trim().max(200)),
  type: z.enum(['certificate', 'scorecard', 'report', 'audit_finding', 'statement']).default('certificate'),
  reference: opt(z.string().trim().max(120)),
  title: z.string().trim().min(1, 'What is it called?').max(300),
  issued_on: day(),
  valid_from: day(),
  valid_until: day(),
  scope: opt(z.string().max(4000)),
  issuing_body: opt(z.string().trim().max(200)),
  status: z.enum(['draft', 'issued']).default('issued'),
  document_id: opt(z.coerce.number().int().positive()),
  owner: opt(z.string().trim().max(120)),
  notes: opt(z.string().max(4000)),
});
const COLUMNS = Object.keys(schema.shape);

function check(body, partial = false) {
  const parsed = (partial ? schema.partial() : schema).safeParse(body || {});
  if (!parsed.success) throw new ApiError(422, 'Please check the highlighted fields', { fields: Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.'), i.message])) });
  const v = partial ? sentFields(parsed.data, body) : parsed.data;
  if (v.valid_from && v.valid_until && v.valid_until < v.valid_from) throw new ApiError(422, 'Please check the highlighted fields', { fields: { valid_until: 'Must be after valid from' } });
  if (!partial && !v.company_id && !v.project_id && !v.po_number && !v.client_name) throw new ApiError(422, 'Please check the highlighted fields', { fields: { company_id: 'Choose the client, the project or the PO' } });
  return v;
}

function friendly(err) {
  if (err.code === '23505') return new ApiError(409, 'A deliverable with this reference already exists', { fields: { reference: 'Already used' } });
  if (err.code === '23503') return new ApiError(422, 'The client, project, PO or service was not found');
  return err;
}

async function insert(db, v, who) {
  if (v.document_id && !(await lockAttachableDocument(db, v.document_id))) throw new ApiError(422, 'That file is already attached elsewhere');
  // client_name is always sent ('' when unknown) so the trigger can fill it from the project or company.
  const cols = COLUMNS.filter((c) => c !== 'client_name' && v[c] !== undefined);
  const values = [...cols.map((c) => v[c]), v.client_name || '', who];
  const { rows: [d] } = await db.query(
    `INSERT INTO deliverables (${[...cols, 'client_name', 'created_by'].join(', ')}) VALUES (${values.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    values);
  if (!d.client_name) throw new ApiError(422, 'Please check the highlighted fields', { fields: { company_id: 'Choose the client' } });
  await syncEngagement(d.id, db);
  return d;
}

deliverablesRouter.get('/', async (req, res) => {
  const where = []; const params = [];
  const add = (sql, v) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
  if (req.query.company_id) add('d.company_id = ?', Number(req.query.company_id));
  if (req.query.project_id) add('d.project_id = ?', String(req.query.project_id));
  if (req.query.po_number) add('d.po_number = ?', String(req.query.po_number));
  if (req.query.type) add('d.type = ?', String(req.query.type));
  if (req.query.status) add('d.status = ANY(?)', String(req.query.status).split(','));
  if (req.query.service) add('d.service_name ILIKE ?', `%${req.query.service}%`);
  if (req.query.expiring) { add(`d.valid_until <= CURRENT_DATE + ?::int`, Number(req.query.expiring) || 90); where.push(`d.status = 'issued'`); }
  if (req.query.q) {
    params.push(`%${req.query.q}%`);
    const n = `$${params.length}`;
    where.push(`(d.client_name ILIKE ${n} OR d.reference ILIKE ${n} OR d.title ILIKE ${n} OR d.scope ILIKE ${n} OR d.service_name ILIKE ${n})`);
  }
  const { rows } = await query(
    `SELECT d.*, (d.valid_until - CURRENT_DATE) AS days_left, doc.file_name, e.status AS engagement_status, e.next_due_on AS engagement_due,
            nd.reference AS superseded_by_reference
       FROM deliverables d
       LEFT JOIN documents doc ON doc.id = d.document_id
       LEFT JOIN engagements e ON e.id = d.engagement_id
       LEFT JOIN deliverables nd ON nd.id = d.superseded_by_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY (d.status = 'issued') DESC, d.valid_until NULLS LAST, d.id DESC
      LIMIT 1000`, params);
  res.json({ data: rows });
});

deliverablesRouter.get('/:id', async (req, res) => {
  const { rows: [d] } = await query('SELECT * FROM deliverables WHERE id = $1', [Number(req.params.id)]);
  if (!d) throw new ApiError(404, 'Deliverable not found');
  const { rows: history } = await query(
    `WITH RECURSIVE chain AS (
       SELECT * FROM deliverables WHERE superseded_by_id = $1
       UNION ALL SELECT p.* FROM deliverables p JOIN chain c ON p.superseded_by_id = c.id)
     SELECT id, reference, status, issued_on, valid_until, document_id FROM chain ORDER BY valid_until DESC NULLS LAST`, [d.id]);
  res.json({ data: { ...d, history } });
});

deliverablesRouter.post('/', async (req, res) => {
  const v = check(req.body);
  try {
    const d = await transaction((db) => insert(db, v, req.user?.username || 'admin'));
    res.status(201).json({ data: d });
  } catch (err) { throw friendly(err); }
});

deliverablesRouter.patch('/:id', async (req, res) => {
  const v = check(req.body, true);
  const id = Number(req.params.id);
  const cols = COLUMNS.filter((c) => v[c] !== undefined);
  if (!cols.length) throw new ApiError(422, 'Nothing to change');
  try {
    const d = await transaction(async (db) => {
      const { rows: [cur] } = await db.query('SELECT * FROM deliverables WHERE id = $1 FOR UPDATE', [id]);
      if (!cur) throw new ApiError(404, 'Deliverable not found');
      if (['superseded', 'withdrawn'].includes(cur.status) && cols.some((c) => !['notes', 'document_id'].includes(c))) throw new ApiError(422, `A ${cur.status} deliverable only takes notes and its file`);
      if (v.document_id && v.document_id !== cur.document_id && !(await lockAttachableDocument(db, v.document_id))) throw new ApiError(422, 'That file is already attached elsewhere');
      if (v.status && cur.status === 'expired') delete v.status;
      const set = cols.filter((c) => v[c] !== undefined);
      const { rows: [row] } = await db.query(`UPDATE deliverables SET ${set.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`, [id, ...set.map((c) => v[c])]);
      // A corrected expiry on an expired record brings it back.
      if (row.status === 'expired' && row.valid_until && row.valid_until >= new Date().toISOString().slice(0, 10)) {
        await db.query(`UPDATE deliverables SET status = 'issued' WHERE id = $1`, [id]);
      }
      await syncEngagement(id, db);
      return (await db.query('SELECT * FROM deliverables WHERE id = $1', [id])).rows[0];
    });
    res.json({ data: d });
  } catch (err) { throw friendly(err); }
});

deliverablesRouter.post('/:id/supersede', async (req, res) => {
  const id = Number(req.params.id);
  try {
    const d = await transaction(async (db) => {
      const { rows: [old] } = await db.query('SELECT * FROM deliverables WHERE id = $1 FOR UPDATE', [id]);
      if (!old) throw new ApiError(404, 'Deliverable not found');
      if (!['issued', 'expired'].includes(old.status)) throw new ApiError(422, `A ${old.status} deliverable cannot be superseded`);
      // The new one inherits what it does not say; the old one's file stays with the old one.
      const v = check({ company_id: old.company_id, client_name: old.client_name, project_id: old.project_id, po_number: old.po_number, service_id: old.service_id, service_name: old.service_name, type: old.type, title: old.title, scope: old.scope, issuing_body: old.issuing_body, owner: old.owner, ...req.body, status: 'issued' });
      const { rows: [fresh] } = await db.query(`UPDATE deliverables SET status = 'superseded' WHERE id = $1 RETURNING engagement_id`, [id]);
      const created = await insert(db, { ...v, engagement_id: undefined }, req.user?.username || 'admin');
      await db.query('UPDATE deliverables SET superseded_by_id = $2 WHERE id = $1', [id, created.id]);
      if (fresh.engagement_id && !created.engagement_id) {
        await db.query('UPDATE deliverables SET engagement_id = $2 WHERE id = $1', [created.id, fresh.engagement_id]);
        await syncEngagement(created.id, db);
      }
      return (await db.query('SELECT * FROM deliverables WHERE id = $1', [created.id])).rows[0];
    });
    res.status(201).json({ data: d });
  } catch (err) { throw friendly(err); }
});

deliverablesRouter.post('/:id/withdraw', async (req, res) => {
  const reason = String(req.body?.reason || '').trim().slice(0, 1000);
  if (!reason) throw new ApiError(422, 'Please check the highlighted fields', { fields: { reason: 'Why is it withdrawn?' } });
  const d = await transaction(async (db) => {
    const { rows: [row] } = await db.query(
      `UPDATE deliverables SET status = 'withdrawn', notes = concat_ws(E'\\n', notes, $2::text) WHERE id = $1 AND status IN ('issued','expired') RETURNING *`,
      [Number(req.params.id), `Withdrawn: ${reason}`]);
    if (!row) throw new ApiError(422, 'Only an issued or expired deliverable can be withdrawn');
    await syncEngagement(row.id, db);
    return row;
  });
  res.json({ data: d });
});

deliverablesRouter.delete('/:id', async (req, res) => {
  const { rowCount } = await query(`DELETE FROM deliverables WHERE id = $1 AND status = 'draft'`, [Number(req.params.id)]);
  if (!rowCount) throw new ApiError(422, 'Only drafts can be deleted; withdraw an issued one instead');
  res.status(204).end();
});
