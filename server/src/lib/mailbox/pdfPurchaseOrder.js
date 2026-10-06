/**
 * Reading a client's purchase order (docs/email-po-plan.md §3.2, §3.4):
 * which attachment it is, the checks the AI's reading must pass, the
 * payment stages its terms describe, and its value with GST. All pure — no
 * database, no network — because they decide whether money is registered.
 *
 * The PDF's text is read with pdfText (pdfQuotation.js), as for our own
 * quotations; a client's PO is a different document, with buyer and vendor
 * the other way round.
 */
import { advanceShare } from '../../import/ai.js';
import { splitReference } from '../../import/parse.js';
import { norm, paymentSplit } from '../../import/rules.js';
import { STATUS } from '../statuses.js';
import { amountInText, near } from './pdfQuotation.js';
import { addressedInText, ourParty } from './ourParties.js';
import { taxFromBreakup, wordsAgree } from './promptRules.js';

// ----------------------------------------------------------- which PDF

// "PO_4500012345.pdf": an underscore counts as a break here.
const PO_NAME = /(^|[^a-z])(po|wo|loi)([^a-z]|$)|purchase|order|contract|award|intent/i;
const PO_FIRST_PAGE = /purchase\s+order|work\s+order|service\s+order|letter\s+of\s+(intent|award)|\bcontract\s+(no|number|agreement)/i;
const ANNEXURE = /terms\s*(and|&)\s*conditions|\bt\s*&\s*c\b|\bgtc\b|annexure|general\s+conditions/i;

/**
 * Which PDF is the order, best first: a file name that says so, then a
 * first page that says "Purchase Order", then the largest. Terms and
 * conditions annexures go last, whatever they are called.
 * files: [{ name, size, firstPage }]
 */
export function rankPoPdfs(files) {
  const score = (f) => {
    const annexure = ANNEXURE.test(f.name || '') || (ANNEXURE.test(String(f.firstPage || '').slice(0, 400)) && !PO_FIRST_PAGE.test(f.firstPage || ''));
    if (annexure) return -1;
    return (PO_NAME.test(f.name || '') ? 2 : 0) + (PO_FIRST_PAGE.test(f.firstPage || '') ? 1 : 0);
  };
  return [...files].sort((a, b) => score(b) - score(a) || (b.size || 0) - (a.size || 0));
}

// ----------------------------------------------------------- the checks

/** Why a PO read from email is not registered. Matches email_po_decisions.review_reason, plus not_po. */
export const PO_REASONS = ['not_po', 'low_confidence', 'amendment', 'cancellation', 'not_to_us', 'no_po_number',
  'no_value', 'amounts_not_in_pdf', 'totals_do_not_add_up', 'bad_currency'];

// Revision wording printed on an order (§3 revision_marks): "Amendment 1", "Rev 2", "Revised PO", "supersedes …".
// Revision 0 is the original: "Rev 0", "Revision No. 00", "R0" and "Amendment No.: 0" are not amendments,
// nor is the "Amendment Date" label printed beside it.
const REVISED = /\bamend(?!ment\s*(?:(?:no\.?|number|#)?\s*[:.-]?\s*0+(?!\d)|date\b))|\brevised\b|supersed|in (lieu|place) of|\brev(ision)?\b\.?\s*(no\.?\s*)?[:-]?\s*0*[1-9]|\bR0*[1-9]\d*\b/i;
const istDay = (iso) => new Date(new Date(iso).getTime() + 330 * 60_000).toISOString().slice(0, 10);
const days = (a, b) => (Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 864e5;
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * The AI's reading of a PO (parsePoVerdict's shape), checked (§3.2). The
 * model proposes; this decides. Returns
 *   { ok: true, po, flags }          register it (after matching, §3.3)
 *   { ok: false, reason, po }        not_po: log it and stop; anything
 *                                    else: the review queue (§3.7). po is
 *                                    what was read, for the reviewer.
 *
 * options:
 *   emailDate      when the email arrived
 *   sourceText     the PDF's text, or the email's when the email is the
 *                  order; null for a scan read by OCR (nothing to check
 *                  amounts against, so they are taken as read)
 *   minConfidence  auto_po_min_confidence
 *   ourNames, ourGstin(s), internalDomains   who "us" is
 *   partners       the companies clients also order through (ourParties.js)
 *
 * A PO addressed to a partner is ours: po.partner_name says which, and
 * po.addressed_gstin is the GSTIN it was addressed to (ours or the
 * partner's), for the invoice to be raised from.
 */
export function checkPo(v, { emailDate, sourceText = null, minConfidence = 0.85, ourNames = [], ourGstin = null, ourGstins = null, partners = [], internalDomains = [] } = {}) {
  const parties = { ourGstins: ourGstins ?? (ourGstin ? [ourGstin] : []), partners, ourNames, internalDomains };
  const po = { ...v };
  const fail = (reason) => ({ ok: false, reason, po });

  if (!v || (!v.is_purchase_order && !['amendment', 'cancellation'].includes(v.document_type)) || v.document_type === 'other') return fail('not_po');
  if (!(v.confidence >= minConfidence)) return fail('low_confidence');
  // A changed or cancelled order may already have been invoiced: a person
  // decides (§3.6).
  if (v.document_type === 'cancellation') return fail('cancellation');
  if (v.document_type === 'amendment' || v.amendment_no > 0 || REVISED.test(v.revision_marks || '')) return fail('amendment');

  // Addressed to us, by us neither: a PO we issued to a vendor reads the
  // other way round.
  if (ourParty(v.buyer, parties)?.kind === 'us') return fail('not_to_us');
  const text = String(sourceText || '');
  const addressed = ourParty(v.vendor, parties)
    || (!v.vendor?.company_name && !v.vendor?.gstin ? addressedInText(text, parties) : null);
  if (!addressed) return fail('not_to_us');
  po.addressed_gstin = addressed.gstin || null;
  po.partner_name = addressed.kind === 'partner' ? addressed.name : null;

  // The number as printed, refused when it is a promise rather than a number.
  const { number } = splitReference(v.po_number);
  if (!number || number.length < 3) return fail('no_po_number');
  po.po_number = number;
  po.po_number_norm = norm(number);

  const flags = [];
  const emailDay = istDay(emailDate);
  if (!v.po_date || days(emailDay, v.po_date) < 0 || days(emailDay, v.po_date) > 365) {
    po.po_date = emailDay;
    flags.push('po_date_from_email');
  }

  // Unknown stays unknown: the quotation it matches says what it is
  // (matchQuotation). Read as INR, a USD order printed without a symbol
  // was registered at an eighty-fifth of its value.
  const currency = v.currency || null;
  if (currency && !STATUS.currency.includes(currency)) return fail('bad_currency');
  po.currency = currency;

  // Values. The total includes tax; with "GST extra" only the basic value
  // is printed, and registration grosses it up (grossUp).
  let { basic_value: basic, tax_value: tax, total_value: total } = v;
  // The GST rows, added here (docs/email-po-invoice-prompt-plan.md §2): the
  // tax when only CGST and SGST are printed; a check when one figure is too.
  const rows = taxFromBreakup(v.tax_breakup);
  if (tax === null) tax = rows;
  else if (rows !== null && !near(tax, rows)) return fail('totals_do_not_add_up');
  if (total === null && basic !== null && tax !== null) total = round2(basic + tax);
  if (basic !== null && tax !== null && total !== null && !near(basic + tax, total)) return fail('totals_do_not_add_up');
  if (!(total > 0) && !(v.gst_extra && basic > 0)) return fail('no_value');
  // The amount in words says the total too; a line that cannot be read is let be.
  if (!wordsAgree(v.total_in_words, [total, basic], near)) return fail('totals_do_not_add_up');

  // Every amount used must be printed: a value the document does not show
  // is a value the model made up. The tax counts as printed when its rows are.
  if (sourceText !== null) {
    const b = v.tax_breakup || {};
    const used = [total, basic, v.tax_value, b.igst, b.cgst, b.sgst].filter((n) => n !== null && n !== undefined && n > 0);
    if (!used.every((n) => amountInText(n, text))) return fail('amounts_not_in_pdf');
  }

  // Its own lines, only when every one is whole and they add up to the
  // basic value (or, with no basic value, to the total). Otherwise the
  // quotation's lines are used, as for a PO typed in by hand.
  const read = v.lines || [];
  const lineAmount = (l) => l.amount ?? (l.rate !== null && l.qty !== null ? round2(l.rate * l.qty) : null);
  const whole = read.length > 0 && read.every((l) => l.description && lineAmount(l) !== null && lineAmount(l) >= 0
    && (sourceText === null || amountInText(lineAmount(l), text)));
  const sum = (ls) => round2(ls.reduce((n, l) => n + lineAmount(l), 0));
  let lines = read;
  po.linesOk = whole && near(sum(read), basic ?? total);
  // One line printed on two rows (Aragen: a description row and a code row,
  // the same ₹2,50,000 on each) reads as two and adds up to twice the value.
  if (whole && !po.linesOk) {
    const merged = twoRowLines(read, lineAmount);
    if (merged.length < read.length && near(sum(merged), basic ?? total)) {
      lines = merged;
      po.linesOk = true;
      flags.push('two_row_lines_merged');
    }
  }
  po.lines = po.linesOk ? lines.map((l) => ({ ...l, amount: lineAmount(l) })) : [];
  if (!po.linesOk && read.length) flags.push('lines_not_used');

  Object.assign(po, { basic_value: basic, tax_value: tax, total_value: total > 0 ? total : null, credit_days: v.credit_days ?? 30 });
  if (v.credit_days === null || v.credit_days === undefined) flags.push('credit_days_default');
  return { ok: true, po, flags };
}

/** Rows next to each other with the same quantity and amount, as one line: the description row and its code row. */
export function twoRowLines(lines, lineAmount) {
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const a = lines[i];
    const b = lines[i + 1];
    if (b && a.qty === b.qty && lineAmount(a) !== null && lineAmount(a) === lineAmount(b)) {
      out.push({ ...a, description: `${a.description} ${b.description}`.trim(), service: a.service || b.service });
      i += 1;
    } else out.push(a);
  }
  return out;
}

// ----------------------------------------------------------- money

/**
 * A basic value with GST added, at the quotation lines' own rates
 * (weighted by their amounts), else 18%. The tracker's PO value includes
 * GST (§3.5).
 * lines: [{ amount, gst_rate }]
 */
export function grossUp(basic, lines = []) {
  const net = lines.reduce((n, l) => n + Number(l.amount || 0), 0);
  const gross = lines.reduce((n, l) => n + Number(l.amount || 0) * (1 + Number(l.gst_rate ?? 18) / 100), 0);
  const factor = net > 0 ? gross / net : 1.18;
  return round2(Number(basic) * factor);
}

// ----------------------------------------------------------- stages

const TAX = /\b(gst|igst|cgst|sgst|tds|tax(es)?|vat|cess|retention|interest|penalty|ld|liquidated)\b/i;
const ADVANCE = /\b(advance|mobili[sz]ation|on (po|order|signing|acceptance)|against (po|order|pi|proforma)|along with (po|order)|upfront|before start)\b/i;
const ON_DELIVERY = /\b(completion|complete[ds]?|deliver(y|ed|ables?)|submission|submitted|final|report|certificat(e|ion)|closure|balance|remaining|rest)\b/i;
const ALL_ON_COMPLETION = /\b(after|on|upon|against)\s+(the\s+)?(successful\s+)?(completion|delivery|submission of (the )?(final )?(report|deliverables?))\b/i;
const PERCENT = /(\d{1,3}(?:\.\d+)?)\s*%/g;

const capitalise = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** A milestone's name from its clause: "40% on submission of draft report" → "Submission of draft report". */
function milestoneName(clause) {
  const name = clause.replace(PERCENT, ' ').replace(/\b(payment|of the (po|order) value|of (po|order) value|to be (paid|released)|shall be (paid|released)|will be (paid|released)|payable|amount)\b/gi, ' ')
    .replace(/^\s*(on|upon|after|against|at)\s+/i, '').replace(/\s+/g, ' ').replace(/^[\s,:;.-]+|[\s,:;.-]+$/g, '').trim();
  return capitalise(name.replace(/^(on|upon|after|against|at)\s+/i, '')).slice(0, 120) || null;
}

/**
 * The payment stages a PO's printed terms describe (§3.4), or the template.
 *
 *   "50% advance, balance on report"            → 50 On PO Registration, 50 On Delivery
 *   "100% after completion"                     → 100 On Delivery
 *   "30% advance, 40% on draft, 30% on final"   → 30 / 40 On Milestone "Draft" / 30
 *   "advance 18% GST extra", "as per PO"        → the template (unclear)
 *
 * Returns { source: 'po_terms', stages: [{ stage_name, trigger_event, percent, milestone_name? }] }
 *      or { source: 'template' }. Percentages next to a tax word are never stages.
 */
export function stagesFromTerms(text) {
  const t = String(text || '').trim();
  if (!t) return { source: 'template' };

  // Each percentage with the clause it sits in, tax ones left out.
  // "&" joins two clauses as "and" does: "50% Advance Against PI & 50% Against work Completion" (Dasami).
  const clauses = t.split(/[;\n|]|,(?!\d)|\.\s|(?:\band\b|&)(?=\s*\d{1,3}\s*%)/i).map((c) => c.trim()).filter(Boolean);
  const parts = [];
  for (const c of clauses) {
    const ps = [...c.matchAll(PERCENT)].map((m) => Number(m[1]));
    if (!ps.length || TAX.test(c)) continue;
    if (ps.length > 1) return { source: 'template' };
    parts.push({ percent: ps[0], clause: c });
  }
  const sum = parts.reduce((n, p) => n + p.percent, 0);
  const asStages = (list) => ({ source: 'po_terms', stages: list });

  // All of it at once.
  if (parts.length === 1 && parts[0].percent === 100) {
    if (ADVANCE.test(parts[0].clause)) return asStages([{ stage_name: 'Advance (100%)', trigger_event: 'On PO Registration', percent: 100 }]);
    return asStages(toStages(paymentSplit(null)));
  }
  if (!parts.length) {
    return ALL_ON_COMPLETION.test(t) && !ADVANCE.test(t) ? asStages(toStages(paymentSplit(null))) : { source: 'template' };
  }

  // Two or three explicit stages adding up to 100.
  if (parts.length >= 2 && parts.length <= 3 && Math.abs(sum - 100) < 0.01) {
    if (parts.length === 2 && ADVANCE.test(parts[0].clause) && !ADVANCE.test(parts[1].clause)) return asStages(toStages(paymentSplit(parts[0].percent)));
    const stages = parts.map((p, i) => {
      const first = i === 0 && ADVANCE.test(p.clause);
      const last = i === parts.length - 1 && ON_DELIVERY.test(p.clause);
      if (first) return { stage_name: `Advance (${p.percent}%)`, trigger_event: 'On PO Registration', percent: p.percent };
      if (last) return { stage_name: `On delivery (${p.percent}%)`, trigger_event: 'On Delivery', percent: p.percent };
      const name = milestoneName(p.clause);
      return name ? { stage_name: `${name} (${p.percent}%)`, trigger_event: 'On Milestone', percent: p.percent, milestone_name: name } : null;
    });
    return stages.every(Boolean) ? asStages(stages) : { source: 'template' };
  }

  // One advance, the rest implied: the importer's rule, which already
  // ignores tax percentages and calls several loose ones unclear.
  if (parts.length === 1) {
    const share = advanceShare(t);
    if (share.percent && ADVANCE.test(parts[0].clause)) return asStages(toStages(paymentSplit(share.percent)));
  }
  return { source: 'template' };
}

/** The importer's stages ({ stage_percent: 0.5 }) in registration's shape ({ percent: 50 }). */
const toStages = (split) => split.map(({ stage_percent: p, ...s }) => ({ ...s, percent: Math.round(p * 10000) / 100 }));
