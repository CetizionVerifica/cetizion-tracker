import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RULES, rulesSchema } from '../src/import/rules.js';

// The rule overrides a request may send to the importer.

test('the defaults and an empty override both pass', () => {
  assert.equal(rulesSchema.safeParse(DEFAULT_RULES).success, true);
  assert.equal(rulesSchema.safeParse({}).success, true);
});

test('a sensible override passes unchanged', () => {
  const parsed = rulesSchema.safeParse({ default_split: [30, 70], invoice_prefix: 'CVPL', default_currency: 'USD' });
  assert.deepEqual(parsed.data, { default_split: [30, 70], invoice_prefix: 'CVPL', default_currency: 'USD' });
});

test('bad values are refused', () => {
  for (const bad of [
    { default_split: [60, 60] },            // does not add up to 100
    { default_split: [0, 100] },            // no advance stage
    { po_date_offset_days: -3 },
    { po_date_offset_days: '7' },           // a string, not a number
    { delivery_offset_months: 1.5 },
    { default_currency: 'rupees' },
    { invoice_prefix: '.*' },               // would change the RegExp
    { exclude_iso: 'yes' },
    { overwrite_existng: true },            // a typo, not a rule
  ]) {
    assert.equal(rulesSchema.safeParse(bad).success, false, JSON.stringify(bad));
  }
});
