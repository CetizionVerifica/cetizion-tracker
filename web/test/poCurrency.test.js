import { test } from 'node:test';
import assert from 'node:assert/strict';
import { poCurrencyFields, poCurrencyWarning } from '../src/lib/poCurrency.js';

/**
 * A PO in the wrong currency is read in that currency by every report, so
 * the PO forms warn about it — but only about the currency. A PO for part of
 * a quotation (50/50, 30/70) is normal and must never be flagged.
 */

const quotations = [
  { quotation_no: 'Q-EUR', currency: 'EUR' },
  { quotation_no: 'Q-INR', currency: 'INR' },
];

test('warns only when the currency differs from the quotation', () => {
  assert.match(poCurrencyWarning(quotations, { quotation_no: 'Q-EUR', currency: 'INR' }), /Q-EUR is in EUR, but this PO is in INR/);
  assert.equal(poCurrencyWarning(quotations, { quotation_no: 'Q-EUR', currency: 'EUR' }), null);
  assert.equal(poCurrencyWarning(quotations, { quotation_no: 'Q-INR', currency: 'INR', po_value: 1 }), null, 'a part payment is not a mismatch');
});

test('says nothing when there is no quotation to compare against', () => {
  assert.equal(poCurrencyWarning(quotations, { quotation_no: '', currency: 'INR' }), null);
  assert.equal(poCurrencyWarning(quotations, { quotation_no: 'Q-UNKNOWN', currency: 'INR' }), null);
});

test('picking the quotation fills in its currency', () => {
  const { quotation, currency } = poCurrencyFields(quotations);
  assert.deepEqual(quotation.fills('Q-EUR'), { currency: 'EUR' });
  assert.deepEqual(quotation.fills(''), {}, 'clearing the quotation leaves the currency alone');
  assert.equal(currency.warn({ quotation_no: 'Q-EUR', currency: 'EUR' }), null);
  assert.ok(currency.warn({ quotation_no: 'Q-EUR', currency: 'USD' }));
});
