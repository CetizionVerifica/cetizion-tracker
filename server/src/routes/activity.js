/**
 * Reading the activity log (#18 Phase 1.5):
 *
 *   GET /api/activity   what was done, newest first
 *
 * Read only, and admin only, both at the router. There is deliberately no
 * POST, PATCH or DELETE here and this table is deliberately absent from the
 * resource registry that generates those — an audit trail anybody can write
 * to proves nothing, and one an admin can edit proves less. Rows are
 * written from inside the operations they describe (src/lib/activity.js),
 * never over HTTP.
 *
 * Admin only because the log names who did what, across everybody. Until
 * Phase 2 gives records an owner there is no such thing as "my own
 * activity" to show a salesperson, and showing them everybody's is not the
 * smaller version of that.
 *
 * No UI reads this yet. It is the foundation the admin screen, the
 * salesperson timeline and the KPI drill-downs will be built on, and it is
 * useful on its own the first time somebody has to ask what happened.
 */
import { Router } from 'express';
import { z } from 'zod';

import { requireAdmin } from '../auth/middleware.js';
import { query } from '../db.js';
import { ACTOR_TYPES } from '../lib/activity.js';
import { ApiError } from '../middleware/error.js';

export const activityRouter = Router();

activityRouter.use(requireAdmin);

// Enough to read on a screen, and never enough to drain the table in one
// request. An audit log is the one table that only grows, so "no limit" is
// not an option that gets safer with time; a caller who wants more pages
// through them with before_id and leaves the server holding one page at a
// time. The existing lists use the same shape (crud.js caps at its own
// MAX_LIMIT), with smaller numbers here because these rows carry JSON.
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// activity_log.id is a bigserial. Beyond 2^53 a JavaScript number stops
// being the integer it was, so the cursor is bounded where it is still
// exact rather than where the column ends.
const MAX_CURSOR = Number.MAX_SAFE_INTEGER;

const filters = z.object({
  // A positive integer, or nothing. Filtering on "no actor" is the shared
  // admin and the system, which actor_type already answers better.
  actor_user_id: z.coerce.number().int().positive().max(2_147_483_647).optional(),
  actor_type: z.enum(ACTOR_TYPES).optional(),
  action: z.string().trim().min(1).max(64).optional(),
  entity_type: z.string().trim().min(1).max(64).optional(),
  entity_id: z.string().trim().min(1).max(128).optional(),
  limit: z.coerce.number().int().positive().max(MAX_LIMIT).default(DEFAULT_LIMIT),
  // The cursor: "the page after this id". Exclusive, so a page never
  // repeats its own last row.
  before_id: z.coerce.number().int().positive().max(MAX_CURSOR).optional(),
});

/**
 * Rejects rather than ignores. A filter the server silently dropped would
 * answer a different question from the one asked and look like an answer to
 * the one asked — which on an audit log reads as "nothing happened".
 */
function parseQuery(raw) {
  // Only the keys we know: a repeated parameter arrives as an array and
  // would otherwise reach coerce as one.
  const input = {};
  for (const key of Object.keys(filters.shape)) {
    const value = raw[key];
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      throw new ApiError(422, 'Please check the highlighted fields', {
        fields: { [key]: 'Give this once' },
      });
    }
    input[key] = value;
  }

  const parsed = filters.safeParse(input);
  if (!parsed.success) {
    throw new ApiError(422, 'Please check the highlighted fields', {
      fields: Object.fromEntries(
        parsed.error.issues.map((i) => [i.path.join('.') || '_', i.message])
      ),
    });
  }
  return parsed.data;
}

/**
 * The shape an admin screen reads.
 *
 * `actor` is the account, when there still is one. A LEFT JOIN, so a row
 * whose actor has since been deleted still comes back — with actor null and
 * actor_type still saying it was a person. That is the case this endpoint
 * most has to get right: an account being deleted is exactly when its
 * history starts mattering.
 *
 * Only the actor's id and name are selected. Not their email, not their
 * role as it is today, and certainly not password_hash or session_version:
 * the join exists to put a name on a row, not to republish the users table
 * through a second endpoint.
 */
const shape = (row) => ({
  id: Number(row.id),
  actor: row.actor_user_id === null ? null : { id: row.actor_user_id, name: row.actor_name },
  actor_type: row.actor_type,
  action: row.action,
  entity_type: row.entity_type,
  entity_id: row.entity_id,
  metadata: row.metadata,
  created_at: row.created_at,
});

activityRouter.get('/', async (req, res) => {
  const q = parseQuery(req.query);

  const params = [];
  const where = [];
  const add = (sql, value) => { params.push(value); where.push(sql.replace('$?', `$${params.length}`)); };

  if (q.actor_user_id !== undefined) add('a.actor_user_id = $?', q.actor_user_id);
  if (q.actor_type !== undefined) add('a.actor_type = $?', q.actor_type);
  if (q.action !== undefined) add('a.action = $?', q.action);
  if (q.entity_type !== undefined) add('a.entity_type = $?', q.entity_type);
  if (q.entity_id !== undefined) add('a.entity_id = $?', q.entity_id);
  if (q.before_id !== undefined) add('a.id < $?', q.before_id);

  // Newest first. Paged on id rather than created_at: the sequence is taken
  // at insert so the two agree on order, and id is unique, so a cursor can
  // never straddle two rows written in the same millisecond.
  params.push(q.limit);
  const { rows } = await query(
    `SELECT a.id, a.actor_user_id, u.name AS actor_name, a.actor_type,
            a.action, a.entity_type, a.entity_id, a.metadata, a.created_at
       FROM activity_log a
       LEFT JOIN users u ON u.id = a.actor_user_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY a.id DESC
      LIMIT $${params.length}`,
    params
  );

  const data = rows.map(shape);
  res.json({
    data,
    limit: q.limit,
    // Where the next page starts, or null when this was the last one. A
    // short page is the end; a full page might not be, and the caller does
    // not have to guess how ids are allocated to ask for the rest.
    next_before_id: data.length === q.limit ? data[data.length - 1].id : null,
  });
});
