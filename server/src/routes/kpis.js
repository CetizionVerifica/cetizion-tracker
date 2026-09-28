import { Router } from 'express';
import { requireAuth, requireAdmin } from '../auth/middleware.js';
import { ApiError } from '../middleware/error.js';
import { actorFrom } from '../lib/activity.js';
import { transaction } from '../db.js';
import { businessYear } from '../lib/businessDate.ts';
import { isUnrestricted } from '../auth/ownership.js';
import { getSalespersonKpis, getTeamSalesKpis } from '../lib/salesKpis.js';
import { listSalesTargets, upsertSalesTarget } from '../lib/salesTargets.js';

export const kpiRouter = Router();

// All KPI endpoints require authentication
kpiRouter.use(requireAuth);

/**
 * GET /api/kpis/me?year=2026
 * Returns personal KPIs and targets for the authenticated sales user.
 */
kpiRouter.get('/me', async (req, res) => {
  if (req.user.mode === 'shared') {
    throw new ApiError(
      400,
      'The personal /me endpoint is for database users. As a shared administrator, use /api/kpis/team.'
    );
  }

  if (req.user.role !== 'sales') {
    throw new ApiError(
      400,
      'The personal /me endpoint is for sales accounts. Administrators should use /api/kpis/team or /api/kpis/users/:userId.'
    );
  }

  const year = req.query.year || businessYear();
  const data = await getSalespersonKpis({ userId: req.user.id, year });
  res.json({ data });
});

/**
 * GET /api/kpis/team?year=2026
 * Returns team-wide sales KPIs, unassigned pipeline, and unattributed performance.
 * Admin-only (database admin and shared admin).
 */
kpiRouter.get('/team', requireAdmin, async (req, res) => {
  const year = req.query.year || businessYear();
  const data = await getTeamSalesKpis({ year });
  res.json({ data });
});

/**
 * GET /api/kpis/users/:userId?year=2026
 * Returns individual salesperson KPIs.
 * Sales users may only inspect their own userId.
 */
kpiRouter.get('/users/:userId', async (req, res) => {
  const targetId = Number(req.params.userId);
  if (!Number.isSafeInteger(targetId) || targetId <= 0) {
    throw new ApiError(422, 'Invalid userId parameter');
  }

  const unrestricted = isUnrestricted(req.user);
  if (!unrestricted && req.user.id !== targetId) {
    throw new ApiError(403, 'You do not have access to another salesperson\'s KPIs');
  }

  const year = req.query.year || businessYear();
  const data = await getSalespersonKpis({ userId: targetId, year });
  res.json({ data });
});

/**
 * GET /api/kpis/targets?year=2026&salesperson_user_id=123
 * List targets scoped by role.
 */
kpiRouter.get('/targets', async (req, res) => {
  const unrestricted = isUnrestricted(req.user);
  let salespersonUserId = req.query.salesperson_user_id
    ? Number(req.query.salesperson_user_id)
    : null;

  if (!unrestricted) {
    // Sales users can only see their own targets
    if (salespersonUserId !== null && salespersonUserId !== req.user.id) {
      throw new ApiError(403, 'You do not have access to another salesperson\'s targets');
    }
    salespersonUserId = req.user.id;
  }

  const calendarYear = req.query.year ? Number(req.query.year) : null;
  const data = await listSalesTargets(undefined, { salespersonUserId, calendarYear });
  res.json({ data });
});

/**
 * PUT /api/kpis/users/:userId/targets/:metric
 * Create or update an annual sales target for a salesperson.
 * Admin-only.
 */
kpiRouter.put('/users/:userId/targets/:metric', requireAdmin, async (req, res) => {
  const targetId = Number(req.params.userId);
  if (!Number.isSafeInteger(targetId) || targetId <= 0) {
    throw new ApiError(422, 'Invalid userId parameter');
  }

  const metric = req.params.metric;
  const { target_value, unit, currency } = req.body || {};
  const calendarYear = req.body?.calendar_year || req.query.year;

  if (!calendarYear) {
    throw new ApiError(422, 'calendar_year is required in request body or query');
  }

  const actor = actorFrom(req.user);

  const { target, isCreated } = await transaction(async (client) => {
    return upsertSalesTarget(client, {
      salespersonUserId: targetId,
      calendarYear,
      metric,
      targetValue: target_value,
      unit,
      currency,
      actor,
    });
  });

  res.status(isCreated ? 201 : 200).json({ data: target });
});
