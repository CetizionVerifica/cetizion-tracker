/**
 * One tool for the whole class of "how many X by Y" questions (#140).
 *
 * Every counted question was becoming its own tool — deals by stage, value
 * by salesperson, wins by month, quotations by sector — and each one is the
 * same GROUP BY with different words around it. This is that GROUP BY, with
 * the columns checked against the table rather than trusted.
 *
 * Two things it does not do. It does not invent scoping: an entity is only
 * aggregatable by a sales token when this file knows how to restrict it to
 * that person's records, and everything else is admin-only. And it does not
 * interpolate anything a caller sent — group_by, the measured column and
 * the filters are all matched against the real column list first, because a
 * GROUP BY built from a string is a SQL injection with a nice name.
 */
import { query } from '../../db.js';
import { ApiError } from '../../middleware/error.js';
import { resources } from '../resources.js';
import { isAdmin, own, ownCompany } from './data.js';
import { ownProjectSql } from '../scope.js';

/**
 * How each entity is narrowed to one person's records.
 *
 * Only the entities whose ownership this can state. An entity missing from
 * here is not "unscoped", it is admin-only — the safe reading of "I do not
 * know who owns this" is not "everybody".
 *
 * The shims exist because ownProjectSql takes a request. isAdmin(req) reads
 * `!req?.user || role === 'admin'`, so a shim without a user counts as an
 * admin: `user` is always set, and always with the role.
 */
const SCOPED = {
  quotations: (scope, params) => own(scope, 'sales_person', params),
  enquiries: (scope, params) => own(scope, 'sales_person', params),
  projects: (scope, params) => own(scope, 'sales_person', params),
  companies: (scope, params) => ownCompany(scope, 'id', params),
  'purchase-orders': (scope, params) => ownProjectSql(reqShim(scope), 'v_purchase_orders', params) || 'TRUE',
  'payment-stages': (scope, params) => ownProjectSql(reqShim(scope), 'v_payment_stages', params) || 'TRUE',
};

const reqShim = (scope) => ({ user: { role: scope.role, username: scope.person, name: scope.person } });

const MEASURES = ['count', 'sum', 'avg', 'min', 'max'];
export const aggregatable = () => Object.keys(resources).filter((k) => resources[k].schema);

/** The real columns of the view a resource is read from, cached per process. */
const columnCache = new Map();
async function columnsOf(entity) {
  if (columnCache.has(entity)) return columnCache.get(entity);
  const def = resources[entity];
  const from = def.view || def.table;
  const { rows } = await query(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1`, [from]);
  const cols = new Map(rows.map((r) => [r.column_name, r.data_type]));
  columnCache.set(entity, cols);
  return cols;
}

const NUMERIC = new Set(['integer', 'bigint', 'smallint', 'numeric', 'real', 'double precision']);
const DATEISH = new Set(['date', 'timestamp with time zone', 'timestamp without time zone']);

/**
 * Group a resource and count or total it.
 *
 * `by` may name a date column with a period — "quotation_date:month" — which
 * is the form most of these questions actually take: not "by date" but "by
 * month". Filters are the same ones the list screens accept, applied by the
 * same buildWhere, so a figure here and a filtered list agree.
 */
export async function aggregate(scope, { entity, by, measure = 'count', of, where = {}, limit = 50, order = 'value' }) {
  const def = resources[entity];
  if (!def || !def.schema) {
    throw new ApiError(422, `"${entity}" cannot be grouped. Call describe_aggregate for the list.`);
  }
  if (!MEASURES.includes(measure)) throw new ApiError(422, `measure must be one of ${MEASURES.join(', ')}.`);

  const scoper = SCOPED[entity];
  if (!isAdmin(scope) && !scoper) {
    throw new ApiError(403, `${entity} can only be grouped by an admin token: this server cannot say whose records those are.`);
  }

  const cols = await columnsOf(entity);
  const params = [];

  // ---- what we are grouping by ------------------------------------
  const [byCol, period] = String(by || '').split(':');
  if (!byCol) throw new ApiError(422, 'Say what to group by, e.g. by: "stage" or by: "quotation_date:month".');
  if (!cols.has(byCol)) {
    throw new ApiError(422, `"${byCol}" is not a column of ${entity}. It has: ${[...cols.keys()].slice(0, 40).join(', ')}`);
  }
  let groupExpr = q(byCol);
  if (period) {
    if (!DATEISH.has(cols.get(byCol))) throw new ApiError(422, `"${byCol}" is not a date, so it cannot be grouped by ${period}.`);
    if (!['day', 'week', 'month', 'quarter', 'year'].includes(period)) {
      throw new ApiError(422, 'Period must be day, week, month, quarter or year.');
    }
    groupExpr = `to_char(date_trunc('${period}', ${q(byCol)}), ${period === 'month' ? `'YYYY-MM'` : period === 'year' ? `'YYYY'` : `'YYYY-MM-DD'`})`;
  }

  // ---- what we are measuring --------------------------------------
  let valueExpr = 'count(*)::numeric';
  if (measure !== 'count') {
    if (!of) throw new ApiError(422, `measure "${measure}" needs a column: of: "quotation_value".`);
    if (!cols.has(of)) throw new ApiError(422, `"${of}" is not a column of ${entity}.`);
    if (!NUMERIC.has(cols.get(of))) throw new ApiError(422, `"${of}" is not a number, so it cannot be ${measure}'d.`);
    valueExpr = `${measure}(${q(of)})::numeric`;
  }

  // ---- filters, the same ones the list screens take ----------------
  const clauses = [];
  for (const [key, raw] of Object.entries(where || {})) {
    if (!cols.has(key)) throw new ApiError(422, `Cannot filter on "${key}": ${entity} has no such column.`);
    if (raw === null || raw === '__none__') { clauses.push(`${q(key)} IS NULL`); continue; }
    if (raw === '__any__') { clauses.push(`${q(key)} IS NOT NULL`); continue; }
    if (Array.isArray(raw)) {
      params.push(raw.map(String));
      clauses.push(`${q(key)}::text = ANY($${params.length}::text[])`);
      continue;
    }
    params.push(String(raw));
    clauses.push(`${q(key)}::text = $${params.length}`);
  }
  if (!isAdmin(scope)) {
    const scoped = scoper(scope, params);
    if (scoped && scoped !== 'TRUE') clauses.push(scoped);
  }

  const from = def.view || def.table;
  const { rows } = await query(
    `SELECT ${groupExpr} AS group, ${valueExpr} AS value, count(*)::int AS rows
       FROM ${q(from)}
      ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      GROUP BY ${groupExpr}
      ORDER BY ${order === 'group' ? '1 ASC' : '2 DESC NULLS LAST'}
      LIMIT ${Math.min(Math.max(Number(limit) || 50, 1), 200)}`, params);

  const groups = rows.map((r) => ({
    group: r.group === null ? null : String(r.group),
    value: r.value === null ? null : Number(r.value),
    rows: r.rows,
  }));
  return {
    entity,
    grouped_by: period ? `${byCol} by ${period}` : byCol,
    measure: measure === 'count' ? 'count' : `${measure} of ${of}`,
    groups,
    // The total of what came back, so a caller does not have to add it up
    // and cannot add it up wrongly. Only meaningful for count and sum.
    total: ['count', 'sum'].includes(measure) ? round(groups.reduce((n, g) => n + (g.value ?? 0), 0)) : null,
    groups_returned: groups.length,
    // A blank group is a real answer — "how many quotations have no sector"
    // is one of the questions this is for — so it is named rather than
    // dropped.
    blank_group_means: 'no value recorded in that column',
  };
}

const round = (n) => Math.round(n * 100) / 100;
/** Quote an identifier. Every one here has already been matched against the table. */
const q = (name) => `"${String(name).replace(/"/g, '')}"`;

/** What can be grouped, and by what. */
export async function describeAggregate(scope, { entity } = {}) {
  if (!entity) {
    return {
      entities: aggregatable().map((name) => ({ name, scoped: Boolean(SCOPED[name]) || isAdmin(scope) })),
      measures: MEASURES,
      periods: ['day', 'week', 'month', 'quarter', 'year'],
      note: 'Group by a column, or by a date column and a period: "quotation_date:month". Name an entity here to see its columns.',
    };
  }
  if (!resources[entity]?.schema) throw new ApiError(422, `"${entity}" cannot be grouped.`);
  if (!isAdmin(scope) && !SCOPED[entity]) {
    throw new ApiError(403, `${entity} can only be grouped by an admin token.`);
  }
  const cols = await columnsOf(entity);
  return {
    entity,
    group_by: [...cols.keys()],
    dates: [...cols].filter(([, t]) => DATEISH.has(t)).map(([c]) => c),
    numbers: [...cols].filter(([, t]) => NUMERIC.has(t)).map(([c]) => c),
  };
}
