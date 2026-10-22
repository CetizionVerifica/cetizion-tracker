import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENCY_TRIP_STATUSES, VENDOR_INVOICE_STATUSES, VENDOR_PAYMENT_MODES,
  agencyInvoiceChip, agencyTripChip, correctionBody, correctionEffect, correctionShape,
  isCorrection, mayCorrectVendorPayment, mayRecordVendorPayment, maySeeVendorPayments,
  payBody, paymentTotals, settlementState, settlesOf, validateCorrection, validatePayment,
} from '../src/lib/vendorPayments.js';

/**
 * Paying a travel agency, from the screens' side (#214).
 *
 * The figures are the point: the server's `amount_paid` is the settlement
 * total — cash plus tax deducted — so a form that asks for the transfer and
 * the deduction has to add them, and must never add what is already paid.
 */

/* ------------------------------------------------------------------ who */

test('an administrator and HR may pay an agency; sales may not', () => {
  assert.equal(mayRecordVendorPayment({ isAdmin: true, isHr: false }), true);
  assert.equal(mayRecordVendorPayment({ isAdmin: false, isHr: true }), true);
  assert.equal(mayRecordVendorPayment({ isAdmin: false, isHr: false }), false);
  assert.equal(mayRecordVendorPayment({}), false);
  assert.equal(mayRecordVendorPayment(), false);
});

test('only an administrator may correct a payment — not HR, not sales', () => {
  assert.equal(mayCorrectVendorPayment({ isAdmin: true, isHr: false }), true);
  assert.equal(mayCorrectVendorPayment({ isAdmin: false, isHr: true }), false);
  assert.equal(mayCorrectVendorPayment({ isAdmin: false, isHr: false }), false);
  assert.equal(mayCorrectVendorPayment(), false);
});

test('the history is for the two roles that settle the agency', () => {
  assert.equal(maySeeVendorPayments({ isAdmin: true }), true);
  assert.equal(maySeeVendorPayments({ isHr: true }), true);
  assert.equal(maySeeVendorPayments({ isAdmin: false, isHr: false }), false);
});

/* -------------------------------------------------------------- figures */

test("the issue's example: 90,000 transferred with 10,000 TDS settles a 100,000 bill", () => {
  const state = settlementState({ netPayable: 100000, settled: 0, transferred: 90000, tds: 10000 });
  assert.equal(state.settles, 100000);
  assert.equal(state.settledAfter, 100000);
  assert.equal(state.overBy, 0);
  assert.equal(state.outstanding, 100000);
});

test('what is already paid is never added to what is being typed', () => {
  // A 100,000 bill with 60,000 settled, paying 40,000 now: the bill lands on
  // 100,000, not on 160,000.
  const state = settlementState({ netPayable: 100000, settled: 60000, transferred: 40000, tds: '' });
  assert.equal(state.settles, 40000);
  assert.equal(state.settledAfter, 100000);
  assert.equal(state.outstanding, 40000);
  assert.equal(state.overBy, 0);
});

test('an invoice with no amount has no payable and no overpayment', () => {
  const state = settlementState({ netPayable: null, settled: 0, transferred: 5000 });
  assert.equal(state.netPayable, null);
  assert.equal(state.outstanding, null);
  assert.equal(state.overBy, 0);
});

test('the payable is the bill after its credit notes', () => {
  const state = settlementState({ netPayable: 90000, settled: 0, transferred: 90000 });
  assert.equal(state.overBy, 0);
  assert.equal(state.outstanding, 90000);
});

/* --------------------------------------------------------- overpayment */

test('overpayment is reported as a figure, not clamped or refused', () => {
  const state = settlementState({ netPayable: 100000, settled: 100000, transferred: 2000 });
  assert.equal(state.overBy, 2000, 'the warning quotes 2,000 over');
  assert.equal(state.settles, 2000, 'nothing reduces the figure typed');
  assert.equal(state.settledAfter, 102000);
  // And it is not a validation error: the person may go ahead.
  assert.deepEqual(validatePayment({ transferred: 2000, tds: '', paidOn: '2026-10-01', today: '2026-10-08' }), {});
});

test('TDS counts towards the overpayment, because it settles the bill', () => {
  const state = settlementState({ netPayable: 100000, settled: 95000, transferred: 4000, tds: 3000 });
  assert.equal(state.settles, 7000);
  assert.equal(state.overBy, 2000);
});

/* ------------------------------------------------------- the pay form */

test('a future payment date is refused in the form', () => {
  const errors = validatePayment({ transferred: 1000, paidOn: '2026-10-09', today: '2026-10-08' });
  assert.equal(errors.payment_date, 'A payment cannot be dated in the future');
  // Today itself is fine, and so is a date in the past.
  assert.equal(validatePayment({ transferred: 1000, paidOn: '2026-10-08', today: '2026-10-08' }).payment_date, undefined);
  assert.equal(validatePayment({ transferred: 1000, paidOn: '2020-01-01', today: '2026-10-08' }).payment_date, undefined);
});

test('a payment has to settle something, and cannot be negative', () => {
  assert.equal(validatePayment({ transferred: '', tds: '' }).amount_paid, 'Give what was transferred, or the tax deducted');
  assert.equal(validatePayment({ transferred: 0, tds: 0 }).amount_paid, 'A payment has to settle something');
  assert.match(validatePayment({ transferred: -500 }).amount_paid, /correct it$/);
  assert.equal(validatePayment({ transferred: 100, tds: -5 }).tds_amount, 'Tax deducted cannot be negative');
});

test('TDS alone is a payment: a bill settled only by deduction', () => {
  assert.deepEqual(validatePayment({ transferred: '', tds: 10000, paidOn: '2026-10-01', today: '2026-10-08' }), {});
  assert.deepEqual(payBody({ transferred: '', tds: 10000, paidOn: '2026-10-01' }), {
    amount_paid: 10000, mode: 'add', tds_amount: 10000, payment_date: '2026-10-01',
  });
});

test('the body sends the settlement total with mode add, so nothing double-counts', () => {
  const body = payBody({
    transferred: 90000, tds: 10000, paidOn: '2026-10-07',
    paymentMode: 'upi', reference: ' UTR-123 ', remarks: ' part payment ', documentId: 42,
  });
  assert.deepEqual(body, {
    amount_paid: 100000,
    mode: 'add',
    tds_amount: 10000,
    payment_date: '2026-10-07',
    payment_mode: 'upi',
    reference: 'UTR-123',
    remarks: 'part payment',
    document_id: 42,
  });
});

test('blank optionals are left out rather than sent empty', () => {
  assert.deepEqual(payBody({ transferred: 500, tds: '', paidOn: '2026-10-07', paymentMode: 'cash', reference: '   ', remarks: '' }), {
    amount_paid: 500, mode: 'add', payment_date: '2026-10-07', payment_mode: 'cash',
  });
});

test('every mode the server accepts is offered, and nothing else', () => {
  assert.deepEqual(VENDOR_PAYMENT_MODES.map((m) => m.value),
    ['bank_transfer', 'upi', 'cheque', 'cash', 'card', 'other']);
  assert.deepEqual(VENDOR_PAYMENT_MODES.map((m) => m.label),
    ['Bank transfer', 'UPI', 'Cheque', 'Cash', 'Card', 'Other']);
});

/* ------------------------------------------------------------- history */

test('the history keeps transferred, TDS and settled apart', () => {
  const payments = [
    { id: 1, amount: 90000, tds_amount: 10000 },
    { id: 2, amount: 5000, tds_amount: 0 },
  ];
  assert.deepEqual(paymentTotals(payments), { cash: 95000, tds: 10000, settled: 105000 });
  assert.equal(settlesOf(payments[0]), 100000, 'TDS is never shown as cash paid');
  assert.equal(settlesOf(payments[1]), 5000);
});

test("an entry's settled figure is the server's own when it sent one", () => {
  // /vendor-invoices/:id/full sends `settles` worked out in SQL. It is used
  // as sent, so the screen cannot disagree with the ledger.
  assert.equal(settlesOf({ amount: 90000, tds_amount: 10000, settles: 100000 }), 100000);
  assert.equal(settlesOf({ amount: 2000, tds_amount: -2000, settles: 0 }), 0, 'a recomposition settles nothing');
  assert.equal(settlesOf({ amount: -2000, tds_amount: 0, settles: -2000 }), -2000);
  // Absent, as on a row that did not come from that route: fall back to the sum.
  assert.equal(settlesOf({ amount: 500, tds_amount: 100 }), 600);
  assert.equal(settlesOf({ amount: 500, tds_amount: 100, settles: null }), 600);
});

test('an empty ledger totals to nothing rather than to NaN', () => {
  assert.deepEqual(paymentTotals([]), { cash: 0, tds: 0, settled: 0 });
  assert.deepEqual(paymentTotals(), { cash: 0, tds: 0, settled: 0 });
  assert.equal(settlesOf(undefined), 0);
});

test('a correction is told apart by its reason, and reads as an adjustment', () => {
  const payment = { id: 1, amount: 90000, tds_amount: 10000 };
  const reversal = { id: 2, amount: -90000, tds_amount: -10000, correction_reason: 'the bank reversed it' };
  const partial = { id: 3, amount: -2000, tds_amount: 0, correction_reason: 'overpaid by 2,000' };
  const split = { id: 4, amount: 2000, tds_amount: -2000, correction_reason: 'TDS was 8,000, not 10,000' };

  assert.equal(isCorrection(payment), false);
  assert.equal(correctionShape(payment), null, 'a payment is not a correction');

  assert.equal(isCorrection(reversal), true);
  assert.equal(correctionShape(reversal), 'reversal');
  assert.equal(correctionShape(partial), 'reversal');
  assert.equal(correctionShape(split), 'recomposition', 'the total is unchanged; the split moved');
  assert.equal(correctionShape({ amount: 500, correction_reason: 'understated' }), 'increase');
});

test('the three corrections the UI has to represent all land on the ledger', () => {
  const payments = [{ id: 1, amount: 90000, tds_amount: 10000 }];
  // Full reversal.
  assert.deepEqual(paymentTotals([...payments, { id: 2, amount: -90000, tds_amount: -10000, correction_reason: 'r' }]),
    { cash: 0, tds: 0, settled: 0 });
  // Partial amount correction.
  assert.deepEqual(paymentTotals([...payments, { id: 2, amount: -2000, tds_amount: 0, correction_reason: 'r' }]),
    { cash: 88000, tds: 10000, settled: 98000 });
  // TDS recomposition: the bill still settles 100,000.
  assert.deepEqual(paymentTotals([...payments, { id: 2, amount: 2000, tds_amount: -2000, correction_reason: 'r' }]),
    { cash: 92000, tds: 8000, settled: 100000 });
});

/* ---------------------------------------------------------- correction */

test('a correction needs a reason and something to correct', () => {
  assert.equal(validateCorrection({ amount: 0, tds: 0, reason: 'x' }).amount,
    'Give the amount, the tax deducted, or both to correct');
  assert.equal(validateCorrection({ amount: -100, reason: '   ' }).reason, 'Say why this is being corrected');
  assert.equal(validateCorrection({ amount: -100, reason: 'bank reversed it', paidOn: '2026-10-09', today: '2026-10-08' }).paid_on,
    'A correction cannot be dated in the future');
  assert.deepEqual(validateCorrection({ amount: -100, reason: 'bank reversed it', paidOn: '2026-10-08', today: '2026-10-08' }), {});
});

test('the correction body is signed, and sends the reason trimmed', () => {
  assert.deepEqual(correctionBody({ amount: 2000, tds: -2000, reason: '  TDS was 8,000  ', paidOn: '2026-10-07' }), {
    amount: 2000, tds_amount: -2000, reason: 'TDS was 8,000', paid_on: '2026-10-07',
  });
  // A leg that does not move is left out rather than sent as zero.
  assert.deepEqual(correctionBody({ amount: -2000, tds: 0, reason: 'overpaid' }), {
    amount: -2000, reason: 'overpaid',
  });
});

test('a correction that lowers the bill is flagged for confirmation', () => {
  const down = correctionEffect({ amount: -2000, tds: 0, settled: 100000, netPayable: 100000 });
  assert.equal(down.delta, -2000);
  assert.equal(down.settledAfter, 98000);
  assert.equal(down.lowers, true);
  assert.equal(down.recomposes, false);

  const split = correctionEffect({ amount: 2000, tds: -2000, settled: 100000, netPayable: 100000 });
  assert.equal(split.delta, 0);
  assert.equal(split.lowers, false, 'the bill settles the same; nothing is taken off');
  assert.equal(split.recomposes, true);

  const up = correctionEffect({ amount: 5000, tds: 0, settled: 100000, netPayable: 100000 });
  assert.equal(up.lowers, false);
  assert.equal(up.overBy, 5000, 'a correction can overpay too, and says so');
});

/* ------------------------------------------------- the agency's status */

test("a trip's agency chip uses the view's own statuses and says whose they are", () => {
  assert.deepEqual(agencyTripChip('Vendor paid'), { label: 'Agency: paid', tone: 'settled' });
  assert.deepEqual(agencyTripChip('Vendor partly paid'), { label: 'Agency: partly paid', tone: 'waiting' });
  assert.deepEqual(agencyTripChip('Vendor to pay'), { label: 'Agency: to pay', tone: 'waiting' });
  assert.deepEqual(agencyTripChip('Invoice awaited'), { label: 'Agency: invoice awaited', tone: 'waiting' });
  assert.deepEqual(agencyTripChip('Invoice OVERDUE from vendor'), { label: 'Agency: invoice overdue', tone: 'late' });
  assert.deepEqual(agencyTripChip('Awaiting travel'), { label: 'Agency: awaiting travel', tone: 'plain' });
});

test('every status the trip view can emit has a chip of its own', () => {
  for (const status of AGENCY_TRIP_STATUSES) {
    const chip = agencyTripChip(status);
    assert.ok(chip, status);
    assert.match(chip.label, /^Agency: /, `${status} must say whose status it is`);
    assert.ok(['plain', 'waiting', 'late', 'settled'].includes(chip.tone), `${status} tone`);
  }
});

test("a bill's agency chip covers every status the invoice view can emit", () => {
  for (const status of VENDOR_INVOICE_STATUSES) {
    const chip = agencyInvoiceChip(status);
    assert.ok(chip, status);
    assert.match(chip.label, /^Agency: /);
  }
  assert.deepEqual(agencyInvoiceChip('Paid'), { label: 'Agency: paid', tone: 'settled' });
  assert.deepEqual(agencyInvoiceChip('Overdue'), { label: 'Agency: overdue', tone: 'late' });
  assert.deepEqual(agencyInvoiceChip('Partially Paid'), { label: 'Agency: partly paid', tone: 'waiting' });
  assert.deepEqual(agencyInvoiceChip('Enter amount'), { label: 'Agency: amount needed', tone: 'waiting' });
});

test('no status at all draws no chip, and an unknown one is passed through', () => {
  assert.equal(agencyTripChip(null), null);
  assert.equal(agencyTripChip(''), null);
  assert.equal(agencyInvoiceChip(undefined), null);
  assert.deepEqual(agencyInvoiceChip('Something new'), { label: 'Agency: Something new', tone: 'plain' });
});
