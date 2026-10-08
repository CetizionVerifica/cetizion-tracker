import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_BULK_VENDOR_INVOICES, VENDOR_PAYMENT_MODES, allocationDefaults, allocationRow,
  bulkBlockedReason, bulkPayBody, bulkResultSummary, bulkSelection, bulkTotals, mayBulkPayVendorInvoices,
  mayJoinBulk, outstandingOf, validateBulkPayment, vendorKeyOf,
} from '../src/lib/vendorPayments.js';

/**
 * One transfer, several of one agency's bills (#214 §2.6).
 *
 * The agency is paid monthly, so this is the ordinary path and the single
 * payment is the exception. Everything here is the pure half: who may do it,
 * which bills may join a selection and why one may not, what each allocation
 * would do to its bill, and what goes on the wire.
 *
 * The two rules worth reading the tests for:
 *
 *   - one agency per transfer, decided by the first bill ticked;
 *   - no bulk correction, so no figure here may be negative.
 */

/** A bill as v_travel_vendor_invoices sends it. */
const bill = (over = {}) => ({
  id: 1,
  vendor_id: 7,
  travel_vendor: 'Happy Tours',
  vendor_invoice_id: 'VIN-1',
  vendor_invoice_no: 'HT/1',
  invoice_amount: 100000,
  net_payable: 100000,
  amount_paid: 0,
  payment_status: 'To Pay',
  ...over,
});

describe('who may record one transfer over several bills', () => {
  test('the travel desk and the administrator may; a sales user may not', () => {
    assert.equal(mayBulkPayVendorInvoices({ isAdmin: true }), true);
    assert.equal(mayBulkPayVendorInvoices({ isHr: true }), true);
    assert.equal(mayBulkPayVendorInvoices({}), false, 'a sales user has no bulk door either');
    assert.equal(mayBulkPayVendorInvoices(), false);
  });
});

describe('which bills may join a selection', () => {
  test('the first bill may always join, and sets the agency', () => {
    assert.equal(bulkBlockedReason(bill(), { vendorId: null, count: 0 }), null);
    const chosen = bulkSelection([bill()], [1]);
    assert.equal(chosen.vendorId, 7);
    assert.equal(chosen.vendorName, 'Happy Tours');
    assert.equal(chosen.count, 1);
  });

  test('a bill of another agency is refused, and says so in words', () => {
    const reason = bulkBlockedReason(bill({ id: 2, vendor_id: 9, travel_vendor: 'Other Travel' }),
      { vendorId: 7, vendorName: 'Happy Tours', count: 1 });
    assert.match(reason, /one vendor only/i);
    assert.match(reason, /Happy Tours/, 'and names the agency the transfer is for');
    assert.equal(mayJoinBulk(bill({ id: 2, vendor_id: 9 }), { vendorId: 7, count: 1 }), false);
  });

  test('a bill with no amount yet cannot be allocated against', () => {
    assert.match(bulkBlockedReason(bill({ invoice_amount: null, net_payable: null }), {}), /no amount yet/i);
  });

  test('a bill already settled is not offered', () => {
    assert.match(bulkBlockedReason(bill({ payment_status: 'Paid', amount_paid: 100000 }), {}), /already settled/i);
  });

  test('past the limit nothing further may be ticked, and the limit is said', () => {
    const reason = bulkBlockedReason(bill(), { vendorId: 7, count: MAX_BULK_VENDOR_INVOICES });
    assert.match(reason, new RegExp(String(MAX_BULK_VENDOR_INVOICES)));
    assert.match(reason, /second transfer/i, 'and what to do instead');
  });

  test('a bill with no agency on it cannot be proved to belong to the same one', () => {
    assert.equal(vendorKeyOf(bill({ vendor_id: null })), null);
    assert.match(bulkBlockedReason(bill({ vendor_id: null }), {}), /no agency on it/i);
  });

  test('a bill already ticked is never blocked, whatever the rule now says', () => {
    // The page passes no reason for a picked row, which is what keeps
    // unticking possible after the selection's agency has been decided.
    const chosen = bulkSelection([bill(), bill({ id: 2 })], [1, 2]);
    assert.equal(chosen.count, 2);
    assert.equal(chosen.vendorId, 7);
  });
});

describe('what a selection amounts to', () => {
  test('it adds up what is still owed across the ticked bills', () => {
    const chosen = bulkSelection(
      [bill({ id: 1, amount_paid: 20000 }), bill({ id: 2, net_payable: 50000 }), bill({ id: 3 })],
      [1, 2]
    );
    assert.equal(chosen.count, 2, 'only the ticked ones');
    assert.equal(chosen.outstanding, 80000 + 50000);
    assert.equal(chosen.atLimit, false);
  });

  test('an empty selection has no agency and no total', () => {
    const chosen = bulkSelection([bill()], []);
    assert.deepEqual([chosen.count, chosen.vendorId, chosen.outstanding], [0, null, 0]);
  });
});

describe('what each row starts at', () => {
  test('the balance, so nothing has to be copied across by hand', () => {
    assert.deepEqual(allocationDefaults(bill({ amount_paid: 30000 })), { transferred: '70000', tds: '' });
  });

  test('TDS starts blank: a deduction is known, never guessed', () => {
    assert.equal(allocationDefaults(bill()).tds, '');
  });

  test('credit notes are already in the balance', () => {
    assert.equal(outstandingOf(bill({ net_payable: 90000, amount_paid: 10000 })), 80000);
  });

  test('a bill with no amount has no balance to default to', () => {
    assert.equal(outstandingOf(bill({ invoice_amount: null, net_payable: null })), null);
    assert.equal(allocationDefaults(bill({ invoice_amount: null, net_payable: null })).transferred, '');
  });
});

describe('what a row would do to its bill', () => {
  test('cash and TDS are separate, and together they settle', () => {
    const row = allocationRow({ invoice: bill(), transferred: '90000', tds: '10000' });
    assert.equal(row.settles, 100000);
    assert.equal(row.settledAfter, 100000);
    assert.equal(row.overBy, 0, 'a bill settled partly by deduction is settled, not overpaid');
  });

  test('going past the payable amount is reported, not clamped', () => {
    const row = allocationRow({ invoice: bill({ amount_paid: 60000 }), transferred: '50000', tds: '' });
    assert.equal(row.outstanding, 40000);
    assert.equal(row.settledAfter, 110000);
    assert.equal(row.overBy, 10000);
  });

  test('a part payment leaves a balance and warns about nothing', () => {
    const row = allocationRow({ invoice: bill(), transferred: '30000', tds: '' });
    assert.equal(row.settledAfter, 30000);
    assert.equal(row.overBy, 0);
  });
});

describe('the totals the dialog shows', () => {
  test('transferred, TDS and settled are three figures, never one', () => {
    const totals = bulkTotals([
      allocationRow({ invoice: bill({ id: 1 }), transferred: '90000', tds: '10000' }),
      allocationRow({ invoice: bill({ id: 2 }), transferred: '20000', tds: '' }),
    ]);
    assert.equal(totals.transferred, 110000, 'what leaves the bank');
    assert.equal(totals.tds, 10000, 'deducted, and not presented as cash');
    assert.equal(totals.settled, 120000);
  });

  test('it counts how many bills go over, and by how much in total', () => {
    const totals = bulkTotals([
      allocationRow({ invoice: bill({ id: 1, net_payable: 10000 }), transferred: '15000', tds: '' }),
      allocationRow({ invoice: bill({ id: 2, net_payable: 10000 }), transferred: '12000', tds: '' }),
      allocationRow({ invoice: bill({ id: 3, net_payable: 10000 }), transferred: '5000', tds: '' }),
    ]);
    assert.equal(totals.overpaid, 2);
    assert.equal(totals.overBy, 7000);
  });
});

describe('what the form refuses', () => {
  const allocation = (over, amounts) => ({ invoice: bill(over), ...amounts });

  test('a transfer with nothing in it', () => {
    assert.match(validateBulkPayment({ allocations: [] }).form.allocations, /at least one bill/i);
  });

  test('a row that settles nothing, named by its own bill', () => {
    const found = validateBulkPayment({
      allocations: [
        allocation({ id: 1 }, { transferred: '1000', tds: '' }),
        allocation({ id: 2 }, { transferred: '', tds: '' }),
      ],
    });
    assert.equal(found.ok, false);
    assert.equal(found.rows[1], undefined, 'the good row is not flagged');
    assert.ok(found.rows[2].amount_paid, 'the empty one is');
  });

  test('a negative figure anywhere: there is no bulk correction', () => {
    const found = validateBulkPayment({ allocations: [allocation({}, { transferred: '-100', tds: '' })] });
    assert.match(found.rows[1].amount_paid, /correct it/i, 'and it says where a reduction belongs');
  });

  test('a date in the future, once, for the whole transfer', () => {
    const found = validateBulkPayment({
      allocations: [allocation({}, { transferred: '1000', tds: '' })],
      paidOn: '2099-01-01',
      today: '2026-10-08',
    });
    assert.match(found.form.payment_date, /future/i);
    assert.deepEqual(found.rows, {}, 'the date is the transfer\'s, not each row\'s');
  });

  test('bills of two agencies, even if the checkboxes were bypassed', () => {
    const found = validateBulkPayment({
      allocations: [
        allocation({ id: 1, vendor_id: 7 }, { transferred: '1000', tds: '' }),
        allocation({ id: 2, vendor_id: 9 }, { transferred: '1000', tds: '' }),
      ],
    });
    assert.match(found.form.allocations, /one vendor only/i);
  });

  test('more bills than one transfer may settle', () => {
    const allocations = Array.from({ length: MAX_BULK_VENDOR_INVOICES + 1 }, (_, n) =>
      allocation({ id: n + 1 }, { transferred: '100', tds: '' }));
    assert.match(validateBulkPayment({ allocations }).form.allocations, new RegExp(String(MAX_BULK_VENDOR_INVOICES)));
  });

  test('a good transfer is accepted', () => {
    const found = validateBulkPayment({
      allocations: [
        allocation({ id: 1 }, { transferred: '90000', tds: '10000' }),
        allocation({ id: 2 }, { transferred: '0', tds: '5000' }),
      ],
      paidOn: '2026-10-01',
      today: '2026-10-08',
    });
    assert.equal(found.ok, true, JSON.stringify(found));
  });
});

describe('what goes on the wire', () => {
  test('the exact body POST /vendor-payments/batch is given', () => {
    const body = bulkPayBody({
      allocations: [
        { invoice: bill({ id: 4 }), transferred: '90000', tds: '10000' },
        { invoice: bill({ id: 9 }), transferred: '20000', tds: '' },
      ],
      paidOn: '2026-10-01',
      paymentMode: 'upi',
      reference: '  UTR-7788  ',
      remarks: ' September ',
      documentId: 42,
    });
    assert.deepEqual(body, {
      payment_date: '2026-10-01',
      payment_mode: 'upi',
      reference: 'UTR-7788',
      remarks: 'September',
      document_id: 42,
      allocations: [
        { vendor_invoice_id: 4, amount: 90000, tds_amount: 10000 },
        { vendor_invoice_id: 9, amount: 20000 },
      ],
    });
  });

  test('`amount` is the cash, not the settlement total', () => {
    // The one place the batch route differs from /vendor-invoices/:id/pay,
    // whose `amount_paid` is the settlement because its callers predate the
    // ledger. Here the two legs go as they are and the server adds them.
    const [allocation] = bulkPayBody({
      allocations: [{ invoice: bill(), transferred: '90000', tds: '10000' }],
    }).allocations;
    assert.equal(allocation.amount, 90000);
    assert.equal(allocation.tds_amount, 10000);
  });

  test('the shared half is left out when it was not given', () => {
    const body = bulkPayBody({ allocations: [{ invoice: bill(), transferred: '1000', tds: '' }] });
    assert.deepEqual(Object.keys(body), ['allocations']);
  });

  test('a TDS-only allocation still carries a zero transfer', () => {
    const [allocation] = bulkPayBody({
      allocations: [{ invoice: bill(), transferred: '', tds: '5000' }],
    }).allocations;
    assert.deepEqual(allocation, { vendor_invoice_id: 1, amount: 0, tds_amount: 5000 });
  });

  test('the modes offered are the six the server accepts, and no others', () => {
    assert.deepEqual(VENDOR_PAYMENT_MODES.map((m) => m.value),
      ['bank_transfer', 'upi', 'cheque', 'cash', 'card', 'other']);
  });
});

describe('what the success line says', () => {
  test('it quotes the server\'s own totals', () => {
    const summary = bulkResultSummary(
      { count: 6, transferred: 450000, tds: 25000, settled: 475000, overpaid: 0, over_payable: 0 },
      (n) => `₹${n}`
    );
    assert.equal(summary.line, '6 vendor invoices updated · ₹450000 transferred · ₹25000 TDS');
    assert.equal(summary.overpaid, 0);
  });

  test('one bill reads as one bill', () => {
    const summary = bulkResultSummary({ count: 1, transferred: 1000, tds: 0 }, String);
    assert.match(summary.line, /^1 vendor invoice updated/);
  });

  test('bills taken past their payable amount come back as a warning to show', () => {
    const summary = bulkResultSummary({ count: 3, transferred: 100, tds: 0, overpaid: 2, over_payable: 900 }, String);
    assert.equal(summary.overpaid, 2);
    assert.equal(summary.overBy, 900);
  });

  test('no reply, no claim about what happened', () => {
    assert.equal(bulkResultSummary(null), null);
  });
});
