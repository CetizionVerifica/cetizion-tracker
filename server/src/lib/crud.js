import { Router } from 'express';
import { query } from '../db.js';
import { ApiError } from '../middleware/error.js';

const MAX_LIMIT = 1000;

/** Identifiers are only ever taken from a resource definition, never a client. */
const ident = (name) => `"${String(name).replace(/"/g, '')}"`;

/**
 * Build the WHERE clause for a list request from the resource's declared
 * search and filter columns. Anything the client asks for that is not in
 * those lists is ignored rather than interpolated.
 */
function buildWhere(def, reqQuery, params) {
  const clauses = [];

  const search = (reqQuery.q || '').trim();
  if (search && def.search?.length) {
    params.push(`%${search}%`);
    const idx = params.length;
    clauses.push(
      `(${def.search.map((c) => `${ident(c)}::text ILIKE $${idx}`).join(' OR ')})`
    );
  }

  for (const col of def.filters || []) {
    const raw = reqQuery[col];
    if (raw === undefined || raw === '') continue;
    const values = String(raw).split(',').map((v) => v.trim()).filter(Boolean);
    if (!values.length) continue;
    if (values.length === 1 && values[0] === '__none__') {
      clauses.push(`${ident(col)} IS NULL`);
      continue;
    }
    params.push(values);
    clauses.push(`${ident(col)}::text = ANY($${params.length})`);
  }

  return clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
}

function buildOrder(def, sortParam) {
  if (!sortParam) return `ORDER BY ${def.defaultSort}`;
  const [rawCol, rawDir] = String(sortParam).split(':');
  const allowed = new Set([...(def.columns || []), ...(def.search || []), ...(def.filters || []), 'id']);
  if (!allowed.has(rawCol)) return `ORDER BY ${def.defaultSort}`;
  const dir = String(rawDir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  return `ORDER BY ${ident(rawCol)} ${dir} NULLS LAST`;
}

/** Reject unknown keys early so typos surface instead of silently vanishing. */
function pickWritable(def, body) {
  const out = {};
  for (const col of def.columns) {
    if (Object.prototype.hasOwnProperty.call(body, col)) out[col] = body[col];
  }
  return out;
}

function validate(def, body, { partial }) {
  const schema = partial ? def.schema.partial() : def.schema;
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(422, 'Please check the highlighted fields', {
      fields: Object.fromEntries(
        parsed.error.issues.map((i) => [i.path.join('.') || '_', i.message])
      ),
    });
  }
  return pickWritable(def, parsed.data);
}

/** Where a resource has a human key (PRJ-2026-001) accept it in the URL too. */
function idPredicate(def, id, params) {
  if (/^\d+$/.test(id)) {
    params.push(Number(id));
    return `id = $${params.length}`;
  }
  if (!def.naturalKey) throw new ApiError(400, 'Invalid id');
  params.push(decodeURIComponent(id));
  return `${ident(def.naturalKey)} = $${params.length}`;
}

export function crudRouter(name, def) {
  const router = Router();
  const readFrom = def.view || def.table;

  router.get('/', async (req, res) => {
    const params = [];
    const where = buildWhere(def, req.query, params);
    const order = buildOrder(def, req.query.sort);
    const limit = Math.min(Number(req.query.limit) || 500, MAX_LIMIT);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const [rows, count] = await Promise.all([
      query(
        `SELECT * FROM ${ident(readFrom)} ${where} ${order} LIMIT ${limit} OFFSET ${offset}`,
        params
      ),
      query(`SELECT COUNT(*)::int AS total FROM ${ident(readFrom)} ${where}`, params),
    ]);

    res.json({ data: rows.rows, total: count.rows[0].total, limit, offset });
  });

  router.get('/:id', async (req, res) => {
    const params = [];
    const pred = idPredicate(def, req.params.id, params);
    const { rows } = await query(`SELECT * FROM ${ident(readFrom)} WHERE ${pred}`, params);
    if (!rows.length) throw new ApiError(404, `${def.label} not found`);
    res.json({ data: rows[0] });
  });

  router.post('/', async (req, res) => {
    const values = validate(def, req.body, { partial: false });
    const cols = Object.keys(values);
    if (!cols.length) throw new ApiError(422, 'Nothing to save');

    const { rows } = await query(
      `INSERT INTO ${ident(def.table)} (${cols.map(ident).join(', ')})
       VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})
       RETURNING id`,
      cols.map((c) => values[c])
    );
    const { rows: full } = await query(
      `SELECT * FROM ${ident(readFrom)} WHERE id = $1`,
      [rows[0].id]
    );
    res.status(201).json({ data: full[0] });
  });

  router.patch('/:id', async (req, res) => {
    const values = validate(def, req.body, { partial: true });
    const cols = Object.keys(values);
    if (!cols.length) throw new ApiError(422, 'Nothing to update');

    const params = cols.map((c) => values[c]);
    const pred = idPredicate(def, req.params.id, params);
    const sets = cols.map((c, i) => `${ident(c)} = $${i + 1}`).join(', ');

    const { rows } = await query(
      `UPDATE ${ident(def.table)} SET ${sets} WHERE ${pred} RETURNING id`,
      params
    );
    if (!rows.length) throw new ApiError(404, `${def.label} not found`);

    const { rows: full } = await query(
      `SELECT * FROM ${ident(readFrom)} WHERE id = $1`,
      [rows[0].id]
    );
    res.json({ data: full[0] });
  });

  router.delete('/:id', async (req, res) => {
    const params = [];
    const pred = idPredicate(def, req.params.id, params);
    const { rowCount } = await query(
      `DELETE FROM ${ident(def.table)} WHERE ${pred}`,
      params
    );
    if (!rowCount) throw new ApiError(404, `${def.label} not found`);
    res.status(204).end();
  });

  return router;
}
