/**
 * What every email reader tells the AI the same way: who we are, how a
 * date, an amount, a currency and a GSTIN are read, and what confidence
 * means. Each reader's prompt (enquiryDetect, poDetect, invoiceDetect,
 * pdfQuotation) adds its own fields on top.
 *
 * The rules are written against what the checks after the model refuse:
 * a day-first date read month-first lands after the email (bad_date), an
 * amount added up by the model is not in the PDF (amounts_not_in_pdf), a
 * service not spelt as the catalogue spells it links to no service, and a
 * confidence lowered for a field the document never printed sends a good
 * document to review. Each of those is an entry somebody types by hand.
 *
 * The bulk import (src/import/) has its own prompt and does not use these.
 */

/**
 * Who "we" are: the names and GSTINs the settings hold, so the model can
 * tell our side from the client's; and the partner companies clients also
 * order through (docs/email-po-invoice-prompt-plan.md §1).
 */
export function whoWeAre({ ourNames = [], ourGstin = null, ourGstins = null, partners = [] } = {}) {
  const names = [...new Set(['Cetizion Verifica', ...ourNames.filter(Boolean)])];
  const gstins = (ourGstins?.length ? ourGstins : [ourGstin]).filter(Boolean);
  // Characters 3 to 12 of a GSTIN are the PAN: the same for each state we are registered in.
  const pan = gstins.length > 1 ? String(gstins[0]).slice(2, 12) : null;
  return [
    `We are ${names.map((n) => `"${n}"`).join(' or ')}${gstins.length ? `, GSTIN ${gstins.join(' or ')}` : ''}${pan ? ` (one company, registered in more than one state; PAN ${pan})` : ''}.`,
    'Our own name, letterhead, GSTIN, bank details and signature are never the client\'s.',
    partners.length ? `We also take orders through our partner${partners.length === 1 ? '' : 's'} ${partners.map((p) => `"${p.name}"${p.gstin ? ` (GSTIN ${p.gstin})` : ''}`).join(', ')}: an order addressed to one of them is an order to us. Say which party the document is addressed to.` : null,
  ].filter(Boolean).join(' ');
}

/** One rule each, so a reader can leave out what does not apply to it. */
export const RULES = {
  dates: 'Dates: give every date as YYYY-MM-DD. Dates printed in India are day first: 03/10/2026, 03.10.26 and 03-10-2026 are 3 October 2026, never 10 March; 25-03-2026 is 25 March. A month may be printed as a name in any case: 08-AUG-2026 is 8 August 2026, and 22-May-26 is 22 May 2026 (a two-digit year is 20YY).',
  amounts: 'Amounts: copy each amount exactly as printed, as a string with its digits, commas and decimals ("1,47,500.00"; lakh grouping is normal, and so are three decimals: "500,000.000" is five lakh). Copy only the number, never a label or currency printed against it: "Indian Rupee24,63,840.00" gives "24,63,840.00". Never add, subtract, round, convert or work out an amount the document does not print.',
  currency: 'Currency: the ISO code the amounts are in: INR for ₹, Rs., Rupees or INR; USD for $ or US$; EUR for €; GBP for £; AED for AED or Dirham. null when the document shows no currency at all.',
  gstin: 'GSTIN: 15 characters, two digits of state code then the PAN (27AAACT2727Q1ZW). Copy it exactly, and only the one printed against that party.',
  names: 'Names: a company by its full name as printed on the document or in the signature ("Tata Steel Limited"), never an email domain or a person. A person by their name as signed, never "Team", "Accounts", "Purchase Dept" or a job title.',
  missing: 'Use null for anything the document does not say. Never guess or use a typical value, and work a value out only where its field says to.',
};

/**
 * All of them: the document readers (PO, invoice, quotation). Each states
 * its own confidence, ending with the same rule: a field the document does
 * not print is null and does not lower confidence; doubt about what a
 * printed value says does.
 */
export const READING_RULES = Object.values(RULES);

/**
 * The service rule: the catalogue's names, spelt exactly, so a line links
 * to its catalogue service (and, on a PO, to the service's payment terms
 * and onboarding templates). fallback: what to use without a catalogue.
 */
export function serviceRule(services = [], { field = 'service', fallback = [] } = {}) {
  const names = services.length ? services : fallback;
  if (!names.length) return `${field}: the service in the document's own words, else null.`;
  return `${field}: when one of these fits, give it spelt exactly as written here: ${names.map((n) => `"${n}"`).join('; ')}. When none fits, the service in the document's own words; null when no service is named.`;
}

// ---------------------------------------------------------------------
// The totals of a PO or an invoice (docs/email-po-invoice-prompt-plan.md §2)
// ---------------------------------------------------------------------

/**
 * What the PO and invoice readers ask beside the amounts: the GST rows one
 * by one, and the amount in words. Code adds the rows and turns the words
 * into a number (taxFromBreakup, wordsToAmount); the model does neither.
 */
export const TOTALS_RULES = [
  'tax_breakup: {"igst": "amount as printed"|null, "cgst": …, "sgst": …}: each GST row as printed against its own label. A row that is printed blank, or not printed, is null, never "0".',
  'total_in_words: the amount-in-words line exactly as printed ("Rupees Two Lakh Ninety Five Thousand Only"), else null.',
];

/** The GST rows in a fixed shape: each a number or null. */
export function parseTaxBreakup(v, parse) {
  const row = (x) => (x === null || x === undefined || x === '' ? null : parse(x));
  return { igst: row(v?.igst), cgst: row(v?.cgst), sgst: row(v?.sgst) };
}

/** The GST the rows add up to, or null when no row is printed. */
export function taxFromBreakup(b) {
  const rows = [b?.igst, b?.cgst, b?.sgst].filter((n) => n !== null && n !== undefined);
  return rows.length ? Math.round(rows.reduce((n, x) => n + x, 0) * 100) / 100 : null;
}

const UNITS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fourty: 40,
  fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const SCALES = { thousand: 1e3, lakh: 1e5, lakhs: 1e5, lac: 1e5, lacs: 1e5, million: 1e6, crore: 1e7, crores: 1e7 };
const NOISE = new Set(['rupees', 'rupee', 'indian', 'inr', 'rs', 'only', 'and', 'amount', 'in', 'words', 'total', 'grand', 'the', 'of', 'sum']);

/** "Two Lakh Ninety Five Thousand" → 295000; null for a word it does not know. */
function wholeWords(words) {
  let total = 0;
  let current = 0;
  let any = false;
  for (const w of words) {
    if (Object.hasOwn(UNITS, w)) { current += UNITS[w]; any = true; } else if (w === 'hundred') { current = (current || 1) * 100; any = true; } else if (Object.hasOwn(SCALES, w)) { total += (current || 1) * SCALES[w]; current = 0; any = true; } else return null;
  }
  return any ? total + current : null;
}

/**
 * An amount in Indian words as a number: crore, lakh, thousand, hundred,
 * and paise after the rupees. Null when the line cannot be read
 * ("… Ninety Five Thousand Paise", with no paise figure): such a line is
 * ignored, never held against the document.
 */
export function wordsToAmount(text) {
  const words = String(text || '').toLowerCase().replace(/[^a-z\s-]/g, ' ').replace(/-/g, ' ').split(/\s+/).filter((w) => w && !NOISE.has(w));
  if (!words.length) return null;
  const p = words.findIndex((w) => w === 'paise' || w === 'paisa');
  if (p < 0) return wholeWords(words);
  // The paise are the unit words straight before "paise"; a scale word there means the line is garbled.
  let start = p;
  while (start > 0 && Object.hasOwn(UNITS, words[start - 1])) start -= 1;
  if (start === p) return null;
  const paise = wholeWords(words.slice(start, p));
  const rupees = start > 0 ? wholeWords(words.slice(0, start)) : 0;
  if (paise === null || rupees === null || paise >= 100 || words.slice(p + 1).length) return null;
  return Math.round((rupees + paise / 100) * 100) / 100;
}

/**
 * Does the amount in words agree with one of the totals printed (the
 * grand total, or the value before tax where that is what the words say)?
 * A line that cannot be read agrees with anything.
 */
export function wordsAgree(words, totals, near) {
  const n = wordsToAmount(words);
  return n === null || totals.some((t) => t !== null && t !== undefined && near(n, t));
}
