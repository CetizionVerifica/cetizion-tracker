/**
 * Insights (docs/insights-dashboard-plan.md): five questions, one round trip.
 *
 *   GET /api/insights?owner=&granularity=month|quarter|fy&horizon=3|6|12&basis=cash|order
 *
 * A sales user sees their own records; an admin sees all, or one owner's
 * with ?owner=. The arithmetic is in lib/insights.js.
 */
import { Router } from 'express';
import { scopeOf } from '../auth/ownership.js';
import { query } from '../db.js';
import { businessToday } from '../lib/businessDate.ts';
import { insights, insightsScope, readOptions } from '../lib/insights.js';

export const insightsRouter = Router();

insightsRouter.get('/', async (req, res) => {
  const scope = insightsScope(req.user, req.query.owner);
  res.json({ data: await insights({ query }, {
    scope,
    today: businessToday(),
    viewerUnrestricted: scopeOf(req).unrestricted,
    ...readOptions(req.query),
  }) });
});
