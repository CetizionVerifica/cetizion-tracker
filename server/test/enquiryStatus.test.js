import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resources } from '../src/lib/resources.js';

const schema = resources.enquiries.schema;

test('the enquiry statuses from before #24 are still accepted, renamed as migration 018 did', () => {
  assert.equal(schema.partial().parse({ status: 'In Progress' }).status, 'Contacted');
  assert.equal(schema.partial().parse({ status: 'Declined' }).status, 'Unqualified');
  assert.equal(schema.partial().parse({ status: 'Won - Quotation Sent' }).status, 'Converted');
  assert.equal(schema.partial().parse({ status: 'Qualified' }).status, 'Qualified');
  assert.throws(() => schema.partial().parse({ status: 'Something else' }));
});
