import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { linkProjectQuotation } from '../src/lib/projects.js';
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

describe('which quotations a project can claim', () => {
  // Stands in for the transaction client: answers the quotation lookup, and
  // any lookup of quotations by project with the ones already on it. Records
  // every statement so a test can see whether the link was written.
  const fakeClient = (quotation, { onProject = [] } = {}) => {
    const statements = [];
    return {
      statements,
      query: async (sql, params) => {
        statements.push({ sql, params });
        if (/FOR UPDATE/.test(sql)) return { rows: quotation ? [quotation] : [] };
        if (/^\s*SELECT[\s\S]*FROM quotations[\s\S]*project_id = \$1/.test(sql)) return { rows: onProject };
        return { rows: [] };
      },
    };
  };
  const won = (overrides = {}) => ({
    quotation_no: 'CTZ/QT/2026/014', status: 'Won - PO Received', project_id: null, client_name: 'Hindalco Ltd', ...overrides,
  });
  const project = { project_id: 'PRJ-2026-003', client_name: 'Hindalco Ltd' };
  const linked = (client) => client.statements.some(({ sql }) => /^UPDATE quotations SET project_id/.test(sql));
  const fieldError = async (promise) => {
    try {
      await promise;
    } catch (err) {
      return err.extra?.fields?.quotation_no;
    }
    return undefined;
  };

  test('a project that already has a won quotation can take a second one, as Register allows (#8)', async () => {
    const client = fakeClient(won(), { onProject: [{ quotation_no: 'CTZ/QT/2026/009' }] });

    const result = await linkProjectQuotation(client, { after: project, input: { quotation_no: 'CTZ/QT/2026/014' } });

    assert.deepEqual(result, { quotation_linked: 'CTZ/QT/2026/014' });
    assert.ok(linked(client));
  });

  test('a quotation for another client is refused and nothing is linked', async () => {
    const client = fakeClient(won({ client_name: 'Tata Steel' }));

    const message = await fieldError(
      linkProjectQuotation(client, { after: project, input: { quotation_no: 'CTZ/QT/2026/014' } })
    );

    assert.match(message, /for Tata Steel, but this project is for Hindalco Ltd/);
    assert.ok(!linked(client));
  });

  test('client names that differ only in case or spacing are the same client', async () => {
    const client = fakeClient(won({ client_name: '  hindalco   LTD ' }));

    await linkProjectQuotation(client, { after: project, input: { quotation_no: 'CTZ/QT/2026/014' } });

    assert.ok(linked(client));
  });
});
