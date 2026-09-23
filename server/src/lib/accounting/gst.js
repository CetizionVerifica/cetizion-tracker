/**
 * Indian GST and TDS helpers for the accounting integration (#48).
 * Pure functions; the reports and draft invoices build on these.
 */

export const STATES = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana',
  '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', 10: 'Bihar', 11: 'Sikkim', 12: 'Arunachal Pradesh', 13: 'Nagaland',
  14: 'Manipur', 15: 'Mizoram', 16: 'Tripura', 17: 'Meghalaya', 18: 'Assam', 19: 'West Bengal', 20: 'Jharkhand', 21: 'Odisha',
  22: 'Chhattisgarh', 23: 'Madhya Pradesh', 24: 'Gujarat', 26: 'Dadra and Nagar Haveli and Daman and Diu', 27: 'Maharashtra',
  29: 'Karnataka', 30: 'Goa', 31: 'Lakshadweep', 32: 'Kerala', 33: 'Tamil Nadu', 34: 'Puducherry', 35: 'Andaman and Nicobar Islands',
  36: 'Telangana', 37: 'Andhra Pradesh', 38: 'Ladakh', 97: 'Other Territory',
};

/** Two-letter state codes, as Zoho Books takes them for place of supply. */
export const STATE_ALPHA = {
  '01': 'JK', '02': 'HP', '03': 'PB', '04': 'CH', '05': 'UK', '06': 'HR', '07': 'DL', '08': 'RJ', '09': 'UP', 10: 'BR', 11: 'SK',
  12: 'AR', 13: 'NL', 14: 'MN', 15: 'MZ', 16: 'TR', 17: 'ML', 18: 'AS', 19: 'WB', 20: 'JH', 21: 'OD', 22: 'CG', 23: 'MP', 24: 'GJ',
  26: 'DN', 27: 'MH', 29: 'KA', 30: 'GA', 31: 'LD', 32: 'KL', 33: 'TN', 34: 'PY', 35: 'AN', 36: 'TS', 37: 'AP', 38: 'LA',
};

const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** The GSTIN check digit (the 15th character) for the first 14. */
export function gstinCheckDigit(first14) {
  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    const v = CHARS.indexOf(first14[i]);
    const p = v * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return CHARS[(36 - (sum % 36)) % 36];
}

/** { valid, state_code, state, pan, reason } */
export function checkGstin(raw) {
  const g = String(raw || '').trim().toUpperCase();
  if (!g) return { valid: false, reason: 'empty' };
  if (!/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(g)) return { valid: false, reason: 'format' };
  const code = g.slice(0, 2);
  const state = STATES[code] || STATES[Number(code)];
  if (!state) return { valid: false, reason: 'state code' };
  if (gstinCheckDigit(g.slice(0, 14)) !== g[14]) return { valid: false, reason: 'check digit' };
  return { valid: true, gstin: g, state_code: code, state, pan: g.slice(2, 12) };
}

/** Intra-state supply pays CGST + SGST; inter-state pays IGST. */
export function splitTax(taxable, rate, { ourState, theirState }) {
  const tax = Math.round(Number(taxable) * Number(rate)) / 100;
  const intra = ourState && theirState && String(ourState).padStart(2, '0') === String(theirState).padStart(2, '0');
  if (intra) {
    const half = Math.round(tax * 50) / 100;
    return { cgst: half, sgst: Math.round((tax - half) * 100) / 100, igst: 0, tax, intra: true };
  }
  return { cgst: 0, sgst: 0, igst: tax, tax, intra: false };
}

/**
 * The GST on a set of quotation or invoice lines, split the way an Indian
 * document has to show it (#23).
 *
 * One number called "GST" is not what a quotation may print. Within the
 * state it is CGST and SGST, half the rate each; outside it, IGST at the
 * full rate. A document with lines at different rates shows a band per
 * rate, because "18%" and "5%" are separate entries on a return and the
 * average of them is a rate that does not exist.
 *
 * Nothing here is stored: it is a function of the lines, the two states and
 * the currency, and it is worked out wherever it is shown.
 *
 * `problems` is what stops it being decided — an unset state, a foreign
 * currency — so a screen can say why rather than quietly showing zero.
 */
export function gstBreakdown(lines, { ourState, theirState, currency = 'INR' } = {}) {
  const zeroRated = String(currency || 'INR').toUpperCase() !== 'INR';
  const problems = [];
  if (zeroRated) problems.push(`This quotation is in ${String(currency).toUpperCase()}. Exports are zero-rated; confirm the treatment with accounts.`);
  else if (!ourState) problems.push('Set the company state code in Settings to decide CGST + SGST or IGST.');
  else if (!theirState) problems.push('No place of supply on this quotation, and the client has no GSTIN, so the split cannot be decided.');

  const byRate = new Map();
  let subtotal = 0;
  for (const l of lines || []) {
    const amount = Math.round(Number(l.amount ?? 0) * 100) / 100;
    if (!Number.isFinite(amount)) continue;
    subtotal = Math.round((subtotal + amount) * 100) / 100;
    const rate = zeroRated ? 0 : Number(l.gst_rate ?? 0);
    const band = byRate.get(rate) || { rate, taxable: 0 };
    band.taxable = Math.round((band.taxable + amount) * 100) / 100;
    byRate.set(rate, band);
  }

  // Undecidable is not the same as zero: with no states to compare, the tax
  // is still owed, it is the split that is unknown. splitTax answers IGST
  // in that case, which is the safer of the two to show.
  const bands = [...byRate.values()]
    .filter((b) => b.taxable !== 0)
    .sort((a, b) => b.rate - a.rate)
    .map((b) => ({ ...b, ...splitTax(b.taxable, b.rate, { ourState, theirState }) }));

  const sum = (key) => Math.round(bands.reduce((n, b) => n + Number(b[key] || 0), 0) * 100) / 100;
  const taxTotal = sum('tax');
  return {
    zero_rated: zeroRated,
    intra: Boolean(ourState && theirState && String(ourState).padStart(2, '0') === String(theirState).padStart(2, '0')),
    our_state: ourState || null,
    their_state: theirState || null,
    bands,
    subtotal,
    cgst: sum('cgst'),
    sgst: sum('sgst'),
    igst: sum('igst'),
    tax_total: taxTotal,
    total: Math.round((subtotal + taxTotal) * 100) / 100,
    problems,
  };
}

/** Indian financial year quarter: April–June is Q1 of the year that starts in April. */
export function fyQuarter(isoDate) {
  const [y, m] = String(isoDate).slice(0, 7).split('-').map(Number);
  const fyStart = m >= 4 ? y : y - 1;
  const q = m >= 4 ? Math.floor((m - 4) / 3) + 1 : 4;
  return { fy: `${fyStart}-${String((fyStart + 1) % 100).padStart(2, '0')}`, quarter: `Q${q}`, label: `FY ${fyStart}-${String((fyStart + 1) % 100).padStart(2, '0')} Q${q}` };
}

/** Invoice numbers compared the way people type them: case, spaces and separators ignored. */
export const normaliseNumber = (s) => String(s || '').toUpperCase().replace(/[\s\-_/\\.]/g, '');

/** GSTR-1 date format. */
export const gstDate = (iso) => {
  if (!iso) return '';
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return `${d}-${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m) - 1]}-${y}`;
};
