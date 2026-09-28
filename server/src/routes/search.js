import { Router } from 'express';
import { resourceClause, scopeOf } from '../auth/ownership.js';
import { query } from '../db.js';
import { resources } from '../lib/resources.js';
import { nameKey, normalizeName } from '../lib/names.ts';

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

/**
 * Hits per object: five unless the caller asks (?limit=), and never more
 * than twenty. Past that, the answer is better words, not a longer list.
 */
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;
const MAX_Q = 120;

function perType(raw) {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, MAX_LIMIT) : DEFAULT_LIMIT;
}

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
 * `%` and `_` are LIKE's own wildcards, so a query of "%" would otherwise
 * match every row of every object — the palette answering a keystroke with
 * the whole database. They are characters people type, not patterns they
 * meant, so they are escaped and searched for literally.
 */
const escapeLike = (q) => q.replace(/([\\%_])/g, '\\$1');

/**
 * A column the way names are compared everywhere else in the app (#75):
 * case ignored, runs of spaces one space, the ends trimmed. The query goes
 * through normalizeName, the same rule in JavaScript, so "hetero  LABS"
 * finds "Hetero Labs" and "CTZ/QT/2026/064 " finds its quotation.
 */
const key = (column) => nameKey(`s."${column}"::text`);

/**
 * One object's hits, best first.
 *
 * Rank 0 is the record whose own reference is exactly what was typed, then
 * any column matching exactly, then one starting with it, then one merely
 * containing it; the list page's own order breaks ties. The match cannot
 * use an index, which is fine at this size and is the reason for the
 * per-object limit — eight small scans, not one big one. One row past the
 * limit is read so the answer can say there were more.
 *
 * The relation is aliased `s` so the ownership predicate can name columns on
 * it (#18 Phase 2C): the palette is the easiest place for row-level access to
 * go missing and the worst place for it to, since one keystroke would
 * otherwise return somebody else's quotation numbers and clients.
 */
async function hits(entry, q, limit, scope) {
  const def = resources[entry.resource];
  if (!def?.search?.length) return { rows: [], more: false };
  const from = def.view || def.table;
  const columns = columnsFor(entry).map((c) => `s."${c}"`).join(', ');
  const any = (test) => def.search.map((c) => `${key(c)} ${test}`).join(' OR ');
  const params = [q, `${escapeLike(q)}%`, `%${escapeLike(q)}%`];
  const mine = resourceClause(def, scope, params, { alias: 's' });
  // The match is parenthesised: it is a chain of ORs, and ownership is an
  // AND over the whole of it, not an alternative to the last column.
  const { rows } = await query(
    `SELECT ${columns},
            CASE WHEN ${key(entry.title)} = $1 THEN 0
                 WHEN ${any('= $1')} THEN 1
                 WHEN ${any(`LIKE $2 ESCAPE '\\'`)} THEN 2
                 ELSE 3 END AS rank
       FROM "${from}" s
      WHERE (${any(`LIKE $3 ESCAPE '\\'`)}) ${mine ? `AND ${mine}` : ''}
      ORDER BY rank, ${def.defaultSort}
      LIMIT ${limit + 1}`,
    params
  );
  return {
    more: rows.length > limit,
    rows: rows.slice(0, limit).map((row) => ({
      type: entry.type,
      label: def.label,
      icon: entry.icon,
      id: row.id,
      title: String(row[entry.title] ?? (entry.fallbackTitle ? row[entry.fallbackTitle] : '') ?? ''),
      subtitle: entry.subtitle.map((c) => row[c]).filter(Boolean).join(' · '),
      state: entry.state ? row[entry.state] || null : null,
      href: entry.href(row),
      rank: row.rank,
    })),
  };
}

/**
 * GET /api/search?q=&limit=
 *
 * Empty or one-character queries answer with nothing rather than with
 * everything: a palette that lists the whole database on the first
 * keystroke is noise, and the "Do" verbs above it are the useful answer
 * until somebody has typed enough to mean a particular record.
 */
searchRouter.get('/', async (req, res) => {
  const q = normalizeName(String(req.query.q ?? '').slice(0, MAX_Q));
  const limit = perType(req.query.limit);
  if (q.length < 2) return res.json({ data: [], meta: { q, limit, truncated: false } });

  const scope = scopeOf(req);
  const found = await Promise.all(SEARCHABLE.map((entry) => hits(entry, q, limit, scope)));
  // Best rank first across objects, and in SEARCHABLE order within a rank
  // (the sort is stable), so the palette, which groups by type in the order
  // the types arrive, opens on the group holding the exact reference.
  const data = found.flatMap((one) => one.rows).sort((a, b) => a.rank - b.rank);
  res.json({
    data,
    meta: { q, limit, truncated: found.some((one) => one.more) },
  });
});
