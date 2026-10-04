/**
 * Reading the quotation PDF we sent (docs/email-enquiries-plan.md §3.9):
 * which attachment it is, its text, what the AI is asked, and the checks
 * the AI's answer must pass. The checks are pure — no database, no network
 * — because they are what decides whether a quotation is created at all.
 *
 * (lib/quotationPdf.js is the other direction: it builds our PDFs.)
 */
import { extractText, getDocumentProxy } from 'unpdf';
import { isUs } from './enquiryDetect.js';
import { READING_RULES, serviceRule, whoWeAre } from './promptRules.js';

export const MAX_PDF_BYTES = 15 * 1024 * 1024;
import { MAX_DOCUMENT_TEXT, MAX_EMAIL_TEXT, MAX_PAGES } from './readLimits.js';

export { MAX_PAGES };
/**
 * Below this many characters of text (spaces aside) a PDF is a scan and
 * needs OCR. A scan yields next to none; even a one-page quotation
 * exported from Word yields hundreds.
 */
export const SCANNED_BELOW = 50;
const QUOTE_NAME = /quot|proposal|offer|\bqt\b|\/qt\/|[-_ ]qt[-_ ]|techno/i;
const QUOTE_TEXT = /quotation|proposal|offer|quote/i;

export const isPdf = (a) => /application\/pdf/i.test(a?.contentType || '') || /\.pdf$/i.test(a?.name || '');

/** The text of a PDF, page by page, at most MAX_PAGES. Throws { code: 'encrypted' | 'unreadable' }. */
export async function pdfText(buffer) {
  let pdf;
  try {
    pdf = await getDocumentProxy(new Uint8Array(buffer));
  } catch (err) {
    throw Object.assign(new Error(err.message), { code: err.name === 'PasswordException' ? 'encrypted' : 'unreadable' });
  }
  try {
    const { text } = await extractText(pdf, { mergePages: false });
    return text.slice(0, MAX_PAGES).map((p) => String(p || ''));
  } finally {
    await pdf.destroy?.().catch?.(() => {});
  }
}

/**
 * Which PDF is the quotation, best first: a file name that says so, then a
 * first page that says so, then the largest. Brochures and company
 * profiles fall to the bottom this way.
 * files: [{ name, size, firstPage }]
 */
export function rankPdfs(files) {
  const score = (f) => (QUOTE_NAME.test(f.name || '') ? 2 : 0) + (QUOTE_TEXT.test(f.firstPage || '') ? 1 : 0);
  return [...files].sort((a, b) => score(b) - score(a) || (b.size || 0) - (a.size || 0));
}

/**
 * An amount as printed: "2,50,000.00", "₹ 2,95,000/-", "Rs. 1,200", "INR 45000".
 * Indian and Western grouping both read the same way. Returns null for
 * anything that is not a number.
 */
export function parseAmount(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v === null || v === undefined) return null;
  // A label printed against the figure goes too: "Indian Rupee24,63,840.00", "Total: 5,90,000".
  const s = String(v).replace(/(rs\.?|inr|usd|eur|gbp|₹|\$|€|£)/gi, '').replace(/^[^\d-]*[a-z][^\d-]*(?=-?\d)/i, '').replace(/\/-\s*$/, '').replace(/[\s,]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Equal within ₹1 or 0.5%, whichever is more. */
export function near(a, b) {
  if (a === null || b === null || a === undefined || b === undefined) return false;
  return Math.abs(a - b) <= Math.max(1, 0.005 * Math.max(Math.abs(a), Math.abs(b)));
}

const lineAmount = (l) => Math.round(l.qty * l.rate * (1 - (l.discount_percent || 0) / 100) * 100) / 100;

/** The lines' amounts sum to the subtotal, and subtotal plus tax is the total. */
export function linesAddUp(lines, { subtotal, tax_total: tax, total }) {
  if (!lines.length) return false;
  const sum = lines.reduce((t, l) => t + lineAmount(l), 0);
  if (subtotal !== null && subtotal !== undefined && !near(sum, subtotal)) return false;
  const sub = subtotal ?? sum;
  if (total !== null && total !== undefined) {
    if (tax !== null && tax !== undefined) return near(sub + tax, total);
    // No tax printed: the lines' own GST must make up the difference.
    const gst = lines.reduce((t, l) => t + Math.round(lineAmount(l) * (l.gst_rate ?? 0)) / 100, 0);
    return near(sub + gst, total) || near(sub, total);
  }
  return subtotal !== null && subtotal !== undefined;
}

/** The digits of an amount appear in the document, however it was grouped. */
export function amountInText(amount, text) {
  if (!text || amount === null) return false;
  const digits = String(text).replace(/[,\s]/g, '');
  const whole = Math.round(amount);
  return digits.includes(String(whole)) || digits.includes(amount.toFixed(2));
}

const CURRENCIES = new Set(['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD', 'JPY', 'AUD', 'CAD', 'CHF', 'CNY', 'SAR']);
const isoDate = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ? v : null);
const clean = (v, max = 300) => { const s = String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max); return s && !/^(null|none|n\/a)$/i.test(s) ? s : null; };
const days = (a, b) => (Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 864e5;

/** "Rev 1", "R2", "rev.3", 2 → 2. */
export function parseRevision(v) {
  if (Number.isInteger(v) && v >= 0) return v;
  const m = /(\d+)/.exec(String(v ?? ''));
  return m ? Number(m[1]) : 0;
}

/**
 * The AI's extraction, checked (plan §3.9.3, §3.9.5). The model proposes;
 * this decides. Returns
 *   { ok: true, extraction, linesOk, printed }   create the quotation
 *   { ok: false, reason }                        enquiry only, and a task
 * reason: low_confidence | no_client | no_total | total_not_in_pdf
 */
export function checkExtraction(raw, { emailDate, sourceText = null, minConfidence = 0.8, ourNames = [], internalDomains = [] } = {}) {
  const v = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const confidence = Number(v.confidence);
  if (!Number.isFinite(confidence) || confidence < minConfidence) return { ok: false, reason: 'low_confidence' };

  const company = clean(v.client?.company_name, 200);
  if (!company || isUs(company, { ourNames, internalDomains })) return { ok: false, reason: 'no_client' };

  // Lines: every number checked; one bad line and none are used.
  const rawLines = Array.isArray(v.lines) ? v.lines : [];
  const lines = []; let linesValid = rawLines.length > 0;
  for (const l of rawLines) {
    const qty = l?.qty === undefined || l?.qty === null ? 1 : parseAmount(l.qty);
    const rate = parseAmount(l?.rate);
    const disc = l?.discount_percent === undefined || l?.discount_percent === null ? 0 : parseAmount(l.discount_percent);
    const gst = l?.gst_rate === undefined || l?.gst_rate === null ? 18 : parseAmount(l.gst_rate);
    const description = clean(l?.description, 500);
    if (!description || qty === null || qty <= 0 || rate === null || rate < 0 || disc === null || disc < 0 || disc > 100 || gst === null || gst < 0 || gst > 100) {
      linesValid = false; break;
    }
    lines.push({ description, qty, unit: clean(l?.unit, 40), rate, discount_percent: disc, gst_rate: gst, service: clean(l?.service, 200) });
  }

  let subtotal = parseAmount(v.subtotal); let tax = parseAmount(v.tax_total); let total = parseAmount(v.total);
  if (total === null && subtotal !== null && tax !== null) total = Math.round((subtotal + tax) * 100) / 100;
  const linesOk = linesValid && linesAddUp(lines, { subtotal, tax_total: tax, total });
  if (linesOk && subtotal === null) subtotal = Math.round(lines.reduce((t, l) => t + lineAmount(l), 0) * 100) / 100;
  if (total === null || total <= 0) return { ok: false, reason: 'no_total' };
  // A total the document does not print is a total the model made up.
  if (sourceText !== null && !amountInText(total, sourceText)) return { ok: false, reason: 'total_not_in_pdf' };

  // The email's date where the business is: a quotation dated 2 October and
  // emailed at 01:00 IST was sent on 1 October in UTC.
  const emailDay = new Date(new Date(emailDate).getTime() + 330 * 60_000).toISOString().slice(0, 10);
  let quotationDate = isoDate(v.quotation_date); let validUntil = isoDate(v.valid_until);
  if (!quotationDate || days(emailDay, quotationDate) < 0 || days(emailDay, quotationDate) > 60) { quotationDate = emailDay; validUntil = null; }
  if (validUntil && days(validUntil, quotationDate) <= 0) validUntil = null;
  const currency = String(v.currency || '').trim().toUpperCase();

  return {
    ok: true,
    linesOk,
    printed: { printed_subtotal: subtotal, printed_tax_total: tax, printed_total: total },
    extraction: {
      quotation_no_printed: clean(v.quotation_no_printed, 60),
      revision: parseRevision(v.revision),
      quotation_date: quotationDate, valid_until: validUntil,
      client: { company_name: company, gstin: clean(v.client?.gstin, 20), state: clean(v.client?.state, 60), country: clean(v.client?.country, 80), contact_name: clean(v.client?.contact_name, 120) },
      currency: CURRENCIES.has(currency) ? currency : 'INR',
      lines: linesOk ? lines : [],
      subtotal, tax_total: tax, total,
      terms: clean(v.terms, 2000),
      confidence: Math.round(Math.min(1, confidence) * 1000) / 1000,
    },
  };
}

/**
 * What the AI is asked: the PDF's text (or the file, for a scan) and the
 * covering email. One call reads the whole quotation as autoQuotation.js
 * creates it: lines that add up (linesAddUp), each with its service spelt
 * as the catalogue spells it, and the number without its revision mark so
 * a revision finds the quotation it revises.
 */
export function extractionPrompt({ pdfText: text, emailSubject, emailText, sentAt, services = [], ourNames = [] }) {
  const system = [
    'You read a quotation that Cetizion Verifica (an Indian sustainability, ESG and certification consultancy) sent to a client, and extract it.',
    whoWeAre({ ourNames }),
    'Answer with one JSON object and nothing else:',
    '{"quotation_no_printed": string|null, "revision": integer, "quotation_date": "YYYY-MM-DD"|null, "valid_until": "YYYY-MM-DD"|null,',
    ' "client": {"company_name": string|null, "gstin": string|null, "state": string|null, "country": string|null, "contact_name": string|null},',
    ' "currency": "INR"|..., "lines": [{"description": string, "qty": number, "unit": string|null, "rate": "amount as printed", "discount_percent": number, "gst_rate": number, "service": string|null}],',
    ' "subtotal": "amount as printed"|null, "tax_total": "amount as printed"|null, "total": "amount as printed"|null, "terms": string|null, "confidence": 0 to 1}',
    'The client is the ADDRESSEE, never the letterhead: Cetizion Verifica is the sender, not the client. client: from the "To" or "Kind attn." block: the company, its GSTIN, the Indian state of its address (the place of supply), its country, and the person it is addressed to.',
    'quotation_no_printed: our number as printed, without its label and without any revision mark ("CTZ/QT/2026/014 Rev 1" gives "CTZ/QT/2026/014" and revision 1). revision: 0 unless the document says Rev 1, R2 and so on.',
    'quotation_date: the date printed on the quotation. valid_until: the validity date printed; when validity is given in days ("valid for 30 days"), the quotation date plus those days; else null.',
    'lines: one entry per priced line, in order. Never a GST, tax, subtotal, discount-total, round-off or grand-total row. description: the line\'s text as printed. qty: a number, 1 when not printed. unit: as printed ("site", "man-day", "engagement"), else null. rate: the unit price before discount and tax, as printed. discount_percent: the line\'s discount in percent, 0 when none. gst_rate: the line\'s GST percent, else the one rate the document applies to all lines (18), else null.',
    serviceRule(services, { field: 'Each line\'s service' }),
    'subtotal: the total before tax. tax_total: the total GST printed as one figure; null when only CGST and SGST are printed separately. total: the grand total including tax.',
    'terms: the payment and commercial terms as printed (payment schedule, taxes, travel and expenses, validity), in up to a paragraph.',
    ...READING_RULES,
    'confidence: how sure you are the document is a quotation and that you read its lines and totals correctly. A field it does not print is null and does not lower confidence; doubt about what a printed value says does.',
  ].join('\n');
  const user = [
    `Covering email, sent ${String(sentAt).slice(0, 10)}. Subject: ${emailSubject || ''}`,
    String(emailText || '').slice(0, MAX_EMAIL_TEXT),
    text ? `\nQuotation document text:\n${String(text).slice(0, MAX_DOCUMENT_TEXT)}` : '\nThe quotation document is attached.',
  ].join('\n');
  return { system, user };
}
