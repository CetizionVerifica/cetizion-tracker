import { businessToday } from './businessDate.ts';
import { ApiError } from '../middleware/error.js';
import { claimNextId } from './sequences.js';
import { ENQUIRY_STATUS, QUOTATION_STATUS } from './statuses.js';

export const ENQUIRY_WON = ENQUIRY_STATUS.quoted;

const blank = (v) => v === null || v === undefined || String(v).trim() === '';

/**
 * What an enquiry must know before it moves on (#24): it leaves New only
 * with a source and a company; it is Qualified (or Converted) only with the
 * services and a value; it is Unqualified only with a reason. Checked when
 * the status changes, on the saved row, so an update that sends only the
 * status is judged on everything the enquiry already holds, and an older
 * enquiry that predates the rules can still be edited without changing it.
 * Returns the missing fields, or null.
 */
export function enquiryRuleErrors(before, after) {
  if (before && before.status === after.status) return null;
  const fields = {};
  if (after.status !== 'New') {
    if (blank(after.source) && blank(after.source_id)) fields.source_id = 'Where it came from: an enquiry leaves New only with a source';
    if (blank(after.client_name) && blank(after.company_id)) fields.client_name = 'Which company: an enquiry leaves New only with one';
  }
  if (after.status === 'Qualified' || after.status === ENQUIRY_WON) {
    if (blank(after.service) && blank(after.services_interested)) fields.service = `Which services: ${after.status} needs at least one`;
    if (blank(after.estimated_value)) fields.estimated_value = `What it is worth: ${after.status} needs an estimated value`;
  }
  if (after.status === ENQUIRY_STATUS.declined && blank(after.unqualified_reason_id) && blank(after.unqualified_notes)) {
    fields.unqualified_reason_id = 'Why it is unqualified: pick a reason or write one';
  }
  return Object.keys(fields).length ? fields : null;
}

/** The enquiry's save hook: its rules first, then the quotation a conversion makes. */
export async function saveEnquiry(client, ctx) {
  const fields = enquiryRuleErrors(ctx.before, ctx.after);
  if (fields) throw new ApiError(422, 'Please check the highlighted fields', { fields });
  return quoteWonEnquiry(client, ctx);
}

/** The services an enquiry asks for, one per line: the service picked, then any others typed. */
export function enquiryServices(e) {
  const names = [e.service, ...String(e.services_interested || '').split(/[,;\n]|\s+and\s+|\s*&\s*/i)]
    .map((s) => String(s || '').trim()).filter(Boolean);
  const seen = new Set();
  return names.filter((n) => { const k = n.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}

/**
 * An enquiry marked won becomes a quotation, with everything the enquiry
 * already knows copied across and the two linked. An enquiry that is
 * already linked — to a quotation created earlier, or to an existing one
 * picked on the form — creates nothing, so enquiries back-filled for past
 * quotations never duplicate them. Runs inside the save's transaction, so
 * if the quotation cannot be created the enquiry is not saved either.
 *
 * Returns { quotation_created } when it made one, for the save response.
 */
export async function quoteWonEnquiry(client, { before, after }) {
  if (after.status !== ENQUIRY_WON || after.quotation_no) return undefined;
  // Already won before this save and no quotation linked: someone removed
  // the link on purpose, so an unrelated edit must not create another.
  if (before?.status === ENQUIRY_WON) return undefined;

  // The quotation date inherits the enquiry's date (e.g. for historical enquiries),
  // falling back to today in the business time zone when blank.
  const quotationDate = after.enquiry_date || businessToday();
  const year = String(quotationDate).slice(0, 4);

  // Two quotations created at the same moment must not be handed the same number.
  // The quotation number year is strictly derived from the quotation's own date.
  const quotationNo = await claimNextId('quotation', client, year);

  // A Draft (#24): nothing has gone to the client yet. Sending it makes it Submitted.
  const currency = after.currency || 'INR';
  const { rows: [q] } = await client.query(
    `INSERT INTO quotations (quotation_no, client_name, contact_person, service_quoted,
                             sector, sales_person, sales_person_email, quotation_date,
                             status, remarks, quotation_value, currency)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [
      quotationNo, after.client_name, after.contact_person, after.service || after.services_interested,
      after.sector, after.sales_person, after.sales_person_email,
      quotationDate, QUOTATION_STATUS.draft,
      `From enquiry ${after.enquiry_no}`,
      after.estimated_value ?? null, currency,
    ]
  );

  // A line per service asked for, filled from the catalogue: its rate when it
  // is priced in the quotation's currency, its GST, unit and description. A
  // single service carries the enquiry's estimate as its rate. The totals
  // trigger then sets the quotation's value from the lines.
  const services = enquiryServices(after);
  for (const [i, name] of services.entries()) {
    const { rows: [s] } = await client.query('SELECT * FROM services WHERE lower(btrim(name)) = lower(btrim($1)) LIMIT 1', [name]);
    const catalogueRate = s && s.currency === currency ? s.default_rate : null;
    const rate = services.length === 1 && after.estimated_value != null ? after.estimated_value : catalogueRate ?? 0;
    await client.query(
      `INSERT INTO quotation_lines (quotation_id, service_id, description, qty, unit, rate, gst_rate, sort_order)
       VALUES ($1, $2, $3, 1, $4, $5, $6, $7)`,
      [q.id, s?.id ?? null, s?.description || s?.name || name, s?.unit ?? null, rate, s?.gst_rate ?? 18, i]
    );
  }
  await client.query('UPDATE enquiries SET quotation_no = $1 WHERE id = $2', [quotationNo, after.id]);
  return { quotation_created: quotationNo };
}
