import { Router } from 'express';
import { resourceClause, scopeOf } from '../auth/ownership.js';
import { query } from '../db.js';
import { resources } from '../lib/resources.js';

export const searchRouter = Router();

/**
 * One search across the objects a person actually looks things up by.
 *
 * The palette is the answer to "I can't work out how to do something", so
 * this has to find a record from whatever fragment somebody remembers — a
 * quotation number, half a client's name, a PO, a destination. It does not
 * need to be clever: every one of these objects already declares the
 * columns it is searched on, for its own list page, and those are the
 * columns somebody would type.
 *
 * Nothing here decides what a person may see, and that has to keep being
 * true now records have owners (#18 Phase 2C). Each object is searched
 * through the same view its list endpoint reads AND under the same ownership
 * predicate that endpoint applies, so search shows exactly what opening that
 * list would have shown and no more. Without the predicate the palette would
 * be the way around row-level access: two characters and somebody else's
 * quotation numbers, clients and project ids come back.
 */

/** 24 rows is two screenfuls in the palette; past that, refine the words. */
const PER_TYPE = 6;
const TOTAL = 24;
const MAX_Q = 120;

/**
 * What the palette draws for a hit: a title you would recognise, a line of
 * context under it, and where it goes.
 *
 * `title` is the natural key where the object has one, because that is what
 * people quote to each other. Companies and contacts are the exception:
 * nobody refers to a company by its id.
 */
const SEARCHABLE = [
  {
    type: 'deal', resource: 'quotations', icon: 'deal',
    title: 'quotation_no', subtitle: ['client_name', 'service_quoted'],
    state: 'status', href: (r) => `/quotations/${encodeURIComponent(r.quotation_no)}`,
  },
  {
    type: 'enquiry', resource: 'enquiries', icon: 'deal',
    title: 'enquiry_no', subtitle: ['client_name', 'service'],
    state: 'status', href: () => '/enquiries',
  },
  {
    type: 'company', resource: 'companies', icon: 'company',
    title: 'name', subtitle: ['sector', 'city'],
    href: (r) => `/companies/${r.id}`,
  },
  {
    type: 'contact', resource: 'contacts', icon: 'company',
    title: 'name', subtitle: ['role', 'email'],
    href: (r) => (r.company_id ? `/companies/${r.company_id}` : '/companies'),
  },
  {
    type: 'project', resource: 'projects', icon: 'project',
    title: 'project_id', subtitle: ['client_name', 'primary_service'],
    state: 'project_stage', href: (r) => `/projects/${encodeURIComponent(r.project_id)}`,
  },
  {
    type: 'order', resource: 'purchase-orders', icon: 'order',
    title: 'po_number', subtitle: ['client_name', 'project_id'],
    href: (r) => `/purchase-orders/${encodeURIComponent(r.po_number)}`,
  },
  {
    type: 'stage', resource: 'payment-stages', icon: 'money',
    title: 'invoice_no', fallbackTitle: 'stage_name',
    subtitle: ['client_name', 'po_number'],
    state: 'stage_status', href: () => '/payment-stages',
  },
  {
    type: 'trip', resource: 'travel-logs', icon: 'trip',
    title: 'travel_id', subtitle: ['employee_name', 'destination'],
    href: () => '/travel',
  },
];

/** Every column the row needs, with no duplicates and nothing else. */
function columnsFor(entry) {
  const wanted = ['id', entry.title, entry.fallbackTitle, entry.state, ...entry.subtitle];
  if (entry.type === 'contact') wanted.push('company_id');
  return [...new Set(wanted.filter(Boolean))];
}

/**
 * What somebody typed, as a pattern that means only itself.
 *
 * `%` and `_` are ILIKE's own wildcards, so a query of "%" would otherwise
 * match every row of every object — the palette answering a keystroke with
 * the whole database. They are characters people type, not patterns they
 * meant, so they are escaped and searched for literally.
 */
function pattern(q) {
  return `%${q.replace(/([\\%_])/g, '\\$1')}%`;
}

/**
 * One object's hits.
 *
 * The ILIKE is the same shape the list pages use. It cannot use an index,
 * which is fine at this size and is the reason for the per-object limit —
 * eight small scans, not one big one.
 */
async function hits(entry, q, scope) {
  const def = resources[entry.resource];
  if (!def?.search?.length) return [];
  const from = def.view || def.table;
  // Aliased, because a parent-derived predicate has to name columns on the
  // relation this statement reads (resourceClause insists on being told).
  const columns = columnsFor(entry).map((c) => `s."${c}"`).join(', ');
  const params = [pattern(q)];
  const matches = def.search.map((c) => `s."${c}"::text ILIKE $1 ESCAPE '\\'`).join(' OR ');
  const mine = resourceClause(def, scope, params, { alias: 's' });
  // The match is parenthesised: it is a chain of ORs, and ownership is an
  // AND over the whole of it, not an alternative to the last column.
  const { rows } = await query(
    `SELECT ${columns} FROM "${from}" s
      WHERE (${matches}) ${mine ? `AND ${mine}` : ''}
      ORDER BY ${def.defaultSort} LIMIT ${PER_TYPE}`,
    params
  );
  return rows.map((row) => ({
    type: entry.type,
    label: def.label,
    icon: entry.icon,
    id: row.id,
    title: String(row[entry.title] ?? (entry.fallbackTitle ? row[entry.fallbackTitle] : '') ?? ''),
    subtitle: entry.subtitle.map((c) => row[c]).filter(Boolean).join(' · '),
    state: entry.state ? row[entry.state] || null : null,
    href: entry.href(row),
  }));
}

/**
 * GET /api/search?q=
 *
 * Empty or one-character queries answer with nothing rather than with
 * everything: a palette that lists the whole database on the first
 * keystroke is noise, and the "Do" verbs above it are the useful answer
 * until somebody has typed enough to mean a particular record.
 */
searchRouter.get('/', async (req, res) => {
  const q = String(req.query.q ?? '').trim().slice(0, MAX_Q);
  if (q.length < 2) return res.json({ data: [], meta: { q, truncated: false } });

  const scope = scopeOf(req);
  const found = await Promise.all(SEARCHABLE.map((entry) => hits(entry, q, scope)));
  const data = found.flat();
  res.json({
    data: data.slice(0, TOTAL),
    meta: { q, truncated: data.length > TOTAL },
  });
});
