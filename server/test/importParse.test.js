import { test } from 'node:test';
import assert from 'node:assert/strict';
import XLSX from 'xlsx';
import { findDate, formatCurrency, looksLikeReference, parseDate, parseMoney, readCurrency, readWorkbook, splitReference } from '../src/import/parse.js';
import { heuristicMapping } from '../src/import/fields.js';
import { buildPlan, extractRow } from '../src/import/rules.js';

/**
 * Reading any reasonable sales sheet (#45): dates, money and reference
 * numbers written the way people write them, headers named the way each
 * team names them, and workbooks laid out with titles, summary tabs and
 * totals. Every workbook here is built in memory; no client file is used.
 */

/* ------------------------------------------------------------ dates */

test('a cell that is a date is read in every common way', () => {
  assert.equal(parseDate('22.09.2026'), '2026-09-22');
  assert.equal(parseDate('22/09/2026'), '2026-09-22');
  assert.equal(parseDate('22-09-26'), '2026-09-22');
  assert.equal(parseDate('2026-09-22'), '2026-09-22');
  assert.equal(parseDate('23-Sep-2026'), '2026-09-23');
  assert.equal(parseDate('22-Sep-26'), '2026-09-22');
  assert.equal(parseDate('25 August 2026'), '2026-08-25');
  assert.equal(parseDate('25th Aug, 2026'), '2026-08-25');
  assert.equal(parseDate('Aug 25, 2026'), '2026-08-25');
  // Day first, the Indian way, unless that cannot be a date.
  assert.equal(parseDate('03/04/2026'), '2026-04-03');
  assert.equal(parseDate('1/20/26'), '2026-01-20');
});

test('a cell that is not only a date is not turned into one', () => {
  assert.equal(parseDate('4501234567 (dtd 22.09.2026)'), null);
  assert.equal(parseDate('25-Aug-2026 (revised 11-Sep)'), null);
  assert.equal(parseDate('31/02/2026'), null);
  assert.equal(parseDate('Sep 2026'), null);
  assert.equal(parseDate('13600000123'), null);
});

test('a date column may carry a note: the first date in it is used', () => {
  assert.equal(findDate('25-Aug-2026 (revised 11-Sep, 3-year tenure)'), '2026-08-25');
  assert.equal(findDate('On/before 16-Sep-2026'), '2026-09-16');
  assert.equal(findDate('2026-01-22'), '2026-01-22');
  assert.equal(findDate('No date yet'), null);
  assert.equal(findDate('PO 45000382 received'), null);
  assert.equal(findDate(46078), null);
});

/* ------------------------------------------------------------ money */

test('money is read with its currency and the Indian units', () => {
  assert.deepEqual(parseMoney('7,96,500/-'), { amount: 796500, currency: null, reinterpreted: null });
  assert.equal(parseMoney('₹ 2,000,000').amount, 2000000);
  assert.equal(parseMoney('₹ 2,000,000').currency, 'INR');
  assert.deepEqual([parseMoney('Rs. 1,00,000').amount, parseMoney('Rs. 1,00,000').currency], [100000, 'INR']);
  assert.deepEqual([parseMoney('USD 8,111').amount, parseMoney('USD 8,111').currency], [8111, 'USD']);
  assert.deepEqual([parseMoney('$9600').amount, parseMoney('$9600').currency], [9600, 'USD']);
  assert.deepEqual([parseMoney('EUR 33000').amount, parseMoney('EUR 33000').currency], [33000, 'EUR']);
  assert.equal(parseMoney('20 Lac').amount, 2000000);
  assert.equal(parseMoney('5 lakh').amount, 500000);
  assert.equal(parseMoney('1.2 Cr').amount, 12000000);
  assert.equal(parseMoney('50k').amount, 50000);
  assert.equal(parseMoney('4053760.2/-').amount, 4053760.2);
  assert.equal(parseMoney(33000).amount, 33000);
});

test('an amount with words around it keeps the first amount and says what the sheet said', () => {
  const plus = parseMoney('USD 8,111 + GST');
  assert.deepEqual([plus.amount, plus.currency, plus.reinterpreted], [8111, 'USD', 'USD 8,111 + GST']);
  const note = parseMoney('7590 (50% advance)');
  assert.deepEqual([note.amount, note.reinterpreted], [7590, '7590 (50% advance)']);
  assert.equal(parseMoney('Amount TBC').amount, null);
});

test('a currency the tracker does not keep is still named, so the review can refuse it', () => {
  assert.equal(parseMoney('CAD 6,900').currency, 'CAD');
  assert.equal(readCurrency('CAD'), 'CAD');
  assert.equal(readCurrency('inr'), 'INR');
  assert.equal(readCurrency('₹'), 'INR');
  assert.equal(readCurrency(''), null);
});

test('a number keeps the currency its cell format shows', () => {
  assert.equal(formatCurrency('"USD "#,##0'), 'USD');
  assert.equal(formatCurrency('"EUR "#,##0'), 'EUR');
  assert.equal(formatCurrency('"₹ "#,##0'), null);            // quoted symbol, not a code: INR is the default anyway
  assert.equal(formatCurrency('[$€-2]\\ #,##0;[Red]\\-[$€-2]\\ #,##0'), 'EUR');
  assert.equal(formatCurrency('[$$-409]#,##0.00'), 'USD');
  assert.equal(formatCurrency('$#,##0'), 'USD');
  assert.equal(formatCurrency('#,##0'), null);
  assert.equal(formatCurrency('General'), null);
});

/* ------------------------------------------------------ references */

test('a PO or invoice number with a note keeps the number, and the date from the note', () => {
  assert.deepEqual(splitReference('4501234567 (dtd 22.09.2026)'), { number: '4501234567', date: '2026-09-22', note: '4501234567 (dtd 22.09.2026)' });
  assert.deepEqual(splitReference('CVPL/2026-27/017 (22-Sep-26)'), { number: 'CVPL/2026-27/017', date: '2026-09-22', note: 'CVPL/2026-27/017 (22-Sep-26)' });
  assert.equal(splitReference('552600042 dated 04-Sep-26').number, '552600042');
  assert.equal(splitReference('Per PO file H26-27QWERTYAB1').number, 'H26-27QWERTYAB1');
  assert.equal(splitReference('PO No. 4500067890').number, '4500067890');
  assert.deepEqual(splitReference('SO 5721000001'), { number: 'SO 5721000001', date: null, note: null });
  assert.deepEqual(splitReference(13600000123), { number: '13600000123', date: null, note: null });
});

test('a sentence about a document is not its number', () => {
  for (const s of ['Awaited', 'Verbal', 'Advance invoice sent 15-Sep', 'Acceptance 03-Sep-2026', 'Email confirmation dtd 02-Sep-2026',
    'Balance 50% + travel invoices sent 10-Aug', '100% project invoice requested 15-Sep']) {
    assert.equal(splitReference(s).number, null, s);
    assert.equal(splitReference(s).note, s);
  }
  assert.equal(splitReference('Acceptance 03-Sep-2026').date, '2026-09-03');
  for (const s of ['4500067890', 'WO-X9-25-26-0001', 'POX9/2627/26100001', '026 & 081', 'PI-001', 'DL26XY010-0001']) assert.equal(looksLikeReference(s), true, s);
});

/* --------------------------------------------------------- headers */

test('headers named the way different teams name them map to the same fields', () => {
  assert.deepEqual(heuristicMapping(['S.No', 'Client Name', 'Deal Stage', 'Proposal Name', 'Proposal Sent Date', 'PO Number', 'PO Amount', 'Ammount received']), {
    sno: 'S.No', client: 'Client Name', stage: 'Deal Stage', service: 'Proposal Name', proposal_date: 'Proposal Sent Date',
    po_number: 'PO Number', po_amount: 'PO Amount', received: 'Ammount received',
  });
  const mis = heuristicMapping(['Deal ID', 'Client', 'Client Contact', 'Service / Proposal', 'Deal Stage', 'Status Detail', 'Currency',
    'Quoted Value', 'PO / WO No.', 'PO Date / Received', 'PO Value', 'Invoiced', 'Received', 'Outstanding', 'Remarks / Source']);
  assert.equal(mis.client, 'Client');
  assert.equal(mis.contact, 'Client Contact');
  assert.equal(mis.service, 'Service / Proposal');
  assert.equal(mis.stage, 'Deal Stage');
  assert.equal(mis.stage_detail, 'Status Detail');
  assert.equal(mis.po_number, 'PO / WO No.');
  assert.equal(mis.po_date, 'PO Date / Received');
  assert.equal(mis.currency, 'Currency');
  assert.equal(mis.pending, 'Outstanding');
  const other = heuristicMapping(['Customer Name', 'Deal Status', 'P.O. No.', 'Contract Value', 'Sales Executive', 'Quotation Date']);
  assert.deepEqual(other, { client: 'Customer Name', stage: 'Deal Status', po_number: 'P.O. No.', po_amount: 'Contract Value', sales_person: 'Sales Executive', proposal_date: 'Quotation Date' });
});

test('a header that says it is something else is not taken for a field', () => {
  const m = heuristicMapping(['Client', 'Deal Stage', 'Payment Status', 'PO Value', 'PO (INR eq.)', 'PO Value Yet to Invoice',
    'PO Received On', 'Filled questionnaire received on', 'Proposal TAT', 'Quoted Value (₹ L)']);
  assert.equal(m.stage, 'Deal Stage');
  assert.equal(m.po_amount, 'PO Value');
  assert.equal(m.po_date, 'PO Received On');
  assert.equal(m.received, undefined);
  assert.equal(m.quoted_price, undefined);
  assert.equal(Object.values(m).includes('Payment Status'), false);
  // "Status" alone is the stage, but only as the whole header.
  assert.equal(heuristicMapping(['Client', 'Status']).stage, 'Status');
});

/* -------------------------------------------------------- workbooks */

const workbook = (sheets) => {
  const wb = XLSX.utils.book_new();
  for (const [name, aoa, formats] of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    for (const [ref, z] of Object.entries(formats || {})) ws[ref].z = z;
    XLSX.utils.book_append_sheet(wb, ws, name);
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
};

test('the header is found under a title and a note, and a summary tab is passed over', () => {
  const buf = workbook([
    ['Dashboard', [['Sales summary'], ['Deal Stage', '# Deals', 'Quoted Value (₹ L)'], ['Won', 3, 12]]],
    ['Deals', [
      ['CETIZION Sales Tracker – updated 25-Sep-2026'],
      ['Values ex-GST unless noted'],
      ['S.No', 'Client Name', 'Deal Stage', 'Proposal Name', 'PO Number', 'PO Amount', 'Remarks', 'Remarks'],
      [1, 'Acme Pharma', 'Proposal sent', 'EcoVadis', null, null, 'first', 'second'],
      ['S.No', 'Client Name', 'Deal Stage', 'Proposal Name', 'PO Number', 'PO Amount', 'Remarks', 'Remarks'],
      [2, 'Beta Metals', 'PO received – 50% advance invoiced', 'ASI audit', '4500012345 (dtd 02.09.2026)', 'USD 8,111', null, null],
      [null, 'Grand Total', null, null, null, 8111, null, null],
    ]],
  ]);
  const wb = readWorkbook(buf, null);
  assert.equal(wb.sheet, 'Deals');
  assert.deepEqual(wb.headers, ['S.No', 'Client Name', 'Deal Stage', 'Proposal Name', 'PO Number', 'PO Amount', 'Remarks', 'Remarks (2)']);
  assert.equal(wb.rows.length, 3, 'the repeated header row is not a record');
  assert.equal(wb.rows[0]['Remarks (2)'], 'second');
  // A sheet can still be chosen by name.
  assert.equal(readWorkbook(buf, 'Dashboard').sheet, 'Dashboard');
});

test('credential columns are dropped at the upload and never reach a row', () => {
  const buf = workbook([['Projects', [
    ['S.No', 'Client Name', 'Deal Stage', 'PO Number', 'User ID', 'Password'],
    [1, 'Acme', 'Won', '4500000001', 'acme-portal', 'hunter2'],
  ]]]);
  const wb = readWorkbook(buf, null);
  assert.deepEqual(wb.dropped_columns, ['User ID', 'Password']);
  assert.equal(wb.headers.includes('Password'), false);
  assert.equal(JSON.stringify(wb.rows).includes('hunter2'), false);
});

test('a number formatted as dollars or euros is read in that currency, not as rupees', () => {
  const buf = workbook([['Deals', [
    ['Client', 'Deal Stage', 'PO Number', 'PO Value', 'Currency'],
    ['Aster Co', 'Won', '4501234567', 8111, 'USD'],
    ['Orbit Cables', 'Won', '552600042', 5100, 'EUR'],
    ['Local Co', 'Won', '5000123456', 196000, 'INR'],
  ], { D2: '"USD "#,##0', D3: '[$€-2]\\ #,##0', D4: '"₹ "#,##0' }]]);
  const wb = readWorkbook(buf, null);
  const rows = wb.rows.map((r) => extractRow(r, heuristicMapping(wb.headers)));
  assert.deepEqual(rows.map((r) => [r.po_amount, r.currency]), [[8111, 'USD'], [5100, 'EUR'], [196000, 'INR']]);
});

test('end to end: a messy sheet becomes a plan with every row accounted for', () => {
  const buf = workbook([['Sheet 1', [
    ['Sales tracker'],
    ['S.No', 'Customer Name', 'Deal Status', 'Service', 'Proposal Date', 'P.O. No.', 'PO Value', 'Invoice No', 'Amount Received', 'Sales Executive'],
    [1, 'Acme Pharma', 'PO received – 50% advance invoiced', 'EcoVadis', '25-Aug-2026 (revised 11-Sep)', '4500012345 (dtd 02.09.2026)', '₹ 1,96,000', 'CVPL/2026-27/017 (05-Sep-26)', '98,000', 'Priya'],
    [2, 'Beta Metals', 'Proposal being revised', 'ASI audit', '01-Sep-2026', null, null, null, null, 'Arjun'],
    [3, 'Gamma Labs', 'Lead – intro sent', 'LCA', null, null, null, null, null, 'Arjun'],
    [4, 'Delta Steel', 'Won – confirmed by email (PO awaited)', 'GHG', '02-Sep-2026', 'Awaited', '5 lakh', null, null, 'Priya'],
    [5, 'Epsilon', 'Xyzzy', 'CBAM', '03-Sep-2026', null, null, null, null, null],
    [6, 'Zeta ISO', 'Proposal sent', 'ISO 14001', '04-Sep-2026', null, null, null, null, null],
    [null, 'Total', null, null, null, null, '₹ 6,96,000', null, null, null],
  ]]]);
  const wb = readWorkbook(buf, null);
  const mapping = heuristicMapping(wb.headers);
  const live = { quotations: [], purchase_orders: [], projects: [], services: [], stages: [], next_quotation_no: 1, next_project_no: 1, year: 2026 };
  const plan = buildPlan({ rows: wb.rows, mapping, live });

  const reasons = Object.fromEntries(plan.skipped.map((s) => [s.client, s.reason]));
  assert.deepEqual(reasons, {
    'Gamma Labs': 'early lead, no proposal yet — add it as an enquiry',
    'Delta Steel': 'won but no PO number yet ("Awaited")',
    Epsilon: 'unrecognised deal stage',
    'Zeta ISO': 'ISO proposal',
    Total: 'total row',
  });

  const q = plan.items.filter((i) => i.step === 'quotation').map((i) => [i.payload.client_name, i.payload.status, i.payload.quotation_date]);
  assert.deepEqual(q, [['Acme Pharma', 'Won - PO Received', '2026-08-25'], ['Beta Metals', 'Under Negotiation', '2026-09-01']]);

  const po = plan.items.find((i) => i.step === 'purchase_order').payload;
  assert.deepEqual([po.po_number, po.po_date, po.po_value, po.currency], ['4500012345', '2026-09-02', 196000, 'INR']);
  const inv = plan.items.find((i) => i.step === 'invoice');
  assert.deepEqual([inv.payload.invoice_no, inv.payload.invoice_date, inv.assumptions], ['CVPL/2026-27/017', '2026-09-05', []]);
  assert.ok(plan.items[0].flags.some((f) => f.code === 'stage_read_as'));

  const readings = Object.fromEntries(plan.summary.stage_values.map((v) => [v.value, v.reading]));
  assert.equal(readings.Xyzzy, 'unknown');
  assert.equal(readings['Lead – intro sent'], 'lead');

  // The reviewer reads the unknown wording as On Hold and switches the PO rule off.
  const again = buildPlan({ rows: wb.rows, mapping, live, rules: { stage_map: { xyzzy: 'On Hold' }, won_requires_po: false } });
  const statuses = Object.fromEntries(again.items.filter((i) => i.step === 'quotation').map((i) => [i.payload.client_name, i.payload.status]));
  assert.equal(statuses.Epsilon, 'On Hold');
  assert.equal(statuses['Delta Steel'], 'Won - PO Received');
});
