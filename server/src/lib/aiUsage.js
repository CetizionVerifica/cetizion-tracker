/**
 * Each day's AI calls and spend, by what made them and on which model
 * (docs/email-auto-entry-plan.md §3.10): the auto-entry panel shows it, so
 * the cost of reading documents with the strongest model is in plain view.
 * Imported for its effect by the web app and the worker; nothing here
 * changes how a call is made, and a failed write never fails the call.
 */
import { query } from '../db.js';
import { onUsage } from './ai.js';

/** "Cetizion Tracker email purchase orders" → "email purchase orders". */
const purposeOf = (title) => String(title || '').replace(/^Cetizion Tracker\s*/i, '').trim().slice(0, 80) || 'other';

export async function recordAiUsage({ title, model, prompt_tokens: input = 0, completion_tokens: output = 0, cost = 0 }) {
  await query(
    `INSERT INTO ai_usage_daily (day, purpose, model, calls, prompt_tokens, completion_tokens, cost_usd)
     VALUES ((now() AT TIME ZONE 'Asia/Kolkata')::date, $1, $2, 1, $3, $4, $5)
     ON CONFLICT (day, purpose, model) DO UPDATE
        SET calls = ai_usage_daily.calls + 1,
            prompt_tokens = ai_usage_daily.prompt_tokens + EXCLUDED.prompt_tokens,
            completion_tokens = ai_usage_daily.completion_tokens + EXCLUDED.completion_tokens,
            cost_usd = ai_usage_daily.cost_usd + EXCLUDED.cost_usd`,
    [purposeOf(title), String(model || 'unknown').slice(0, 120), Math.round(input), Math.round(output), Number(cost) || 0]);
}

onUsage(async (u) => {
  try {
    await recordAiUsage(u);
  } catch (err) {
    console.warn('[ai] usage not recorded:', err.message);
  }
});
