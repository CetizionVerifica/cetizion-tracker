/**
 * Is this email a client's purchase order? The rules, kept free of the
 * database and the network so they can be tested on their own
 * (docs/email-po-plan.md §3.1, §3.2).
 *
 *   poPrefilter(message, facts)   free rules: is it worth reading at all?
 *   poNumbersIn(text)             the PO numbers an email or PDF prints
 *   isPortalSender(email, list)   a procurement portal's notification
 *   buildPoPrompt(...)            what the AI is asked
 *   parsePoVerdict(raw)           what the AI answered, in a fixed shape
 *
 * The model proposes and code decides: parsePoVerdict only shapes the
 * answer; checkPo (pdfPurchaseOrder.js) decides whether it is used.
 */
import { parseAmount } from './pdfQuotation.js';
import { BULK, BULK_SENDER, addr, domainOf } from './rules.js';
import { splitReference } from '../../import/parse.js';
import { MAX_DOCUMENT_TEXT as MAX_PDF_TEXT, MAX_EMAIL_TEXT, MAX_LINES } from './readLimits.js';
import { READING_RULES, TOTALS_RULES, parseTaxBreakup, serviceRule, whoWeAre } from './promptRules.js';

export const DOCUMENT_TYPES = ['purchase_order', 'work_order', 'loi', 'contract', 'amendment', 'cancellation', 'other'];

/** How much of the email's own text, and of the PO and its annexures, goes to the AI (readLimits.js). */
export { MAX_EMAIL_TEXT, MAX_DOCUMENT_TEXT as MAX_PDF_TEXT } from './readLimits.js';

// How clients say it. The short forms are matched in capitals only: "po"
// and "wo" in lower case are as often parts of other words or typos.
const PO_WORDS = /\bpurchase[\s-]*orders?\b|\bwork[\s-]*orders?\b|\bservice[\s-]*orders?\b|\bletter of (intent|award)\b|\bcontract\b|\border confirmation\b|pleased to (place|award|release)|(attached|enclosed) (is )?(our|the) (purchase )?order\b|\b(release|placing|placed) (of |the |an |our )?(purchase )?order\b/i;
const PO_SHORT = /\bP\.?\s?O\.?(?=[\s:#-]|$)|\bW\.?O\.?(?=[\s:#-]|$)|\bLOI\b/;
// Mail about money already moving mentions PO numbers too.
const PAYMENT = /\bremittance\b|payment advice|\bUTR\b|\bcredited\b|payment (has been |is )?(made|released|processed)/i;
// "PO_4500012345.pdf": an underscore counts as a break in a file name.
const PO_FILE = /(^|[^a-z])(po|wo|loi)([^a-z]|$)|order|contract|purchase/i;
const REPLY = /^\s*(re|aw|sv)\s*:/i;

/** "*@ansmtp.ariba.com", "orders@acme.com", "*.coupahost.com". */
function matchesPattern(email, pattern) {
  const p = addr(pattern);
  if (!p) return false;
  const e = addr(email);
  const re = new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
  return re.test(e) || (!p.includes('@') && re.test(domainOf(e)));
}

/** Is this address a procurement portal's? patterns: the po_portal_senders setting, as a list or comma-separated. */
export function isPortalSender(email, patterns = []) {
  const list = Array.isArray(patterns) ? patterns : String(patterns || '').split(',');
  return list.some((p) => matchesPattern(email, p.trim()));
}

// A label a PO number follows: "PO No:", "P.O. Number –", "Order No.",
// "WO No.", "Purchase Order #", "Contract No", "LOI Ref".
const LABEL = /\b(?:purchase\s+order|work\s+order|service\s+order|p\.?\s?o\.?|w\.?\s?o\.?|order|contract|loi|agreement)\s*(?:no\.?|number|num\.?|#|ref(?:erence)?\.?)\s*[:.#–—-]*\s*([A-Z0-9][A-Z0-9/_.-]{1,39})/gi;
const BARE = /\b(?:PO|WO)[-/]\d[\w/-]{2,}|\bPO[-\s]?\d{3,}\b/g;

/**
 * The PO numbers in a text, as printed. Used for matching and duplicates,
 * never for the phase 1 "names a record" rule. A label followed by
 * "Awaited", "TBD" or "Verbal" is not a number: splitReference's refusal.
 */
export function poNumbersIn(text) {
  const s = String(text || '');
  const found = [];
  for (const m of s.matchAll(LABEL)) {
    const token = m[1].replace(/[.\-/_]+$/, '');
    const { number } = splitReference(token);
    if (number && /\d/.test(number) && number.length >= 3) found.push(number);
  }
  for (const m of s.matchAll(BARE)) found.push(m[0].replace(/\s+/g, '-'));
  return [...new Set(found)];
}

/**
 * Should this email be read as a possible PO? Pure: the caller works out the
 * facts that need the database.
 *
 * message: { direction, subject, text, from: {email}, attachments: [{name, contentType}], has_attachments }
 * facts:
 *   decided        it already has a PO decision in this mailbox
 *   portalSenders  the po_portal_senders setting
 *   readAll        email_read_everything: every inbound email is read, the
 *                  AI decides whether it is an order
 *
 * Returns { candidate: boolean, reason }. Runs on every inbound message,
 * replies included: that is where most POs arrive.
 */
export function poPrefilter(message, facts = {}) {
  if (facts.decided) return { candidate: false, reason: 'already decided' };
  if (message.direction !== 'inbound') return { candidate: false, reason: 'outbound' };
  if (facts.readAll) return { candidate: true, reason: null };
  const subject = String(message.subject || '');
  const text = String(message.text || '');
  const files = (message.attachments || []).map((a) => String(a?.name || ''));
  const both = `${subject}\n${text}`;
  const portal = isPortalSender(message.from?.email, facts.portalSenders);

  if (!portal && (BULK.test(text) || BULK_SENDER.test(String(message.from?.email || '')))) return { candidate: false, reason: 'bulk' };
  if (PAYMENT.test(both)) return { candidate: false, reason: 'payment advice' };

  const worded = PO_WORDS.test(both) || PO_SHORT.test(both) || files.some((f) => PO_FILE.test(f) && /\.pdf$/i.test(f));
  if (!worded) return { candidate: false, reason: 'no PO words' };

  const pdf = (message.attachments || []).some((a) => /application\/pdf/i.test(a?.contentType || '') || /\.pdf$/i.test(a?.name || ''))
    // Without the list, a message that says it has attachments may have the PDF.
    || (!message.attachments && Boolean(message.has_attachments));
  if (pdf || portal || poNumbersIn(both).length) return { candidate: true, reason: null };
  // "We will send the PO next week" is not a PO.
  return { candidate: false, reason: REPLY.test(subject) ? 'PO words in a reply, nothing attached' : 'PO words only' };
}

/**
 * What the AI is asked. The email's new text and the PO's text go out, for
 * PO candidates only (security.md); for a scanned PO the file goes instead,
 * and pdfText is null.
 *
 * One call reads everything registration needs (checkPo, stagesFromTerms,
 * autoPurchaseOrder.js): the lines without tax rows, so they add up to the
 * basic value; the payment clause word for word, so its stages are read
 * from it; and each line's service spelt as the catalogue spells it, so the
 * service's payment terms and onboarding templates apply.
 */
export function buildPoPrompt({ pdfText = null, emailSubject, emailText, receivedAt, from, services = [], ourNames = [], ourGstin = null, ourGstins = null, partners = [] }) {
  const system = [
    'You read one document a client sent to Cetizion Verifica, an Indian sustainability, ESG and certification consultancy, and say whether it is a purchase order to us, and what it says.',
    whoWeAre({ ourNames, ourGstin, ourGstins, partners }),
    'Answer with one JSON object and nothing else:',
    '{"is_purchase_order": boolean, "document_type": ' + DOCUMENT_TYPES.map((t) => `"${t}"`).join(' | ') + ', "confidence": 0 to 1,',
    ' "po_number": string|null, "po_date": "YYYY-MM-DD"|null, "amendment_no": integer,',
    ' "buyer": {"company_name": string|null, "gstin": string|null, "state": string|null, "contact_name": string|null, "contact_email": string|null},',
    ' "vendor": {"company_name": string|null, "gstin": string|null},',
    ' "our_quotation_ref": string|null, "currency": "INR"|...,',
    ' "lines": [{"description": string, "qty": number, "rate": "amount as printed", "amount": "amount as printed", "service": string|null}],',
    ' "basic_value": "amount as printed"|null, "tax_value": "amount as printed"|null, "total_value": "amount as printed"|null, "gst_extra": boolean,',
    ' "tax_breakup": {"igst": "amount as printed"|null, "cgst": "amount as printed"|null, "sgst": "amount as printed"|null}, "total_in_words": string|null,',
    ' "payment_terms_text": string|null, "credit_days": integer|null, "delivery_date": "YYYY-MM-DD"|null,',
    ' "project_manager": {"name": string|null, "email": string|null}}',
    'The BUYER is the client who issues the order: its name, GSTIN and state from the buyer, "Bill to" or letterhead block. The VENDOR (supplier, contractor, service provider) is who it is addressed to; for a PO to us that is Cetizion Verifica.',
    'is_purchase_order: true for an order placed with us (purchase_order, work_order, loi, contract), including one raised through a procurement portal (Ariba, Coupa, SAP); false otherwise.',
    'document_type: purchase_order, work_order, loi (letter of intent or award) or contract for a new order; amendment for a revised or amended order ("Amendment 1", "Rev 2"); cancellation for a cancelled order; other for anything else (a quotation, an invoice, a remittance, a reminder, an email that only promises an order).',
    'po_number: the order\'s own number as printed, without its label ("PO No.: 4500012345" gives "4500012345"). Never our quotation number, a purchase requisition, an RFQ, a vendor code or a GSTIN. When the email itself is the order, the number it gives for it.',
    'po_date: the order\'s date as printed, not the email\'s. amendment_no: 0 unless the document says it is an amendment or revision; then its number.',
    'our_quotation_ref: our quotation or offer number the order cites ("Ref: your offer no. …", "Quotation No."), as printed; ours look like CTZ/QT/2026/014. Else null.',
    'buyer.contact_name and contact_email: the client\'s person who raised, signed or is named as contact for the order. buyer.state: the Indian state of the buyer\'s billing address.',
    'lines: one entry per priced line of the order, in order. Never a GST, tax, subtotal, round-off or grand-total row. qty: a number, 1 when not printed. rate: the unit rate before tax; amount: the line\'s value before tax; both as printed.',
    serviceRule(services, { field: 'Each line\'s service' }),
    'basic_value: the order value before tax (Sub-total, Basic value, Taxable value). tax_value: the total GST printed as one figure; null when only CGST and SGST are printed separately. total_value: the grand total including tax. gst_extra: true when the order says GST or taxes are extra or as applicable, with no tax amount printed.',
    ...TOTALS_RULES,
    'payment_terms_text: the payment terms copied word for word, every percentage and milestone in them ("30% advance against PO, 40% on submission of draft report, 30% on final report"), from the terms annexure if that is where they are. Leave out tax and penalty clauses.',
    'credit_days: the days to pay after an invoice ("within 45 days of invoice", "45 days credit", "Net 45" give 45), if stated; never a delivery period.',
    'delivery_date: the date the work must be completed or delivered by, only when printed as a date. project_manager: the client\'s person named as engineer-in-charge, coordinator or project manager for the work.',
    ...READING_RULES,
    'confidence: how sure you are the document is an order to Cetizion Verifica and that you read its number, date and values correctly. A field it does not print is null and does not lower confidence; doubt about what a printed value says does.',
  ].join('\n');
  const user = [
    `Email received ${String(receivedAt || '').slice(0, 10)} from ${from?.name || ''} <${from?.email || ''}>. Subject: ${emailSubject || ''}`,
    String(emailText || '').slice(0, MAX_EMAIL_TEXT),
    pdfText === null || pdfText === undefined
      ? '\nThe order document is attached.'
      : (pdfText ? `\nOrder document text:\n${String(pdfText).slice(0, MAX_PDF_TEXT)}` : '\nThere is no attachment: the email itself is the order, if anything is.'),
  ].join('\n');
  return { system, user };
}

const clean = (v, max = 300) => { const s = String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max); return s && !/^(null|none|n\/a|nil|-)$/i.test(s) ? s : null; };
const isoDate = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ? v : null);
const wholeNumber = (v, max) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isInteger(n) && n >= 0 && n <= max ? n : null; };
const email = (v) => { const s = clean(v, 160); return s && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s.toLowerCase() : null; };

const NOT_A_PO = Object.freeze({
  is_purchase_order: false, document_type: 'other', confidence: 0, po_number: null, po_date: null, amendment_no: 0,
  buyer: {}, vendor: {}, our_quotation_ref: null, currency: null, lines: [], basic_value: null, tax_value: null, total_value: null,
  gst_extra: false, payment_terms_text: null, credit_days: null, delivery_date: null, project_manager: {},
  tax_breakup: { igst: null, cgst: null, sgst: null }, total_in_words: null,
});

/**
 * The AI's answer in a fixed shape: amounts parsed from their printed form,
 * dates valid or null, nothing extra. Anything malformed is "not a PO" with
 * confidence 0, which no bar accepts. Whether it is used is checkPo's call.
 */
export function parsePoVerdict(raw) {
  let v = raw;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = null; } }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ...NOT_A_PO };
  const c = Number(v.confidence);
  const lines = (Array.isArray(v.lines) ? v.lines : []).slice(0, MAX_LINES).map((l) => ({
    description: clean(l?.description, 500),
    qty: l?.qty === undefined || l?.qty === null ? 1 : parseAmount(l.qty),
    rate: parseAmount(l?.rate),
    amount: parseAmount(l?.amount),
    service: clean(l?.service, 200),
  }));
  return {
    is_purchase_order: v.is_purchase_order === true,
    document_type: DOCUMENT_TYPES.includes(v.document_type) ? v.document_type : 'other',
    confidence: Number.isFinite(c) ? Math.round(Math.max(0, Math.min(1, c)) * 1000) / 1000 : 0,
    po_number: clean(v.po_number, 60),
    po_date: isoDate(v.po_date),
    amendment_no: wholeNumber(v.amendment_no, 99) ?? 0,
    buyer: {
      company_name: clean(v.buyer?.company_name, 200), gstin: clean(v.buyer?.gstin, 20)?.toUpperCase() ?? null,
      state: clean(v.buyer?.state, 60), contact_name: clean(v.buyer?.contact_name, 120), contact_email: email(v.buyer?.contact_email),
    },
    vendor: { company_name: clean(v.vendor?.company_name, 200), gstin: clean(v.vendor?.gstin, 20)?.toUpperCase() ?? null },
    our_quotation_ref: clean(v.our_quotation_ref, 60),
    currency: clean(v.currency, 3)?.toUpperCase() ?? null,
    lines,
    basic_value: parseAmount(v.basic_value),
    tax_value: parseAmount(v.tax_value),
    total_value: parseAmount(v.total_value),
    gst_extra: v.gst_extra === true,
    tax_breakup: parseTaxBreakup(v.tax_breakup, parseAmount),
    total_in_words: clean(v.total_in_words, 300),
    payment_terms_text: clean(v.payment_terms_text, 1000),
    credit_days: wholeNumber(v.credit_days, 365),
    delivery_date: isoDate(v.delivery_date),
    project_manager: { name: clean(v.project_manager?.name, 120), email: email(v.project_manager?.email) },
  };
}
