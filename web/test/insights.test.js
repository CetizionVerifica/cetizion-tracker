import { test } from 'node:test';
import assert from 'node:assert/strict';
import { followUpAnswer, hrefs, queryString, readFilters, receivablesAnswer, ruleText, tones } from '../src/lib/insights.js';

/**
 * Insights' pure half: every bar and tile leads to the list that counts the
 * same rows, and a tile's colour agrees with its number.
 */

test('the filters are read from the address bar, with nonsense defaulted', () => {
  assert.deepEqual(readFilters(new URLSearchParams('')), { owner: '', granularity: 'month', horizon: '6', basis: 'cash' });
  assert.deepEqual(readFilters(new URLSearchParams('owner=4&granularity=quarter&horizon=12&basis=order')), { owner: '4', granularity: 'quarter', horizon: '12', basis: 'order' });
  assert.deepEqual(readFilters(new URLSearchParams('granularity=week&horizon=5&basis=x')), { owner: '', granularity: 'month', horizon: '6', basis: 'cash' });
});

test('a query string leaves blanks out and encodes the rest', () => {
  assert.equal(queryString({ a: '', b: null, c: undefined }), '');
  assert.equal(queryString({ overdue_days: '15+', q: 'a b' }), '?overdue_days=15%2B&q=a+b');
});

test('drill-downs open the lists with the filters the server understands', () => {
  assert.equal(hrefs.followUps('', '8-14'), '/quotations?follow_up=overdue&overdue_days=8-14');
  assert.equal(hrefs.followUps('7'), '/quotations?follow_up=overdue&owner=7', 'an admin looking at one owner keeps them');
  assert.equal(hrefs.followUpOwner(null), '/quotations?follow_up=overdue&owner=none', 'the "no owner" bar');
  assert.equal(hrefs.risk('', 'no_reply'), '/enquiries?risk=no_reply');
  assert.equal(hrefs.risk(''), '/enquiries?risk=at_risk');
  assert.equal(hrefs.ageing('31-60'), '/collections?bucket=31-60');
  assert.equal(hrefs.client(12), '/companies/12');
  assert.equal(hrefs.client(null), '/collections');
  assert.equal(hrefs.awaitingMonth('', 4, '2026-11'), '/quotations?stage_id=4&close_month=2026-11');
  assert.equal(hrefs.poStatus('To Invoice'), '/purchase-orders?payment_status=To+Invoice&live=1', 'the live POs the chart counted');
  assert.equal(hrefs.period({ period: '2026-10', from: '2026-10-01', to: '2026-10-31' }, 'month'), '/cashflow?month=2026-10');
  assert.equal(hrefs.period({ period: '2026Q3', from: '2026-10-01', to: '2026-12-31' }, 'quarter'), '/cashflow?from=2026-10-01&to=2026-12-31');
});

test('a tile is red when something is properly late, amber when not yet, green when clear', () => {
  assert.equal(tones.followUps({ count: 0 }), 'success');
  assert.equal(tones.followUps({ count: 2, oldest_days: 3 }), 'warning');
  assert.equal(tones.followUps({ count: 2, oldest_days: 12 }), 'danger');
  assert.equal(tones.receivables({ overdue: 0 }), 'success');
  assert.equal(tones.receivables({ overdue: 10, buckets: [{ key: '1-30', amount: 10 }, { key: '90+', amount: 0 }] }), 'warning');
  assert.equal(tones.receivables({ overdue: 10, buckets: [{ key: '90+', amount: 10 }] }), 'danger');
  assert.equal(tones.enquiryRisk({ count: 1, top: [{ decision_near: true }] }), 'danger');
  assert.equal(tones.enquiryRisk({ count: 1, top: [{ decision_near: false }] }), 'warning');
});

test('the one-line answers say what good looks like when there is nothing to do', () => {
  assert.match(followUpAnswer({ count: 0 }), /Nice/);
  assert.match(followUpAnswer({ count: 2, oldest_days: 23, top: [{ client: 'Acme', value_inr: 1200000 }] }), /^2 quotations, oldest 23 days past its date\. Start with Acme \(₹12/);
  assert.match(receivablesAnswer({ outstanding: 0 }), /Nothing invoiced/);
});

test('the ⓘ text reads the live settings', () => {
  assert.match(ruleText('follow_ups', { quotation_idle_days: 7 }), /7 working days/);
  assert.match(ruleText('enquiry_risk', { enquiry_reply_days: 1, enquiry_decision_warn_days: 5, enquiry_idle_days: 3 }), /within 1 working day,.*within 5 working days.*3 working days/);
});
