/**
 * The travel workbook's columns (#196 §5.1). HR's sheet changes a little
 * every month — columns added, duplicated, left unnamed — so a column is
 * recognised by what its header says, tab by tab, never by its position.
 *
 * Each field lists the headers that mean it, compared after normHeader:
 * lower case, punctuation as spaces, one space between words. A header
 * that starts with one of them counts too ("Types: Marketing/Non-Chargeable,
 * Chargeable" is the trip type).
 */

export const TRAVEL_FIELDS = {
  journey_date: { label: 'Date of journey', synonyms: ['date of journey', 'journey date', 'travel date', 'date of travel', 'dt of journey'] },
  traveller: { label: 'Traveller', synonyms: ['name of the person', 'traveller', 'traveler', 'employee', 'employee name', 'passenger', 'name'] },
  from_place: { label: 'From', synonyms: ['from', 'origin', 'source', 'sector from'] },
  to_place: { label: 'To', synonyms: ['to', 'destination', 'sector to'] },
  provider: { label: 'Airline, railway, cab or hotel', synonyms: ['airlines', 'airline', 'carrier', 'hotel', 'hotel name', 'provider', 'operator', 'railway'] },
  mode: { label: 'Mode', synonyms: ['mode', 'travel mode', 'mode of travel'] },
  base_fare: { label: 'Fare', synonyms: ['amount', 'fare', 'basic', 'base fare', 'basic fare'] },
  service_charge: { label: 'Service charge', synonyms: ['admin charges', 'admin charge', 'service fee', 'service charge', 'service charges', 'management fee'] },
  gst_amount: { label: 'GST', synonyms: ['gst', 'gst amount', 'igst', 'tax'] },
  line_total: { label: 'Total', synonyms: ['total amt', 'total amount', 'total', 'net amount', 'gross amount'] },
  booking_date: { label: 'Booked on', synonyms: ['dt of booking', 'date of booking', 'booking date', 'booked on'] },
  trip_type: { label: 'Trip type', synonyms: ['types', 'type', 'trip type', 'travel type'] },
  client_name: { label: 'Client', synonyms: ['client name', 'client', 'customer', 'customer name'] },
  po_no: { label: 'PO number', synonyms: ['po no', 'po number', 'po', 'purchase order'] },
  invoice_no: { label: 'Agency invoice number', synonyms: ['if yes invoice number', 'invoice number', 'invoice no', 'bill no', 'bill number'] },
  service_request_no: { label: 'Service request no.', synonyms: ['service request no', 'service request number', 'service request', 'sr no'] },
  remarks: { label: 'Remarks', synonyms: ['remarks', 'remark', 'comments', 'comment'] },
  credit_note_no: { label: 'Credit note number', synonyms: ['credit note no', 'credit note number', 'credit note', 'cn no'] },
  against_invoice: { label: 'Against invoice', synonyms: ['against invoice', 'original invoice', 'against invoice no'] },
  check_in: { label: 'Check-in', synonyms: ['check in', 'checkin', 'check in date'] },
  check_out: { label: 'Check-out', synonyms: ['check out', 'checkout', 'check out date'] },
  pnr: { label: 'PNR or booking ref', synonyms: ['pnr', 'pnr booking ref', 'booking ref', 'booking reference', 'confirmation no'] },
  travel_id: { label: 'Travel ID', synonyms: ['travel id', 'trip id'] },
  project_id: { label: 'Project ID', synonyms: ['project id'] },
};

/**
 * Headers that are known and deliberately not read: the reconciliation
 * columns nobody fills, and "Included in customer invoice (yes/No)", which
 * is never filled either (the trip's billing is recorded on the trip).
 */
const IGNORED = ['checking', 'difference', 'included in customer invoice', 'included in customer invoice yes no', 'ok', 's no', 'sl no', 'sr', 'sno'];

export const normHeader = (h) => String(h ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** The field a header means, 'ignore', or null when it is not known. */
export function fieldFor(header) {
  const h = normHeader(header);
  if (!h || /^column [a-z]+$/.test(h)) return null;
  // "Included in customer invoice (yes/No) / if yes, invoice number" in one cell is the agency's number (§9.1).
  if (h.includes('if yes invoice number')) return 'invoice_no';
  if (IGNORED.includes(h) || IGNORED.some((i) => h.startsWith(`${i} `))) return 'ignore';
  // Exact first, then a header that starts with a synonym ("types marketing non chargeable chargeable").
  for (const [field, def] of Object.entries(TRAVEL_FIELDS)) if (def.synonyms.includes(h)) return field;
  for (const [field, def] of Object.entries(TRAVEL_FIELDS)) {
    if (def.synonyms.some((s) => s.length > 2 && h.startsWith(`${s} `))) return field;
  }
  return null;
}

/** How many of a row's cells are headers this importer knows: picks the header row. */
export const headerScore = (cells) => cells.filter((c) => typeof c === 'string' && fieldFor(c) && fieldFor(c) !== 'ignore').length;

/**
 * A tab's mapping, header → field, from what each header says, with any
 * correction remembered for this vendor laid over it (§5.1: "corrections
 * are remembered per vendor"). `remembered` is { normHeader: field }.
 */
export function mapHeaders(headers, remembered = {}) {
  const mapping = {};
  for (const h of headers) {
    const key = normHeader(h);
    mapping[h] = Object.hasOwn(remembered, key) ? remembered[key] : fieldFor(h);
  }
  return mapping;
}
