import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bucketEnd, bucketStart, defaultGrain, drillLink, presetOf, presetPeriod, readReportQuery,
} from '../src/lib/reportPeriods.js';

// The Reports page's period control: presets, the grain that follows them,
// and links into the records behind a chart.

test('presets resolve to whole months, FY quarters and years', () => {
  const today = '2026-10-02';
  assert.deepEqual(presetPeriod('this-month', today), { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(presetPeriod('last-month', today), { from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(presetPeriod('this-quarter', today), { from: '2026-10-01', to: '2026-12-31' });
  assert.deepEqual(presetPeriod('this-fy', today), { from: '2026-04-01', to: '2027-03-31' });
  assert.deepEqual(presetPeriod('last-fy', today), { from: '2025-04-01', to: '2026-03-31' });
  assert.deepEqual(presetPeriod('this-year', today), { from: '2026-01-01', to: '2026-12-31' });
});

test('January belongs to the financial year that started the April before', () => {
  assert.deepEqual(presetPeriod('this-fy', '2027-01-15'), { from: '2026-04-01', to: '2027-03-31' });
  assert.deepEqual(presetPeriod('this-quarter', '2027-01-15'), { from: '2027-01-01', to: '2027-03-31' });
  assert.deepEqual(presetPeriod('this-quarter', '2026-05-15'), { from: '2026-04-01', to: '2026-06-30' });
  assert.deepEqual(presetPeriod('last-month', '2027-01-15'), { from: '2026-12-01', to: '2026-12-31' });
  assert.deepEqual(presetPeriod('this-month', '2028-02-10'), { from: '2028-02-01', to: '2028-02-29' });
});

test('a from/to pair names its preset, or custom', () => {
  assert.equal(presetOf('2026-04-01', '2027-03-31', '2026-10-02'), 'this-fy');
  assert.equal(presetOf('2026-04-01', '2026-04-15', '2026-10-02'), 'custom');
});

test('the grain follows the period length, as on the server', () => {
  assert.equal(defaultGrain('2026-10-01', '2026-10-31'), 'day');
  assert.equal(defaultGrain('2026-04-01', '2026-09-30'), 'week');
  assert.equal(defaultGrain('2026-04-01', '2027-03-31'), 'month');
});

test('the address bar is the report; anything unreadable falls back to this month', () => {
  const q = (s) => readReportQuery(new URLSearchParams(s), '2026-10-02');
  assert.deepEqual(q('from=2026-04-01&to=2027-03-31&grain=week&owner=7'),
    { from: '2026-04-01', to: '2027-03-31', grain: 'week', owner: '7', preset: 'this-fy' });
  assert.deepEqual(q('from=2026-12-01&to=2026-01-01&grain=hour&owner=x'),
    { from: '2026-10-01', to: '2026-10-31', grain: '', owner: '', preset: 'this-month' });
});

test('a bucket opens its own days, clipped to the period', () => {
  assert.equal(bucketEnd('2026-09-28', 'week', '2026-10-31'), '2026-10-04');
  assert.equal(bucketStart('2026-09-28', 'week', '2026-10-01'), '2026-10-01');
  assert.equal(bucketEnd('2026-02', 'month', null), '2026-02-28');
  assert.equal(bucketEnd('2027-03', 'month', '2027-03-15'), '2027-03-15');
});

test('drill-down links carry the period, the owner and the slice', () => {
  assert.equal(drillLink('enquiries', { from: '2026-09-01', to: '2026-09-30', owner: '' }, { outcome: 'lost' }),
    '/enquiries?report_from=2026-09-01&report_to=2026-09-30&report_outcome=lost');
  assert.equal(drillLink('purchase-orders', { from: '2026-09-01', to: '2026-09-30', owner: '3' }, { sector: 'Metal Industry', month: null }),
    '/purchase-orders?report_from=2026-09-01&report_to=2026-09-30&report_owner=3&report_sector=Metal+Industry');
});
