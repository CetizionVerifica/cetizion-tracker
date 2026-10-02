/**
 * The quotation pipeline's arithmetic, shared by /api/pipeline and Insights,
 * so the same stage cannot carry two different totals on two screens.
 *
 * Every currency counts, converted to INR at the rate on the quotation's own
 * date (#25), the way the sales reports convert. A currency with no rate for
 * that date is left out of the totals and counted as such.
 */
import { scopedSources } from '../auth/ownership.js';
import { RATES, rateOn } from './salesReport.js';

/**
 * The open and paused quotations this scope may see, each with its INR value.
 * `filters` takes `sales_person` and `sector`, as the board's query string does.
 */
export async function pipelineCards(db, scope, filters = {}) {
  const params = [];
  const src = scopedSources(scope, params);
  const where = [];
  if (filters.sales_person) { params.push(String(filters.sales_person)); where.push(`v.sales_person = $${params.length}`); }
  if (filters.sector) { params.push(String(filters.sector)); where.push(`v.sector = $${params.length}`); }
  // The relation is substituted, not the arithmetic: the conversion is the
  // same whoever reads it, it simply runs over the cards this reader may see.
  const { rows } = await db.query(
    `WITH ${RATES}
     SELECT v.id, v.quotation_no, v.client_name, v.company_id, v.service_quoted, v.sales_person, v.sector, v.quotation_value, v.currency, v.status,
            v.stage_id, v.probability, v.weighted_value, v.expected_close_date, v.next_step, v.days_in_stage, v.stale, v.valid_until, v.expired,
            v.sent_at, v.accepted_at, v.quotation_date,
            round(v.quotation_value * r.rate, 2) AS value_inr, round(v.weighted_value * r.rate, 2) AS weighted_inr
       FROM ${src.vQuotations} v ${rateOn('r', 'v.currency', 'v.quotation_date')}
      WHERE v.stage_type IN ('open', 'paused') ${where.length ? `AND ${where.join(' AND ')}` : ''}
      ORDER BY v.stage_order, v.expected_close_date NULLS LAST, v.quotation_value DESC NULLS LAST`,
    params
  );
  return rows;
}

/** A card whose value could be put into rupees. */
export const converted = (c) => c.quotation_value != null && c.value_inr != null;

/**
 * Per-stage totals, the forecast by expected close month and the count of
 * cards left out for want of a rate. Pure: the cards are counted in
 * JavaScript, so scoping the cards scopes the totals and changes no arithmetic.
 */
export function summarisePipeline(stages, cards) {
  // Forecast: weighted INR value of open quotations by expected close month; undated ones in their own bucket.
  const forecast = {};
  for (const c of cards) {
    // A draft has not gone to the client: it is not forecast (#24).
    if (c.status === 'Draft' || !converted(c) || !Number(c.quotation_value)) continue;
    const key = c.expected_close_date ? String(c.expected_close_date).slice(0, 7) : 'undated';
    forecast[key] ??= { month: key, count: 0, value: 0, weighted: 0 };
    forecast[key].count += 1; forecast[key].value += Number(c.value_inr); forecast[key].weighted += Number(c.weighted_inr || 0);
  }
  const perStage = Object.fromEntries(stages.map((s) => [s.id, { count: 0, value: 0, weighted: 0, stale: 0, without_rate: 0 }]));
  for (const c of cards) {
    const t = perStage[c.stage_id]; if (!t) continue;
    t.count += 1;
    if (converted(c)) { t.value += Number(c.value_inr); if (c.status !== 'Draft') t.weighted += Number(c.weighted_inr || 0); }
    else if (c.quotation_value != null) t.without_rate += 1;
    if (c.stale) t.stale += 1;
  }
  return {
    stages: stages.map((s) => ({ ...s, ...perStage[s.id] })),
    forecast: Object.values(forecast).sort((a, b) => a.month.localeCompare(b.month)),
    without_rate: cards.filter((c) => c.quotation_value != null && c.value_inr == null).length,
  };
}
