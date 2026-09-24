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
