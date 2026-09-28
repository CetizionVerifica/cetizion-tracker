/**
 * The cash forecast as an endpoint. The forecast itself is in
 * lib/cashflow.js, because the MCP server answers the same question
 * (#140) and one forecast computed twice is two forecasts.
 */
import { Router } from 'express';
import { cashflow } from '../lib/cashflow.js';

export const cashflowRouter = Router();

cashflowRouter.get('/', async (req, res) => {
  res.json({ data: await cashflow({ months: req.query.months }) });
});
