import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advicePrefill, cashAfterTds, isSettled, settledBy } from '../src/lib/receiptTds.js';

/**
 * TDS settles an invoice as cash does, so a receipt or a payment advice
 * pre-filled with the outstanding has to come down by the TDS typed on top
 * of it: 1,18,000 outstanding, 10,000 deducted, is 1,08,000 received.
 */

test('the cash to receive is the outstanding less the TDS', () => {
  assert.equal(cashAfterTds(118000, 10000), 108000);
  assert.equal(cashAfterTds(118000, ''), 118000, 'no TDS typed yet');
  assert.equal(cashAfterTds(100.3, 0.1), 100.2, 'to the paisa');
  assert.equal(cashAfterTds(5000, 9000), 0, 'never below nothing');
});

test('what a receipt settles is the cash plus the TDS', () => {
  assert.equal(settledBy('108000', '10000'), 118000);
  assert.equal(settledBy('0.1', '0.2'), 0.3);
  assert.equal(settledBy('', ''), 0);
});

test("a client's advice is kept as they reported it, held to what is outstanding", () => {
  assert.deepEqual(advicePrefill({ amount: 108000, tds_amount: 10000 }, 118000), { amount: 108000, tds: 10000 });
  assert.deepEqual(advicePrefill({ amount: 50000, tds_amount: 0 }, 118000), { amount: 50000, tds: 0 }, 'a part payment');
  // Reported 1,18,000 paid and 10,000 TDS on 1,18,000: the TDS stands and the cash comes down.
  assert.deepEqual(advicePrefill({ amount: 118000, tds_amount: 10000 }, 118000), { amount: 108000, tds: 10000 });
  assert.deepEqual(advicePrefill({ amount: 100, tds_amount: 500 }, 200), { amount: 0, tds: 200 });
});

test('an advice on an invoice already settled is not a receipt to record', () => {
  assert.equal(isSettled(0), true);
  assert.equal(isSettled(-50), true, 'over-settled already');
  assert.equal(isSettled(0.004), true, 'under a paisa');
  assert.equal(isSettled(0.01), false);
  assert.equal(isSettled(118000), false);
});
