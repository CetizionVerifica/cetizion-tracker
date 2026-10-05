/**
 * The one way the tracker talks to a language model: OpenRouter's
 * OpenAI-style chat endpoint, plain fetch, JSON out.
 *
 * Shared by the bulk importer (import/ai.js) and the email enquiry reader
 * (lib/mailbox/autoEnquiry.js). Each caller passes its own `usage` object,
 * so the importer's per-batch counts are not mixed with the mailbox's
 * daily ones, and its own `title`, which OpenRouter shows against the call.
 *
 * The model proposes; the caller's code decides and validates. Nothing
 * here interprets an answer beyond parsing it as JSON.
 */

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

const list = (v, dflt) => String(v ?? dflt).split(',').map((m) => m.trim()).filter(Boolean);

/**
 * Read once at start-up; tests flip `enabled` to force the rules path.
 *
 * model       reads documents, and everything else (docs/email-auto-entry-plan.md §4)
 * fallbacks   tried in order when `model` does not route with zero
 *             retention; the privacy setting is never relaxed instead
 * triageModel sorts each email before a document reader runs (§3.8)
 * checkModel  reads an image PDF a second time, independently (§3.7)
 */
export const aiConfig = {
  apiKey: process.env.OPENROUTER_API_KEY || '',
  model: process.env.OPENROUTER_MODEL || 'anthropic/claude-fable-5.1',
  fallbacks: list(process.env.OPENROUTER_FALLBACK_MODELS, 'anthropic/claude-opus-5.5,openai/gpt-6.1-sol,anthropic/claude-sonnet-5.5'),
  triageModel: process.env.OPENROUTER_TRIAGE_MODEL || 'anthropic/claude-sonnet-5.5',
  checkModel: process.env.OPENROUTER_CHECK_MODEL || 'anthropic/claude-sonnet-5.5',
  enabled: Boolean(process.env.OPENROUTER_API_KEY),
};

/**
 * Does the model read a PDF itself, page images and text together? Then a
 * document goes as the file, with OpenRouter's native engine (§3.1). A
 * text-only model gets the text layer, and a scan through OCR.
 * OPENROUTER_READS_PDF=0 or 1 overrides the guess.
 */
export function readsPdf(model = aiConfig.model) {
  const set = process.env.OPENROUTER_READS_PDF;
  if (set === '0' || set === '1') return set === '1';
  return /^(anthropic|openai|google)\//.test(String(model));
}

export const newUsage = () => ({ calls: 0, prompt_tokens: 0, completion_tokens: 0, cost_usd: 0, provider: null, model: null });

/**
 * One chat call that must answer in JSON.
 *
 * `user` is either the user message's text, or an array of content parts
 * (text and file parts), for a request that sends a document.
 * `plugins` passes OpenRouter plugins through, e.g. the PDF OCR engine.
 * `model` asks one model, with no fallbacks: the second reader must be another model.
 * `schema` is { name, schema }: the answer must fit that JSON Schema
 * exactly (§3.5), so a missing key or a string in a number field cannot
 * come back. The caller's parser still checks it.
 */
export async function chatJSON(system, user, { maxTokens = 4000, timeoutMs = 60_000, title = 'Cetizion Tracker', usage = null, plugins, model = null, schema = null } = {}) {
  const primary = model || aiConfig.model;
  const models = model ? [model] : [...new Set([aiConfig.model, ...aiConfig.fallbacks])];
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
        'X-Title': title,
      },
      body: JSON.stringify({
        model: primary,
        ...(models.length > 1 ? { models } : {}),
        temperature: 0,
        max_tokens: maxTokens,
        response_format: schema
          ? { type: 'json_schema', json_schema: { name: schema.name, strict: true, schema: schema.schema } }
          : { type: 'json_object' },
        // The work is extraction, not reasoning: with thinking on, a
        // flash-class model spends its output budget deliberating and
        // truncates. Fable models cannot switch thinking off; keep it low.
        reasoning: /fable/i.test(primary) ? { effort: 'low' } : { enabled: false },
        // What goes out is a client's commercial detail — names, deal
        // values, invoice numbers, the text of an email. Which provider
        // serves the model decides whether that is kept, and the default is
        // to let OpenRouter choose freely.
        //
        // data_collection: 'deny' routes only to providers that do not
        // store or train on prompts; zdr narrows that to zero-retention
        // endpoints. Both can make a request fail to route rather than
        // fall back to a provider that keeps it, which is the right way
        // round: not answering is recoverable, and every caller falls back
        // to rules. A copy of a client's pipeline on somebody's training
        // set is not recoverable.
        provider: { data_collection: 'deny', zdr: true },
        ...(plugins ? { plugins } : {}),
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
  if (usage) {
    const u = data.usage || {};
    usage.calls += 1;
    usage.prompt_tokens += u.prompt_tokens || 0;
    usage.completion_tokens += u.completion_tokens || 0;
    usage.cost_usd += Number(u.cost || 0);
    usage.provider = data.provider || usage.provider;
    usage.model = data.model || usage.model || null;
  }
  return JSON.parse(cleaned);
}
