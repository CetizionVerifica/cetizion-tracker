import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIST_DATE_PRESETS, listPresetOf, listPresetRange } from '../src/lib/listDateRange.js';

// The date-range filter on a list, such as Enquiries' received date.

test('rolling windows count today and end on it', () => {
  const today = '2026-10-25';
  assert.deepEqual(listPresetRange('today', today), { from: '2026-10-25', to: '2026-10-25' });
  assert.deepEqual(listPresetRange('last-7', today), { from: '2026-10-19', to: '2026-10-25' });
  assert.deepEqual(listPresetRange('last-30', today), { from: '2026-09-26', to: '2026-10-25' });
});

test('rolling windows cross month and year ends on the calendar', () => {
  assert.deepEqual(listPresetRange('last-7', '2027-01-03'), { from: '2026-12-28', to: '2027-01-03' });
  assert.deepEqual(listPresetRange('last-30', '2028-03-01'), { from: '2028-02-01', to: '2028-03-01' });
});

test('month, quarter and FY spans are the Reports page’s own', () => {
  const today = '2026-10-25';
  assert.deepEqual(listPresetRange('this-month', today), { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(listPresetRange('this-quarter', today), { from: '2026-10-01', to: '2026-12-31' });
  assert.deepEqual(listPresetRange('last-fy', today), { from: '2025-04-01', to: '2026-03-31' });
});

test('custom and unknown keys have no range of their own', () => {
  assert.equal(listPresetRange('custom', '2026-10-25'), null);
  assert.equal(listPresetRange('this-year', '2026-10-25'), null);
});

test('a from/to pair names its preset, custom, or nothing', () => {
  const today = '2026-10-25';
  assert.equal(listPresetOf('', '', today), '');
  assert.equal(listPresetOf(undefined, undefined, today), '');
  assert.equal(listPresetOf('2026-10-19', '2026-10-25', today), 'last-7');
  assert.equal(listPresetOf('2026-04-01', '2027-03-31', today), 'this-fy');
  assert.equal(listPresetOf('2026-10-02', '2026-10-09', today), 'custom');
  // One end open is a custom range, never a preset.
  assert.equal(listPresetOf('2026-10-01', '', today), 'custom');
});

test('every preset but custom resolves', () => {
  for (const { key } of LIST_DATE_PRESETS) {
    if (key !== 'custom') assert.ok(listPresetRange(key, '2026-10-25'), key);
  }
});
