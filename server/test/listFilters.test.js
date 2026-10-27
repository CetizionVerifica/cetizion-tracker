import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { buildWhere } from '../src/lib/crud.js';

// Kept out of dataQuality.test.js: importing crud.js opens the database pool,
// and that file must set DATABASE_URL before anything does.
describe('buildWhere: __any__ is the other half of __none__', () => {
  const def = { filters: ['invoice_no', 'sector'], normalizedFilters: ['sector'] };

  test('a plain column: IS NOT NULL, no parameter', () => {
    const params = [];
    assert.equal(buildWhere(def, { invoice_no: '__any__' }, params), 'WHERE "invoice_no" IS NOT NULL');
    assert.deepEqual(params, []);
  });

  test('a normalized column: a blank is not a value', () => {
    const params = [];
    assert.equal(buildWhere(def, { sector: '__any__' }, params), `WHERE NULLIF(btrim("sector"), '') IS NOT NULL`);
  });

  test('__none__ and __any__ on two columns combine', () => {
    const params = [];
    assert.equal(
      buildWhere({ filters: ['invoice_no', 'document_id'] }, { invoice_no: '__any__', document_id: '__none__' }, params),
      'WHERE "invoice_no" IS NOT NULL AND "document_id" IS NULL'
    );
  });
});

// Every list screen with a date picker (ListPage dateRange) filters ?from=&to=
// on one date column of its resource, both ends inclusive.
describe('buildWhere: the list date picker', async () => {
  const { resources } = await import('../src/lib/resources.js');
  const PICKER = {
    enquiries: 'enquiry_date', quotations: 'quotation_date', projects: 'planned_start_date',
    'purchase-orders': 'po_date', 'payment-stages': 'invoice_date', 'travel-logs': 'travel_start_date',
    'vendor-invoices': 'invoice_date', 'vendor-credit-notes': 'credit_note_date', 'expense-claims': 'submission_date',
  };

  test('each list with a picker names its date column', () => {
    for (const [name, column] of Object.entries(PICKER)) assert.equal(resources[name].dateFilter, column, name);
  });

  test('from and to are inclusive, and either end may be open', () => {
    const def = { filters: [], dateFilter: 'invoice_date' };
    let params = [];
    assert.equal(buildWhere(def, { from: '2026-10-01', to: '2026-10-31' }, params), 'WHERE "invoice_date" >= $1::date AND "invoice_date" <= $2::date');
    assert.deepEqual(params, ['2026-10-01', '2026-10-31']);
    params = [];
    assert.equal(buildWhere(def, { to: '2026-10-31' }, params), 'WHERE "invoice_date" <= $1::date');
  });
});
