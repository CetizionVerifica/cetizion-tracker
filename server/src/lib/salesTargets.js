import { pool } from '../db.js';
import { ApiError } from '../middleware/error.js';
import { ACTIONS, logActivity } from './activity.js';
import { resolvePeriod } from './reportingPeriod.js';

export const SUPPORTED_TARGET_UNITS = Object.freeze(['count', 'currency', 'percentage']);

/**
 * A target covers a whole month, quarter or year — never an arbitrary range.
 *
 * #18 §4 asks for monthly targets, and monthly is what rolls up: an annual
 * figure is the sum of its months, while the reverse is an invention. A
 * target over "12 March to 4 May" could not be summed with anything or
 * compared with any report period, so it is refused rather than stored.
 */
export const TARGET_PERIOD_TYPES = Object.freeze(['month', 'quarter', 'fy', 'calendar-year']);

/**
 * 066 stores three period types; resolvePeriod names two kinds of year
 * because a report needs to tell an April-to-March year from a January one.
 * A stored target does not: its dates already say which, and a fourth value
 * in the CHECK would have to be added to every database to record something
 * the row can be read off directly.
 */
const storedPeriodType = (type) => (type === 'fy' || type === 'calendar-year' ? 'year' : type);

/**
 * Validate and upsert an annual sales target atomically with an audit log.
 */
export async function upsertSalesTarget(
  client,
  { salespersonUserId, period, metric, targetValue, unit, currency = null, actor }
) {
  // A target belongs to a period, not to a calendar year (#18 §4, 066).
  // The caller passes the same shape every report uses, so "the target for
  // March" and "March's figures" cannot describe different months.
  const { from, to, type } = resolvePeriod(period);
  if (!TARGET_PERIOD_TYPES.includes(type)) {
    throw new ApiError(422, `A target covers a whole ${TARGET_PERIOD_TYPES.join(', a ')} — not a custom range`);
  }
  // Kept in step for anything still reading it; 066 made it derived.
  const year = Number(from.slice(0, 4));

  const metricKey = String(metric ?? '').trim();
  if (!metricKey) {
    throw new ApiError(422, 'metric is required');
  }

  if (!SUPPORTED_TARGET_UNITS.includes(unit)) {
    throw new ApiError(422, `unit must be one of: ${SUPPORTED_TARGET_UNITS.join(', ')}`);
  }

  const numVal = Number(targetValue);
  if (Number.isNaN(numVal) || numVal < 0) {
    throw new ApiError(422, 'target_value must be a non-negative number');
  }

  let cleanCurrency = currency ? String(currency).trim() : null;

  if (unit === 'count') {
    if (!Number.isInteger(numVal)) {
      throw new ApiError(422, 'Count target_value must be a whole integer');
    }
    if (cleanCurrency !== null) {
      throw new ApiError(422, 'Count targets must not have a currency specified');
    }
  } else if (unit === 'percentage') {
    if (numVal < 0 || numVal > 100) {
      throw new ApiError(422, 'Percentage target_value must be between 0 and 100');
    }
    if (cleanCurrency !== null) {
      throw new ApiError(422, 'Percentage targets must not have a currency specified');
    }
  } else if (unit === 'currency') {
    if (!cleanCurrency) {
      throw new ApiError(422, 'Currency is required for monetary targets');
    }
  }

  // Validate target salesperson exists and has role 'sales'
  const { rows: userRows } = await client.query(
    'SELECT id, name, role, active FROM users WHERE id = $1',
    [salespersonUserId]
  );
  if (!userRows.length) {
    throw new ApiError(422, 'Target salesperson does not exist');
  }
  const targetUser = userRows[0];
  if (targetUser.role !== 'sales') {
    throw new ApiError(422, `Cannot set sales target for user with role '${targetUser.role}'. User must have role 'sales'`);
  }

  const actorUserId = actor.type === 'user' ? actor.userId : null;
  const currParam = cleanCurrency ?? '';

  // Check if target already exists under row lock
  const { rows: existingRows } = await client.query(
    `SELECT * FROM sales_targets
      WHERE salesperson_user_id = $1
        AND period_start = $2::date AND period_end = $3::date
        AND metric = $4
        AND COALESCE(currency, '') = $5
      FOR UPDATE`,
    [targetUser.id, from, to, metricKey, currParam]
  );

  let target;
  let isCreated = false;
  let previousValue = null;

  if (existingRows.length) {
    const existing = existingRows[0];
    previousValue = existing.target_value;

    const { rows: updated } = await client.query(
      `UPDATE sales_targets
          SET target_value = $1,
              unit = $2,
              currency = $3,
              updated_by_user_id = $4,
              actor_type = $5,
              updated_at = now()
        WHERE id = $6
        RETURNING *`,
      [numVal, unit, cleanCurrency, actorUserId, actor.type, existing.id]
    );
    target = updated[0];
  } else {
    isCreated = true;
    const { rows: inserted } = await client.query(
      `INSERT INTO sales_targets (
         salesperson_user_id, period_start, period_end, period_type, calendar_year,
         metric, target_value, unit, currency,
         created_by_user_id, updated_by_user_id, actor_type
       ) VALUES ($1, $2::date, $3::date, $4, $5, $6, $7, $8, $9, $10, $10, $11)
       RETURNING *`,
      [targetUser.id, from, to, storedPeriodType(type), year,
        metricKey, numVal, unit, cleanCurrency, actorUserId, actor.type]
    );
    target = inserted[0];
  }

  // Audit event in activity_log
  await logActivity(client, {
    actor,
    action: isCreated ? ACTIONS.TARGET_CREATED : ACTIONS.TARGET_UPDATED,
    entityType: 'sales_targets',
    entityId: String(target.id),
    metadata: {
      salesperson_user_id: targetUser.id,
      salesperson_name: targetUser.name,
      period_start: from,
      period_end: to,
      period_type: type,
      metric: metricKey,
      previous_target_value: previousValue !== null ? Number(previousValue) : null,
      new_target_value: numVal,
      unit,
      currency: cleanCurrency,
    },
  });

  return {
    target: {
      ...target,
      target_value: Number(target.target_value),
    },
    isCreated,
  };
}

/**
 * List annual sales targets filtered by year and/or salesperson.
 */
/**
 * Targets for a set of people, optionally narrowed to a date range.
 *
 * `salespersonUserIds` rather than one id: the team report asks once for
 * everybody, so the page does not issue one query per person (#18's
 * performance note).
 *
 * The range filter selects targets lying wholly inside it, which is what
 * makes an annual attainment the sum of its months rather than the months
 * plus a year counted twice.
 */
export async function listSalesTargets(
  db = pool,
  { salespersonUserId = null, salespersonUserIds = null, from = null, to = null } = {}
) {
  const clauses = [];
  const params = [];

  if (salespersonUserId !== null) {
    params.push(Number(salespersonUserId));
    clauses.push(`t.salesperson_user_id = $${params.length}`);
  }

  if (salespersonUserIds !== null) {
    params.push(salespersonUserIds.map(Number));
    clauses.push(`t.salesperson_user_id = ANY($${params.length}::int[])`);
  }

  if (from !== null && to !== null) {
    params.push(from, to);
    clauses.push(`t.period_start >= $${params.length - 1}::date AND t.period_end <= $${params.length}::date`);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const { rows } = await db.query(
    `SELECT t.id,
            t.salesperson_user_id,
            u.name                 AS salesperson_name,
            u.email                AS salesperson_email,
            u.active               AS salesperson_active,
            -- As text, not as a date. node-postgres turns a date column into a
            -- JS Date at local midnight, and every caller then has to
            -- convert it back without tripping over the timezone —
            -- String(d).slice(0, 10) yields "Wed Apr 01", which compares
            -- against an ISO string in the wrong order and silently. The
            -- database already holds the exact characters wanted.
            t.period_start::text AS period_start,
            t.period_end::text   AS period_end,
            t.period_type,
            t.calendar_year,
            t.metric,
            t.target_value::numeric AS target_value,
            t.unit,
            t.currency,
            t.created_at,
            t.updated_at
       FROM sales_targets t
       JOIN users u ON u.id = t.salesperson_user_id
       ${where}
      ORDER BY t.period_start DESC, t.salesperson_user_id, t.metric, t.currency NULLS LAST`,
    params
  );

  return rows.map((r) => ({
    ...r,
    target_value: Number(r.target_value),
  }));
}
