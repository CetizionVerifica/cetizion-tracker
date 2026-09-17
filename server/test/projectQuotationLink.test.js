import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { resources } from '../src/lib/resources.js';

/**
 * Registering a won quotation from the Projects page. The link lives on
 * quotations.project_id, so it is written by an onSave hook rather than a
 * column — these pin the contract that makes that possible.
 */

describe('a project can claim a won quotation', () => {
  test('quotation_no is accepted but is not a projects column', () => {
    const def = resources.projects;
    assert.ok(def.schema.shape.quotation_no, 'must survive validation to reach onSave');
    assert.ok(!def.columns.includes('quotation_no'), 'projects has no such column');
    assert.equal(typeof def.onSave, 'function', 'the link is written by the hook');
  });

  test('an update with nothing but a linked field is still work to do', async () => {
    const { readFileSync } = await import('node:fs');
    const crud = readFileSync('src/lib/crud.js', 'utf8');
    // Guards a 422 that would block the feature, and a 500 from UPDATE ... SET.
    // An empty body is still 422; a body that only links stays work to do.
    assert.ok(crud.includes('const linksOnly = def.onSave && Object.keys(input).length > 0;'));
    assert.ok(crud.includes("if (!cols.length && !linksOnly) throw new ApiError(422, 'Nothing to update');"));
    assert.ok(crud.includes('rows = before ? [before] : [];'),
      'with no columns the locked row is reused instead of an empty UPDATE');
  });

  test('a rate cannot overflow the column it is stored in', () => {
    const { schema } = resources['exchange-rates'];
    const ok = (rate) => schema.safeParse({ from_currency: 'USD', rate, effective_from: '2026-04-01' }).success;
    assert.equal(ok('88.25'), true);
    assert.equal(ok('1000000'), true);
    // numeric(18,6) holds 12 digits before the point.
    assert.equal(ok('10000000000000'), false, 'must be refused, not stored and 500');
  });
});
