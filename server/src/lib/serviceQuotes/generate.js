/**
 * Generate a quotation from a submitted questionnaire response (#208 phase
 * 2, module CLAUDE.md §4). One transaction; only ever a Draft, which a
 * person checks and sends (D1).
 *
 *   generateQuotation(client, { responseId, mode, user, scope })
 *     1. the response, within the caller's reach and locked; submitted, and
 *        still on an enquiry
 *     2. its version's pricing run on its answers (pricing.js)
 *     3. the enquiry has no quotation          → mode 'new': a Draft made the
 *                                                way a converted enquiry's is
 *                                                (insertDraftQuotation), and
 *                                                its number written onto the
 *                                                enquiry (spec C7)
 *        its quotation is Draft or Submitted   → mode 'revise': the shared
 *                                                revision (reviseQuotation),
 *                                                then this service's
 *                                                generated lines replaced;
 *                                                other services' generated
 *                                                lines and lines a person
 *                                                added stay
 *        any other status                      → 422, nothing written
 *     4. the lines written, each linked to this response, the totals
 *        worked out, the event logged
 *   and returns { quotation_no, mode, revision, lines, price_needed_count }.
 *
 * One quotation per enquiry (spec D12): an enquiry asking for ISO audits and
 * Ecovadis gets one quotation, and each service's questionnaire contributes
 * its own generated lines, as quoteWonEnquiry puts a line per service on one
 * quotation. quotations.questionnaire_response_id is the response it was last
 * generated from; which lines came from which is on the lines.
 *
 * Rates are in the service's currency. A quotation in another is priced
 * through the exchange rates the tracker keeps (exchangeFor): the converted
 * figure is the line's own rate from then on, so a later rate never changes
 * it, and a missing or stale rate leaves the line Price needed with why.
 *
 * Phase 3 adds the design's wording here. Not here: the "Price needed"
 * send block and the reasons shown on the quotation (routes, fullQuotation).
 */
import { ApiError } from '../../middleware/error.js';
import { ownerClause } from '../../auth/ownership.js';
import { businessToday } from '../businessDate.ts';
import { newestRates, rateAges, readableDate } from '../fx.ts';
import { insertDraftQuotation } from '../enquiries.js';
import { checkAnswers } from '../questionnaireDefinition.js';
import { responseClause } from '../questionnaires.js';
import { reviseQuotation } from '../quotationRevisions.js';
import { actAs, logStageMoves, logUpdated } from '../recordActs.js';
import { QUOTATION_STATUS } from '../statuses.js';
import { limitText, MAX_AMOUNT, money, priceLines, validatePricing } from './pricing.js';

export const MODES = ['new', 'revise'];
/** What generation may revise (spec §4): a quotation still being put together, or sent and not yet answered. */
const REVISABLE = new Set([QUOTATION_STATUS.draft, QUOTATION_STATUS.submitted]);

/** How old a rate may be before it is not used, in ECB publishing days: the reports' own rule (fx.ts staleRates). */
export const MAX_RATE_AGE = 4;

/**
 * How a rate in the service's currency becomes one in the quotation's
 * (approved for #208: the ECB reference rates the tracker already keeps,
 * fx.ts and exchange_rates; no second source). Every stored rate is rupees
 * for one unit, so any pair goes through INR:
 *
 *   factor = (INR per unit of `from`) / (INR per unit of `to`)
 *
 * with the newest rate on or before `asOf`, and only while it is fresh by
 * the reports' rule. Returns { factor, detail } or, when a rate is missing
 * or stale, { factor: null, unavailable: <reason>, detail }; never a guess.
 * `detail` is what the activity log records: the pair, each rate used, its
 * date and whether the feed or a person entered it.
 */
export async function exchangeFor(db, { from, to, asOf }) {
  if (from === to) return { factor: 1, unavailable: null, detail: null };
  const currencies = [...new Set([from, to])].filter((c) => c !== 'INR');
  const rows = await newestRates({ db, currencies, asOf });
  const ages = rateAges(rows, { today: asOf, maxPublishingDays: MAX_RATE_AGE });
  const rowOf = (c) => rows.find((r) => r.currency === c);
  const detail = {
    from, to, via: 'INR', as_of: asOf,
    rates: currencies.filter(rowOf).map((c) => ({ currency: c, inr_per_unit: Number(rowOf(c).rate), effective_from: rowOf(c).effective_from, source: rowOf(c).source })),
  };
  const missing = currencies.find((c) => !rowOf(c));
  if (missing) {
    return { factor: null, detail, unavailable: `no exchange rate for ${missing} on or before ${readableDate(asOf)} to convert the ${from} rate card into ${to}` };
  }
  const stale = ages.find((a) => a.stale);
  if (stale) {
    return { factor: null, detail, unavailable: `the newest ${stale.currency} exchange rate is from ${readableDate(stale.effective_from)}, more than ${MAX_RATE_AGE} publishing days before ${readableDate(asOf)}` };
  }
  const inrPer = (c) => (c === 'INR' ? 1 : Number(rowOf(c).rate));
  const factor = inrPer(from) / inrPer(to);
  return { factor, unavailable: null, detail: { ...detail, factor: Number(factor.toFixed(8)) } };
}

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * A quotation line generated for the service in $2: by the response it came
 * from, so editing a line's service by hand does not move it; one whose
 * response has since been deleted, by its service. Lines a person added are
 * never these.
 */
const THIS_SERVICE = `quotation_lines.generated AND (
    EXISTS (SELECT 1 FROM questionnaire_responses gr
              JOIN questionnaire_versions gv ON gv.id = gr.version_id
              JOIN questionnaires gq ON gq.id = gv.questionnaire_id
             WHERE gr.id = quotation_lines.questionnaire_response_id AND gq.service_id = $2)
    OR (quotation_lines.questionnaire_response_id IS NULL AND quotation_lines.service_id = $2))`;

/**
 * What the quotation's totals would come to, worked out the way
 * quotation_totals() does (amount less discount, GST on each line, rounded
 * per line), for the lines it would hold: the new ones and any kept.
 */
export function projectedTotals(lines) {
  let subtotal = 0; let tax = 0;
  for (const l of lines) {
    const amount = round2(Number(l.qty) * Number(l.rate) * (1 - (Number(l.discount_percent) || 0) / 100));
    subtotal += amount;
    tax += round2(amount * (Number(l.gst_rate) || 0) / 100);
  }
  return { subtotal: round2(subtotal), tax_total: round2(tax), total: round2(subtotal + tax) };
}

/** Why a quotation in this status is not regenerated, in the salesperson's words. */
function refusal(q) {
  switch (q.status) {
    case QUOTATION_STATUS.won: return `${q.quotation_no} is won; a won quotation is not regenerated. Raise a new quotation for extra scope.`;
    case QUOTATION_STATUS.lost: return `${q.quotation_no} is lost; a lost quotation is not regenerated.`;
    default: return `${q.quotation_no} is ${q.status}. Generating only revises a Draft or Submitted quotation; change its lines by hand, or move it back first.`;
  }
}

export async function generateQuotation(client, { responseId, mode, user, scope }) {
  if (!MODES.includes(mode)) throw new ApiError(422, 'Please check the highlighted fields', { fields: { mode: 'new or revise' } });
  await actAs(client, user);

  // 1. The response, reached the way every response route reaches it.
  const params = [responseId];
  const reach = responseClause(scope, params, 'r');
  // The enquiry is locked before the response: every generation on one enquiry then queues there first,
  // holding nothing else, so two services' responses generating at once cannot deadlock (one quotation, D12).
  const { rows: [head] } = await client.query(
    `SELECT r.enquiry_id FROM questionnaire_responses r WHERE r.id = $1 ${reach ? `AND ${reach}` : ''}`, params);
  if (!head) throw new ApiError(404, 'Questionnaire not found');
  if (head.enquiry_id) await client.query('SELECT 1 FROM enquiries WHERE id = $1 FOR UPDATE', [head.enquiry_id]);
  const { rows: [r] } = await client.query(
    `SELECT r.id, r.status, r.enquiry_id, r.answers, v.definition, v.pricing, q.service_id
       FROM questionnaire_responses r
       JOIN questionnaire_versions v ON v.id = r.version_id
       JOIN questionnaires q ON q.id = v.questionnaire_id
      WHERE r.id = $1 ${reach ? `AND ${reach}` : ''}
        FOR UPDATE OF r`, params);
  if (!r) throw new ApiError(404, 'Questionnaire not found');
  if (!r.enquiry_id) throw new ApiError(422, 'This questionnaire is no longer linked to an enquiry');
  // Moved to another enquiry between the two reads: the lock above is not this one's, so start again.
  if (r.enquiry_id !== head.enquiry_id) throw new ApiError(409, 'This questionnaire changed while it was being priced; try again');
  // 'reopened' is stored, and only ever set on a submitted response (POST /:id/reopen); it stays through the client's edits.
  if (r.status === 'reopened') throw new ApiError(422, 'This questionnaire was reopened for changes; generate once the client submits it again');
  if (r.status !== 'submitted') throw new ApiError(422, 'The client has not submitted this questionnaire yet');
  if (!(r.pricing?.lines?.length)) throw new ApiError(422, 'This questionnaire has no pricing rules yet; add them in Settings › Templates before generating');
  const problems = validatePricing(r.pricing, r.definition);
  if (problems.length) throw new ApiError(422, 'This questionnaire\'s pricing rules have problems', { problems });

  const { rows: [enquiry] } = await client.query('SELECT * FROM enquiries WHERE id = $1 FOR UPDATE', [r.enquiry_id]);
  const { rows: [service] } = await client.query('SELECT * FROM services WHERE id = $1', [r.service_id]);

  // The enquiry's quotation, if it has one, within the caller's reach too.
  let current = null;
  if (enquiry.quotation_no) {
    const qp = [enquiry.quotation_no];
    const mine = ownerClause(scope, qp, { alias: 'q' });
    const { rows: [q] } = await client.query(
      `SELECT q.* FROM v_quotations q WHERE q.quotation_no = $1 ${mine ? `AND ${mine}` : ''}`, qp);
    if (!q) throw new ApiError(422, `${enquiry.quotation_no} is not a quotation you can revise`);
    await client.query('SELECT 1 FROM quotations WHERE id = $1 FOR UPDATE', [q.id]);
    current = (await client.query('SELECT * FROM v_quotations WHERE id = $1', [q.id])).rows[0];
  }

  // Every refusal comes before the first write.
  if (current && !REVISABLE.has(current.status)) throw new ApiError(422, refusal(current));
  if (current && mode === 'new') throw new ApiError(422, `Enquiry ${enquiry.enquiry_no} already has ${current.quotation_no}; generate again to revise it`);
  if (!current && mode === 'revise') throw new ApiError(422, `Enquiry ${enquiry.enquiry_no} has no quotation to revise; generate a new one`);
  // The new version is dated today either way (a new Draft, or the revision), so that is the rate's date too.
  const today = businessToday();
  const currency = current ? current.currency : (enquiry.currency || 'INR');
  const exchange = await exchangeFor(client, { from: service.currency || 'INR', to: currency, asOf: today });

  // 2. The lines, from the answers as checked against the version, in the quotation's currency.
  const { values } = checkAnswers(r.definition, r.answers || {});
  const lines = priceLines({ definition: r.definition, pricing: r.pricing }, values, service,
    exchange.factor ? { rateFactor: exchange.factor } : { rateUnavailable: exchange.unavailable });
  // A rule's own SAC code is stored on its line; null leaves it to the service's (fullQuotation falls back).
  const ownSac = new Map(r.pricing.lines.map((p) => [p.key, p.sac_code ?? null]));

  // Each line fits a quotation line (pricing.js); together with every line a revision keeps (other services'
  // generated lines, and lines a person added) they must fit the quotation's own totals, or
  // quotation_totals() would fail after the writes.
  const kept = current
    ? (await client.query(`SELECT qty, rate, discount_percent, gst_rate FROM quotation_lines WHERE quotation_id = $1 AND NOT (${THIS_SERVICE})`, [current.id, service.id])).rows
    : [];
  const projected = projectedTotals([...kept, ...lines.map((l) => ({ ...l, gst_rate: l.gst_rate ?? 18 }))]);
  if (projected.subtotal > MAX_AMOUNT || projected.tax_total > MAX_AMOUNT || projected.total > MAX_AMOUNT) {
    throw new ApiError(422, `These lines come to ${money(projected.total)} with GST, more than a quotation can hold (${limitText(MAX_AMOUNT)}). Check the answers and the pricing rules.`);
  }

  // 3. A new Draft, or the next revision of the current one.
  let quotationId; let quotationNo; let revision;
  if (current) {
    const next = await reviseQuotation(client, current, { note: `Generated from the ${service.name} questionnaire answers`, by: user?.username });
    // Only this service's: a newer response for it replaces the older one's lines rather than adding to them.
    await client.query(`DELETE FROM quotation_lines WHERE quotation_id = $1 AND ${THIS_SERVICE}`, [current.id, service.id]);
    ({ id: quotationId, quotation_no: quotationNo } = current);
    revision = next.revision;
  } else {
    const made = await insertDraftQuotation(client, enquiry, {
      quotationDate: today,
      serviceQuoted: service.name,
      remarks: `From the questionnaire answers on enquiry ${enquiry.enquiry_no}`,
      value: null,
    });
    ({ id: quotationId, quotation_no: quotationNo } = made);
    revision = 0;
    await client.query('UPDATE enquiries SET quotation_no = $1 WHERE id = $2', [quotationNo, enquiry.id]);
  }

  // 4. The lines, the link to the answers, the totals, the record of it.
  for (const l of lines) {
    await client.query(
      `INSERT INTO quotation_lines (quotation_id, service_id, description, qty, unit, rate, gst_rate, sort_order, generated, rule_key, price_needed, sac_code, questionnaire_response_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, $9, $10, $11, $12)`,
      [quotationId, service.id, l.description, l.qty, l.unit, l.rate, l.gst_rate ?? 18, l.sort_order, l.rule_key, l.price_needed, ownSac.get(l.rule_key) ?? null, r.id]);
  }
  await client.query('UPDATE quotations SET questionnaire_response_id = $2, generated_at = now() WHERE id = $1', [quotationId, r.id]);
  await client.query('SELECT quotation_totals($1)', [quotationId]);

  const priceNeeded = lines.filter((l) => l.price_needed).length;
  await logUpdated(client, user, {
    entity: 'quotation', ref: quotationNo, changes: {},
    extra: {
      event: 'generated_from_answers', mode: current ? 'revise' : 'new', response_id: r.id, enquiry_no: enquiry.enquiry_no,
      client_name: current?.client_name ?? enquiry.client_name, revision, lines: lines.length, price_needed: priceNeeded,
      // The conversion, as it was made: the pair, each rate, its date and source. Null when no conversion was needed.
      exchange: exchange.detail ? { ...exchange.detail, ...(exchange.unavailable ? { unavailable: exchange.unavailable } : {}) } : null,
    },
  });
  if (current) await logStageMoves(client, user, [quotationId]);
  return { quotation_no: quotationNo, mode: current ? 'revise' : 'new', revision, lines: lines.length, price_needed_count: priceNeeded };
}
