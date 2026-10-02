import { pool } from '../db.js';
import { SUPPORTED_ENTITIES, getEntityDef } from './ownershipHistory.js';

/**
 * The Unassigned queue (#18 §2 and §7).
 *
 * Phase 2C made an unowned record admin-only: "we do not know whose this
 * is" reads as "not yours" to a sales user. That is the safe default and it
 * has a cost — until somebody assigns them, those records are invisible to
 * the people who actually sold them. The issue calls this out as a risk:
 * "an admin must check the Unassigned queue *before* scoping is switched
 * on, or people will lose sight of their records."
 *
 * So the queue is not a report. It is the worklist that makes the rollout
 * safe, and it needs to name records rather than count them — which is why
 * this is admin-only at the router and why db/diagnostics/ ownership SQL,
 * which is counts-only and safe to paste anywhere, is a different thing for
 * a different question.
 *
 * Ordering is oldest-first by the record's own business date, so working
 * the queue from the top clears the history that reporting most depends on.
 */

/** What a row of the queue shows, per table. Columns only — no free text beyond the name. */
const QUEUE_COLUMNS = {
  enquiries: {
    date: 'enquiry_date',
    select: `e.id, e.enquiry_no AS reference, e.client_name, e.enquiry_date AS record_date,
             e.status, e.sales_person, e.sales_person_email, e.estimated_value AS value, e.currency`,
    from: 'enquiries e',
    alias: 'e',
  },
  quotations: {
    date: 'quotation_date',
    select: `q.id, q.quotation_no AS reference, q.client_name, q.quotation_date AS record_date,
             q.status, q.sales_person, q.sales_person_email, q.quotation_value AS value, q.currency`,
    from: 'quotations q',
    alias: 'q',
  },
  projects: {
    date: 'planned_start_date',
    select: `p.id, p.project_id AS reference, p.client_name, p.planned_start_date AS record_date,
             p.project_stage AS status, p.sales_person, NULL::text AS sales_person_email,
             NULL::numeric AS value, NULL::text AS currency`,
    from: 'projects p',
    alias: 'p',
  },
};

export const QUEUE_ENTITIES = SUPPORTED_ENTITIES;

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

/** How many records are waiting, per table. Cheap enough to serve beside the list. */
export async function unassignedCounts(db = pool) {
  const { rows } = await db.query(
    QUEUE_ENTITIES.map(
      (t) => `SELECT '${t}' AS entity, COUNT(*)::int AS count FROM ${t} WHERE owner_user_id IS NULL`
    ).join(' UNION ALL ')
  );
  const byEntity = Object.fromEntries(rows.map((r) => [r.entity, r.count]));
  return {
    ...Object.fromEntries(QUEUE_ENTITIES.map((t) => [t, byEntity[t] ?? 0])),
    total: rows.reduce((n, r) => n + r.count, 0),
  };
}

/**
 * One page of the queue for one table.
 *
 * Paged by offset rather than by cursor, deliberately: the queue only ever
 * shrinks as it is worked, a cursor would skip rows as earlier ones are
 * assigned away, and an admin clearing a backlog wants page 1 to keep
 * showing whatever is still outstanding.
 */
export async function listUnassigned(db = pool, { entity, limit = DEFAULT_LIMIT, offset = 0 } = {}) {
  const spec = QUEUE_COLUMNS[entity];
  if (!spec) throw new Error(`Not an owner-scoped table: ${entity}`);

  const safeLimit = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const safeOffset = Math.max(Number(offset) || 0, 0);

  const { rows } = await db.query(
    `SELECT ${spec.select}, COUNT(*) OVER ()::int AS total_rows
       FROM ${spec.from}
      WHERE ${spec.alias}.owner_user_id IS NULL
      ORDER BY ${spec.alias}.${spec.date} ASC NULLS LAST, ${spec.alias}.id ASC
      LIMIT $1 OFFSET $2`,
    [safeLimit, safeOffset]
  );

  // COUNT(*) OVER () lives on the rows, so a page past the end has nothing
  // to read it from — the bug #142 is fixing in the MCP lists. Ask
  // separately in that one case rather than reporting a total of zero.
  let total = rows.length ? Number(rows[0].total_rows) : null;
  if (total === null) {
    const { rows: [c] } = await db.query(
      `SELECT COUNT(*)::int AS total FROM ${spec.from} WHERE ${spec.alias}.owner_user_id IS NULL`
    );
    total = c.total;
  }

  return {
    entity,
    limit: safeLimit,
    offset: safeOffset,
    total,
    has_more: safeOffset + rows.length < total,
    records: rows.map(({ total_rows, ...r }) => r),
  };
}

/**
 * The candidate owner each unowned record's own text points at, if any.
 *
 * The same two rules 060 applies — an exact email, or an unambiguous name —
 * asked one record at a time so an admin can accept a suggestion rather
 * than retype it. A suggestion is never applied automatically: that is the
 * whole distinction between this and the backfill.
 */
export async function suggestOwners(db = pool, { entity, ids }) {
  const def = getEntityDef(entity);
  if (!ids?.length) return [];

  const emailColumn = entity === 'projects' ? 'NULL::text' : `r.sales_person_email`;
  const { rows } = await db.query(
    `SELECT r.id,
            (SELECT u.id FROM users u
              WHERE ${emailColumn} IS NOT NULL AND btrim(${emailColumn}) <> ''
                AND u.email IS NOT NULL
                AND lower(btrim(u.email)) = lower(btrim(${emailColumn}))
              LIMIT 1)                                             AS by_email,
            (SELECT u.id FROM users u
              WHERE r.sales_person IS NOT NULL AND btrim(r.sales_person) <> ''
                AND lower(regexp_replace(btrim(u.name), '\\s+', ' ', 'g'))
                  = lower(regexp_replace(btrim(r.sales_person), '\\s+', ' ', 'g'))
              LIMIT 1)                                             AS by_name,
            (SELECT COUNT(*)::int FROM users u
              WHERE r.sales_person IS NOT NULL AND btrim(r.sales_person) <> ''
                AND lower(regexp_replace(btrim(u.name), '\\s+', ' ', 'g'))
                  = lower(regexp_replace(btrim(r.sales_person), '\\s+', ' ', 'g'))) AS name_matches
       FROM ${def.table} r
      WHERE r.id = ANY($1::int[]) AND r.owner_user_id IS NULL`,
    [ids]
  );

  return rows.map((r) => ({
    id: r.id,
    suggested_user_id: r.by_email ?? (r.name_matches === 1 ? r.by_name : null),
    basis: r.by_email ? 'email' : r.name_matches === 1 ? 'name' : null,
    ambiguous: r.name_matches > 1,
  }));
}
