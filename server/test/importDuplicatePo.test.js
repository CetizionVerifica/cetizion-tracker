import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flagRepeatedPoNumbers } from '../src/import/rules.js';

// The same PO number on two rows of the sheet, settled during review.

const po = (seq, source_row, po_number, extra = {}) => ({
  seq, source_row, step: 'purchase_order', action: 'create', flags: [], payload: { po_number }, ...extra,
});
const codes = (it) => it.flags.map((f) => `${f.level}:${f.code}`);

test('the first row creates the PO; the rest block the commit until they are settled', () => {
  const items = [po(1, 4, 'PO-9'), po(2, 11, 'PO-9'), po(3, 12, 'PO-9')];
  flagRepeatedPoNumbers(items);
  assert.deepEqual(codes(items[0]), ['warn:duplicate_po_in_sheet']);
  assert.deepEqual(codes(items[1]), ['error:duplicate_po_in_sheet']);
  assert.deepEqual(codes(items[2]), ['error:duplicate_po_in_sheet']);
  assert.match(items[0].flags[0].message, /on 3 rows of the sheet \(S\.No 4, S\.No 11, S\.No 12\)/);
  assert.match(items[1].flags[0].message, /already created by S\.No 4/);
});

test('the number is matched the way the importer matches it: spacing and case do not hide a clash', () => {
  const items = [po(1, 4, 'PO 9'), po(2, 5, 'po-9')];
  flagRepeatedPoNumbers(items);
  assert.equal(items[1].flags[0].level, 'error');
});

test('distinct PO numbers, and a single row, are left alone', () => {
  const items = [po(1, 4, 'PO-9'), po(2, 5, 'PO-10')];
  flagRepeatedPoNumbers(items);
  assert.deepEqual(items.flatMap(codes), []);
});

test('rows that keep or update a PO already on the site never collide', () => {
  const items = [po(1, 4, 'PO-9', { action: 'skip' }), po(2, 5, 'PO-9', { action: 'update' })];
  flagRepeatedPoNumbers(items);
  assert.deepEqual(items.flatMap(codes), []);
});

test('other steps sharing a PO number are not touched', () => {
  const items = [po(1, 4, 'PO-9'), { seq: 2, source_row: 5, step: 'stage', action: 'create', flags: [], payload: { po_number: 'PO-9' } }];
  flagRepeatedPoNumbers(items);
  assert.deepEqual(items.flatMap(codes), []);
});
