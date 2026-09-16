/**
 * Talking to the books (#48): a draft invoice built from a due payment
 * stage, and the two systems the lead may choose between.
 *
 *   Zoho Books: REST with OAuth (a refresh token from a self-client), data
 *     centre from ZOHO_DC (in, com, eu...). Pulls invoices and customer
 *     payments; pushes a draft invoice.
 *   Tally Prime: XML over its HTTP port (TALLY_URL, usually through a
 *     tunnel to the office machine). Pushes a sales voucher; reading the day
 *     book falls back to export files uploaded on the Accounting page.
 */
import { query } from '../../db.js';
import { checkGstin, splitTax, STATE_ALPHA } from './gst.js';

// ------------------------------------------------------------ the draft

/** What an invoice for this stage should say, before any system sees it. */
export async function draftForStage(stageId) {
  const { rows: [s] } = await query(
    `SELECT s.*, po.quotation_no, po.po_date, p.company_id, c.name AS company_name, c.gstin, c.address, c.city,
            q.place_of_supply_state, q.id AS quotation_id
       FROM v_payment_stages s JOIN purchase_orders po ON po.po_number = s.po_number JOIN projects p ON p.project_id = po.project_id
       LEFT JOIN companies c ON c.id = p.company_id LEFT JOIN quotations q ON q.quotation_no = po.quotation_no
      WHERE s.id = $1`, [stageId]);
  if (!s) throw Object.assign(new Error('Payment stage not found'), { status: 404 });
  const { rows: settings } = await query(`SELECT key, value FROM settings WHERE key IN ('company_state_code','gst_rate_default','company_gstin')`);
  const set = Object.fromEntries(settings.map((r) => [r.key, r.value]));
  const { rows: [rate] } = s.quotation_id
    ? await query('SELECT round(SUM(amount * gst_rate) / NULLIF(SUM(amount), 0), 2) AS rate FROM quotation_lines WHERE quotation_id = $1', [s.quotation_id])
    : { rows: [] };
  const gstRate = Number(rate?.rate ?? set.gst_rate_default ?? 18);
  const buyer = checkGstin(s.gstin);
  const ourState = set.company_state_code || checkGstin(set.company_gstin).state_code || null;
  const theirState = buyer.valid ? buyer.state_code : (s.place_of_supply_state || '').match(/^\d{2}/)?.[0] || null;
  const taxable = Number(s.stage_amount);
  const tax = splitTax(taxable, gstRate, { ourState, theirState });
  const { rows: [map] } = await query(`SELECT books_ref, books_name FROM accounting_mappings WHERE kind = 'customer' AND tracker_ref = $1`, [String(s.company_id)]);
  const problems = [];
  if (!s.gstin) problems.push('The client has no GSTIN on its company record');
  else if (!buyer.valid) problems.push(`The client's GSTIN looks wrong (${buyer.reason})`);
  if (!ourState) problems.push('Set company_state_code (or company_gstin) in Settings to decide CGST+SGST or IGST');
  if (s.currency !== 'INR') problems.push(`The PO is in ${s.currency}; check the rate and export treatment`);
  return {
    stage_id: s.id,
    customer: { company_id: s.company_id, name: s.company_name || s.client_name, gstin: s.gstin || null, books_ref: map?.books_ref || null, books_name: map?.books_name || null, address: [s.address, s.city].filter(Boolean).join(', ') || null },
    reference: `${s.po_number} · ${s.stage_name}`,
    po_number: s.po_number, po_date: s.po_date, quotation_no: s.quotation_no,
    description: `${s.stage_name} against PO ${s.po_number}${s.quotation_no ? ` (quotation ${s.quotation_no})` : ''}`,
    currency: s.currency, taxable, gst_rate: gstRate, ...tax, total: Math.round((taxable + tax.tax) * 100) / 100,
    place_of_supply: theirState, supply: tax.intra ? 'intra-state (CGST + SGST)' : 'inter-state (IGST)',
    invoice_no: s.invoice_no || null, problems,
  };
}

// ------------------------------------------------------------ Zoho Books

const zoho = () => ({
  dc: process.env.ZOHO_DC || 'in',
  clientId: process.env.ZOHO_CLIENT_ID || '',
  clientSecret: process.env.ZOHO_CLIENT_SECRET || '',
  refreshToken: process.env.ZOHO_REFRESH_TOKEN || '',
  orgId: process.env.ZOHO_ORGANIZATION_ID || '',
});
export const zohoConfigured = () => { const z = zoho(); return Boolean(z.clientId && z.clientSecret && z.refreshToken && z.orgId); };

let zohoToken = null;
async function zohoFetch(path, { method = 'GET', body, params = {}, fetchImpl = fetch } = {}) {
  const z = zoho();
  if (!zohoToken || zohoToken.expires < Date.now()) {
    const r = await fetchImpl(`https://accounts.zoho.${z.dc}/oauth/v2/token?${new URLSearchParams({ refresh_token: z.refreshToken, client_id: z.clientId, client_secret: z.clientSecret, grant_type: 'refresh_token' })}`, { method: 'POST' });
    const j = await r.json();
    if (!j.access_token) throw new Error(`Zoho sign-in failed: ${j.error || r.status}`);
    zohoToken = { value: j.access_token, expires: Date.now() + (Number(j.expires_in || 3600) - 60) * 1000 };
  }
  const url = `https://www.zohoapis.${z.dc}/books/v3${path}?${new URLSearchParams({ organization_id: z.orgId, ...params })}`;
  const r = await fetchImpl(url, { method, headers: { Authorization: `Zoho-oauthtoken ${zohoToken.value}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || (j.code !== undefined && j.code !== 0)) throw new Error(`Zoho Books: ${j.message || r.status}`);
  return j;
}

/** Invoices and customer payments changed since a date, as books entries. */
export async function zohoPull(sinceIso, opts = {}) {
  const entries = [];
  for (let page = 1; page < 50; page += 1) {
    const j = await zohoFetch('/invoices', { params: { page, per_page: 200, ...(sinceIso ? { last_modified_time: `${sinceIso}T00:00:00+0530` } : {}) }, ...opts });
    for (const i of j.invoices || []) {
      entries.push({ kind: 'invoice', books_id: i.invoice_id, number: i.invoice_number, customer_name: i.customer_name, customer_gstin: i.gst_no || null, entry_date: i.date, due_date: i.due_date, taxable_amount: null, tax_amount: null, total_amount: i.total, currency: i.currency_code, reference: i.reference_number, status: i.status, raw: i });
    }
    if (!j.page_context?.has_more_page) break;
  }
  for (let page = 1; page < 50; page += 1) {
    const j = await zohoFetch('/customerpayments', { params: { page, per_page: 200 }, ...opts });
    for (const p of j.customerpayments || []) {
      entries.push({ kind: 'payment', books_id: p.payment_id, number: p.payment_number, customer_name: p.customer_name, entry_date: p.date, total_amount: p.amount, tds_amount: p.tax_amount_withheld || 0, currency: p.currency_code, reference: p.invoice_numbers || p.reference_number, status: null, raw: p });
    }
    if (!j.page_context?.has_more_page) break;
  }
  return entries;
}

export async function zohoCreateDraft(draft, opts = {}) {
  if (!draft.customer.books_ref) throw Object.assign(new Error('Map this client to a Zoho customer first (Accounting → Mappings)'), { status: 422 });
  const { rows: [item] } = await query(`SELECT books_ref FROM accounting_mappings WHERE kind = 'service' AND tracker_ref = 'default'`);
  const j = await zohoFetch('/invoices', {
    method: 'POST', ...opts,
    body: {
      customer_id: draft.customer.books_ref, reference_number: draft.reference, date: new Date().toISOString().slice(0, 10),
      gst_no: draft.customer.gstin || undefined, place_of_supply: (draft.place_of_supply && (STATE_ALPHA[draft.place_of_supply] || STATE_ALPHA[Number(draft.place_of_supply)])) || undefined,
      line_items: [{ ...(item ? { item_id: item.books_ref } : {}), description: draft.description, rate: draft.taxable, quantity: 1 }],
      notes: `Tracker stage ${draft.stage_id}`,
    },
  });
  return { system: 'zoho', books_id: j.invoice?.invoice_id, number: j.invoice?.invoice_number, status: j.invoice?.status };
}

// ------------------------------------------------------------ Tally Prime

const esc = (s) => String(s ?? '').replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
const tallyDate = (iso) => String(iso).slice(0, 10).replace(/-/g, '');

/** A Tally import envelope with one sales voucher, as the draft says. */
export function tallyVoucherXml(draft, { salesLedger = 'Sales', cgstLedger = 'Output CGST', sgstLedger = 'Output SGST', igstLedger = 'Output IGST', date = new Date().toISOString() } = {}) {
  const party = draft.customer.books_name || draft.customer.name;
  const line = (ledger, amt, deemed) => `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${esc(ledger)}</LEDGERNAME><ISDEEMEDPOSITIVE>${deemed ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE><AMOUNT>${deemed ? '-' : ''}${Number(amt).toFixed(2)}</AMOUNT></ALLLEDGERENTRIES.LIST>`;
  const taxes = draft.intra
    ? [line(cgstLedger, draft.cgst, false), line(sgstLedger, draft.sgst, false)]
    : [line(igstLedger, draft.igst, false)];
  return `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME></REQUESTDESC><REQUESTDATA>
<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER VCHTYPE="Sales" ACTION="Create">
<DATE>${tallyDate(date)}</DATE><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME><REFERENCE>${esc(draft.reference)}</REFERENCE>
<PARTYLEDGERNAME>${esc(party)}</PARTYLEDGERNAME><PARTYGSTIN>${esc(draft.customer.gstin || '')}</PARTYGSTIN><NARRATION>${esc(draft.description)}</NARRATION>
${line(party, draft.total, true)}
${line(salesLedger, draft.taxable, false)}
${taxes.join('\n')}
</VOUCHER></TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
}

export const tallyConfigured = () => Boolean(process.env.TALLY_URL);

export async function tallyPush(xml, { fetchImpl = fetch } = {}) {
  const r = await fetchImpl(process.env.TALLY_URL, { method: 'POST', headers: { 'Content-Type': 'text/xml' }, body: xml, signal: AbortSignal.timeout(30_000) });
  const text = await r.text();
  const created = Number(text.match(/<CREATED>(\d+)<\/CREATED>/)?.[1] || 0);
  const errors = Number(text.match(/<ERRORS>(\d+)<\/ERRORS>/)?.[1] || 0);
  if (!r.ok || errors || !created) throw new Error(`Tally did not accept the voucher: ${text.match(/<LINEERROR>(.*?)<\/LINEERROR>/)?.[1] || `status ${r.status}`}`);
  return { system: 'tally', created };
}
