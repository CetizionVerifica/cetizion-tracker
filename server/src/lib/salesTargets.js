import { pool } from '../db.js';
import { ApiError } from '../middleware/error.js';
import { ACTIONS, logActivity } from './activity.js';

export const SUPPORTED_TARGET_UNITS = Object.freeze(['count', 'currency', 'percentage']);

/**
 * Validate and upsert an annual sales target atomically with an audit log.
 */
export async function upsertSalesTarget(
  client,
  { salespersonUserId, calendarYear, metric, targetValue, unit, currency = null, actor }
) {
  const year = Number(calendarYear);
  if (!Number.isSafeInteger(year) || year < 2000 || year > 2100) {
    throw new ApiError(422, 'calendar_year must be an integer between 2000 and 2100');
  }

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
        AND calendar_year = $2
        AND metric = $3
        AND COALESCE(currency, '') = $4
      FOR UPDATE`,
    [targetUser.id, year, metricKey, currParam]
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
         salesperson_user_id, calendar_year, metric, target_value, unit, currency,
         created_by_user_id, updated_by_user_id, actor_type
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8)
       RETURNING *`,
      [targetUser.id, year, metricKey, numVal, unit, cleanCurrency, actorUserId, actor.type]
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
      calendar_year: year,
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
export async function listSalesTargets(
  db = pool,
  { salespersonUserId = null, calendarYear = null } = {}
) {
  const clauses = [];
  const params = [];

  if (salespersonUserId !== null) {
    params.push(Number(salespersonUserId));
    clauses.push(`t.salesperson_user_id = $${params.length}`);
  }

  if (calendarYear !== null) {
    params.push(Number(calendarYear));
    clauses.push(`t.calendar_year = $${params.length}`);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const { rows } = await db.query(
    `SELECT t.id,
            t.salesperson_user_id,
            u.name                 AS salesperson_name,
            u.email                AS salesperson_email,
            u.active               AS salesperson_active,
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
      ORDER BY t.calendar_year DESC, t.salesperson_user_id, t.metric, t.currency NULLS LAST`,
    params
  );

  return rows.map((r) => ({
    ...r,
    target_value: Number(r.target_value),
  }));
}
