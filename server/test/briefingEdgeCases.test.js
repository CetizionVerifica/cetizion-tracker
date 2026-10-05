import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import XLSX from 'xlsx';
import { balanceOf, checkList, linesFromRows, parseListVerdict, readSheet } from '../src/lib/mailbox/receivablesList.js';
import { clientKey, invoiceTables, pendingRow, reconcile } from '../src/lib/misReports.js';
import { closingLine, dayParagraph, glanceRows, listNote, sourceLine } from '../src/lib/misBriefing.js';
import { dailyBriefingDoc, misPdf, pdfPageCount } from '../src/lib/misPdf.js';

/**
 * The briefing (docs/mis-briefing-fix-plan.md §3, §3a) at its edges: what
 * Tally really prints, files that cannot be read, names spelt another way,
 * amounts with no rate, and a day with nothing in it at all.
 */

describe("Finance's list, as Tally really prints it", () => {
  test('Dr is owed to us, Cr is the client\'s credit', () => {
    assert.equal(balanceOf('2,44,530.00 Dr'), 244530);
    assert.equal(balanceOf('15,000.00 Cr'), -15000);
    assert.equal(balanceOf('15,000.00 Cr.'), -15000);
    assert.equal(balanceOf(5000), 5000);
    assert.equal(balanceOf('Dr'), null);
    assert.equal(balanceOf(null), null);
  });

  test('a list with Dr and Cr balances adds up, an advance counting against the total', () => {
    const rows = [
      ['Particulars', 'Closing Balance'],
      ['Bluepeak Textiles Ltd', '2,44,530.00 Dr'],
      ['Northwind Polymers Pvt Ltd', '15,000.00 Cr'],
      ['Grand Total', '2,29,530.00 Dr'],
    ];
    const r = linesFromRows(rows);
    assert.deepEqual(r.lines.map((l) => l.amount), [244530, -15000]);
    assert.equal(r.grand_total, 229530);
    assert.equal(checkList({ ...r, text: rows.flat().join(' ') }), null);
  });

  test('a header that is not on the first row, odd labels, and a sub total are all read', () => {
    const r = linesFromRows([
      ['Debtors as on 03-Oct-2026'], [], ['PARTY NAME', 'Outstanding Amt', 'Ageing'],
      ['A Ltd', 100, 12], ['B Ltd', 200, 40], ['Sub Total', 300], ['C Ltd', 50, 3], ['Grand Total', 350],
    ]);
    assert.deepEqual(r.lines.map((l) => [l.client, l.amount, l.days]), [['A Ltd', 100, 12], ['B Ltd', 200, 40], ['C Ltd', 50, 3]]);
    assert.equal(r.grand_total, 350);
  });

  test('a sheet with no table, an empty file and a CSV: nothing read, never a crash', () => {
    assert.deepEqual(readSheet(Buffer.from('')).lines, []);
    assert.deepEqual(readSheet(Buffer.from('just some text, nothing tabular')).lines, []);
    const csv = readSheet(Buffer.from('Party,Balance\nA Ltd,100\nGrand Total,100\n'));
    assert.deepEqual([csv.lines.length, csv.grand_total], [1, 100]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Notes'], ['nothing here']]), 'Cover');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Party', 'Balance'], ['A Ltd', 100], ['Grand Total', 100]]), 'Debtors');
    assert.equal(readSheet(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })).lines.length, 1, 'the list on the second sheet');
  });

  test('the AI\'s answer with Dr/Cr, and a list of only zero rows, are refused cleanly', () => {
    const v = parseListVerdict({ grand_total: '85,000.00 Dr', lines: [{ client: 'A', amount: '1,00,000.00 Dr' }, { client: 'B', amount: '15,000.00 Cr' }] });
    assert.deepEqual([v.lines.map((l) => l.amount), v.grand_total], [[100000, -15000], 85000]);
    assert.match(checkList({ lines: [], grand_total: 0, text: '' }), /no rows/);
  });
});

describe('matching the list with the tracker, at the edges', () => {
  const row = (client, inr, over = {}) => pendingRow({ kind: 'invoice_due', key: client, client, reference: client, amount_inr: inr, amount: inr ?? 1000, currency: inr === null ? 'USD' : 'INR', days: 2, next_action: 'Chase', link: '/x', ...over }, 7);
  const list = { id: 1, date: '2026-10-03', link: null };

  test('"M/s." and "Limited" do not stop a match', () => {
    assert.equal(clientKey('M/s. Bluepeak Textiles Limited'), clientKey('Bluepeak Textiles Ltd'));
    assert.equal(clientKey('M/S Bluepeak Textiles'), clientKey('BLUEPEAK TEXTILES PVT. LTD.'));
    const { rows } = reconcile([row('Bluepeak Textiles Ltd', 100000)], [{ line_no: 1, client: 'M/s. Bluepeak Textiles Limited', amount: 100000 }], { list, overdueDays: 7, kind: 'receivables' });
    assert.equal(rows[0].source, 'both');
  });

  test('a tracker amount with no exchange rate is "not converted", never ₹0', () => {
    const { rows } = reconcile([row('Pacific Coast Apparel Inc', null)], [{ line_no: 1, client: 'Pacific Coast Apparel Inc', amount: 750000 }], { list, overdueDays: 7, kind: 'receivables' });
    assert.equal(rows[0].note, 'list: 7,50,000; tracker: not converted to ₹');
  });

  test('two equal invoices of one client pair one to one; a third line is on the list only', () => {
    const lines = [1, 2, 3].map((n) => ({ line_no: n, client: 'A Ltd', amount: 5000 }));
    const r = reconcile([row('A Ltd', 5000, { key: 'a1' }), row('A Ltd', 5000, { key: 'a2' })], lines, { list, overdueDays: 7, kind: 'receivables' });
    assert.deepEqual(r.rows.map((x) => x.source), ['both', 'both']);
    assert.equal(r.fromList.length, 1);
  });

  test('a list with no lines for the to-raise table still gives both tables and the note', () => {
    const t = invoiceTables([row('A Ltd', 5000)], { list: { ...list, grand_total: 5000, lines: [{ line_no: 1, client: 'A Ltd', amount: 5000, pending_for_invoicing: false }] } });
    assert.equal(t.to_raise.count, 0);
    assert.match(listNote(t.list), /1 matched, 0 lines on the list only/);
  });
});

describe('a day with nothing in it', () => {
  const empty = {
    kind: 'daily_briefing', period: { from: '2026-10-04', to: '2026-10-04' }, today: '2026-10-05', overdue_days: 7,
    at_a_glance: { new_enquiries: 0, quotations_sent: 0, pos_received: 0, pos_received_inr: 0, pos_registered_late: 0, invoices_raised: 0, invoices_raised_inr: 0, payments_received: 0, payments_received_inr: 0, pending_invoices: 0, pending_pos: 0, pending_quotations: 0, overdue: 0 },
    pending: { invoices: { count: 0, overdue: 0, value_inr: 0, unconverted: 0, rows: [] }, pos: { count: 0, overdue: 0, value_inr: 0, unconverted: 0, rows: [] }, quotations: { count: 0, overdue: 0, value_inr: 0, unconverted: 0, rows: [] } },
    invoice_tables: { actions: { count: 0, rows: [] }, to_raise: { count: 0, rows: [] }, receivables: { count: 0, value_inr: 0, rows: [] }, list: null },
    top_actions: [], readers: {}, events: [], highlights: [], reminders: [], mailboxes: { read: [], not_read: [] }, glance_detail: {}, quiet: true,
  };

  test('the briefing still goes, short, every section saying there is nothing', async () => {
    const pdf = await misPdf(empty);
    assert.ok(pdfPageCount(pdf) <= 2, `${pdfPageCount(pdf)} pages`);
    const text = JSON.stringify(dailyBriefingDoc(empty).content);
    for (const s of ['Nothing to check.', 'Nothing to invoice.', 'Nothing outstanding.', 'Nothing is pending.', 'No debtors list from Finance', 'no shared mailbox is read']) assert.ok(text.includes(s), s);
    assert.equal(dayParagraph(empty), 'No new enquiry, quotation, PO, invoice or payment on 4 Oct. No pending item was closed.');
    assert.equal(glanceRows(empty).find((r) => r.metric.startsWith('Overdue')).detail, 'none');
    assert.equal(closingLine('pos', empty), 'No PO received or closed on 4 Oct.');
  });

  test('a mail window with no threads, and data from before the glance details existed', () => {
    assert.match(dayParagraph({ ...empty, mail_window: { threads: 0, excluded: [] } }), /^0 email threads in the shared mailboxes on 4 Oct\. /);
    assert.equal(glanceRows({ ...empty, glance_detail: undefined })[0].detail, '');
    assert.equal(sourceLine(undefined, 'Asia/Kolkata'), 'no shared mailbox is read');
  });
});
