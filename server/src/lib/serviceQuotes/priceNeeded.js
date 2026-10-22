/**
 * Lines a pricing rule could not price (#208 phase 2, module CLAUDE.md §4).
 *
 *   assertPricedForClient(q)       a quotation goes to the client (sent, or
 *                                  an acceptance link) only once every line
 *                                  has a price: 422 saying how many do not
 *   priceNeededReasons(db, q, lines)
 *                                  why each flagged line needs a price,
 *                                  worked out on read, never stored (rule 1)
 *
 * The flag itself is stored (quotation_lines.price_needed), and a rate above
 * 0 clears it in the database (098); the count is v_quotations'.
 */
import { ApiError } from '../../middleware/error.js';
import { businessToday } from '../businessDate.ts';
import { checkAnswers } from '../questionnaireDefinition.js';
import { exchangeFor } from './generate.js';
import { priceLines } from './pricing.js';

/** When the reason cannot be worked out again, say what is known, not something new. */
export const REASON_UNKNOWN = 'the pricing rules could not price this line when it was generated';

export function priceNeededMessage(count) {
  return `${count} line${count === 1 ? ' needs' : 's need'} a price before this can go to the client`;
}

/** Refuses with 422 while any line needs a price. `q` is a v_quotations row (fullQuotation). */
export function assertPricedForClient(q) {
  const count = Number(q?.price_needed_count) || 0;
  if (count > 0) throw new ApiError(422, priceNeededMessage(count), { price_needed_count: count });
}

/**
 * The conversion a response's latest generation on this quotation made, as
 * its activity-log entry recorded it: { factor } or { unavailable }. That
 * record, not today's table, so a rate added afterwards (even for that same
 * day) does not change why a line was left unpriced. Without an entry, the
 * rates on the day its lines were written.
 */
async function conversionAtGeneration(db, q, responseId, serviceCurrency, writtenOn) {
  const { rows: [log] } = await db.query(
    `SELECT metadata->'exchange' AS exchange FROM activity_log
      WHERE entity_type = 'quotation' AND entity_id = $1 AND metadata->>'event' = 'generated_from_answers'
        AND metadata->>'response_id' = $2::text
      ORDER BY id DESC LIMIT 1`, [q.quotation_no, responseId]);
  if (log) {
    const x = log.exchange;
    if (!x) return { factor: 1 };
    return x.unavailable ? { unavailable: x.unavailable } : { factor: Number(x.factor) };
  }
  const exchange = await exchangeFor(db, { from: serviceCurrency, to: q.currency || 'INR', asOf: businessToday(new Date(writtenOn)) });
  return exchange.factor ? { factor: exchange.factor } : { unavailable: exchange.unavailable };
}

/**
 * Line id → why it needs a price. Each flagged line's own response (the
 * per-line link; one quotation can hold several services' lines, D12) is
 * priced again as at the generation that wrote it: the same version, the
 * same service, the same conversion. A line whose rule now prices (the
 * answers were changed since), or that no response is known for, gets
 * REASON_UNKNOWN rather than a reason it did not have.
 */
export async function priceNeededReasons(db, q, lines) {
  const flagged = lines.filter((l) => l.price_needed);
  const reasons = new Map(flagged.map((l) => [l.id, REASON_UNKNOWN]));
  const byResponse = new Map();
  for (const l of flagged) {
    if (!l.questionnaire_response_id) continue;
    if (!byResponse.has(l.questionnaire_response_id)) byResponse.set(l.questionnaire_response_id, []);
    byResponse.get(l.questionnaire_response_id).push(l);
  }

  for (const [responseId, ofResponse] of byResponse) {
    const { rows: [r] } = await db.query(
      `SELECT r.answers, v.definition, v.pricing, s.*
         FROM questionnaire_responses r
         JOIN questionnaire_versions v ON v.id = r.version_id
         JOIN questionnaires qn ON qn.id = v.questionnaire_id
         JOIN services s ON s.id = qn.service_id
        WHERE r.id = $1`, [responseId]);
    if (!r) continue;
    const conversion = await conversionAtGeneration(db, q, responseId, r.currency || 'INR', ofResponse[0].created_at);
    const { values } = checkAnswers(r.definition, r.answers || {});
    let priced;
    try {
      priced = priceLines({ definition: r.definition, pricing: r.pricing }, values, r,
        conversion.unavailable ? { rateUnavailable: conversion.unavailable } : { rateFactor: conversion.factor });
    } catch {
      continue;
    }
    const byRule = new Map(priced.map((p) => [p.rule_key, p]));
    for (const l of ofResponse) {
      const again = l.rule_key ? byRule.get(l.rule_key) : null;
      if (again?.price_needed && again.why) reasons.set(l.id, again.why);
    }
  }
  return reasons;
}
