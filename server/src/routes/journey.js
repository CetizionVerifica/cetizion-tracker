/**
 * The sales journey, Enquiry → Quotation → PO (docs/specs/sales-journey;
 * the contract is server/src/lib/journey/CLAUDE.md §5):
 *
 *   GET /api/journey      ?sales_person= &service= &stuck=1 &closed=1 &from= &to= &cohort=
 *                         every sale this caller may see, by step: the funnel, the three columns, the cards
 *   GET /api/journey/of   ?enquiry= | quotation= | po= | project=
 *                         the one sale holding that record, in full, for its page's rail
 *
 * Read only: a step, a flag or a next action is never written anywhere.
 * Both are scoped (journeyClause): a sales user sees a sale when they own a
 * record in it. HR never reaches either; hrGate refuses it first.
 */
import { Router } from 'express';
import { z } from 'zod';
import { scopeOf } from '../auth/ownership.js';
import { query } from '../db.js';
import { ApiError } from '../middleware/error.js';
import { businessToday } from '../lib/businessDate.ts';
import { journeyOfRecord, journeyRows, journeySettings, OF_KINDS } from '../lib/journey/queries.js';
import { COHORTS, daysBefore, journeyBoard, journeyDetail } from '../lib/journey/steps.js';

export const journeyRouter = Router();

/** The funnel's default period: the 90 days up to today (server layer §5). */
const DEFAULT_PERIOD_DAYS = 90;

const isDay = (v) => {
  const t = Date.parse(`${v}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v;
};
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date as YYYY-MM-DD').refine(isDay, 'There is no such date');
const toggle = z.enum(['1', '0', 'true', 'false']).transform((v) => v === '1' || v === 'true');
const name = z.string().trim().min(1).max(200);

const boardSchema = z.object({
  sales_person: name.optional(),
  service: name.optional(),
  stuck: toggle.optional(),
  closed: toggle.optional(),
  from: day.optional(),
  to: day.optional(),
  cohort: z.enum(COHORTS).optional(),
});

const invalid = (fields) => new ApiError(422, 'Please check the highlighted fields', { fields });
const fieldsOf = (error) => Object.fromEntries(error.issues.map((i) => [i.path.join('.') || '_', i.message]));

journeyRouter.get('/', async (req, res) => {
  // An empty filter is no filter, as on Pipeline; anything else must read right.
  const parsed = boardSchema.safeParse(Object.fromEntries(Object.entries(req.query).filter(([, v]) => v !== '')));
  if (!parsed.success) throw invalid(fieldsOf(parsed.error));
  const f = parsed.data;
  const today = businessToday();
  const to = f.to ?? today;
  const from = f.from ?? daysBefore(to, DEFAULT_PERIOD_DAYS);
  if (from > to) throw invalid({ from: 'The period starts after it ends' });

  const db = { query };
  const [settings, rows] = await Promise.all([
    journeySettings(db),
    journeyRows(db, scopeOf(req), { sales_person: f.sales_person, service: f.service }),
  ]);
  res.json({ data: journeyBoard(rows, settings, today, {
    period: { from, to }, stuck: Boolean(f.stuck), closed: Boolean(f.closed), cohort: f.cohort ?? null,
  }) });
});

const KINDS = Object.keys(OF_KINDS);
const ofSchema = z.object(Object.fromEntries(KINDS.map((k) => [k, z.string().trim().min(1, 'Give the record\'s number').max(200).optional()])));

journeyRouter.get('/of', async (req, res) => {
  const parsed = ofSchema.safeParse(req.query);
  if (!parsed.success) throw invalid(fieldsOf(parsed.error));
  const given = KINDS.filter((k) => parsed.data[k] !== undefined);
  if (given.length !== 1) {
    const message = 'Name exactly one record: an enquiry, a quotation, a PO or a project';
    throw invalid(Object.fromEntries((given.length ? given : KINDS).map((k) => [k, message])));
  }
  const [kind] = given;
  const db = { query };
  // Read before the settings: a refusal costs one query and says nothing more than a miss does.
  const row = await journeyOfRecord(db, scopeOf(req), kind, parsed.data[kind]);
  if (!row) throw new ApiError(404, 'Journey not found');
  res.json({ data: journeyDetail(row, await journeySettings(db), businessToday()) });
});
