/**
 * Who a party on a PO or an invoice is, to us (docs/email-po-invoice-prompt-plan.md §1):
 *
 *   us        one of our registrations. We invoice from more than one state
 *             (Delhi and UP), so a GSTIN is ours when its PAN is ours.
 *   partner   a company clients also order through (Innovative CSR
 *             Solutions): an order addressed to it is an order to us. Its
 *             GSTIN must match in full.
 *   null      neither.
 *
 * A party with a GSTIN is judged by it whenever we know ours; by name only
 * otherwise, as the readers always have. Pure: settings in, answer out.
 */
import { isUs } from './enquiryDetect.js';

export const gstinOf = (v) => String(v || '').toUpperCase().replace(/[^0-9A-Z]/g, '');

/** Characters 3 to 12 of a GSTIN: the PAN of whoever holds it. */
export const panOf = (v) => { const g = gstinOf(v); return /^\d{2}[A-Z]{5}\d{4}[A-Z]/.test(g) ? g.slice(2, 12) : null; };

/** Our GSTINs: company_gstin first, so what read the one setting keeps reading the same, then company_gstins. */
export function gstinList(first, rest) {
  return [...new Set([first, ...String(rest || '').split(/[,;\s]+/)].map(gstinOf).filter((g) => g.length === 15))];
}

/**
 * partner_companies, one per line: "name | GSTIN | other names, comma
 * separated". A JSON list of { name, gstin, aliases } is read too.
 * "none" or blank is no partners.
 */
export function partnersOf(value) {
  const v = String(value ?? '').trim();
  if (!v || v.toLowerCase() === 'none') return [];
  if (v.startsWith('[')) {
    try {
      return JSON.parse(v).filter((p) => p?.name).map((p) => ({ name: String(p.name).trim(), gstin: gstinOf(p.gstin) || null, aliases: (p.aliases || []).map(String).map((a) => a.trim()).filter(Boolean) }));
    } catch { return []; }
  }
  return v.split(/\r?\n/).map((line) => line.split('|').map((x) => x.trim())).filter(([name]) => name)
    .map(([name, gstin, aliases]) => ({ name, gstin: gstinOf(gstin) || null, aliases: String(aliases || '').split(',').map((a) => a.trim()).filter(Boolean) }));
}

const nameKey = (s) => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ')
  .replace(/\b(pvt|private|ltd|limited|llp|inc|india)\b/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * { kind: 'us' | 'partner', gstin, name } or null.
 * parties: { ourGstins, partners, ourNames, internalDomains }
 */
export function ourParty(party, { ourGstins = [], partners = [], ourNames = [], internalDomains = [] } = {}) {
  const g = gstinOf(party?.gstin) || null;
  const name = party?.company_name || null;
  if (g) {
    const ours = new Set(ourGstins.map(panOf).filter(Boolean));
    if (panOf(g) && ours.has(panOf(g))) return { kind: 'us', gstin: g, name };
    const partner = partners.find((p) => p.gstin && p.gstin === g);
    if (partner) return { kind: 'partner', gstin: g, name: partner.name };
    // A GSTIN that is neither ours nor a partner's is somebody else, whatever the name says.
    if (ours.size) return null;
  }
  if (isUs(name, { ourNames, internalDomains })) return { kind: 'us', gstin: g, name };
  const k = nameKey(name);
  const partner = k && partners.find((p) => [p.name, ...p.aliases].some((n) => nameKey(n) === k) && !(g && p.gstin && p.gstin !== g));
  if (partner) return { kind: 'partner', gstin: g || partner.gstin, name: partner.name };
  return null;
}

/**
 * Who a document is addressed to when its vendor block is blank (a work
 * order with no vendor GSTIN): one of our GSTINs or names in its text, else
 * a partner's GSTIN or name. Null when none is.
 */
export function addressedInText(text, { ourGstins = [], partners = [], ourNames = [] } = {}) {
  const flat = String(text || '').toUpperCase().replace(/\s/g, '');
  const gstin = ourGstins.find((x) => flat.includes(gstinOf(x)));
  if (gstin) return { kind: 'us', gstin: gstinOf(gstin), name: null };
  const upper = String(text || '').toUpperCase();
  if (/CETIZION/.test(upper) || ourNames.some((n) => n && upper.includes(String(n).toUpperCase()))) return { kind: 'us', gstin: null, name: null };
  const partner = partners.find((p) => (p.gstin && flat.includes(p.gstin)) || [p.name, ...p.aliases].some((n) => n && upper.includes(n.toUpperCase())));
  return partner ? { kind: 'partner', gstin: partner.gstin && flat.includes(partner.gstin) ? partner.gstin : null, name: partner.name } : null;
}
