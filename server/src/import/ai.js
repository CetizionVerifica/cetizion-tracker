/**
 * The model's three jobs in the importer, and nothing else:
 *
 *   1. mapColumns   — say which sheet column holds which field, for sheets
 *                     whose headers don't match the known layout;
 *   2. readStages   — read deal-stage wordings the rules did not understand
 *                     (shown as the AI's reading, for the admin to check);
 *   3. reviewRows   — read free-text remarks and flag oddities: an advance
 *                     percentage mentioned in a comment, a proforma-style
 *                     invoice number, a remark the figures contradict.
 *
 * Every number and date that gets written comes from rules.js, computed in
 * code. The model proposes; code decides and validates.
 *
 * Talks to OpenRouter's OpenAI-style chat endpoint with plain fetch. Model
 * and key come from the environment; with no key, both jobs fall back to
 * the heuristics below and the batch is marked as built without AI.
 */

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

export const aiConfig = {
  apiKey: process.env.OPENROUTER_API_KEY || '',
  model: process.env.OPENROUTER_MODEL || 'deepseek/deepseek-v4.1-flash',
  enabled: Boolean(process.env.OPENROUTER_API_KEY),
};

/** Running totals for the current batch; the route resets and reads them. */
export const usage = { calls: 0, prompt_tokens: 0, completion_tokens: 0, cost_usd: 0, provider: null };
export function resetUsage() { usage.calls = 0; usage.prompt_tokens = 0; usage.completion_tokens = 0; usage.cost_usd = 0; usage.provider = null; }

async function chatJSON(system, user, { maxTokens = 4000, timeoutMs = 60_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${aiConfig.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://tracker.cetizionverifica.com',
        'X-Title': 'Cetizion Tracker bulk import',
      },
      body: JSON.stringify({
        model: aiConfig.model,
        temperature: 0,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
        // The review is extraction, not reasoning: with thinking on, a
        // flash-class model spends its output budget deliberating and
        // truncates. Fable models cannot switch thinking off; keep it low.
        reasoning: /fable/i.test(aiConfig.model) ? { effort: 'low' } : { enabled: false },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
  } catch (err) {
    throw new Error(err.name === 'AbortError' ? `OpenRouter timed out after ${timeoutMs / 1000}s` : err.message);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OpenRouter ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || '{}';
  const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const u = data.usage || {};
  usage.calls += 1;
  usage.prompt_tokens += u.prompt_tokens || 0;
  usage.completion_tokens += u.completion_tokens || 0;
  usage.cost_usd += Number(u.cost || 0);
  usage.provider = data.provider || usage.provider;
  return JSON.parse(cleaned);
}

/* ------------------------------------------------------------------ */
/* 1. Column mapping                                                    */
/* ------------------------------------------------------------------ */

// The fields and the header matcher live in fields.js, shared with the
// reader (which uses them to find the header row and pick the sheet).
export { FIELDS, heuristicMapping } from './fields.js';
import { FIELDS, heuristicMapping } from './fields.js';
import { QUOTE_STAGES, stageKey } from './stages.js';

// What each field holds, for the model: a bare name like "received" or
// "pending" is not enough to place "Yet to Receive" or "Money Received".
const MEANING = {
  sno: 'serial / row number of the deal',
  client: 'customer company name',
  industry: "client's industry or sector",
  contact: "the client's contact person",
  lead_type: 'lead source or type (new, repeat, referral)',
  stage: 'deal stage or status (won, lost, proposal sent, on hold...)',
  stage_detail: 'a second, more detailed stage or status column',
  service: 'service or scope proposed',
  proposal_date: 'date the proposal or quotation was sent',
  quotation_no: 'quotation / proposal reference number',
  quoted_price: 'fee or price quoted in the proposal',
  currency: 'currency code of the amounts',
  po_date: 'date the order was won: PO, work order, contract or award date',
  po_number: 'purchase order, work order, contract or award number',
  po_amount: 'order value: PO, work order or contract amount',
  invoice_number: 'invoice number(s)',
  invoice_amount: 'amount invoiced / billed so far',
  received: 'money received / collected so far',
  pending: 'amount still to be received / outstanding',
  follow_up: 'next follow-up date or next action',
  remarks: 'free-text remarks or comments',
  sales_person: 'our salesperson or owner of the deal',
};

/**
 * Ask the model only for the fields the heuristic could not place. Returns
 * {mapping, source: 'heuristic' | 'heuristic+ai'}.
 */
export async function mapColumns(headers, sampleRows) {
  const mapping = heuristicMapping(headers);
  const missing = Object.keys(FIELDS).filter((f) => !mapping[f]);
  // Whenever a named column is left over and a field is still free: one short
  // call, and the model may only fill those gaps, never move a placed column.
  const placed = new Set(Object.values(mapping));
  const spare = headers.filter((h) => h && !placed.has(h) && !/^column_\d+$/.test(h));
  const needAI = aiConfig.enabled && missing.length > 0 && spare.length > 0;
  if (!needAI) return { mapping, source: 'heuristic' };

  const system = `You map spreadsheet columns to fields for a sales tracker. Reply with JSON only:
{"mapping": {"<field>": "<exact header text or null>", ...}}
Fields and their meaning:
${Object.keys(FIELDS).map((f) => `- ${f}: ${MEANING[f] || f}`).join('\n')}
Use a header only once. Use null when no column fits: a column that is none of
these (an ID, e-mail, address, GST number, probability...) stays unmapped.
Never invent headers.`;
  const user = `Headers: ${JSON.stringify(headers)}
Already mapped (keep these): ${JSON.stringify(mapping)}
Fields still unmapped: ${JSON.stringify(missing)}
Columns not yet used: ${JSON.stringify(spare)}
Sample rows: ${JSON.stringify(sampleRows.slice(0, 5))}`;

  try {
    const out = await chatJSON(system, user, { maxTokens: 1200 });
    for (const [field, header] of Object.entries(out.mapping || {})) {
      if (FIELDS[field] && header && headers.includes(header) && !Object.values(mapping).includes(header)) {
        mapping[field] = header;
      }
    }
    return { mapping, source: 'heuristic+ai' };
  } catch (err) {
    return { mapping, source: 'heuristic', ai_error: err.message };
  }
}

/**
 * Read the deal-stage wordings the rules did not understand. Returns
 * {map: {stageKey: reading}} with readings from QUOTE_STAGES or 'lead';
 * a wording the model is unsure of is left out and stays "not understood".
 */
export async function readStages(wordings) {
  const todo = [...new Set(wordings.filter(Boolean))].slice(0, 150);
  if (!aiConfig.enabled || !todo.length) return { map: {} };
  const system = `You read the deal-stage column of a B2B sales tracker (consulting: ESG ratings, audits, certification, assurance). For each wording reply with the stage it means. Reply with JSON only: {"stages": {"<wording exactly as given>": "<stage or null>"}}
Stages:
- "Won - PO Received": the order is placed or confirmed (PO, work order, signed contract, award) or work, invoicing or payment on it has started.
- "Under Negotiation": a priced proposal is being negotiated, revised or re-quoted, or the client agreed but the formal order (PO) is still awaited.
- "Submitted": a proposal, quotation or bid has been sent and the client has not answered yet.
- "On Hold": paused, deferred or postponed.
- "Lost": not won: lost, dropped, declined, cancelled, competitor chosen, no bid, done in-house.
- "lead": no proposal sent yet: enquiry, RFQ/RFP received, intro call, scoping, NDA, proposal being prepared.
Use null when the wording does not say which (a name, a date, a code, "see remarks").`;
  try {
    const out = await chatJSON(system, `Wordings: ${JSON.stringify(todo)}`, { maxTokens: 3000 });
    const map = {};
    for (const [wording, stage] of Object.entries(out.stages || {})) {
      if (todo.includes(wording) && (QUOTE_STAGES.includes(stage) || stage === 'lead')) map[stageKey(wording)] = stage;
    }
    return { map };
  } catch (err) {
    return { map: {}, ai_error: err.message };
  }
}

/* ------------------------------------------------------------------ */
/* 2. Row review                                                        */
/* ------------------------------------------------------------------ */

// REVIEW_PROMPT_START — replaced wholesale by the prompt iteration script.
const REVIEW_SYSTEM = `You check rows of a sales spreadsheet before they are imported into a finance tracker. Each row: sno, stage, and when present po (PO number), po_amt, cur (currency of po_amt and recv, INR when absent), inv (invoice number), recv (amount received), pend (amount pending), rem (free-text remarks). Amounts are plain numbers. A key that is absent means the sheet has no value there.

Reply with JSON only: {"rows":[{"sno":<n>,"advance_percent":<1-99|null>,"flags":[{"code":"<code>","message":"<under 12 words>"}]}]}

advance_percent: the first-invoice share if rem states one ("Invoice shared for 20% adv" -> 20, "50%+GST" -> 50, "30% advance" -> 30). Otherwise null.

The importer already checks all arithmetic: missing PO amounts, receipts larger than the PO, receipts that do not match a stated advance share, invoice number formats. Never compute or compare amounts. You look only for what the text reveals. Flag codes:

- remark_contradicts_figures: rem states something the row explicitly contradicts: "received in full" or "fully paid" while recv is present and obviously far below po_amt (less than half); "first invoice still unpaid" together with a second invoice raised. Both the claim and the contradicting value must be present in the row. "Total invoice amount received" or "advance received" means the invoiced stage was paid, not the whole PO: never a contradiction, whatever recv is.
- multiple_invoices: rem says a second, another or a final invoice has been raised or is being raised for this PO.
- reissued_invoice: rem says an invoice was cancelled, withdrawn, or replaced by one with a new number. Re-sending or re-sharing the same invoice (same number, soft copy, on mail) is NOT a reissue.
- signed_quote_as_po: po is words like "Signed Quote", or rem says the client signed the quotation instead of issuing a PO.
- revised_po: rem says the PO amount or scope is being amended, revised upward or awaiting an amendment.
- currency_mismatch: rem itself names two different currencies for the same deal, e.g. "PO in Euros, updated PO in USD". A currency symbol in rem that matches cur is NOT a mismatch. If rem names only one currency, no flag.
- full_payment_on_completion: rem says the whole amount (100%, full amount, entire payment, single payment, no advance) is paid after completion, delivery, sign-off or the final report.
- unclear_terms: rem states the payment terms themselves and they name no percentage and no amount, e.g. "payment terms as mutually agreed". Only when the remark is about the terms. A remark that merely mentions an advance or a balance ("Advance received, balance pending", "Balance after final report") is not a statement of terms: no flag, the importer applies its default split.
- other: something else a finance reviewer must see. Say what. Use rarely.

Never flag these, they are normal:
- Lost and pending rows: no PO, invoice or payment by nature. Remarks about follow-ups, holds, competitors or management decisions: no flag.
- A won row whose invoice is awaited, pending, not yet raised, or not yet received from finance.
- A won row where rem just restates the figures: "Invoice shared for 50%", "Total invoice amount received as per payment terms", "Advance invoice raised as per PO terms".
- A receipt net of TDS, an advance plus GST, or a receipt a little different from the stated share. Amount comparisons are not your job.
- Remarks about kick-off dates, deliveries, GST invoice copies, PO copies, filing, reminders, bank details, or an invoice re-shared with the same number.
- Remarks that mention an advance or a balance without stating a percentage.

Omit every row with nothing to flag and no percentage. Shorter output is better.

Examples:
{"sno":4,"stage":"Won - PO Received","po":"PO1","po_amt":800000,"inv":"603","recv":200000,"rem":"Payment received in full as per terms"} -> {"sno":4,"advance_percent":null,"flags":[{"code":"remark_contradicts_figures","message":"Says received in full; recv is a quarter of PO"}]}
{"sno":7,"stage":"Won - PO Received","po":"Signed Quote","po_amt":360000,"inv":"PI-003"} -> {"sno":7,"advance_percent":null,"flags":[{"code":"signed_quote_as_po","message":"Client signed the quote; no formal PO"}]}
{"sno":8,"stage":"Won - PO Received","po":"PO9","po_amt":1000000,"inv":"608","recv":500000,"rem":"Invoice shared for 30% adv"} -> {"sno":8,"advance_percent":30,"flags":[]}
{"sno":11,"stage":"Won - PO Received","po":"PO4","po_amt":796500,"inv":"118","recv":145800,"pend":13500,"rem":"Invoice shared for 20% adv - 1,59,300/- | TDS deducted"} -> {"sno":11,"advance_percent":20,"flags":[]}
{"sno":13,"stage":"Won - PO Received","po":"PO5","po_amt":300000,"rem":"Invoice not received yet from Finance Team"} -> omitted
{"sno":14,"stage":"Won - PO Received","po":"7500004842","po_amt":8640,"cur":"USD","inv":"CVPL/2025-2026/116","recv":4320,"rem":"Invoice shared for $4320"} -> omitted
{"sno":15,"stage":"Won - PO Received","po":"WO 305","po_amt":900000,"inv":"305","recv":270000,"pend":630000,"rem":"Total invoice amount received as per payment terms"} -> omitted
{"sno":16,"stage":"Won - PO Received","po":"PO3","po_amt":400000,"rem":"No advance. Full amount payable on submission of final report"} -> {"sno":16,"advance_percent":null,"flags":[{"code":"full_payment_on_completion","message":"Whole amount after final report"}]}
{"sno":9,"stage":"Lost","rem":"Opted for another vendor"} -> omitted
{"sno":12,"stage":"Won - PO Received","po":"PO2","po_amt":500000,"inv":"118","recv":250000,"pend":250000} -> omitted`;
const REVIEW_CODES = ['remark_contradicts_figures', 'multiple_invoices', 'reissued_invoice', 'signed_quote_as_po', 'revised_po', 'currency_mismatch', 'full_payment_on_completion', 'unclear_terms', 'other'];
// REVIEW_PROMPT_END

/**
 * Given the rows the rules engine kept, ask the model for per-row hints.
 * Output is validated: percentages must be 1-99, flags must use known codes.
 * Anything else is dropped. Returns a map keyed by source row number.
 */
export async function reviewRows(rows, { chunkSize = 15, concurrency = 6 } = {}) {
  const heuristic = Object.fromEntries(rows.map((r) => [r.sno, heuristicReview(r)]));
  if (!aiConfig.enabled || !rows.length) return { hints: heuristic, source: 'heuristic' };

  // A row with only a client, a stage and a service has nothing for the
  // model to judge. Sending it costs tokens and can only invent a flag.
  const worth = rows.filter((r) => r.follow_up || r.remarks || r.invoice_number || r.received !== null || r.pending !== null || (r.po_number && r.po_amount === null));
  if (!worth.length) return { hints: heuristic, source: 'heuristic', ai_rows: 0, ai_sent: 0, ai_ms: 0 };

  const codes = new Set(REVIEW_CODES);
  // Keys shortened and empty fields dropped: fewer tokens, same content.
  const compact = worth.map((r) => {
    const o = { sno: r.sno, stage: r.stage };
    if (r.po_number) o.po = r.po_number;
    if (r.po_amount !== null) o.po_amt = r.po_amount;
    if (r.currency) o.cur = r.currency;
    if (r.invoice_number) o.inv = r.invoice_number;
    if (r.received !== null) o.recv = r.received;
    if (r.pending !== null) o.pend = r.pending;
    const rem = [r.follow_up, r.remarks].filter(Boolean).join(' | ').slice(0, 240);
    if (rem) o.rem = rem;
    return o;
  });

  // Small chunks in parallel: one big request is slow and more likely to
  // come back truncated.
  const chunks = [];
  for (let i = 0; i < compact.length; i += chunkSize) chunks.push(compact.slice(i, i + chunkSize));
  const started = Date.now();
  const settled = await runLimited(chunks.map((chunk) => () => chatJSON(REVIEW_SYSTEM, JSON.stringify(chunk), { maxTokens: 1200 })), concurrency);
  const hints = { ...heuristic };
  const errors = [];
  let aiRows = 0;
  settled.forEach((res, i) => {
    if (res.status === 'rejected') { errors.push(`chunk ${i + 1}: ${res.reason?.message || res.reason}`); return; }
    for (const row of res.value?.rows || []) {
      const base = hints[row.sno];
      if (!base) continue;
      aiRows += 1;
      const pct = Number(row.advance_percent);
      if (Number.isFinite(pct) && pct >= 1 && pct <= 99) base.advance_percent = pct;
      for (const f of row.flags || []) {
        if (f && codes.has(f.code) && !base.flags.some((x) => x.code === f.code)) {
          base.flags.push({ level: 'warn', code: f.code, message: String(f.message || f.code).slice(0, 120), by: 'ai' });
        }
      }
    }
  });
  return { hints, source: errors.length === chunks.length ? 'heuristic' : 'heuristic+ai', ai_error: errors.length ? errors.join('; ') : undefined, ai_rows: aiRows, ai_sent: worth.length, ai_ms: Date.now() - started };
}

/** Promise.allSettled with at most `limit` tasks in flight. */
async function runLimited(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      try { results[i] = { status: 'fulfilled', value: await tasks[i]() }; }
      catch (reason) { results[i] = { status: 'rejected', reason }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

/** What code alone can read from a row's text. */
function heuristicReview(r) {
  const text = [r.follow_up, r.remarks].filter(Boolean).join(' | ');
  const flags = [];
  let advance_percent = null;
  const m = /(\d{1,3})\s*%/.exec(text);
  if (m) { const p = Number(m[1]); if (p > 0 && p < 100) advance_percent = p; }
  // Whole amount after the work: "100% within 30 days of completion", "No advance. Full amount payable on submission of final report",
  // "Single payment on completion", "Entire payment after sign-off", "Full payment against final deliverable".
  const wholeAmount = /(100\s*(%|percent)|full (amount|payment)|entire (amount|payment)|single payment|no advance)/i;
  const afterWork = /(complet|deliver|sign[- ]?off|final (report|deliverable)|submission|closure)/i;
  if (wholeAmount.test(text) && afterWork.test(text)) flags.push({ level: 'info', code: 'full_payment_on_completion', message: 'Terms say the whole amount is paid after completion', by: 'rule' });
  if (r.invoice_number && /\bPI[-\s]?\d/i.test(String(r.invoice_number))) flags.push({ level: 'warn', code: 'proforma_invoice', message: 'PI-style number may be a proforma invoice', by: 'rule' });
  if (r.po_number && r.po_amount === null) flags.push({ level: 'warn', code: 'po_without_amount', message: 'PO number given but no amount', by: 'rule' });
  if (r.invoice_number && /[&,]|\band\b/i.test(String(r.invoice_number))) flags.push({ level: 'warn', code: 'multiple_invoices', message: 'More than one invoice number listed; check which stage each belongs to', by: 'rule' });
  return { advance_percent, flags };
}
