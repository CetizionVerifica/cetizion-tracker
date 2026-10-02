/**
 * The Reports section's CSVs, one per section, shaped from the same
 * salesReport() result the screen and the PDF read (reportDefinitions.js).
 * Pure: each takes the report and returns plain rows for sendCsv.
 */

const blank = (value) => value ?? '';
const pct = (value) => (value == null ? '' : `${value}%`);
const OUTCOME_LABEL = { converted: 'Converted to PO', pipeline: 'In pipeline', quoted_not_won: 'Quoted, not won', lost: 'Lost' };

export function enquiriesCsvRows({ enquiries }) {
  const sources = enquiries.sources.map((s) => s.name);
  return enquiries.buckets.map((b) => ({
    [enquiries.grain[0].toUpperCase() + enquiries.grain.slice(1)]: b.key ?? 'No date',
    Label: b.label,
    Enquiries: b.enquiries,
    ...Object.fromEntries(sources.map((s) => [s, b.by_source[s] ?? 0])),
  }));
}

export function outcomesCsvRows({ outcomes }) {
  return outcomes.detail.map((e) => ({
    Enquiry: e.enquiry_no,
    Client: e.client,
    Received: e.date,
    'Enquiry status': e.status,
    Quotation: blank(e.quotation_no),
    Outcome: OUTCOME_LABEL[e.outcome] ?? e.outcome,
    Stage: e.stage === 'not_quoted' ? 'Not yet quoted' : e.stage === 'quoted' ? 'Quoted, awaiting a decision' : '',
  }));
}

export function sectorCsvRows({ sectors }) {
  return sectors.rows.flatMap((r) => [
    { Sector: r.sector, Spelling: '', POs: r.pos, Share: pct(r.pct), 'PO value incl. GST (INR)': r.value_inr },
    // Other, spelled out: which free-text sectors it is made of.
    ...r.raw.map((raw) => ({ Sector: r.sector, Spelling: raw.name, POs: raw.pos, Share: '', 'PO value incl. GST (INR)': raw.value_inr })),
  ]);
}

export function servicesCsvRows({ services }) {
  return services.rows.map((r) => ({
    'Service line': r.line, POs: r.pos, 'PO value incl. GST (INR)': r.value_inr, 'Share of value': pct(r.pct),
  }));
}

export function newCustomersCsvRows({ customers }) {
  return customers.new_customer_enquiries.map((e) => ({
    Enquiry: e.enquiry_no, Client: e.client, Received: e.date, Outcome: OUTCOME_LABEL[e.outcome] ?? e.outcome,
  }));
}

export function repeatOrdersCsvRows({ customers }) {
  return customers.repeat_orders.map((r) => ({
    Client: r.customer,
    PO: r.po_number,
    'PO date': r.po_date,
    Service: blank(r.service),
    'PO value incl. GST (INR)': blank(r.po_value_inr),
    'Earlier POs': r.previous_orders,
  }));
}

export function revenueCsvRows({ revenue }) {
  return [...revenue.months, { key: 'Total', label: 'Total', ...revenue.total }].map((m) => ({
    Month: m.key ?? 'No date',
    Label: m.label,
    POs: m.pos,
    'PO value incl. GST (INR)': m.po_value_inr,
    'Invoiced (INR)': m.invoiced_inr,
    'Received (INR)': m.received_inr,
    'Not in INR (no rate)': m.unconverted.map((u) => `${u.currency} ${u.amount}`).join('; '),
  }));
}

export function revenuePosCsvRows({ revenue }) {
  return revenue.months.flatMap((m) => m.detail.map((r) => ({
    Month: m.key ?? 'No date',
    PO: r.po_number,
    'PO date': blank(r.po_date),
    Client: r.client,
    Sector: r.sector,
    Service: blank(r.service),
    Owner: blank(r.owner),
    Currency: r.currency,
    'PO value': blank(r.po_value),
    'PO value incl. GST (INR)': blank(r.po_value_inr),
    'Invoiced (INR)': r.invoiced_inr,
    'Received (INR)': r.received_inr,
  })));
}
