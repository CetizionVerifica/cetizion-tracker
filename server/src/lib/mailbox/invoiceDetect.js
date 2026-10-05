/**
 * Is this email one of our invoices to a client, and which payment stage is
 * it? The rules, kept free of the database and the network so they can be
 * tested on their own (docs/email-po-plan.md §3.10).
 *
 *   invoicePrefilter(message, facts)   free rules: is it worth reading at all?
 *   rankInvoicePdfs(files)             which attachment is the invoice
 *   buildInvoicePrompt(...)            what the AI is asked
 *   parseInvoiceVerdict(raw)           what the AI answered, in a fixed shape
 *   checkInvoice(verdict, opts)        what code accepts of it
 *   pickStage(stages, total, hint)     the open stage the invoice is for
 *
 * The model proposes and code decides.
 */
import { BULK } from './rules.js';
import { amountInText, near, parseAmount } from './pdfQuotation.js';
import { STATUS } from '../statuses.js';
import { MAX_DOCUMENT_TEXT, MAX_EMAIL_TEXT } from './readLimits.js';
import { READING_RULES, S, TOTALS_RULES, TOTALS_SCHEMA, answerSchema, parseTaxBreakup, ratePercent, taxAgreesWithRate, taxFromBreakup, whoWeAre, wordsAgree } from './promptRules.js';
import { gstinOf, gstinValid, ourParty } from './ourParties.js';

/** An invoice number as compared: case, spaces and dashes ignored. */
export const normaliseInvoiceNo = (s) => String(s || '').toLowerCase().replace(/[\s-]/g, '');

export const DOCUMENT_TYPES = ['tax_invoice', 'proforma', 'credit_note', 'debit_note', 'other'];
export const MAX_RECIPIENTS = 5;

const INVOICE_WORDS = /\b(tax\s+)?invoices?\b|\bgst\s+invoice\b|\bbill\b/i;
const NOTE_WORDS = /\b(credit|debit)\s+note\b/i;
// A proforma invoice is not a tax invoice: it asks for an advance, and must
// not use up the GST series.
const PROFORMA = /\bpro[\s-]?forma\b|\bPI\s*(no|number|#)/i;
const FORWARD = /^\s*(fw|fwd|wg)\s*:/i;
const isPdfFile = (a) => /application\/pdf/i.test(a?.contentType || '') || /\.pdf$/i.test(a?.name || '');

/**
 * Should this email be read as a possible invoice of ours? Pure.
 *
 * message: { direction, subject, text, external: [...], attachments?, has_attachments }
 * facts:   { decided }   it already has an invoice decision in this mailbox
 *          { readAll }   email_read_everything: every email we send with a
 *                        PDF is read, forwards and mail to colleagues
 *                        included; the AI and checkInvoice decide. Without
 *                        a PDF there is no invoice to read, and a proforma
 *                        is still answered by the rules: it is a decision,
 *                        not a filter, and needs no AI call.
 *
 * Returns { candidate: boolean, reason }. A proforma is answered here, by
 * the rules: reason 'proforma', which the caller logs not_invoice.
 */
export function invoicePrefilter(message, facts = {}) {
  if (facts.decided) return { candidate: false, reason: 'already decided' };
  if (message.direction !== 'outbound') return { candidate: false, reason: 'inbound' };
  const subject = String(message.subject || '');
  const text = String(message.text || '');
  const files = (message.attachments || []).map((a) => String(a?.name || ''));
  const words = `${subject}\n${text}\n${files.join('\n')}`;
  const external = message.external || [];
  const pdf = message.attachments ? message.attachments.some(isPdfFile) : Boolean(message.has_attachments);
  if (!facts.readAll) {
    if (!external.length) return { candidate: false, reason: 'no client' };
    if (external.length > MAX_RECIPIENTS) return { candidate: false, reason: 'too many recipients' };
    if (FORWARD.test(subject)) return { candidate: false, reason: 'forward' };
    if (BULK.test(text)) return { candidate: false, reason: 'bulk' };
  }
  if (!pdf) return { candidate: false, reason: 'no PDF' };
  // A subject or file name that says proforma decides it; the body saying
  // so only when it does not also call this a tax invoice ("tax invoice
  // against proforma 12").
  const heading = `${subject}\n${files.join('\n')}`;
  if ((PROFORMA.test(heading) && !/\btax\s+invoice\b/i.test(heading)) || (PROFORMA.test(text) && !/\btax\s+invoice\b/i.test(words))) {
    return { candidate: false, reason: 'proforma' };
  }
  if (!facts.readAll && !INVOICE_WORDS.test(words) && !NOTE_WORDS.test(words)) return { candidate: false, reason: 'no invoice words' };
  return { candidate: true, reason: null };
}

const INVOICE_NAME = /invoice|\binv\b|bill|[-_ ]inv[-_ ]|cvpl/i;
const INVOICE_FIRST_PAGE = /tax\s+invoice|\binvoice\s+(no|number)/i;

/** The invoice first: a file name that says so, then a first page that says so, then the largest. */
export function rankInvoicePdfs(files) {
  const score = (f) => (INVOICE_NAME.test(f.name || '') ? 2 : 0) + (INVOICE_FIRST_PAGE.test(f.firstPage || '') ? 1 : 0);
  return [...files].sort((a, b) => score(b) - score(a) || (b.size || 0) - (a.size || 0));
}

/**
 * What the AI is asked: the invoice's text (or the file, for a scan) and the
 * covering email. One call reads what checkInvoice and pickStage need: the
 * three amounts as printed, the PO it cites to match it, and the stage
 * wording to pick which payment stage it bills.
 */
export function buildInvoicePrompt({ pdfText = null, emailSubject, emailText, sentAt, to = [], ourNames = [], ourGstin = null, ourGstins = null, partners = [], clientNotes = null }) {
  const system = [
    'You read one document that Cetizion Verifica, an Indian sustainability, ESG and certification consultancy, emailed to a client, and say whether it is our tax invoice, and what it says.',
    whoWeAre({ ourNames, ourGstin, ourGstins, partners }),
    ...(clientNotes ? [clientNotes] : []),
    'Answer with one JSON object and nothing else:',
    '{"document_type": ' + DOCUMENT_TYPES.map((t) => `"${t}"`).join(' | ') + ', "confidence": 0 to 1, "revised_or_cancelled": boolean,',
    ' "invoice_no": string|null, "invoice_date": "YYYY-MM-DD"|null,',
    ' "seller": {"company_name": string|null, "gstin": string|null}, "buyer": {"company_name": string|null, "gstin": string|null},',
    ' "po_reference": string|null, "po_date": "YYYY-MM-DD"|null, "project_reference": string|null, "quotation_reference": string|null, "currency": "INR"|...,',
    ' "taxable_value": "amount as printed"|null, "tax_value": "amount as printed"|null, "total_value": "amount as printed"|null,',
    ' "tax_breakup": {"igst": "amount as printed"|null, "cgst": "amount as printed"|null, "sgst": "amount as printed"|null}, "tax_rate_percent": number|null, "total_in_words": string|null,',
    ' "stage_hint": string|null, "due_date": "YYYY-MM-DD"|null}',
    'The SELLER issues the invoice; for our invoice that is Cetizion Verifica, with the GSTIN it is raised from (we have more than one), or one of our partners. The BUYER is the client it is addressed to: the "Bill to" or "Buyer" block, with that block\'s GSTIN.',
    'document_type: tax_invoice for a GST tax invoice; proforma for a proforma invoice or PI; credit_note or debit_note for those; other for anything else (a quotation, a statement, a reminder, a receipt).',
    'revised_or_cancelled: true when the document says it is revised, cancelled, a replacement or a duplicate of an earlier invoice. "Original for recipient" and "Duplicate for transporter" copy marks are not that.',
    'invoice_no: the number as printed, without its label; ours look like CVPL/2026-27/037 (older ones CVPL/26-27/0013). invoice_date: the invoice\'s date, not the email\'s. due_date: only a due date printed as a date; never worked out from the terms.',
    'po_reference: the client\'s PO or order number the invoice cites, without its label, from a box labelled "Buyer\'s Order No.", "PO No.", "Order Ref", "Work Order No." or "Your Ref". Never from the "Reference No. & Date", "Other References", "Delivery Note" or "Dispatch Doc No." boxes unless they say PO. po_date: the date printed beside that number ("Dated 20-May-26"), else null. project_reference: a project number like PRJ-2026-014, if printed. quotation_reference: our quotation number it cites (CTZ/QT/2026/014), if printed.',
    'stage_hint: what part of the order the invoice is for, in the document\'s words ("50% advance", "Balance", "Final", "Milestone 2: draft report"), from the line description or a note; else null.',
    'taxable_value: the value before tax (Taxable value, Sub-total). tax_value: the total GST printed as one figure; null when only CGST and SGST are printed separately. total_value: the invoice total including tax (Grand total, Total invoice value), never an amount after TDS.',
    ...TOTALS_RULES,
    ...READING_RULES,
    'confidence: how sure you are the document is our tax invoice and that you read its number, date and amounts correctly. A field it does not print is null and does not lower confidence; doubt about what a printed value says does.',
  ].join('\n');
  const user = [
    `Email sent ${String(sentAt || '').slice(0, 10)} to ${to.map((p) => `${p.name || ''} <${p.email}>`).join(', ')}. Subject: ${emailSubject || ''}`,
    String(emailText || '').slice(0, MAX_EMAIL_TEXT),
    pdfText === null || pdfText === undefined ? '\nThe document is attached.' : `\nDocument text:\n${String(pdfText).slice(0, MAX_DOCUMENT_TEXT)}`,
  ].join('\n');
  return { system, user };
}

const clean = (v, max = 300) => { const s = String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max); return s && !/^(null|none|n\/a|nil|-)$/i.test(s) ? s : null; };
const isoDate = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ? v : null);

/** The AI's answer in a fixed shape. Anything malformed is "other" with confidence 0. */
export function parseInvoiceVerdict(raw) {
  let v = raw;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = null; } }
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    return { document_type: 'other', confidence: 0, revised_or_cancelled: false, invoice_no: null, invoice_date: null, seller: {}, buyer: {},
      po_reference: null, po_date: null, project_reference: null, quotation_reference: null, currency: null, taxable_value: null, tax_value: null, total_value: null, stage_hint: null, due_date: null,
      tax_breakup: { igst: null, cgst: null, sgst: null }, tax_rate_percent: null, total_in_words: null };
  }
  const c = Number(v.confidence);
  return {
    document_type: DOCUMENT_TYPES.includes(v.document_type) ? v.document_type : 'other',
    confidence: Number.isFinite(c) ? Math.round(Math.max(0, Math.min(1, c)) * 1000) / 1000 : 0,
    revised_or_cancelled: v.revised_or_cancelled === true,
    invoice_no: clean(v.invoice_no, 60),
    invoice_date: isoDate(v.invoice_date),
    seller: { company_name: clean(v.seller?.company_name, 200), gstin: clean(v.seller?.gstin, 20)?.toUpperCase() ?? null },
    buyer: { company_name: clean(v.buyer?.company_name, 200), gstin: clean(v.buyer?.gstin, 20)?.toUpperCase() ?? null },
    po_reference: clean(v.po_reference, 60),
    po_date: isoDate(v.po_date),
    project_reference: clean(v.project_reference, 40),
    quotation_reference: clean(v.quotation_reference, 60),
    currency: clean(v.currency, 3)?.toUpperCase() ?? null,
    taxable_value: parseAmount(v.taxable_value),
    tax_value: parseAmount(v.tax_value),
    total_value: parseAmount(v.total_value),
    tax_breakup: parseTaxBreakup(v.tax_breakup, parseAmount),
    tax_rate_percent: ratePercent(v.tax_rate_percent),
    total_in_words: clean(v.total_in_words, 300),
    stage_hint: clean(v.stage_hint, 120),
    due_date: isoDate(v.due_date),
  };
}

/** The answer's exact shape (docs/email-auto-entry-plan.md §3.5); parseInvoiceVerdict still checks it. */
export const INVOICE_SCHEMA = answerSchema('invoice_reading', {
  document_type: S.oneOf(DOCUMENT_TYPES),
  confidence: { type: 'number' },
  revised_or_cancelled: S.boolean,
  invoice_no: S.text, invoice_date: S.text,
  seller: S.object({ company_name: S.text, gstin: S.text }),
  buyer: S.object({ company_name: S.text, gstin: S.text }),
  po_reference: S.text, po_date: S.text, project_reference: S.text, quotation_reference: S.text, currency: S.text,
  taxable_value: S.text, tax_value: S.text, total_value: S.text,
  ...TOTALS_SCHEMA,
  stage_hint: S.text, due_date: S.text,
});

/** What two readings of one invoice must agree on (§3.7). */
export const INVOICE_KEY_FIELDS = ['invoice_no', 'invoice_date', 'po_reference', 'total_value'];

/** Why an invoice read from email is not recorded. Matches email_invoice_decisions.review_reason, plus not_invoice. */
export const INVOICE_REASONS = ['not_invoice', 'credit_note', 'low_confidence', 'revised', 'not_from_us', 'no_invoice_no',
  'bad_date', 'bad_currency', 'totals_do_not_add_up', 'amounts_not_in_pdf', 'wrong_gstin', 'po_date_mismatch', 'bad_gstin', 'readers_disagree'];

const istDay = (iso) => new Date(new Date(iso).getTime() + 330 * 60_000).toISOString().slice(0, 10);
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * The AI's reading of an invoice, checked (§3.10.2). Returns
 *   { ok: true, invoice }       record it (after matching, §3.10.3)
 *   { ok: false, reason }       not_invoice: log it and stop; anything else: review
 *
 * The seller is one of our registrations, or a partner (the invoice for a
 * PO addressed to that partner): invoice.issuing_gstin is the GSTIN it was
 * raised from, checked against the PO's (wrongGstin).
 */
export function checkInvoice(v, { emailDate, sourceText = null, minConfidence = 0.85, ourNames = [], ourGstin = null, ourGstins = null, partners = [], internalDomains = [] } = {}) {
  const parties = { ourGstins: ourGstins ?? (ourGstin ? [ourGstin] : []), partners, ourNames, internalDomains };
  const fail = (reason) => ({ ok: false, reason, invoice: v });
  if (!v || v.document_type === 'other' || v.document_type === 'proforma') return fail('not_invoice');
  if (!(v.confidence >= minConfidence)) return fail('low_confidence');
  if (v.document_type === 'credit_note' || v.document_type === 'debit_note') return fail('credit_note');
  if (v.revised_or_cancelled) return fail('revised');

  // The seller is us (or a partner), the buyer is not: a vendor's bill we forwarded reads the other way.
  const seller = ourParty(v.seller, parties);
  if (!seller || ourParty(v.buyer, parties)?.kind === 'us') return fail('not_from_us');
  // A GSTIN whose check character does not fit was misread (§3.7).
  if ([v.seller?.gstin, v.buyer?.gstin].some((g) => g && !gstinValid(g))) return fail('bad_gstin');

  if (!v.invoice_no || v.invoice_no.length < 2 || !/\d/.test(v.invoice_no)) return fail('no_invoice_no');
  const emailDay = istDay(emailDate);
  if (!v.invoice_date || v.invoice_date > emailDay) return fail('bad_date');
  const currency = v.currency || 'INR';
  if (!STATUS.currency.includes(currency)) return fail('bad_currency');

  let { taxable_value: taxable, tax_value: tax, total_value: total } = v;
  // The GST rows, added here (§2): the tax when only CGST and SGST are printed; a check when one figure is too.
  const rows = taxFromBreakup(v.tax_breakup);
  if (tax === null) tax = rows;
  else if (rows !== null && !near(tax, rows)) return fail('totals_do_not_add_up');
  if (total === null && taxable !== null && tax !== null) total = round2(taxable + tax);
  if (!(total > 0)) return fail('totals_do_not_add_up');
  if (taxable !== null && tax !== null && !near(taxable + tax, total)) return fail('totals_do_not_add_up');
  if (!taxAgreesWithRate(taxable, tax, v.tax_rate_percent)) return fail('totals_do_not_add_up');
  if (!wordsAgree(v.total_in_words, [total, taxable], near)) return fail('totals_do_not_add_up');
  const b = v.tax_breakup || {};
  if (sourceText !== null && ![total, taxable, v.tax_value, b.igst, b.cgst, b.sgst].filter((n) => n !== null && n !== undefined && n > 0).every((n) => amountInText(n, sourceText))) return fail('amounts_not_in_pdf');

  return {
    ok: true,
    invoice: {
      ...v, currency, tax_value: tax, total_value: total, invoice_no_norm: normaliseInvoiceNo(v.invoice_no),
      issuing_gstin: gstinOf(v.seller?.gstin) || null, through_partner: seller.kind === 'partner' ? seller.name : null,
    },
  };
}

/**
 * Was the invoice raised from the registration the PO was addressed to?
 * Clients reject an invoice from the wrong one (§1). Only when both GSTINs
 * are known: a PO with no addressed GSTIN, or an invoice that prints none,
 * passes.
 */
export const wrongGstin = (invoice, po) => Boolean(invoice?.issuing_gstin && po?.addressed_gstin && gstinOf(invoice.issuing_gstin) !== gstinOf(po.addressed_gstin));

const ADVANCE_HINT = /\badvance|mobili[sz]ation|first|on (po|order)\b/i;
const HINT_PERCENT = /\b(\d{1,2}(?:\.\d+)?)\s*%/;

/**
 * When an invoice is a share of a PO whose only stage is 100% (Alembic:
 * "50% Advance Payment As Per P.O." against a PO that says "Against
 * delivery"), the split a reviewer may accept: this invoice's share as a
 * stage of its own, the rest left open (docs/email-po-invoice-prompt-plan.md §5).
 * The share is the one the invoice names, else the advance the quotation's
 * terms give; it must be the invoice's amount. Never applied here.
 *
 * stages: [{ id, stage_no, stage_name, trigger_event, stage_percent, stage_amount, invoice_no, on_hold }]
 * Returns { stage_id, percent, stage_name, trigger_event, basis } or null.
 */
export function splitFor(stages, invoice, { quotationAdvance = null } = {}) {
  if (stages.length !== 1) return null;
  const [s] = stages;
  if (s.invoice_no || s.on_hold || Math.abs(Number(s.stage_percent) - 1) > 0.0001) return null;
  const hinted = HINT_PERCENT.exec(String(invoice.stage_hint || ''));
  const percent = hinted ? Number(hinted[1]) : quotationAdvance;
  if (!(percent > 0 && percent < 100)) return null;
  if (!near(Number(s.stage_amount) * (percent / 100), invoice.total_value)) return null;
  const advance = hinted ? ADVANCE_HINT.test(invoice.stage_hint) : true;
  return {
    stage_id: s.id, percent,
    stage_name: advance ? `Advance (${percent}%)` : `${String(invoice.stage_hint).slice(0, 60)}`,
    trigger_event: advance ? 'On PO Registration' : 'Manual',
    basis: hinted ? 'invoice' : 'quotation',
  };
}
const FINAL_HINT = /\bfinal|balance|remaining|completion|delivery|last\b/i;

/**
 * The stage an invoice is for (§3.10.3). Only open stages count: no invoice
 * yet and not on hold. The stage's amount (its share of the PO, GST
 * included) must equal the invoice total within ₹1 or 0.5% — rounding,
 * never a different split. Several equal stages: the one the hint names,
 * else the lowest number, because invoices go out in order.
 *
 * stages: [{ id, stage_no, stage_name, trigger_event, milestone_name, stage_amount, invoice_no, on_hold }]
 * Returns { stage } or { reason: 'po_without_stages' | 'amount_not_a_stage' }.
 */
export function pickStage(stages, total, hint = null) {
  if (!stages.length) return { reason: 'po_without_stages' };
  const open = stages.filter((s) => !s.invoice_no && !s.on_hold).sort((a, b) => a.stage_no - b.stage_no);
  const fits = open.filter((s) => near(Number(s.stage_amount), total));
  if (!fits.length) return { reason: 'amount_not_a_stage' };
  if (fits.length === 1 || !hint) return { stage: fits[0] };
  const h = String(hint);
  const named = fits.find((s) => s.milestone_name && h.toLowerCase().includes(String(s.milestone_name).toLowerCase()))
    || (ADVANCE_HINT.test(h) && fits.find((s) => s.trigger_event === 'On PO Registration'))
    || (FINAL_HINT.test(h) && fits.find((s) => s.trigger_event === 'On Delivery'));
  return { stage: named || fits[0] };
}
