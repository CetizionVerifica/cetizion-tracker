/**
 * A quotation as a PDF (#23): company header, client block, the lines with
 * GST, totals, validity and terms. Built with pdfmake from the same data as
 * the quotation page; nothing is stored and no outside service is used.
 */
import pdfmake from './pdf.js';
import { money as formatMoney } from './reportFormat.js';
import { timed } from './ops/metrics.js';

const INK = '#0f172a'; const MUTED = '#64748b'; const LINE = '#e2e8f0'; const BRAND = '#0f766e';

const money = (n, currency = 'INR') => formatMoney(n, currency, { decimals: 2 });
const date = (d) => {
  if (!d) return '';
  const [y, m, day] = String(d).slice(0, 10).split('-');
  return `${day} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m) - 1]} ${y}`;
};

/** The document definition, exported so a test can check it without rendering. */
export function quotationDocument(q) {
  const s = q.settings || {};
  const cur = q.currency || 'INR';
  const hasLines = q.lines?.length > 0;
  const gstRates = [...new Set((q.lines || []).map((l) => Number(l.gst_rate)))];
  const taxLabel = gstRates.length === 1 ? `GST @ ${gstRates[0]}%` : 'GST';
  const lineRows = (q.lines || []).map((l, i) => [
    { text: String(i + 1), color: MUTED },
    { stack: [{ text: l.description }, l.service_name && l.service_name !== l.description ? { text: l.service_name, color: MUTED, fontSize: 8 } : null].filter(Boolean) },
    { text: `${Number(l.qty)} ${l.unit || ''}`.trim(), alignment: 'right' },
    { text: money(l.rate, cur), alignment: 'right' },
    { text: Number(l.discount_percent) ? `${Number(l.discount_percent)}%` : '', alignment: 'right', color: MUTED },
    { text: `${Number(l.gst_rate)}%`, alignment: 'right', color: MUTED },
    { text: money(l.amount, cur), alignment: 'right' },
  ]);
  const totals = hasLines
    ? [['Subtotal', money(q.subtotal, cur)], [taxLabel, money(q.tax_total, cur)], ['Total', money(q.total, cur)]]
    : [['Quoted value', money(q.quotation_value, cur)]];

  return {
    pageSize: 'A4',
    pageMargins: [42, 48, 42, 56],
    defaultStyle: { font: 'Roboto', fontSize: 9.5, color: INK, lineHeight: 1.25 },
    footer: (page, pages) => ({ margin: [42, 16, 42, 0], columns: [{ text: `${q.quotation_no}${q.revision ? ` · Rev ${q.revision}` : ''}`, color: MUTED, fontSize: 8 }, { text: `Page ${page} of ${pages}`, alignment: 'right', color: MUTED, fontSize: 8 }] }),
    content: [
      { columns: [
        { stack: [{ text: s.company_name || 'Cetizion Verifica', fontSize: 16, bold: true, color: BRAND }, s.company_address ? { text: s.company_address, color: MUTED, fontSize: 8.5 } : null, s.company_gstin ? { text: `GSTIN ${s.company_gstin}`, color: MUTED, fontSize: 8.5 } : null].filter(Boolean) },
        { stack: [{ text: 'QUOTATION', fontSize: 14, bold: true, alignment: 'right' }, { text: q.quotation_no, alignment: 'right', bold: true }, q.revision ? { text: `Revision ${q.revision}`, alignment: 'right', color: MUTED } : null, { text: `Date: ${date(q.quotation_date)}`, alignment: 'right', color: MUTED }, q.valid_until ? { text: `Valid until: ${date(q.valid_until)}`, alignment: 'right', color: MUTED } : null].filter(Boolean), width: 200 },
      ] },
      { canvas: [{ type: 'line', x1: 0, y1: 8, x2: 511, y2: 8, lineWidth: 1, lineColor: LINE }], margin: [0, 4, 0, 12] },
      { columns: [
        { stack: [{ text: 'To', color: MUTED, fontSize: 8 }, { text: q.client_name, bold: true }, q.contact?.name || q.contact_person ? { text: q.contact?.name || q.contact_person } : null, q.contact?.email ? { text: q.contact.email, color: MUTED } : null, q.company?.address ? { text: q.company.address, color: MUTED } : null, q.company?.gstin ? { text: `GSTIN ${q.company.gstin}`, color: MUTED } : null].filter(Boolean) },
        { stack: [{ text: 'Subject', color: MUTED, fontSize: 8 }, { text: q.service_quoted || 'Services', bold: true }, q.place_of_supply_state ? { text: `Place of supply: ${q.place_of_supply_state}`, color: MUTED } : null, q.sales_person ? { text: `Prepared by ${q.sales_person}`, color: MUTED } : null].filter(Boolean), width: 220 },
      ], margin: [0, 0, 0, 16] },
      hasLines ? {
        table: {
          headerRows: 1, widths: [16, '*', 44, 70, 34, 34, 80],
          body: [
            ['#', 'Description', 'Qty', 'Rate', 'Disc.', 'GST', 'Amount'].map((h, i) => ({ text: h, bold: true, fontSize: 8, color: MUTED, alignment: i >= 2 ? 'right' : 'left' })),
            ...lineRows,
          ],
        },
        layout: { hLineWidth: (i, node) => (i === 0 || i === node.table.body.length ? 0 : 0.5), vLineWidth: () => 0, hLineColor: () => LINE, paddingTop: () => 5, paddingBottom: () => 5 },
      } : { text: `Scope: ${q.service_quoted || 'as discussed'}`, margin: [0, 0, 0, 8] },
      { columns: [{ width: '*', text: '' }, {
        width: 220,
        table: { widths: ['*', 90], body: totals.map(([k, v], i) => [{ text: k, bold: i === totals.length - 1, alignment: 'right', color: i === totals.length - 1 ? INK : MUTED }, { text: v, bold: i === totals.length - 1, alignment: 'right' }]) },
        layout: { hLineWidth: (i, node) => (i === node.table.body.length - 1 ? 1 : 0), vLineWidth: () => 0, hLineColor: () => INK, paddingTop: () => 3, paddingBottom: () => 3 },
        margin: [0, 10, 0, 0],
      }] },
      q.terms ? { stack: [{ text: 'Terms', bold: true, margin: [0, 18, 0, 4] }, { text: q.terms, color: INK }] } : null,
      { text: 'We look forward to working with you.', margin: [0, 18, 0, 0] },
      { columns: [{ text: '' }, { stack: [{ text: `For ${s.company_name || 'Cetizion Verifica'}`, color: MUTED, fontSize: 8, margin: [0, 28, 0, 20] }, { text: q.sales_person || 'Authorised signatory' }], width: 200 }] },
    ].filter(Boolean),
  };
}

export function quotationPdf(q) {
  return timed('quotation', () => pdfmake.createPdf(quotationDocument(q)).getBuffer());
}
