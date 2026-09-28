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
  const cardParams = []; const cardSrc = scopedSources(scope, cardParams);
  const closedParams = []; const closedSrc = scopedSources(scope, closedParams);
  const filters = (params) => {
    const where = [];
    if (req.query.sales_person) { params.push(String(req.query.sales_person)); where.push(`q.sales_person = $${params.length}`); }
    if (req.query.sector) { params.push(String(req.query.sector)); where.push(`q.sector = $${params.length}`); }
    return where.length ? `AND ${where.join(' AND ')}` : '';
  };
  const cardWhere = filters(cardParams);
  const closedWhere = filters(closedParams);
  const [stages, cards, closed] = await Promise.all([
    query('SELECT * FROM pipeline_stages WHERE active ORDER BY sort_order'),
    query(`SELECT q.id, q.quotation_no, q.client_name, q.company_id, q.service_quoted, q.sales_person, q.sector, q.quotation_value, q.currency, q.status, q.stage_id, q.probability, q.weighted_value,
                  q.expected_close_date, q.next_step, q.days_in_stage, q.stale, q.valid_until, q.expired, q.sent_at, q.accepted_at, q.quotation_date
             FROM ${cardSrc.vQuotations} q WHERE q.stage_type IN ('open', 'paused') ${cardWhere}
            ORDER BY q.stage_order, q.expected_close_date NULLS LAST, q.quotation_value DESC NULLS LAST`, cardParams),
    query(`SELECT q.stage, COUNT(*)::int AS n, COALESCE(SUM(q.quotation_value) FILTER (WHERE q.currency = 'INR'), 0) AS value_inr,
                  q.lost_reason
             FROM ${closedSrc.vQuotations} q WHERE q.stage_type IN ('won', 'lost') AND q.closed_at >= now() - interval '90 days' ${closedWhere}
            GROUP BY q.stage, q.lost_reason ORDER BY q.stage, n DESC`, closedParams),
  ]);
  // Forecast: weighted INR value of open quotations by expected close month; undated ones in their own bucket.
  const forecast = {};
  for (const c of cards.rows) {
    if (c.currency !== 'INR' || !c.quotation_value) continue;
    const key = c.expected_close_date ? String(c.expected_close_date).slice(0, 7) : 'undated';
    forecast[key] ??= { month: key, count: 0, value: 0, weighted: 0 };
    forecast[key].count += 1; forecast[key].value += Number(c.quotation_value); forecast[key].weighted += Number(c.weighted_value || 0);
  }
  const perStage = Object.fromEntries(stages.rows.map((s) => [s.id, { count: 0, value: 0, weighted: 0, stale: 0 }]));
  for (const c of cards.rows) {
    const t = perStage[c.stage_id]; if (!t) continue;
    t.count += 1;
    if (c.currency === 'INR') { t.value += Number(c.quotation_value || 0); t.weighted += Number(c.weighted_value || 0); }
    if (c.stale) t.stale += 1;
  }
  res.json({ data: { stages: stages.rows.map((s) => ({ ...s, ...perStage[s.id] })), cards: cards.rows, forecast: Object.values(forecast).sort((a, b) => a.month.localeCompare(b.month)), closed_90_days: closed.rows } });
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
