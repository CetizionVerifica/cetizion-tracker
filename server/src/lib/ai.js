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

/** Read once at start-up; tests flip `enabled` to force the rules path. */
export const aiConfig = {
  apiKey: process.env.OPENROUTER_API_KEY || '',
  model: process.env.OPENROUTER_MODEL || 'deepseek/deepseek-v4.1-flash',
  enabled: Boolean(process.env.OPENROUTER_API_KEY),
};

export const newUsage = () => ({ calls: 0, prompt_tokens: 0, completion_tokens: 0, cost_usd: 0, provider: null });

/**
 * One chat call that must answer in JSON.
 *
 * `user` is either the user message's text, or an array of content parts
 * (text and file parts), for a request that sends a document.
 * `plugins` passes OpenRouter plugins through, e.g. the PDF OCR engine.
 */
export async function chatJSON(system, user, { maxTokens = 4000, timeoutMs = 60_000, title = 'Cetizion Tracker', usage = null, plugins } = {}) {
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
        model: aiConfig.model,
        temperature: 0,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
        // The work is extraction, not reasoning: with thinking on, a
        // flash-class model spends its output budget deliberating and
        // truncates. Fable models cannot switch thinking off; keep it low.
        reasoning: /fable/i.test(aiConfig.model) ? { effort: 'low' } : { enabled: false },
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
  }
  return JSON.parse(cleaned);
}
