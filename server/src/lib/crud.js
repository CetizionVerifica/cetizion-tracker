import { Router } from 'express';
import { query, transaction } from '../db.js';
import { ApiError } from '../middleware/error.js';
import { lockAttachableDocument, purgeDocument } from './documents.js';
import { nameKey, normalizeName } from './names.js';
import { reportPeriod } from './salesReport.js';
import { claimNextId, sequenceColumn } from './sequences.js';

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
    // Free-text names match the way the sales reports group them: case and
    // extra spaces ignored, and a blank value counts as not set.
    const normalized = def.normalizedFilters?.includes(col);
    if (values.length === 1 && values[0] === '__none__') {
      clauses.push(normalized ? `NULLIF(btrim(${ident(col)}), '') IS NULL` : `${ident(col)} IS NULL`);
      continue;
    }
    if (normalized) {
      params.push(values.map(normalizeName));
      clauses.push(`${nameKey(ident(col))} = ANY($${params.length})`);
    } else {
      params.push(values);
      clauses.push(`${ident(col)}::text = ANY($${params.length})`);
    }
  }

  // ?from=&to= on the resource's date column, so a list opened from a
  // report covers the same period as the figure it came from.
  if (def.dateFilter && (reqQuery.from || reqQuery.to)) {
    const { from, to } = reportPeriod(reqQuery);
    if (from) {
      params.push(from);
      clauses.push(`${ident(def.dateFilter)} >= $${params.length}::date`);
    }
    if (to) {
      params.push(to);
      clauses.push(`${ident(def.dateFilter)} <= $${params.length}::date`);
    }
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

/**
 * Where a resource has a human key (PRJ-2026-001) accept it in the URL too.
 *
 * A human key can itself be all digits — clients issue PO numbers like
 * 4530056073 — so digits alone do not mean "internal id". The human key
 * wins whenever a row carries it; the numeric id is only tried when it
 * fits Postgres' integer type and no row has that human key.
 */
const MAX_INT = 2147483647;

function idPredicate(def, id, params) {
  const key = decodeURIComponent(id);
  const numeric = /^\d+$/.test(key) && Number(key) <= MAX_INT;

  if (!def.naturalKey) {
    if (!numeric) throw new ApiError(400, 'Invalid id');
    params.push(Number(key));
    return `id = $${params.length}`;
  }
  params.push(key);
  const byKey = `${ident(def.naturalKey)} = $${params.length}`;
  if (!numeric) return byKey;

  params.push(Number(key));
  return `(${byKey} OR (id = $${params.length} AND NOT EXISTS (
            SELECT 1 FROM ${ident(def.table)} WHERE ${byKey})))`;
}

/**
 * Quotations, POs and payment stages may carry one document. A blank value never clears one
 * already attached. A new one must be an upload no record uses, and it stays
 * locked until the save commits, so two saves cannot both attach it and a
 * purge cannot remove it underneath the record. Returns the document being
 * replaced, if any, so it can be removed once the record is committed.
 */
async function claimDocument(client, def, values, id) {
  if (values.document_id === null || values.document_id === undefined) {
    delete values.document_id;
    return null;
  }

  let previous = null;
  if (id !== undefined) {
    const params = [];
    const { rows } = await client.query(
      `SELECT document_id FROM ${ident(def.table)} WHERE ${idPredicate(def, id, params)} FOR UPDATE`,
      params
    );
    if (!rows.length) throw new ApiError(404, `${def.label} not found`);
    previous = rows[0].document_id;
  }

  if (values.document_id !== previous && !(await lockAttachableDocument(client, values.document_id))) {
    throw new ApiError(422, 'Please check the highlighted fields', {
      fields: { document_id: 'That upload has expired or is already in use — choose the file again' },
    });
  }
  return previous;
}

export function crudRouter(name, def) {
  const router = Router();
  const readFrom = def.view || def.table;

  // A save with follow-on work runs in one transaction: whatever an
  // onSave(client, { before, after }) hook writes, a document attached under
  // lock, and a reference number taken from its series commit together with
  // the record or not at all.
  const write = (fn) => (def.onSave || def.hasDocument || def.autoId ? transaction(fn) : fn({ query }));

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

    const { id, extra } = await write(async (client) => {
      if (def.hasDocument) await claimDocument(client, def, values);
      // The reference number (CTZ/ENQ/2026/004) is always the next in its series, never typed.
      if (def.autoId) values[sequenceColumn(def.autoId)] = await claimNextId(def.autoId, client);
      const cols = Object.keys(values);
      if (!cols.length) throw new ApiError(422, 'Nothing to save');

      const { rows } = await client.query(
        `INSERT INTO ${ident(def.table)} (${cols.map(ident).join(', ')})
         VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})
         RETURNING *`,
        cols.map((c) => values[c])
      );
      const extra = await def.onSave?.(client, { before: null, after: rows[0] });
      return { id: rows[0].id, extra };
    });

    const { rows: full } = await query(
      `SELECT * FROM ${ident(readFrom)} WHERE id = $1`,
      [id]
    );
    // A hook may report what it did, e.g. the quotation a won enquiry created.
    res.status(201).json({ data: { ...full[0], ...extra } });
  });

  router.patch('/:id', async (req, res) => {
    const values = validate(def, req.body, { partial: true });
    // An assigned reference number stays as it was given.
    if (def.autoId) delete values[sequenceColumn(def.autoId)];

    const { id, extra, previousDocument } = await write(async (client) => {
      const previousDocument = def.hasDocument ? await claimDocument(client, def, values, req.params.id) : null;
      const cols = Object.keys(values);
      if (!cols.length) throw new ApiError(422, 'Nothing to update');

      let before = null;
      if (def.onSave) {
        const keyParams = [];
        const keyPred = idPredicate(def, req.params.id, keyParams);
        ({ rows: [before] } = await client.query(
          `SELECT * FROM ${ident(def.table)} WHERE ${keyPred} FOR UPDATE`,
          keyParams
        ));
      }

      const params = cols.map((c) => values[c]);
      const pred = idPredicate(def, req.params.id, params);
      const sets = cols.map((c, i) => `${ident(c)} = $${i + 1}`).join(', ');
      const { rows } = await client.query(
        `UPDATE ${ident(def.table)} SET ${sets} WHERE ${pred} RETURNING *`,
        params
      );
      if (!rows.length) throw new ApiError(404, `${def.label} not found`);
      const extra = await def.onSave?.(client, { before, after: rows[0] });
      return { id: rows[0].id, extra, previousDocument };
    });

    // The replaced file leaves storage only once the new one is committed.
    if (previousDocument && values.document_id !== undefined && values.document_id !== previousDocument) {
      await purgeDocument(previousDocument).catch((err) => console.error('[documents]', err));
    }

    const { rows: full } = await query(
      `SELECT * FROM ${ident(readFrom)} WHERE id = $1`,
      [id]
    );
    res.json({ data: { ...full[0], ...extra } });
  });

  router.delete('/:id', async (req, res) => {
    const remove = async (client) => {
      const params = [];
      const pred = idPredicate(def, req.params.id, params);
      const { rows: [target] } = await client.query(
        `SELECT * FROM ${ident(def.table)} WHERE ${pred} FOR UPDATE`,
        params
      );
      if (!target) throw new ApiError(404, `${def.label} not found`);

      // Rows the delete cascades to (a PO's payment stages) may carry documents of their own.
      const cascaded = def.cascadeDocuments
        ? (await client.query(def.cascadeDocuments.sql, [target[def.cascadeDocuments.key]])).rows.map((row) => row.document_id)
        : [];
      await client.query(`DELETE FROM ${ident(def.table)} WHERE id = $1`, [target.id]);
      return [def.hasDocument ? target.document_id : null, ...cascaded].filter(Boolean);
    };
    const documents = def.hasDocument || def.cascadeDocuments ? await transaction(remove) : await remove({ query });

    // Files leave Cloudinary only once the delete is committed.
    for (const documentId of documents) {
      await purgeDocument(documentId).catch((err) => console.error('[documents]', err));
    }
    res.status(204).end();
  });

  return router;
}
