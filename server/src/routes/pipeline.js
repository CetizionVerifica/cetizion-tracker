/**
 * The quotation pipeline (#25):
 *
 *   GET  /api/pipeline                 stages, the open quotations under each, and the forecast
 *   POST /api/pipeline/:key/move       { stage_id, lost_reason_id?, lost_notes?, competitor?, probability? }
 */
import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { ApiError } from '../middleware/error.js';

export const pipelineRouter = Router();

pipelineRouter.get('/', async (req, res) => {
  const params = []; const where = [];
  if (req.query.sales_person) { params.push(String(req.query.sales_person)); where.push(`sales_person = $${params.length}`); }
  if (req.query.sector) { params.push(String(req.query.sector)); where.push(`sector = $${params.length}`); }
  const w = where.length ? `AND ${where.join(' AND ')}` : '';
  const [stages, cards, closed] = await Promise.all([
    query('SELECT * FROM pipeline_stages WHERE active ORDER BY sort_order'),
    query(`SELECT id, quotation_no, client_name, company_id, service_quoted, sales_person, sector, quotation_value, currency, status, stage_id, probability, weighted_value,
                  expected_close_date, next_step, days_in_stage, stale, valid_until, expired, sent_at, accepted_at, quotation_date
             FROM v_quotations WHERE stage_type IN ('open', 'paused') ${w}
            ORDER BY stage_order, expected_close_date NULLS LAST, quotation_value DESC NULLS LAST`, params),
    query(`SELECT stage, COUNT(*)::int AS n, COALESCE(SUM(quotation_value) FILTER (WHERE currency = 'INR'), 0) AS value_inr,
                  lost_reason
             FROM v_quotations WHERE stage_type IN ('won', 'lost') AND closed_at >= now() - interval '90 days' ${w}
            GROUP BY stage, lost_reason ORDER BY stage, n DESC`, params),
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
  const { rows } = await query(
    `UPDATE quotations SET stage_id = $2::int, probability = COALESCE($3::int, probability),
            lost_reason_id = CASE WHEN $4::text = 'lost' THEN $5::int ELSE NULL END,
            lost_notes = CASE WHEN $4::text = 'lost' THEN $6::text ELSE NULL END,
            -- the competitor belongs to a loss: kept unless sent (blank clears it), dropped on reopening
            competitor = CASE WHEN $4::text <> 'lost' THEN NULL WHEN $10::boolean THEN NULLIF($7::text, '') ELSE competitor END,
            expected_close_date = COALESCE($8::date, expected_close_date),
            next_step = COALESCE($9::text, next_step)
      WHERE quotation_no = $1 OR (id::text = $1 AND NOT EXISTS (SELECT 1 FROM quotations WHERE quotation_no = $1))
      RETURNING id`,
    [key, b.stage_id, b.probability ?? null, stage.type, b.lost_reason_id ?? null, b.lost_notes ?? null, b.competitor ?? null, b.expected_close_date ?? null, b.next_step ?? null, Object.hasOwn(req.body || {}, 'competitor')]
  );
  if (!rows.length) throw new ApiError(404, 'Quotation not found');
  const { rows: [q] } = await query('SELECT * FROM v_quotations WHERE id = $1', [rows[0].id]);
  res.json({ data: q });
});
