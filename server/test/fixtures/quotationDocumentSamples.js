/**
 * Made-up quotations covering every path through quotationDocument(q), and
 * pin(doc), which turns its definition into plain JSON so two can be compared.
 * quotationDocument.pinned.json holds the result for each sample; after a
 * change to the document that is meant, rewrite it with
 * `node test/fixtures/repinQuotationDocument.js` from server/.
 */

const settings = { company_name: 'Example Verifica Pvt Ltd', company_address: '1 Sample Road, Pune', company_gstin: '27AAAAA0000A1Z5' };

const line = (over = {}) => ({
  description: 'Certification audit', service_name: null, sac_code: null,
  qty: 1, unit: 'day', rate: 1000, discount_percent: 0, gst_rate: 18, amount: 1000, ...over,
});

export const samples = {
  'within the state, two GST rates, every optional field': {
    quotation_no: 'CTZ/QT/2026/901', revision: 2, currency: 'INR', settings,
    quotation_date: '2026-10-05', valid_until: '2026-11-04',
    client_name: 'Sample Steel Ltd', contact: { name: 'A. Tester', email: 'tester@example.com' },
    company: { address: '9 Test Street, Mumbai', gstin: '27BBBBB1111B1Z6' },
    service_quoted: 'ISO 9001 audit', place_of_supply_state: 'Maharashtra', sales_person: 'B. Seller', terms: 'Payable in 30 days.',
    lines: [
      line({ description: 'Stage 1 audit', service_name: 'ISO audits', sac_code: '998311', qty: 2.5, rate: 25000, discount_percent: 10, amount: 56250 }),
      line({ description: 'Training', service_name: 'Training', qty: 1, unit: 'session', rate: 10000, gst_rate: 5, amount: 10000 }),
    ],
    subtotal: 66250, tax_total: 10625, total: 76875,
    gst: { bands: [{ rate: 18, intra: true, cgst: 5062.5, sgst: 5062.5, igst: 0 }, { rate: 5, intra: true, cgst: 250, sgst: 250, igst: 0 }] },
  },
  'outside the state': {
    quotation_no: 'CTZ/QT/2026/902', revision: 0, currency: 'INR', settings: { company_name: 'Example Verifica Pvt Ltd' },
    quotation_date: '2026-10-06', client_name: 'Sample Foods Ltd', contact_person: 'C. Tester',
    service_quoted: 'Ecovadis', place_of_supply_state: 'Karnataka',
    lines: [line({ description: 'Assessment support', service_name: 'Assessment support', rate: 350000, amount: 350000 })],
    subtotal: 350000, tax_total: 63000, total: 413000,
    gst: { bands: [{ rate: 18, intra: false, cgst: 0, sgst: 0, igst: 63000 }] },
  },
  'an export, zero-rated whatever rate the line carries': {
    quotation_no: 'CTZ/QT/2026/903', revision: 0, currency: 'USD', settings: {},
    quotation_date: '2026-10-07', client_name: 'Sample Overseas Inc',
    lines: [line({ description: 'Remote audit', rate: 4000, amount: 4000 })],
    subtotal: 4000, tax_total: 0, total: 4000,
    gst: { bands: [{ rate: 0, intra: false, cgst: 0, sgst: 0, igst: 0 }] },
  },
  'an old revision with no GST split, one rate': {
    quotation_no: 'CTZ/QT/2026/904', revision: 1, currency: 'INR', settings: {},
    quotation_date: '2026-10-08', client_name: 'Sample Textiles Ltd',
    lines: [line({ gst_rate: 2.5 }), line({ description: 'Report', gst_rate: 2.5 })],
    subtotal: 2000, tax_total: 50, total: 2050,
  },
  'an old revision with no GST split, mixed rates': {
    quotation_no: 'CTZ/QT/2026/905', revision: 0, currency: 'INR', settings: {},
    quotation_date: '2026-10-09', client_name: 'Sample Paper Ltd',
    lines: [line(), line({ description: 'Training', gst_rate: 5 })],
    subtotal: 2000, tax_total: 230, total: 2230, gst: { bands: [] },
  },
  'no lines, the quoted value only': {
    quotation_no: 'CTZ/QT/2026/906', quotation_date: '2026-10-10', client_name: 'Sample Glass Ltd',
    quotation_value: 150000,
  },
};

/** Footers and table layouts are functions: keep what they return, not the functions. */
export function pin(doc) {
  const layout = (l, node) => Object.fromEntries(Object.entries(l).map(([key, fn]) => (
    [key, [...node.table.body.keys(), node.table.body.length].map((i) => fn(i, node))]
  )));
  const walk = (value) => {
    if (typeof value === 'function') throw new Error('an unpinned function in the document');
    if (Array.isArray(value)) return value.map(walk);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, key === 'layout' ? layout(v, value) : walk(v)]));
  };
  const { footer, ...rest } = doc;
  return JSON.parse(JSON.stringify({ ...walk(rest), footer: [footer(1, 2), footer(2, 2)].map(walk) }));
}
