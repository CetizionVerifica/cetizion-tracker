import { pool } from '../db.js';
import { ACTIONS, logActivity } from './activity.js';
import { idPredicate } from './crud.js';
import { resources } from './resources.js';
import { ApiError } from '../middleware/error.js';

export const SUPPORTED_ENTITIES = Object.freeze(['enquiries', 'quotations', 'projects']);

/**
 * Validate that an entity name is one of the three ownership-scoped resources.
 */
export function getEntityDef(entityType) {
  if (!SUPPORTED_ENTITIES.includes(entityType)) {
    throw new ApiError(404, `Unsupported ownership resource: ${entityType}`);
  }
  const def = resources[entityType];
  if (!def) {
    throw new ApiError(404, `Resource definition not found: ${entityType}`);
  }
  return def;
}

/**
 * Change record owner atomically within a transaction.
 *
 * Steps performed under row locks:
 * 1. Lock the business record with SELECT ... FOR UPDATE.
 * 2. Validate expected_owner_user_id against the locked record. If mismatched -> 409 Conflict.
 * 3. If new_owner_user_id === currentOwnerId -> return 200 no-op (no history/activity created).
 * 4. If new_owner_user_id is non-null:
 *    Lock the target user with SELECT ... FOR UPDATE.
 *    Validate that the user exists, is active, and has role = 'sales'.
 * 5. Update the business record's owner_user_id and updated_at.
 * 6. Insert immutable attribution history record into ownership_history.
 * 7. Emit atomic audit event via logActivity.
 *
 * @param {import('pg').PoolClient} client Transactional client
 */
export async function changeRecordOwner(
  client,
  { entityType, entityIdOrKey, expectedOwnerId, newOwnerId, reason, actor }
) {
  const def = getEntityDef(entityType);

  // 1. Lock the business record
  const params = [];
  const pred = idPredicate(def, entityIdOrKey, params);
  const { rows: recordRows } = await client.query(
    `SELECT * FROM "${def.table}" WHERE ${pred} FOR UPDATE`,
    params
  );

  if (!recordRows.length) {
    throw new ApiError(404, `${def.label} not found`);
  }

  const record = recordRows[0];
  const currentOwnerId = record.owner_user_id;

  // 2. Validate expected owner before handling no-op
  if (expectedOwnerId !== currentOwnerId) {
    throw new ApiError(
      409,
      `Ownership conflict: record is currently owned by ${
        currentOwnerId === null ? 'nobody (unassigned)' : `user ${currentOwnerId}`
      }, but request expected ${
        expectedOwnerId === null ? 'nobody (unassigned)' : `user ${expectedOwnerId}`
      }`
    );
  }

  // 3. True no-op check: proposing the already-current owner after successful expected-owner check
  if (newOwnerId === currentOwnerId) {
    return {
      record,
      history: null,
      noOp: true,
    };
  }

  // 4. Validate target owner eligibility under row lock
  let targetUserSnapshot = { id: null, name: null };
  if (newOwnerId !== null) {
    // Row lock target user with FOR UPDATE to prevent concurrent deactivation race
    const { rows: userRows } = await client.query(
      `SELECT id, name, email, role, active FROM users WHERE id = $1 FOR UPDATE`,
      [newOwnerId]
    );

    if (!userRows.length) {
      throw new ApiError(422, 'Target user does not exist');
    }

    const targetUser = userRows[0];
    if (!targetUser.active) {
      throw new ApiError(422, 'Cannot assign record to an inactive user');
    }

    if (targetUser.role !== 'sales') {
      throw new ApiError(
        422,
        `Cannot assign record to user with role '${targetUser.role}'. Target user must have role 'sales'`
      );
    }

    targetUserSnapshot = { id: targetUser.id, name: targetUser.name };
  }

  // Capture previous owner snapshot
  let prevUserSnapshot = { id: null, name: null };
  if (currentOwnerId !== null) {
    const { rows: prevUserRows } = await client.query(
      `SELECT id, name FROM users WHERE id = $1`,
      [currentOwnerId]
    );
    prevUserSnapshot = {
      id: currentOwnerId,
      name: prevUserRows[0]?.name ?? null,
    };
  }

  // Capture actor snapshot
  let changedBySnapshot = { id: null, name: null };
  if (actor.type === 'user') {
    changedBySnapshot = { id: actor.userId, name: actor.name };
  } else if (actor.type === 'shared_admin') {
    changedBySnapshot = { id: null, name: actor.name || 'admin' };
  } else {
    changedBySnapshot = { id: null, name: 'system' };
  }

  // 5. Update record owner
  const { rows: updatedRows } = await client.query(
    `UPDATE "${def.table}" SET owner_user_id = $1, updated_at = now() WHERE id = $2 RETURNING *`,
    [newOwnerId, record.id]
  );
  const updatedRecord = updatedRows[0];

  // 6. Insert ownership history entry
  const { rows: historyRows } = await client.query(
    `INSERT INTO ownership_history (
       entity_type, entity_id,
       previous_owner_user_id, previous_owner_snapshot_id, previous_owner_name,
       new_owner_user_id, new_owner_snapshot_id, new_owner_name,
       changed_by_user_id, changed_by_snapshot_id, changed_by_name,
       actor_type, reason
     ) VALUES (
       $1, $2,
       $3, $4, $5,
       $6, $7, $8,
       $9, $10, $11,
       $12, $13
     ) RETURNING *`,
    [
      def.table,
      record.id,
      currentOwnerId,
      prevUserSnapshot.id,
      prevUserSnapshot.name,
      newOwnerId,
      targetUserSnapshot.id,
      targetUserSnapshot.name,
      actor.type === 'user' ? (actor.userId ?? null) : null,
      changedBySnapshot.id,
      changedBySnapshot.name,
      actor.type,
      reason,
    ]
  );
  const history = historyRows[0];

  // 7. Emit atomic activity event
  let actionKey = ACTIONS.OWNERSHIP_ASSIGNED;
  if (currentOwnerId === null && newOwnerId !== null) {
    actionKey = ACTIONS.OWNERSHIP_ASSIGNED;
  } else if (currentOwnerId !== null && newOwnerId !== null) {
    actionKey = ACTIONS.OWNERSHIP_REASSIGNED;
  } else if (currentOwnerId !== null && newOwnerId === null) {
    actionKey = ACTIONS.OWNERSHIP_UNASSIGNED;
  }

  await logActivity(client, {
    actor,
    action: actionKey,
    entityType: def.table,
    entityId: String(record.id),
    metadata: {
      previous_owner_user_id: currentOwnerId,
      new_owner_user_id: newOwnerId,
      ownership_history_id: history.id,
      reason,
    },
  });

  return {
    record: updatedRecord,
    history,
    noOp: false,
  };
}

/**
 * Query ownership history for a given entity with immutable attribution snapshots.
 */
export async function listRecordOwnershipHistory(
  db = pool,
  { entityType, entityIdOrKey, limit = 50, before = null }
) {
  const def = getEntityDef(entityType);

  // Validate parent record exists
  const parentParams = [];
  const parentPred = idPredicate(def, entityIdOrKey, parentParams);
  const { rows: parentRows } = await db.query(
    `SELECT id, owner_user_id FROM "${def.table}" WHERE ${parentPred}`,
    parentParams
  );

  if (!parentRows.length) {
    throw new ApiError(404, `${def.label} not found`);
  }

  const parentId = parentRows[0].id;

  const queryParams = [def.table, parentId];
  let cursorClause = '';
  if (before !== null && Number.isSafeInteger(Number(before)) && Number(before) > 0) {
    queryParams.push(Number(before));
    cursorClause = `AND h.id < $${queryParams.length}`;
  }

  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 500);
  queryParams.push(safeLimit);
  const limitClause = `LIMIT $${queryParams.length}`;

  const sql = `
    SELECT
      h.id,
      h.entity_type,
      h.entity_id,
      h.previous_owner_user_id,
      h.previous_owner_snapshot_id,
      h.previous_owner_name,
      h.new_owner_user_id,
      h.new_owner_snapshot_id,
      h.new_owner_name,
      h.changed_by_user_id,
      h.changed_by_snapshot_id,
      h.changed_by_name,
      h.actor_type,
      h.reason,
      h.created_at,
      u_prev.name AS current_prev_name,
      u_prev.email AS current_prev_email,
      u_prev.active AS current_prev_active,
      u_new.name AS current_new_name,
      u_new.email AS current_new_email,
      u_new.active AS current_new_active,
      u_actor.name AS current_actor_name,
      u_actor.email AS current_actor_email
    FROM ownership_history h
    LEFT JOIN users u_prev ON u_prev.id = h.previous_owner_user_id
    LEFT JOIN users u_new ON u_new.id = h.new_owner_user_id
    LEFT JOIN users u_actor ON u_actor.id = h.changed_by_user_id
    WHERE h.entity_type = $1
      AND h.entity_id = $2
      ${cursorClause}
    ORDER BY h.id DESC
    ${limitClause}
  `;

  const { rows } = await db.query(sql, queryParams);

  const data = rows.map((h) => ({
    id: h.id,
    entity_type: h.entity_type,
    entity_id: h.entity_id,
    previous_owner:
      h.previous_owner_snapshot_id !== null
        ? {
            id: h.previous_owner_user_id ?? h.previous_owner_snapshot_id,
            name: h.current_prev_name ?? h.previous_owner_name,
            email: h.current_prev_email ?? null,
            active: h.current_prev_active ?? false,
            deleted: h.previous_owner_user_id === null,
          }
        : null,
    new_owner:
      h.new_owner_snapshot_id !== null
        ? {
            id: h.new_owner_user_id ?? h.new_owner_snapshot_id,
            name: h.current_new_name ?? h.new_owner_name,
            email: h.current_new_email ?? null,
            active: h.current_new_active ?? false,
            deleted: h.new_owner_user_id === null,
          }
        : null,
    changed_by: {
      id: h.changed_by_user_id ?? h.changed_by_snapshot_id ?? null,
      name: h.current_actor_name ?? h.changed_by_name ?? null,
      actor_type: h.actor_type,
      deleted: h.actor_type === 'user' && h.changed_by_user_id === null,
    },
    reason: h.reason,
    created_at: h.created_at,
  }));

  return {
    data,
    total: data.length,
    limit: safeLimit,
  };
}
