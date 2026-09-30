/**
 * Saved views (#17): the pinned list in the sidebar, and every report.
 *
 *   GET    /api/views?counts=1    the views this person may see
 *   POST   /api/views             { resource, name, filters?, pinned?, tone?, chart?, shared? }
 *   PATCH  /api/views/:id         any of the above
 *   DELETE /api/views/:id
 *
 * A view is a resource, a set of filters and a name. That is enough to be
 * three things at once: an entry in the sidebar with the count of what is
 * behind it, a preset on a list page, and — with `chart` set — a report,
 * because a report here is a filtered list with a summary above it.
 */
import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { resourceClause, scopeOf } from '../auth/ownership.js';
import { buildWhere } from '../lib/crud.js';
import { ApiError } from '../middleware/error.js';
import { resources } from '../lib/resources.js';

export const viewRouter = Router();

/** The charts a view may draw above its table. Named for what they show. */
const CHARTS = ['ageing', 'by-month', 'by-stage', 'by-client', 'cash-flow'];

/**
 * The shape of a view, with no defaults on it.
 *
 * Defaults belong on create and nowhere near a patch. zod applies a
 * `.default()` inside `.partial()` — a key left out still comes back with
 * its default value — so a schema that carried them would turn
 * "unpin this" into "unpin this, and clear its filters, and move it to
 * the top". Which is exactly what it did: a saved view lost the filters
 * that were the whole point of it, the first time anybody unpinned one.
 */
const shape = z.object({
  resource: z.string().min(1).max(60),
  name: z.string().trim().min(1).max(80),
  filters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  pinned: z.boolean(),
  sort_order: z.number().int().min(0).max(999),
  tone: z.enum(['late', 'waiting', 'settled', 'info']).nullish(),
  chart: z.enum(CHARTS).nullish(),
  /** A shared view belongs to nobody, and only an admin may write one. */
  shared: z.boolean(),
});

/** Creating one fills in what was not said. */
const createSchema = shape.extend({
  filters: shape.shape.filters.default({}),
  pinned: shape.shape.pinned.default(false),
  sort_order: shape.shape.sort_order.default(0),
  shared: shape.shape.shared.default(false),
});

/** Changing one touches only the keys that were sent. */
const patchSchema = shape.partial();

const who = (req) => req.user?.username || 'admin';
const isAdmin = (req) => req.user?.role === 'admin';

/** A view is yours, or it is everybody's and you are an admin. */
function mayWrite(req, row) {
  if (row.owner === null) return isAdmin(req);
  return row.owner === who(req) || isAdmin(req);
}

/**
 * Only filters the resource still declares.
 *
 * A view outlives the list it filters. When a filter is dropped from a
 * resource, the stored view keeps the key but stops applying it, which is
 * the behaviour that leaves somebody with a slightly wider list rather
 * than a page that will not load.
 */
function usable(def, filters) {
  const allowed = new Set([...(def.filters || []), 'q']);
  // A list with a date column takes `from` and `to` as well, and they are
  // not in `filters`. Without them a view like "invoiced this quarter"
  // would be counted across all time, and the number in the sidebar would
  // not be the number of rows you get when you click it.
  if (def.dateFilter) { allowed.add('from'); allowed.add('to'); }
  return Object.fromEntries(Object.entries(filters || {}).filter(([key]) => allowed.has(key)));
}

function resourceOf(name) {
  const def = resources[name];
  if (!def) throw new ApiError(422, `There is no list called "${name}".`, { fields: { resource: 'Not a list this tracker has' } });
  return def;
}

/**
 * How many records a view holds.
 *
 * One COUNT per view, through the same WHERE the list endpoint builds, so
 * the number in the sidebar is the number of rows you get when you click
 * it. A view whose resource has gone is counted as null rather than
 * failing the whole request.
 */
async function countOf(view, scope) {
  const def = resources[view.resource];
  if (!def) return null;
  const params = [];
  // The list endpoint counts through the ownership predicate (#18 Phase
  // 2C); without the same predicate here the sidebar said "2" over a page
  // showing none, and the number itself was the leak — how many records
  // exist that this reader may not open.
  const relation = def.view || def.table;
  const scoped = resourceClause(def, scope, params, { alias: relation });
  // buildWhere returns the whole clause, `WHERE …` or the empty string.
  const where = buildWhere(def, usable(def, view.filters), params, scoped ? [scoped] : []);
  const { rows } = await query(`SELECT count(*)::int AS n FROM "${relation}" ${where}`, params);
  return rows[0].n;
}

viewRouter.get('/', async (req, res) => {
  const { rows } = await query(
    `SELECT * FROM saved_views WHERE owner IS NULL OR owner = $1 ORDER BY pinned DESC, sort_order, lower(name)`,
    [who(req)]
  );
  if (req.query.counts !== '1') return res.json({ data: rows });
  // Counted in parallel: eight small COUNTs beats eight round trips. One
  // view that cannot be counted — a filter that no longer makes sense
  // against its list — comes back as null rather than taking the sidebar
  // down with it, but it is logged, because a permanently uncountable
  // view is a bug somebody should see.
  const scope = scopeOf(req);
  const counts = await Promise.all(rows.map((row) => countOf(row, scope).catch((err) => {
    console.error(`[views] cannot count "${row.name}" on ${row.resource}: ${err.message}`);
    return null;
  })));
  res.json({ data: rows.map((row, i) => ({ ...row, count: counts[i] })) });
});

viewRouter.post('/', async (req, res) => {
  const body = createSchema.parse(req.body ?? {});
  resourceOf(body.resource);
  if (body.shared && !isAdmin(req)) {
    throw new ApiError(403, 'Only an admin may save a view for everybody.');
  }
  const { rows: [row] } = await query(
    `INSERT INTO saved_views (resource, name, filters, owner, pinned, sort_order, tone, chart, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [body.resource, body.name, JSON.stringify(body.filters), body.shared ? null : who(req),
      body.pinned, body.sort_order, body.tone ?? null, body.chart ?? null, who(req)]
  ).catch((err) => {
    if (err.code === '23505') throw new ApiError(409, `You already have a view called "${body.name}" on that list.`);
    throw err;
  });
  res.status(201).json({ data: row });
});

viewRouter.patch('/:id', async (req, res) => {
  const { rows: [existing] } = await query('SELECT * FROM saved_views WHERE id = $1', [req.params.id]);
  if (!existing) throw new ApiError(404, 'No such view.');
  if (!mayWrite(req, existing)) throw new ApiError(403, 'That view is not yours to change.');

  const body = patchSchema.parse(req.body ?? {});
  if (body.resource) resourceOf(body.resource);
  if (body.shared !== undefined && !isAdmin(req)) {
    throw new ApiError(403, 'Only an admin may share a view with everybody.');
  }

  const sets = [];
  const params = [];
  const set = (col, value) => { params.push(value); sets.push(`${col} = $${params.length}`); };
  if (body.resource !== undefined) set('resource', body.resource);
  if (body.name !== undefined) set('name', body.name);
  if (body.filters !== undefined) set('filters', JSON.stringify(body.filters));
  if (body.pinned !== undefined) set('pinned', body.pinned);
  if (body.sort_order !== undefined) set('sort_order', body.sort_order);
  if (body.tone !== undefined) set('tone', body.tone ?? null);
  if (body.chart !== undefined) set('chart', body.chart ?? null);
  // Un-sharing returns a view to the person who owned it, not to whoever
  // happens to be unsharing it. An admin taking a shared view private
  // would otherwise quietly become its owner and remove it from everybody
  // else's sidebar under their own name.
  if (body.shared !== undefined) set('owner', body.shared ? null : (existing.created_by || existing.owner || who(req)));
  if (!sets.length) throw new ApiError(422, 'Nothing to change.');
  sets.push('updated_at = now()');

  params.push(req.params.id);
  const { rows: [row] } = await query(
    `UPDATE saved_views SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params
  ).catch((err) => {
    if (err.code === '23505') throw new ApiError(409, 'There is already a view with that name on that list.');
    throw err;
  });
  res.json({ data: row });
});

viewRouter.delete('/:id', async (req, res) => {
  const { rows: [existing] } = await query('SELECT * FROM saved_views WHERE id = $1', [req.params.id]);
  if (!existing) throw new ApiError(404, 'No such view.');
  if (!mayWrite(req, existing)) throw new ApiError(403, 'That view is not yours to delete.');
  await query('DELETE FROM saved_views WHERE id = $1', [req.params.id]);
  res.status(204).end();
});

/**
 * Reordering the sidebar is one request, not one per view.
 *
 * Not admin-only: a sales user may order their own sidebar. What they may
 * not do is move a view that is not theirs, so the update names the owner
 * as well as the id and a shared view simply does not match.
 */
viewRouter.post('/order', async (req, res) => {
  const parsed = z.array(z.number().int().positive()).max(50).safeParse(req.body?.order);
  if (!parsed.success) {
    throw new ApiError(422, 'Send `order` as a list of view ids, newest first.', { fields: { order: 'A list of view ids' } });
  }
  let moved = 0;
  for (const [index, id] of parsed.data.entries()) {
    const { rowCount } = await query(
      `UPDATE saved_views SET sort_order = $1, updated_at = now()
        WHERE id = $2 AND (owner = $3 OR ($4::boolean AND owner IS NULL))`,
      [index + 1, id, who(req), isAdmin(req)]
    );
    moved += rowCount;
  }
  res.json({ data: { ordered: moved } });
});
