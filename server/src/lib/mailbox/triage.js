/**
 * One cheap call per email before a document reader runs
 * (docs/email-auto-entry-plan.md §3.8): what kind of email it is, from its
 * subject, its new text and its attachments' names. The PO and invoice
 * readers then make their one reading call (on the strong model, with the
 * PDF) only for what triage says is theirs, and the enquiry reader skips
 * newsletters, notifications and payment advice without its own call.
 *
 * The answer is stored per email, so the PO, invoice and enquiry readers,
 * and the same email in another mailbox, share one call. Triage only ever
 * lets a reader skip: with no AI, triage switched off, the day's ceiling
 * reached, an unsure answer or a failed call, every reader reads as before.
 */
import { query } from '../../db.js';
import { aiConfig, chatJSON } from '../ai.js';
import { mainText } from './enquiryDetect.js';
import { S, answerSchema } from './promptRules.js';

export const LABELS = ['enquiry', 'quotation_sent', 'client_po', 'po_change', 'our_invoice', 'payment_advice', 'other'];

/** How sure triage must be before a reader skips an email on its word. */
export const TRIAGE_BAR = 0.8;

/** Tests set `chat`; otherwise the triage model, when there is an AI key. */
export const deps = { chat: null };
const chatFn = () => deps.chat || (aiConfig.enabled && aiConfig.triageModel
  ? (system, user, opts) => chatJSON(system, user, { title: 'Cetizion Tracker email triage', model: aiConfig.triageModel, ...opts })
  : null);

export const TRIAGE_SCHEMA = answerSchema('email_triage', { label: S.oneOf(LABELS), confidence: { type: 'number' } });

const MAX_TRIAGE_TEXT = 3000;

/** What triage is asked: never the attachments themselves, only their names. */
export function buildTriagePrompt({ direction, subject, text, from, to = [], attachments = [] }) {
  const system = [
    'You sort one email in the mailbox of Cetizion Verifica, an Indian sustainability, ESG and certification consultancy, by what it is. Answer with one JSON object: {"label": ' + LABELS.map((l) => `"${l}"`).join(' | ') + ', "confidence": 0 to 1}.',
    'enquiry: a client or prospect writing to us about work: asking for a quotation or proposal, sending a scope or RFQ, or replying about one.',
    'quotation_sent: our quotation, proposal or offer sent to a client, or our revision of one.',
    'client_po: a client\'s purchase order, work order, letter of intent or contract to us.',
    'po_change: a client amending, revising or cancelling a purchase order already sent.',
    'our_invoice: our tax invoice sent to a client (not a proforma, a statement or a reminder).',
    'payment_advice: a remittance, payment confirmation or TDS certificate.',
    'other: anything else: newsletters, notifications, marketing, vendors selling to us, a vendor\'s bill, colleagues writing to each other, job applications.',
    'confidence: how sure you are of the label. Say less than 0.8 whenever the email could be one of ours (an enquiry, a quotation, a PO or an invoice) and you cannot tell which.',
  ].join('\n');
  const user = [
    `Direction: ${direction === 'outbound' ? 'sent by us' : 'received by us'}. From: ${from?.name || ''} <${from?.email || ''}>. To: ${to.map((p) => p.email).join(', ')}`,
    `Subject: ${subject || ''}`,
    attachments.length ? `Attachments: ${attachments.join(', ')}` : 'Attachments: none listed',
    String(text || '').slice(0, MAX_TRIAGE_TEXT),
  ].join('\n');
  return { system, user };
}

/** The answer in a fixed shape; anything malformed is "other" with confidence 0, which skips nothing. */
export function parseTriage(raw) {
  let v = raw;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = null; } }
  const c = Number(v?.confidence);
  return {
    label: LABELS.includes(v?.label) ? v.label : 'other',
    confidence: LABELS.includes(v?.label) && Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : 0,
  };
}

/** Each reader skips what triage surely says is not its own. */
const OWN = {
  po: ['client_po', 'po_change'],
  invoice: ['our_invoice'],
  // A PO the PO reader turned down may still be an RFQ: it stays with the enquiry reader.
  enquiry: ['enquiry', 'quotation_sent', 'client_po', 'po_change'],
};
export const notFor = (reader, t) => Boolean(t) && t.confidence >= TRIAGE_BAR && !OWN[reader].includes(t.label);

/**
 * The email's label: stored, or asked once. Returns { label, confidence }
 * or null (no AI, triage off, the ceiling reached, the call failed).
 * ctx is the reader's run context: its settings.dailyAiLimit and aiUsed.
 */
export async function triage(account, cand, ctx, direction) {
  const { m } = cand;
  ctx.triageOn ??= (await query(`SELECT value FROM settings WHERE key = 'email_triage_enabled'`)).rows[0]?.value !== 'false';
  if (!ctx.triageOn) return null;
  const { rows: [stored] } = await query(
    `SELECT label, confidence::float8 AS confidence FROM email_triage
      WHERE (account_id = $1 AND provider_id = $2) OR ($3::text IS NOT NULL AND lower(internet_message_id) = lower($3))
      ORDER BY (account_id = $1 AND provider_id = $2) DESC LIMIT 1`,
    [account.id, m.provider_id, m.internet_message_id || null]);
  if (stored) return stored;
  const chat = chatFn();
  if (!chat || ctx.aiUsed >= ctx.settings.dailyAiLimit) return null;
  ctx.aiUsed += 1;
  await query(`INSERT INTO email_ai_calls (purpose) VALUES ('triage')`);
  const { system, user } = buildTriagePrompt({
    direction, subject: m.subject, from: m.from, to: [...(m.to || []), ...(m.cc || [])],
    text: mainText(m.body_html || (m.preview ? `<p>${m.preview}</p>` : ''), MAX_TRIAGE_TEXT),
    attachments: (m.attachments || []).map((a) => a?.name).filter(Boolean),
  });
  let t;
  try {
    t = parseTriage(await chat(system, user, { maxTokens: 200, timeoutMs: 30_000, schema: TRIAGE_SCHEMA }));
  } catch (err) {
    console.warn('[triage] not answered, the reader reads it:', err.message);
    return null;
  }
  await query(
    `INSERT INTO email_triage (account_id, provider_id, internet_message_id, direction, label, confidence)
     VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (account_id, provider_id) DO NOTHING`,
    [account.id, m.provider_id, m.internet_message_id || null, direction === 'outbound' ? 'outbound' : 'inbound', t.label, t.confidence]);
  return t;
}
