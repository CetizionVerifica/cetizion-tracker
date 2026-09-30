import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../auth/middleware.js';
import { actorFrom } from '../lib/activity.js';
import {
  changeRecordOwner,
  getEntityDef,
  listRecordOwnershipHistory,
  SUPPORTED_ENTITIES,
} from '../lib/ownershipHistory.js';
import { pool, transaction } from '../db.js';
import { ApiError } from '../middleware/error.js';

export const ownershipRouter = Router();

/**
 * "Missing" and "the wrong type" are different mistakes and deserve
 * different messages. zod 4 — which the rest of the app is on — replaced
 * `required_error` / `invalid_type_error` with one `error`, and silently
 * ignores the old pair: left as they were, every field here answered with
 * zod's own "Invalid input: expected number, received undefined" instead.
 * The function form keeps both messages: an absent value has no input.
 */
const missingOr = (field, kind) => (issue) => (
  issue.input === undefined ? `${field} is required` : `${field} must be ${kind}`
);

// Validation schema for ownership change
const updateOwnerSchema = z.object({
  expected_owner_user_id: z.union([z.number().int().positive(), z.null()], {
    error: missingOr('expected_owner_user_id', 'an integer or null'),
  }),
  new_owner_user_id: z.union([z.number().int().positive(), z.null()], {
    error: missingOr('new_owner_user_id', 'an integer or null'),
  }),
  reason: z
    .string({ error: missingOr('reason', 'a string') })
    .trim()
    .min(1, 'A non-empty reason is required')
    .max(1000, 'Keep reason under 1000 characters'),
});

function parseBody(schema, body) {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ApiError(422, 'Please check the highlighted fields', {
      fields: Object.fromEntries(
        result.error.issues.map((i) => [i.path.join('.') || '_', i.message])
      ),
    });
  }
  return result.data;
}

// Enforce resource validation
function validateResource(req, res, next) {
  const { resource } = req.params;
  if (!SUPPORTED_ENTITIES.includes(resource)) {
    return next(new ApiError(404, `Not found: ${resource}`));
  }
  next();
}

/**
 * PATCH /api/:resource/:id/owner
 *
 * Dedicated admin-only endpoint to assign, reassign, or unassign ownership.
 */
ownershipRouter.patch(
  '/:resource/:id/owner',
  requireAdmin,
  validateResource,
  async (req, res) => {
    const { resource, id } = req.params;
    const body = parseBody(updateOwnerSchema, req.body || {});
    const actor = actorFrom(req.user);

    const result = await transaction((client) =>
      changeRecordOwner(client, {
        entityType: resource,
        entityIdOrKey: id,
        expectedOwnerId: body.expected_owner_user_id,
        newOwnerId: body.new_owner_user_id,
        reason: body.reason,
        actor,
      })
    );

    const def = getEntityDef(resource);
    const naturalKey = def.naturalKey ? result.record[def.naturalKey] : null;

    res.json({
      data: {
        id: result.record.id,
        entity_type: resource,
        entity_id: result.record.id,
        natural_key: naturalKey,
        previous_owner_user_id: result.history
          ? result.history.previous_owner_user_id
          : result.record.owner_user_id,
        new_owner_user_id: result.record.owner_user_id,
        ownership_history_id: result.history ? result.history.id : null,
        no_op: result.noOp,
        updated_at: result.record.updated_at,
      },
    });
  }
);

/**
 * GET /api/:resource/:id/ownership-history
 *
 * Dedicated admin-only endpoint to view timeline of ownership changes.
 */
ownershipRouter.get(
  '/:resource/:id/ownership-history',
  requireAdmin,
  validateResource,
  async (req, res) => {
    const { resource, id } = req.params;
    const { limit, before } = req.query;

    const result = await listRecordOwnershipHistory(pool, {
      entityType: resource,
      entityIdOrKey: id,
      limit,
      before,
    });

    res.json(result);
  }
);
