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

/** Who "we" are: the names and GSTIN the settings hold, so the model can tell our side from the client's. */
export function whoWeAre({ ourNames = [], ourGstin = null } = {}) {
  const names = [...new Set(['Cetizion Verifica', ...ourNames.filter(Boolean)])];
  return [
    `We are ${names.map((n) => `"${n}"`).join(' or ')}${ourGstin ? `, GSTIN ${ourGstin}` : ''}.`,
    'Our own name, letterhead, GSTIN, bank details and signature are never the client\'s.',
  ].join(' ');
}

/** One rule each, so a reader can leave out what does not apply to it. */
export const RULES = {
  dates: 'Dates: give every date as YYYY-MM-DD. Dates printed in India are day first: 03/10/2026, 03.10.26 and 03-10-2026 are 3 October 2026, never 10 March.',
  amounts: 'Amounts: copy each amount exactly as printed, as a string with its digits, commas and decimals ("1,47,500.00"; lakh grouping is normal). Never add, subtract, round, convert or work out an amount the document does not print.',
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
