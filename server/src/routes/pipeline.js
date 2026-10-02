/**
 * The quotation pipeline (#25):
 *
 *   GET  /api/pipeline                 stages, the open quotations under each, and the forecast
 *   POST /api/pipeline/:key/move       { stage_id, lost_reason_id?, lost_notes?, competitor?, probability? }
 */
import { Router } from 'express';
import { z } from 'zod';
import { ownerClause, scopeOf, scopedSources } from '../auth/ownership.js';
import { query } from '../db.js';
import { ApiError } from '../middleware/error.js';
import { pipelineCards, summarisePipeline } from '../lib/pipeline.js';
import { RATES, rateOn } from '../lib/salesReport.js';

export const pipelineRouter = Router();

pipelineRouter.get('/', async (req, res) => {
  // The board is made of cards, and a card is a quotation with its number,
  // its client and its value on the face of it — the same row /api/quotations
  // already scopes (#18 Phase 2C). The per-stage totals below are counted in
  // JavaScript from these very cards, so scoping the rows scopes the totals
  // with them and changes no arithmetic. The closed-90-days summary reads the
  // same table and is narrowed the same way, so one screen does not mix a
  // salesperson's own stage totals with the whole company's closures.
  //
  // The pipeline_stages list is configuration and stays whole: an empty
  // column is information, and hiding the column would not be.
  const scope = scopeOf(req);
  const closedParams = []; const closedSrc = scopedSources(scope, closedParams);
  const closedWhere = [];
  if (req.query.sales_person) { closedParams.push(String(req.query.sales_person)); closedWhere.push(`v.sales_person = $${closedParams.length}`); }
  if (req.query.sector) { closedParams.push(String(req.query.sector)); closedWhere.push(`v.sector = $${closedParams.length}`); }
  const [stages, cards, closed] = await Promise.all([
    query('SELECT * FROM pipeline_stages WHERE active ORDER BY sort_order'),
    pipelineCards({ query }, scope, { sales_person: req.query.sales_person, sector: req.query.sector }),
    query(`WITH ${RATES}
           SELECT v.stage, COUNT(*)::int AS n, COALESCE(round(SUM(v.quotation_value * r.rate), 2), 0) AS value_inr,
                  COUNT(*) FILTER (WHERE v.quotation_value IS NOT NULL AND r.rate IS NULL)::int AS without_rate, v.lost_reason
             FROM ${closedSrc.vQuotations} v ${rateOn('r', 'v.currency', 'v.quotation_date')}
            WHERE v.stage_type IN ('won', 'lost') AND v.closed_at >= now() - interval '90 days' ${closedWhere.length ? `AND ${closedWhere.join(' AND ')}` : ''}
            GROUP BY v.stage, v.lost_reason ORDER BY v.stage, n DESC`, closedParams),
  ]);
  const summary = summarisePipeline(stages.rows, cards);
  res.json({ data: {
    stages: summary.stages, cards,
    forecast: summary.forecast, closed_90_days: closed.rows,
    without_rate: summary.without_rate,
  } });
});

const moveSchema = z.object({
  stage_id: z.coerce.number().int().positive(),
  probability: z.coerce.number().int().min(0).max(100).optional(),
  lost_reason_id: z.coerce.number().int().positive().optional().nullable(),
  lost_notes: z.string().trim().max(1000).optional().nullable(),
  competitor: z.string().trim().max(160).optional().nullable(),
  expected_close_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  next_step: z.string().trim().max(300).optional().nullable(),
});

pipelineRouter.post('/:key/move', async (req, res) => {
  const parsed = moveSchema.safeParse(req.body || {});
  if (!parsed.success) throw new ApiError(422, 'Please check the highlighted fields', { fields: Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.'), i.message])) });
  const b = parsed.data;
  const { rows: [stage] } = await query('SELECT * FROM pipeline_stages WHERE id = $1', [b.stage_id]);
  if (!stage) throw new ApiError(404, 'Unknown stage');
  if (stage.type === 'won') throw new ApiError(422, 'Won is reached by registering the project or the PO, not by moving the card');
  if (stage.type === 'lost' && !b.lost_reason_id) throw new ApiError(422, 'Pick a lost reason', { fields: { lost_reason_id: 'Required' } });
  const key = decodeURIComponent(req.params.key);
  const moveParams = [key, b.stage_id, b.probability ?? null, stage.type, b.lost_reason_id ?? null, b.lost_notes ?? null,
    b.competitor ?? null, b.expected_close_date ?? null, b.next_step ?? null, Object.hasOwn(req.body || {}, 'competitor')];
  // Moving a card changes a quotation's stage, its probability and, on a
  // loss, why it was lost — so the predicate rides in the UPDATE rather than
  // in a read before it, and a card that is not this caller's simply matches
  // no row (#18 Phase 2C).
  const mine = ownerClause(scopeOf(req), moveParams, { alias: 'quotations' });
  const { rows } = await query(
    `UPDATE quotations SET stage_id = $2::int, probability = COALESCE($3::int, probability),
            lost_reason_id = CASE WHEN $4::text = 'lost' THEN $5::int ELSE NULL END,
            lost_notes = CASE WHEN $4::text = 'lost' THEN $6::text ELSE NULL END,
            -- the competitor belongs to a loss: kept unless sent (blank clears it), dropped on reopening
            competitor = CASE WHEN $4::text <> 'lost' THEN NULL WHEN $10::boolean THEN NULLIF($7::text, '') ELSE competitor END,
            expected_close_date = COALESCE($8::date, expected_close_date),
            next_step = COALESCE($9::text, next_step)
      WHERE (quotation_no = $1 OR (id::text = $1 AND NOT EXISTS (SELECT 1 FROM quotations WHERE quotation_no = $1)))
        ${mine ? `AND ${mine}` : ''}
      RETURNING id`,
    moveParams
  );
  if (!rows.length) throw new ApiError(404, 'Quotation not found');
  const { rows: [q] } = await query('SELECT * FROM v_quotations WHERE id = $1', [rows[0].id]);
  res.json({ data: q });
});
