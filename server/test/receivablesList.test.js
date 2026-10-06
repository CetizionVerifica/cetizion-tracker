import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import XLSX from 'xlsx';
import { checkList, linesFromRows, listPrompt, parseListVerdict, readSheet } from '../src/lib/mailbox/receivablesList.js';
import { clientKey, invoiceTables, pendingRow, reconcile } from '../src/lib/misReports.js';
import { listNote } from '../src/lib/misBriefing.js';

/**
 * Finance's Sundry Debtors list (docs/mis-briefing-fix-plan.md §3a): read
 * from a spreadsheet in code or from a PDF by the AI, used only when it adds
 * up, and reconciled with the tracker client by client.
 */

// As Tally exports it: a title, the header, a receivables section, a pending-for-invoicing section, the grand total.
const TALLY = [
  ['Cetizion Verifica Pvt Ltd'],
  ['Sundry Debtors as on 03-Oct-2026'],
  [],
  ['Particulars', 'Bill No.', 'Bill Date', 'Closing Balance', 'Overdue by days'],
  ['Receivables'],
  ['Hindalco Industries Ltd', 'CVPL/2026-27/011', '15-Aug-2026', 244530, 49],
  ['Coreal Pvt. Ltd.', 'CVPL/2026-27/012', '02-Sep-2026', '50,000.00', 31],
  ['Pending for invoicing'],
  ['Aragen Life Sciences', null, null, 100000, 10],
  ['Grand Total', null, null, 394530, null],
];
const sheet = (aoa) => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Debtors');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
};

describe("reading Finance's debtors list", () => {
  test('a Tally export: the header found below the title, the sections marked, the grand total kept', () => {
    const r = linesFromRows(TALLY);
    assert.deepEqual(r.lines, [
      { client: 'Hindalco Industries Ltd', invoice_no: 'CVPL/2026-27/011', amount: 244530, days: 49, pending_for_invoicing: false },
      { client: 'Coreal Pvt. Ltd.', invoice_no: 'CVPL/2026-27/012', amount: 50000, days: 31, pending_for_invoicing: false },
      { client: 'Aragen Life Sciences', invoice_no: null, amount: 100000, days: 10, pending_for_invoicing: true },
    ]);
    assert.equal(r.grand_total, 394530);
  });

  test('section totals stand for the grand total when there is none', () => {
    const r = linesFromRows([['Party', 'Amount'], ['A Ltd', 10], ['Total', 10], ['Pending for invoicing'], ['B Ltd', 5], ['Total', 5]]);
    assert.equal(r.grand_total, 15);
    assert.deepEqual(r.lines.map((l) => l.pending_for_invoicing), [false, true]);
  });

  test('a sheet with no client and amount columns is not a list', () => {
    assert.equal(linesFromRows([['Date', 'Narration'], ['2026-10-01', 'Opening']]), null);
  });

  test('an Excel file is read in code, and passes the checks when it adds up', () => {
    const read = readSheet(sheet(TALLY));
    assert.equal(read.lines.length, 3);
    assert.equal(checkList(read), null);
  });

  test('a list that does not add up, or with an amount not in the file, is not used', () => {
    const read = readSheet(sheet(TALLY.map((r) => (r[0] === 'Grand Total' ? ['Grand Total', null, null, 400000] : r))));
    assert.match(checkList(read), /the rows add up to 394530, not the grand total 400000/);
    assert.match(checkList({ lines: [{ client: 'A', amount: 999 }], grand_total: 999, text: 'A 998' }), /2 amounts are not in the file/);
    assert.match(checkList({ lines: [{ client: 'A', amount: 5 }], grand_total: null, text: 'A 5' }), /no grand total/);
    assert.match(checkList({ lines: [], grand_total: 0, text: '' }), /no rows/);
  });

  test("a PDF list: the AI's answer is taken in its fixed shape only", () => {
    const v = parseListVerdict({
      list_date: '2026-10-03', grand_total: '3,94,530.00',
      lines: [
        { client: 'Hindalco Industries Ltd', amount: '2,44,530', days: 49 },
        { client: 'Aragen Life Sciences', amount: '1,00,000', pending_for_invoicing: true },
        { client: 'Coreal', amount: '50,000.00', days: '31' },
        { client: '', amount: '10' },
        { client: 'Nil row', amount: '0' },
      ],
    });
    assert.equal(v.grand_total, 394530);
    assert.equal(v.list_date, '2026-10-03');
    assert.deepEqual(v.lines.map((l) => [l.client, l.amount, l.days, l.pending_for_invoicing]), [
      ['Hindalco Industries Ltd', 244530, 49, false], ['Aragen Life Sciences', 100000, null, true], ['Coreal', 50000, 31, false],
    ]);
    assert.deepEqual(parseListVerdict('nonsense'), { lines: [], grand_total: null, list_date: null });
    const { system, user } = listPrompt('Sundry Debtors …');
    assert.match(system, /pending_for_invoicing true/);
    assert.match(system, /day first/, 'the shared date rule');
    assert.match(user, /Sundry Debtors/);
  });
});

describe('reconciling the list with the tracker', () => {
  const row = (client, inr, over = {}) => pendingRow({ kind: 'invoice_due', key: client, client, reference: `Invoice of ${client}`, amount_inr: inr, amount: inr, currency: 'INR', days: 3, next_action: 'Chase payment', link: '/x', ...over }, 7);
  const list = { id: 9, date: '2026-10-03', link: 'https://outlook.office.com/mail/item/list', grand_total: 394530 };
  const lines = [
    { line_no: 1, client: 'Hindalco Industries Ltd', amount: 244530, days: 49, pending_for_invoicing: false },
    { line_no: 2, client: 'COREAL PVT LTD', amount: 50000, days: 31, pending_for_invoicing: false },
    { line_no: 3, client: 'Gamma & Sons', invoice_no: 'CVPL/2026-27/020', amount: 12000, days: 5, pending_for_invoicing: false },
  ];

  test('names match without punctuation or "Pvt Ltd"', () => {
    assert.equal(clientKey('Coreal Pvt. Ltd.'), clientKey('COREAL PRIVATE LIMITED'));
    assert.equal(clientKey('Gamma & Sons'), 'gamma and sons');
  });

  test('equal amounts match; the rest of a client shows both figures; leftovers are on one side only', () => {
    const { rows, fromList } = reconcile([row('Hindalco Industries Limited', 210000), row('Coreal Pvt. Ltd.', 50000), row('Beta Metals', 30000)], lines, { list, overdueDays: 7, kind: 'receivables' });
    const by = Object.fromEntries(rows.map((r) => [r.client, r]));
    assert.equal(by['Coreal Pvt. Ltd.'].source, 'both');
    assert.equal(by['Coreal Pvt. Ltd.'].note, null, 'the same figure: nothing to say');
    assert.equal(by['Hindalco Industries Limited'].source, 'both');
    assert.equal(by['Hindalco Industries Limited'].note, 'list: 2,44,530; tracker: 2,10,000');
    assert.equal(by['Beta Metals'].source, 'tracker');
    assert.equal(by['Beta Metals'].note, "not on Finance's list of 3 Oct");
    assert.equal(fromList.length, 1);
    assert.deepEqual(
      [fromList[0].client, fromList[0].source, fromList[0].reference, fromList[0].next_action, fromList[0].email_link, fromList[0].overdue, fromList[0].age],
      ['Gamma & Sons', 'list', 'Invoice CVPL/2026-27/020', 'Finance: record in tracker', list.link, false, 5],
    );
  });

  test('the tables: receivables and to-raise reconciled, the tracker total kept, the counts for the note', () => {
    const toRaise = pendingRow({ kind: 'to_invoice', key: 't', client: 'Aragen Life Sciences Pvt Ltd', reference: 'PO-9 · Advance', amount_inr: 100000, amount: 100000, currency: 'INR', days: 2, next_action: 'Raise', link: '/x' }, 7);
    const t = invoiceTables([row('Hindalco Industries Limited', 210000), row('Beta Metals', 30000), toRaise], {
      list: { ...list, file_name: 'Debtors.xlsx', lines: [...lines, { line_no: 4, client: 'Aragen Life Sciences', amount: 100000, pending_for_invoicing: true }] },
    });
    assert.equal(t.receivables.count, 4, 'two tracker rows and two lines on the list only');
    assert.equal(t.receivables.value_inr, 240000, "the tracker's total");
    assert.equal(t.receivables.list_total, 306530);
    assert.equal(t.to_raise.rows[0].source, 'both');
    assert.deepEqual([t.list.matched, t.list.list_only, t.list.tracker_only], [2, 2, 1]);
    assert.equal(listNote(t.list, { money: (v) => `₹${v}` }), "Reconciled with Finance's list of 3 Oct (grand total ₹394530): 2 matched, 2 lines on the list only (Finance to record in the tracker), 1 in the tracker only.");
  });

  test('with no list, or a list that was not used, the tables are the tracker alone and the note says so', () => {
    const t = invoiceTables([row('Beta Metals', 30000)], { list: null });
    assert.equal(t.receivables.rows[0].source, undefined);
    assert.equal(listNote(null), "No debtors list from Finance in the last 14 days: the receivables are the tracker's alone.");
    const rejected = invoiceTables([row('Beta Metals', 30000)], { list: { id: 2, date: '2026-10-04', rejected: true, reason: 'the rows add up to 5, not the grand total 6' } });
    assert.equal(rejected.receivables.count, 1);
    assert.equal(listNote(rejected.list), "Finance's list of 4 Oct was not used (the rows add up to 5, not the grand total 6): the receivables are the tracker's alone.");
  });
});
