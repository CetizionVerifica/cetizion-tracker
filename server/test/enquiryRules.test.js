import assert from 'node:assert/strict';
import { test } from 'node:test';
import { enquiryRuleErrors, enquiryServices } from '../src/lib/enquiries.js';

/**
 * What an enquiry must know before it moves on (#24): it leaves New only
 * with a source and a company, is Qualified only with services and a
 * value, and Unqualified only with a reason.
 */

const bare = { status: 'New', client_name: 'Acme Ltd', company_id: 1 };

test('leaving New needs a source, and a company', () => {
  assert.deepEqual(Object.keys(enquiryRuleErrors({ ...bare }, { ...bare, status: 'Contacted' })), ['source_id']);
  assert.equal(enquiryRuleErrors({ ...bare }, { ...bare, status: 'Contacted', source: 'Referral' }), null);
  assert.equal(enquiryRuleErrors({ ...bare }, { ...bare, status: 'Contacted', source_id: 3 }), null);
  assert.deepEqual(Object.keys(enquiryRuleErrors(null, { status: 'Contacted', client_name: ' ', source: 'Web' })), ['client_name']);
});

test('Qualified and Converted need the services and a value', () => {
  const contacted = { ...bare, status: 'Contacted', source: 'Web' };
  assert.deepEqual(Object.keys(enquiryRuleErrors(contacted, { ...contacted, status: 'Qualified' })).sort(), ['estimated_value', 'service']);
  assert.equal(enquiryRuleErrors(contacted, { ...contacted, status: 'Qualified', services_interested: 'GHG', estimated_value: 0 }), null, 'a value of 0 is a value');
  assert.deepEqual(Object.keys(enquiryRuleErrors(contacted, { ...contacted, status: 'Converted', service: 'LCA' })), ['estimated_value']);
});

test('Unqualified needs a reason, picked or written', () => {
  const contacted = { ...bare, status: 'Contacted', source: 'Web' };
  assert.deepEqual(Object.keys(enquiryRuleErrors(contacted, { ...contacted, status: 'Unqualified' })), ['unqualified_reason_id']);
  assert.equal(enquiryRuleErrors(contacted, { ...contacted, status: 'Unqualified', unqualified_reason_id: 2 }), null);
  assert.equal(enquiryRuleErrors(contacted, { ...contacted, status: 'Unqualified', unqualified_notes: 'Wanted it free' }), null);
});

test('only a change of status is judged, so an older enquiry stays editable', () => {
  const legacy = { status: 'Qualified', client_name: 'Old Co' };
  assert.equal(enquiryRuleErrors(legacy, { ...legacy, notes: 'edited' }), null);
  assert.equal(enquiryRuleErrors(null, { ...bare }), null, 'a new enquiry starts at New with nothing more');
});

test('the services asked for, one per line, the picked one first', () => {
  assert.deepEqual(enquiryServices({ service: 'EcoVadis', services_interested: 'GHG inventory, BRSR & ecovadis; LCA and CBAM' }),
    ['EcoVadis', 'GHG inventory', 'BRSR', 'LCA', 'CBAM']);
  assert.deepEqual(enquiryServices({ service: null, services_interested: '' }), []);
});
