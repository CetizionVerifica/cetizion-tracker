#!/usr/bin/env node
/**
 * Does each model the email readers would use answer with zero data
 * retention? (docs/email-auto-entry-plan.md §4, build step 1)
 *
 *   npm run ai:check-models
 *   npm run ai:check-models -- anthropic/claude-fable-5.1 openai/gpt-6.1-sol
 *
 * One tiny call per model, with the same privacy routing every real call
 * has (data_collection deny, zdr), asking for {"ok": true}. No client data
 * goes out. A model that does not route is reported, never retried with
 * the privacy setting relaxed. Run it with the production key: routing
 * depends on the account. Needs OPENROUTER_API_KEY.
 */
import '../src/config.js';
import { aiConfig, chatJSON, readsPdf } from '../src/lib/ai.js';

async function main() {
  if (!aiConfig.enabled) {
    console.error('No AI key: set OPENROUTER_API_KEY.');
    process.exit(1);
  }
  const asked = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const models = asked.length ? asked : [...new Set([aiConfig.model, ...aiConfig.fallbacks, aiConfig.checkModel, aiConfig.triageModel])];
  let failed = 0;
  for (const model of models) {
    const started = Date.now();
    try {
      const usage = { calls: 0, prompt_tokens: 0, completion_tokens: 0, cost_usd: 0, provider: null, model: null };
      const answer = await chatJSON('Answer with the JSON object {"ok": true} and nothing else.', 'Check.', { model, maxTokens: 50, timeoutMs: 60_000, usage, title: 'Cetizion Tracker model check' });
      const ok = answer?.ok === true;
      if (!ok) failed += 1;
      console.log(`${ok ? 'routes ' : 'odd    '} ${model}  via ${usage.provider || '?'} in ${Date.now() - started} ms${readsPdf(model) ? ', reads PDFs' : ''}${ok ? '' : `: answered ${JSON.stringify(answer)}`}`);
    } catch (err) {
      failed += 1;
      console.log(`FAILS   ${model}: ${err.message.slice(0, 200)}`);
    }
  }
  console.log(failed
    ? `\n${failed} of ${models.length} did not answer with zero retention. Set OPENROUTER_MODEL to the first that does (the order is in docs/email-auto-entry-plan.md §4).`
    : `\nEvery model answers with zero retention. OPENROUTER_MODEL is ${aiConfig.model}.`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => { console.error(err); process.exit(1); });
