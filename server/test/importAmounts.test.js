import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewFlags } from '../src/import/rules.js';
import { parseMoney } from '../src/import/parse.js';

test('a negative amount is an error at review time, and clears once corrected', () => {
  const flags = reviewFlags('quotation', { quotation_value: parseMoney('-5000').amount }, [{ level: 'warn', code: 'no_date' }]);
  assert.deepEqual(flags.map((f) => f.code), ['no_date', 'negative_amount']);
  assert.equal(flags[1].level, 'error');
  assert.deepEqual(reviewFlags('quotation', { quotation_value: 5000 }, flags).map((f) => f.code), ['no_date']);
});

test('a value the form would refuse is an error at review time', () => {
  const flags = reviewFlags('quotation', { client_name: 'Acme', sales_person: 'x'.repeat(900) });
  assert.deepEqual(flags.map((f) => f.code), ['invalid_value']);
  assert.match(flags[0].message, /sales person/);
  assert.deepEqual(reviewFlags('quotation', { client_name: 'Acme', sales_person: 'Vishnu' }, flags), []);
});

test('blank and zero amounts are not flagged', () => {
  assert.deepEqual(reviewFlags('purchase_order', { po_value: 0, amount_received: '' }), []);
  assert.deepEqual(reviewFlags('quotation', { quotation_value: null }), []);
});
