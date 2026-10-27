/**
 * Which travel record a file's name names (#196 §5.4), apart from the
 * upload in documents.js so it can be read and tested without a database.
 */

const KINDS = [[/boarding/i, 'boarding_pass'], [/ticket|e-?tkt/i, 'ticket'], [/hotel|folio|stay/i, 'hotel_bill'], [/visa/i, 'visa'],
  [/approv/i, 'travel_approval'], [/credit|\bcn\b|cancel/i, 'credit_note'], [/invoice|\binv\b|bill/i, 'vendor_invoice']];
export const docTypeOf = (name) => KINDS.find(([re]) => re.test(name))?.[1] || 'other';

/** A pattern for a reference written with any separators, whole: HT/2627/18 does not match HT-2627-1877. */
function referencePattern(ref) {
  const tokens = String(ref).toUpperCase().match(/[A-Z0-9]+/g);
  if (!tokens) return null;
  return new RegExp(`(?<![A-Z0-9])${tokens.join('[^A-Z0-9]*')}(?![0-9])`);
}

/** The record a file's name names: the longest reference it holds wins. */
export function matchFile(name, { invoices, credits, trips }) {
  const base = String(name).replace(/\.[a-z0-9]{1,5}$/i, '').toUpperCase();
  const best = (rows, key) => rows
    .filter((r) => r[key] && referencePattern(r[key])?.test(base))
    .sort((a, b) => b[key].length - a[key].length)[0];
  const credit = best(credits, 'credit_note_no');
  if (credit) return { kind: 'credit_note', record: credit };
  const invoice = best(invoices, 'vendor_invoice_no');
  if (invoice) return { kind: 'vendor_invoice', record: invoice };
  const trip = best(trips, 'travel_id');
  if (trip) return { kind: 'trip', record: trip };
  return null;
}
