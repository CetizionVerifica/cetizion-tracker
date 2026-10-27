import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addBand, blankValue, kindOf, newLine, numericColumns, problemsByLine, publishHold, questionsFor, removeBand, setBandCell, VALUE_KINDS,
} from '../src/lib/pricingRules.js';

/** The Pricing tab's helpers (#208 phase 2C): what the editor offers, never a price. A made-up form. */
const def = { steps: [{ key: 's', title: 'S', questions: [
  { key: 'legal_name', type: 'text', label: 'Legal name' },
  { key: 'employee_count', type: 'number', label: 'Employees' },
  { key: 'turnover', type: 'money', label: 'Turnover' },
  { key: 'standards', type: 'multiselect', label: 'Standards', options: [{ key: 'iso_9001', label: 'ISO 9001' }] },
  { key: 'previously_certified', type: 'yesno', label: 'Certified before?' },
  { key: 'sites', type: 'table', label: 'Sites', columns: [{ key: 'city', type: 'text', label: 'City' }, { key: 'employees', type: 'number', label: 'Employees' }] },
  { key: 'org_chart', type: 'file', label: 'Org chart' },
  { key: 'note', type: 'info', label: 'Note' },
] }] };
const keys = (qs) => qs.map((q) => q.key);

test('the vocabulary offered is the server\'s, exactly', () => {
  assert.deepEqual(VALUE_KINDS.map((k) => k.kind).sort(),
    ['add', 'answer', 'band', 'catalogue', 'count', 'fixed', 'max', 'min', 'multiply', 'round_up', 'rows', 'sum']);
});

test('each picker lists only the questions its block can read', () => {
  assert.deepEqual(keys(questionsFor('answer', def)), ['employee_count', 'turnover'], 'numbers and money');
  assert.deepEqual(keys(questionsFor('count', def)), ['standards'], 'multi-selects and tick boxes');
  assert.deepEqual(keys(questionsFor('rows', def)), ['sites'], 'tables');
  assert.deepEqual(keys(questionsFor('sum', def)), ['sites']);
  assert.deepEqual(keys(questionsFor('include', def)), ['legal_name', 'employee_count', 'turnover', 'standards', 'previously_certified'], 'not tables, files or guidance');
  assert.deepEqual(numericColumns(def.steps[0].questions[5]).map((c) => c.key), ['employees']);
});

test('a new block starts on the first thing it can read', () => {
  assert.deepEqual(blankValue('answer', def), { answer: 'employee_count' });
  assert.deepEqual(blankValue('sum', def), { sum: { table: 'sites', column: 'employees' } });
  assert.deepEqual(blankValue('band', def), { band: { of: { answer: 'employee_count' }, bands: [[1, 10, 1]] } });
  assert.deepEqual(blankValue('multiply', def), { multiply: [{ fixed: 1 }] });
  assert.deepEqual(blankValue('catalogue', def), { catalogue: true });
  assert.equal(kindOf({ round_up: { fixed: 2 } }), 'round_up');
});

test('bands are edited as rows: a new one starts where the last stopped', () => {
  let bands = [[1, 45, 3]];
  bands = addBand(bands);
  assert.deepEqual(bands, [[1, 45, 3], [46, 46, 3]]);
  bands = setBandCell(bands, 1, 1, 125);
  bands = setBandCell(bands, 1, 2, 5);
  assert.deepEqual(bands, [[1, 45, 3], [46, 125, 5]]);
  assert.deepEqual(removeBand(bands, 0), [[46, 125, 5]]);
  assert.deepEqual(addBand([]), [[1, 1, 1]]);
});

test('a new line gets a key no other line has', () => {
  assert.equal(newLine([]).key, 'line_1');
  assert.equal(newLine([{ key: 'line_2' }, { key: 'audit' }]).key, 'line_3');
  assert.equal(newLine([{ key: 'line_1' }]).key, 'line_2');
});

test('Publish waits, saying why in one sentence, while pricing has problems; nothing holds it once they are gone', () => {
  assert.equal(publishHold(['Line 1 (audit), rate: x']), 'Publishing waits until the pricing problem on the Pricing tab is fixed and saved.');
  assert.equal(publishHold(['a', 'b', 'c']), 'Publishing waits until the 3 pricing problems on the Pricing tab are fixed and saved.');
  assert.equal(publishHold([]), null, 'enabled again');
  assert.equal(publishHold(undefined), null);
  assert.equal(publishHold([], true), 'Publishing waits until the changes on the Pricing tab are saved.', 'unsaved pricing would be left behind');
});

test('the server\'s problems are shown beside the line they are about', () => {
  const { byLine, general } = problemsByLine([
    'Line 1 (audit), quantity: "legal_name" is a text question; a quantity or rate needs a number or money answer',
    'Line 2 (stage1): "include when" on "previously_certified" needs true or false',
    'lines.1.rate: not one of the pricing blocks: fixed, answer, …',
    'pricing: Unrecognized key',
    'Line 9 (gone): out of range',
  ], [{ key: 'audit' }, { key: 'stage1' }]);
  assert.deepEqual(byLine[0], ['quantity: "legal_name" is a text question; a quantity or rate needs a number or money answer']);
  assert.deepEqual(byLine[1], ['"include when" on "previously_certified" needs true or false', 'rate: not one of the pricing blocks: fixed, answer, …']);
  assert.deepEqual(general, ['pricing: Unrecognized key', 'Line 9 (gone): out of range']);
});

test('a problem stays with its line when lines are moved or removed before saving', () => {
  const problems = ['Line 1 (audit), rate: x'];
  assert.deepEqual(problemsByLine(problems, [{ key: 'report' }, { key: 'audit' }]).byLine, [[], ['rate: x']], 'moved down');
  const removed = problemsByLine(problems, [{ key: 'report' }]);
  assert.deepEqual(removed.byLine, [[]], 'not pinned on the line that took its place');
  assert.deepEqual(removed.general, problems);
});
