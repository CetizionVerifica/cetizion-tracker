import { Router } from 'express';
import { requireAuth, requireAdmin } from '../auth/middleware.js';
import { ApiError } from '../middleware/error.js';
import { actorFrom } from '../lib/activity.js';
import { transaction } from '../db.js';
import { isUnrestricted } from '../auth/ownership.js';
import { KPI_DEFINITIONS, getSalespersonKpis, getTeamSalesKpis } from '../lib/salesKpis.js';
import { SUPPORTED_TARGET_UNITS, listSalesTargets, upsertSalesTarget } from '../lib/salesTargets.js';

export const kpiRouter = Router();

kpiRouter.use(requireAuth);

/**
 * How a caller says which period it wants.
 *
 * `from`/`to` is the explicit half-open range from #18's API sketch; the
 * presets are for the period buttons §7 asks for. Parsed in one place so
 * every endpoint accepts the same vocabulary and a person comparing two
 * pages is comparing the same dates.
 */
const periodFrom = (q) => ({
  from: q.from,
  to: q.to,
  preset: q.period,
  anchor: q.on,
  quarter: q.quarter,
});

const dimensionsFrom = (q) => ({
  sector: q.sector ? String(q.sector) : null,
  service: q.service ? String(q.service) : null,
});

/** `?compare=false` turns off the previous-period comparison. */
const comparing = (q) => q.compare !== 'false' && q.compare !== '0';

/**
 * GET /api/kpis/me?from&to  (or ?period=month|quarter|fy|calendar-year)
 *
 * The signed-in salesperson's own figures.
 */
kpiRouter.get('/me', async (req, res) => {
  if (req.user.mode === 'shared') {
    throw new ApiError(
      400,
      'The personal view is for database accounts. As a shared administrator, use /api/kpis/team.'
    );
  }
  if (req.user.role !== 'sales') {
    throw new ApiError(
      400,
      'The personal view is for sales accounts. Administrators should use /api/kpis/team or /api/kpis/users/:userId.'
    );
  }

  const data = await getSalespersonKpis({
    userId: req.user.id,
    period: periodFrom(req.query),
    compare: comparing(req.query),
    ...dimensionsFrom(req.query),
  });
  res.json({ data, definitions: KPI_DEFINITIONS });
});

/**
 * GET /api/kpis/team?from&to&sector&service
 *
 * Everybody, their totals, and the same figures per person. Admin only:
 * this is the one endpoint that names other people's numbers.
 */
kpiRouter.get('/team', requireAdmin, async (req, res) => {
  const data = await getTeamSalesKpis({
    period: periodFrom(req.query),
    compare: comparing(req.query),
    ...dimensionsFrom(req.query),
  });
  res.json({ data, definitions: KPI_DEFINITIONS });
});

/**
 * GET /api/kpis/users/:userId
 *
 * One person's figures. An admin may ask about anyone — this is §7's
 * drill-down, "clicking a person opens their My sales view, read-only".
 * A sales user may only ask about themselves, and asking about somebody
 * else is refused rather than quietly answered about themselves.
 */
kpiRouter.get('/users/:userId', async (req, res) => {
  const targetId = Number(req.params.userId);
  if (!Number.isSafeInteger(targetId) || targetId <= 0) {
    throw new ApiError(422, 'Invalid userId');
  }
  if (!isUnrestricted(req.user) && req.user.id !== targetId) {
    throw new ApiError(403, "You do not have access to another salesperson's KPIs");
  }

  const data = await getSalespersonKpis({
    userId: targetId,
    period: periodFrom(req.query),
    compare: comparing(req.query),
    ...dimensionsFrom(req.query),
  });
  res.json({ data, definitions: KPI_DEFINITIONS });
});

/**
 * GET /api/kpis/targets?from&to&salesperson_user_id=
 *
 * Scoped like everything else: a sales user sees their own and asking for
 * somebody else's is a 403, not an empty list — an empty list reads as
 * "they have no targets", which is a different and untrue statement.
 */
kpiRouter.get('/targets', async (req, res) => {
  const unrestricted = isUnrestricted(req.user);
  let salespersonUserId = req.query.salesperson_user_id
    ? Number(req.query.salesperson_user_id)
    : null;

  if (!unrestricted) {
    if (salespersonUserId !== null && salespersonUserId !== req.user.id) {
      throw new ApiError(403, "You do not have access to another salesperson's targets");
    }
    salespersonUserId = req.user.id;
  }

  const { from = null, to = null } = req.query;
  const data = await listSalesTargets(undefined, { salespersonUserId, from, to });
  res.json({ data });
});

/**
 * PUT /api/kpis/users/:userId/targets/:metric
 *
 * Set one target for one person for one period. Admin only — a target you
 * set for yourself is not a target.
 *
 * The period is given the same way a report's is, so "the target for March"
 * and "March's figures" cannot end up describing different months.
 */
kpiRouter.put('/users/:userId/targets/:metric', requireAdmin, async (req, res) => {
  const targetId = Number(req.params.userId);
  if (!Number.isSafeInteger(targetId) || targetId <= 0) {
    throw new ApiError(422, 'Invalid userId');
  }

  const body = req.body || {};
  const { target_value: targetValue, unit, currency = null } = body;
  if (!SUPPORTED_TARGET_UNITS.includes(unit)) {
    throw new ApiError(422, `unit must be one of: ${SUPPORTED_TARGET_UNITS.join(', ')}`);
  }

  const period = body.period ?? periodFrom({ ...req.query, ...body });
  if (!period.from && !period.preset) {
    throw new ApiError(422, 'Say which period this target covers: from and to, or period=month with on=YYYY-MM-DD');
  }

  const { target, isCreated } = await transaction((client) => upsertSalesTarget(client, {
    salespersonUserId: targetId,
    period,
    metric: req.params.metric,
    targetValue,
    unit,
    currency,
    actor: actorFrom(req.user),
  }));

  res.status(isCreated ? 201 : 200).json({ data: target });
});
