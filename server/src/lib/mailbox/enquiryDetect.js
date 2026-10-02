/**
 * Is this email a new enquiry? The rules, kept free of the database and the
 * network so they can be tested on their own (docs/email-enquiries-plan.md
 * §3.2, §3.3, §3.8).
 *
 *   prefilter(message, facts)   free rules: is it worth judging at all?
 *   ruleScore(subject, text)    the rules-only judgement, 0 to 1
 *   rulesVerdict(...)           a verdict without AI, in the AI's shape
 *   buildPrompt(...)            what the AI is asked
 *   parseVerdict(raw, ...)      what the AI answered, checked by code
 *   companyNameFromEmail(addr)  "acme-steel.co.in" → "Acme Steel"
 *
 * The model proposes and code decides: nothing the AI returns is used
 * without passing through parseVerdict.
 */
import { domainOf, PUBLIC_DOMAINS, referencesIn, snippet } from './rules.js';
import { SERVICE_LINES, serviceLinesFor, OTHER_SERVICE, NO_SERVICE } from '../serviceLines.js';

export const KINDS = ['new_enquiry', 'quotation_sent', 'reply_or_followup', 'billing', 'vendor_or_sales_pitch', 'marketing', 'job_application', 'spam', 'other'];

/** The bar rules alone must clear: they err towards missing an enquiry, not inventing one. */
export const RULES_BAR = 0.85;

/** How much of a body is read: the new part only, as text. */
export const MAX_TEXT = 4000;
export const MAX_RECIPIENTS = 5;

const ENQUIRY_TERMS = [
  /\bquot(e|es|ation|ations)\b/i, /\bproposal\b/i, /\brfq\b/i, /\brequest for\b/i, /\benquir(y|ies)\b/i, /\binquir(y|ies)\b/i,
  /\brequirements?\b/i, /\binterested in\b/i, /\bpricing\b/i, /\bcost\b/i, /\bfees?\b/i, /\bplease share\b/i, /\bscope\b/i,
  /\baudit\b/i, /\bcertification\b/i, /\bassessment\b/i,
];
// A few phrasings that say "quote us" outright weigh more than a word in passing.
const STRONG_TERMS = /\brfq\b|request for (a )?(quot|proposal)|please (send|share) (us )?(a |your )?(quot|proposal|offer)|need a quot|looking for a quot/i;
const BULK = /\bunsubscribe\b|view (it |this (email|message) )?in (your |a )?browser|this is an automated (message|email)|do not reply to this (email|message)/i;
const BULK_SENDER = /^(newsletters?|marketing|news|mailer|bounces?|campaigns?|updates|digest)[@.+-]/i;
const BILLING_HR = /\binvoice\b|\bremittance\b|payment advice|statement of account|\bresume\b|\bcv\b|curriculum vitae|job application|applying for|\binternship\b/i;
const JOB = /\bresume\b|\bcv\b|curriculum vitae|job application|applying for (the )?(post|position|role)|\binternship\b/i;
const QUOTATION_WORDS = /\bquotation\b|\bquote\b|\bproposal\b|\boffer\b|techno[\s-]*commercial|fee proposal|commercial offer|\bprice\b/i;
const REPLY = /^\s*(re|aw|sv)\s*:/i;
const FORWARD = /^\s*(fw|fwd|wg)\s*:/i;

/** Every record number an email mentions, in its subject or its new text. */
export function numbersIn(subject, text = '') {
  const a = referencesIn(subject); const b = referencesIn(text);
  return {
    quotations: [...new Set([...a.quotations, ...b.quotations])],
    enquiries: [...new Set([...a.enquiries, ...b.enquiries])],
    pos: [...new Set([...a.pos, ...b.pos])],
  };
}

/** The new part of a message's body, as plain text, capped. */
export const mainText = (html, max = MAX_TEXT) => snippet(html, max);

const anyNumber = (refs) => refs.quotations.length + refs.enquiries.length + refs.pos.length > 0;

/**
 * Should this email be judged? Pure: the caller works out the facts that
 * need the database.
 *
 * message: { direction, subject, text, from: {email}, external: [...], has_attachments }
 * facts:
 *   firstInConversation  inbound: nothing earlier is known in this conversation
 *   handled              the conversation is already linked to a record by
 *                        number, converted, or has an enquiry decision
 *   toVendor             outbound: a recipient is one of our vendors
 *
 * Returns { candidate: 'inbound' | 'quotation' | null, reason }.
 */
export function prefilter(message, facts = {}) {
  const subject = String(message.subject || '');
  const text = String(message.text || '');
  const both = `${subject}\n${text}`;
  if (facts.handled) return { candidate: null, reason: 'already handled' };

  if (message.direction === 'outbound') {
    if (FORWARD.test(subject)) return { candidate: null, reason: 'forward' };
    if ((message.external || []).length > MAX_RECIPIENTS) return { candidate: null, reason: 'too many recipients' };
    if (facts.toVendor) return { candidate: null, reason: 'to a vendor' };
    if (BULK.test(text)) return { candidate: null, reason: 'bulk' };
    if (looksLikeQuotation(message)) return { candidate: 'quotation', reason: null };
    return { candidate: null, reason: 'not a quotation' };
  }

  if (!facts.firstInConversation) return { candidate: null, reason: 'not the first message' };
  if (REPLY.test(subject)) return { candidate: null, reason: 'reply' };
  if (anyNumber(referencesIn(subject))) return { candidate: null, reason: 'names a record' };
  if (BULK.test(text) || BULK_SENDER.test(String(message.from?.email || ''))) return { candidate: null, reason: 'bulk' };
  if (BILLING_HR.test(both) && !ENQUIRY_TERMS.some((re) => re.test(both))) return { candidate: null, reason: 'billing or hr' };
  return { candidate: 'inbound', reason: null };
}

/**
 * Our quotation going to a client: one of our quotation numbers, or an
 * attachment with quotation words. Words alone, with nothing attached and
 * no number, are not enough — that is a covering note at most.
 */
export function looksLikeQuotation(message) {
  const subject = String(message.subject || ''); const text = String(message.text || '');
  if (numbersIn(subject, text).quotations.length) return true;
  return Boolean(message.has_attachments) && QUOTATION_WORDS.test(`${subject}\n${text}`);
}

/** The rules' own judgement of an inbound email, 0 to 1. */
export function ruleScore(subject, text) {
  const both = `${subject || ''}\n${text || ''}`;
  const hits = ENQUIRY_TERMS.filter((re) => re.test(both)).length;
  let score = Math.min(0.75, hits * 0.25);
  if (STRONG_TERMS.test(both)) score += 0.15;
  if (SERVICE_LINES.some((l) => l.pattern.test(both))) score += 0.2;
  if (BILLING_HR.test(both)) score -= 0.4;
  if (JOB.test(both)) score -= 0.6;
  if (BULK.test(both)) score -= 0.6;
  return Math.round(Math.max(0, Math.min(1, score)) * 1000) / 1000;
}

const TLDS = new Set(['com', 'in', 'co', 'net', 'org', 'biz', 'info', 'io', 'uk', 'us', 'de', 'ae', 'sg', 'gov', 'edu', 'ac', 'ltd', 'nic', 'res', 'firm', 'gen', 'ind', 'eu', 'fr', 'it', 'nl', 'jp', 'cn', 'au', 'ca']);
const SUBDOMAINS = new Set(['mail', 'email', 'in', 'india', 'corp', 'www', 'mx', 'smtp', 'groups']);

/** A company name from an address's domain, or null for free mail. */
export function companyNameFromEmail(email) {
  const d = domainOf(email);
  if (!d || PUBLIC_DOMAINS.has(d)) return null;
  const labels = d.split('.');
  while (labels.length > 1 && TLDS.has(labels[labels.length - 1])) labels.pop();
  while (labels.length > 1 && SUBDOMAINS.has(labels[0])) labels.shift();
  const core = labels[labels.length - 1];
  if (!core || TLDS.has(core)) return null;
  const words = core.split(/[-_]+/).filter(Boolean);
  if (!words.length) return null;
  // A short word with no vowels is an acronym: jsw → JSW, hpcl → HPCL.
  return words.map((w) => (w.length <= 5 && !/[aeiouy]/.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1))).join(' ');
}

/** The service line an email asks about, or null. */
export function serviceFrom(text) {
  const line = serviceLinesFor(text)[0];
  return line === OTHER_SERVICE || line === NO_SERVICE ? null : line;
}

const cleanName = (s, max = 160) => {
  const v = String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  return v && !/^(null|none|n\/a|unknown|-)$/i.test(v) ? v : null;
};
const fromName = (from) => {
  const n = cleanName(from?.name);
  return n && !n.includes('@') ? n : null;
};

/**
 * Is a company name ours? Our name from Settings, any internal domain, or
 * the word Cetizion.
 */
export function isUs(name, { ourNames = [], internalDomains = [] } = {}) {
  const key = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\b(pvt|private|ltd|limited|llp|inc)\b/g, '').trim();
  const k = key(name);
  if (!k) return false;
  if (/\bcetizion\b/.test(k)) return true;
  if (ourNames.some((n) => key(n) && key(n) === k)) return true;
  return internalDomains.some((d) => { const core = key(String(d).split('.')[0]); return core && k === core; });
}

/** A free-mail domain written where a company name should be. */
const isFreeMail = (name) => {
  const v = String(name || '').toLowerCase().replace(/\s+/g, '');
  return PUBLIC_DOMAINS.has(v) || [...PUBLIC_DOMAINS].some((d) => v === d.split('.')[0]);
};

/**
 * The rules' verdict, in the same shape the AI's is. For an outbound
 * quotation the prefilter's test is the whole decision.
 *
 * input: { direction, subject, text, from, to: [{email,name}], external, companyName }
 */
export function rulesVerdict(input) {
  const both = `${input.subject || ''}\n${input.text || ''}`;
  const client = input.direction === 'outbound' ? (input.external || input.to || [])[0] : input.from;
  const base = {
    company_name: input.companyName || companyNameFromEmail(client?.email),
    contact_name: fromName(client), contact_phone: null,
    service: serviceFrom(both), sector: null, country: null,
    summary: cleanName(input.subject, 200), quoted_amount: null, currency: null,
  };
  if (input.direction === 'outbound') {
    const numbered = numbersIn(input.subject, input.text).quotations.length > 0;
    return { ...base, kind: 'quotation_sent', confidence: numbered ? 0.9 : RULES_BAR, method: 'rules' };
  }
  const score = ruleScore(input.subject, input.text);
  return { ...base, kind: score >= RULES_BAR ? 'new_enquiry' : 'other', confidence: score, method: 'rules' };
}

/**
 * What the AI is asked. Only the sender, the subject and the new part of
 * the body go out; whether the company is known and has open deals, never
 * what they are worth.
 */
export function buildPrompt(input, { companyKnown = false, openDeals = 0 } = {}) {
  const lines = SERVICE_LINES.map((l) => l.name).join('; ');
  const system = [
    'You read one business email for Cetizion Verifica, an Indian sustainability, ESG and certification consultancy, and say what it is.',
    'Answer with one JSON object and nothing else:',
    '{"kind": one of ' + KINDS.map((k) => `"${k}"`).join(' | ') + ', "confidence": 0 to 1, "company_name": string|null, "contact_name": string|null, "contact_phone": string|null, "service": string|null, "sector": string|null, "country": string|null, "summary": string|null, "quoted_amount": number|null, "currency": string|null}',
    'new_enquiry: a client or prospect asking us for new work: a quote, a proposal, pricing, an audit, a certification, an assessment, a consultation.',
    'quotation_sent: an email WE send to a client carrying our quotation or proposal.',
    'reply_or_followup: about work already under discussion. vendor_or_sales_pitch: someone selling to us. billing: invoices, payments, statements.',
    'For inbound mail the company and contact are the sender\'s. For quotation_sent they are the RECIPIENT\'s, from the addressee and the letter, never from our own signature or letterhead.',
    `service: one of these service lines when it fits, otherwise the client's own words: ${lines}.`,
    'summary: one short sentence about what is asked, naming no one beyond the company. quoted_amount and currency only for quotation_sent, only if stated.',
    'Never invent a value: use null when the email does not say.',
  ].join('\n');
  const user = [
    `Direction: ${input.direction === 'outbound' ? 'sent by us' : 'received by us'}`,
    `From: ${input.from?.name || ''} <${input.from?.email || ''}>`,
    input.direction === 'outbound' ? `To: ${(input.external || []).map((p) => `${p.name || ''} <${p.email}>`).join(', ')}` : null,
    `Sender domain: ${domainOf(input.from?.email)}`,
    `Company already known to us: ${companyKnown ? 'yes' : 'no'}; open deals with them: ${openDeals}`,
    `Has attachments: ${input.has_attachments ? 'yes' : 'no'}`,
    `Subject: ${input.subject || ''}`,
    'Body (new part only):',
    String(input.text || '').slice(0, MAX_TEXT),
  ].filter((l) => l !== null).join('\n');
  return { system, user };
}

const CURRENCIES = new Set(['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD', 'JPY', 'AUD', 'CAD', 'CHF', 'CNY', 'SAR']);

/**
 * The AI's answer, checked. Anything malformed comes back as kind 'other'
 * with confidence 0, which no threshold accepts.
 */
export function parseVerdict(raw, { ourNames = [], internalDomains = [] } = {}) {
  let v = raw;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = null; } }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { kind: 'other', confidence: 0, company_name: null, contact_name: null, contact_phone: null, service: null, sector: null, country: null, summary: null, quoted_amount: null, currency: null, method: 'ai' };
  const kind = KINDS.includes(v.kind) ? v.kind : 'other';
  const c = Number(v.confidence);
  let company = cleanName(v.company_name, 200);
  if (company && (isUs(company, { ourNames, internalDomains }) || isFreeMail(company))) company = null;
  const amount = Number(v.quoted_amount);
  const currency = String(v.currency || '').trim().toUpperCase();
  return {
    kind,
    confidence: Number.isFinite(c) ? Math.round(Math.max(0, Math.min(1, c)) * 1000) / 1000 : 0,
    company_name: company,
    contact_name: cleanName(v.contact_name, 120),
    contact_phone: cleanName(v.contact_phone, 40),
    service: cleanName(v.service, 300),
    sector: cleanName(v.sector, 120),
    country: cleanName(v.country, 80),
    summary: cleanName(v.summary, 300),
    quoted_amount: Number.isFinite(amount) && amount > 0 ? amount : null,
    currency: CURRENCIES.has(currency) ? currency : null,
    method: 'ai',
  };
}
