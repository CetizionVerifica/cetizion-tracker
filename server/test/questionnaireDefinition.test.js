import assert from 'node:assert/strict';
import test from 'node:test';
import { checkAnswers, checkDefinition, isVisible, prefillAnswers, prefillDifferences } from '../src/lib/questionnaireDefinition.js';

/**
 * A service questionnaire's definition and the answers given to it
 * (#208): the rules the builder, the client's page and the server share.
 * The example is made up (an ISO certification form of the usual shape),
 * not one of the business's own questionnaires.
 */
const example = () => ({
  intro: 'A few questions so we can quote accurately.',
  steps: [
    {
      key: 'organisation', title: 'Your organisation', questions: [
        { key: 'legal_name', type: 'text', label: 'Legal name', required: true, prefill: 'company.name' },
        { key: 'gstin', type: 'text', label: 'GSTIN', prefill: 'company.gstin' },
        { key: 'employee_count', type: 'number', label: 'Employees in scope', required: true, integer: true, min: 1, max: 100000 },
        { key: 'turnover', type: 'money', label: 'Annual turnover', currency: 'INR' },
      ],
    },
    {
      key: 'scope', title: 'Scope', questions: [
        { key: 'standards', type: 'multiselect', label: 'Standards', required: true, options: [{ key: 'iso_9001', label: 'ISO 9001' }, { key: 'iso_14001', label: 'ISO 14001' }] },
        { key: 'previously_certified', type: 'yesno', label: 'Certified before?', required: true },
        { key: 'certifying_body', type: 'text', label: 'Which body certified you?', required: true, show_if: { key: 'previously_certified', op: 'eq', value: true } },
        { key: 'sites', type: 'table', label: 'Sites', required: true, columns: [
          { key: 'city', type: 'text', label: 'City', required: true },
          { key: 'employees', type: 'number', label: 'Employees', integer: true, min: 0 },
          { key: 'shifts', type: 'select', label: 'Shifts', options: [{ key: 'one', label: '1' }, { key: 'two', label: '2' }] },
        ] },
        { key: 'audit_month', type: 'date', label: 'Preferred audit month' },
        { key: 'org_chart', type: 'file', label: 'Organisation chart' },
        { key: 'note', type: 'info', label: 'We will confirm the man-days after reading your answers.' },
      ],
    },
  ],
});

test('a well-formed definition passes, and is returned as checked', () => {
  const r = checkDefinition(example());
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.equal(r.definition.steps.length, 2);
});

test('every rule a shape cannot say is reported in the admin\'s words', () => {
  const cases = [
    [(d) => { d.steps[1].questions[0].key = 'legal_name'; }, /used twice/],
    [(d) => { d.steps[0].questions[0].show_if = { key: 'standards', op: 'answered' }; }, /must point to a question before it/],
    [(d) => { d.steps[1].questions[0].options = []; }, /at least one option/],
    [(d) => { d.steps[1].questions[3].columns = []; }, /at least one column/],
    [(d) => { d.steps[0].questions[2].min = 10; d.steps[0].questions[2].max = 5; }, /minimum is above the maximum/],
    [(d) => { d.steps[0].questions[2].prefill = 'company.name'; }, /only a text question can be prefilled/],
    [(d) => { d.steps[1].questions[2].show_if = { key: 'sites', op: 'answered' }; d.steps[1].questions.push(d.steps[1].questions.splice(2, 1)[0]); }, /cannot depend on a table/],
    [(d) => { d.steps[1].questions[2].show_if = { key: 'previously_certified', op: 'in', value: true }; }, /needs a list/],
    [(d) => { d.steps[0].questions[0].key = 'Legal Name'; }, /Lower-case letters/],
    [(d) => { d.steps[0].questions[0].type = 'script'; }, /type/],
    [(d) => { d.steps[0].questions[0].onload = 'x'; }, /Unrecognized key/],
  ];
  for (const [change, expected] of cases) {
    const d = example(); change(d);
    const r = checkDefinition(d);
    assert.equal(r.ok, false, String(expected));
    assert.match(r.errors.join(' | '), expected);
  }
});

test('show-if rules: each comparison, and a hidden question hides what depends on it', () => {
  const q = (op, value) => ({ show_if: { key: 'n', op, value } });
  assert.equal(isVisible(q('eq', 3), { n: 3 }), true);
  assert.equal(isVisible(q('neq', 3), { n: 3 }), false);
  assert.equal(isVisible(q('in', ['a', 'b']), { n: 'b' }), true);
  assert.equal(isVisible(q('in', ['a']), { n: ['x', 'a'] }), true, 'a multiselect matches on any option');
  assert.equal(isVisible(q('gt', 10), { n: 11 }), true);
  assert.equal(isVisible(q('gt', 10), {}), false, 'an unanswered number is not greater');
  assert.equal(isVisible(q('lte', 10), { n: 10 }), true);
  assert.equal(isVisible({ show_if: { key: 'n', op: 'answered' } }, { n: '' }), false);
  const byKey = new Map([['a', { key: 'a', show_if: { key: 'z', op: 'eq', value: 1 } }]]);
  assert.equal(isVisible({ show_if: { key: 'a', op: 'answered' } }, { a: 'yes', z: 2 }, byKey), false);
});

test('answers: unknown keys and hidden questions dropped, wrong kinds refused, never coerced', () => {
  const def = checkDefinition(example()).definition;
  const { values, errors } = checkAnswers(def, {
    legal_name: '  Example Industries ', employee_count: '450', turnover: '1,20,00,000', standards: ['iso_9001', 'iso_9001'],
    previously_certified: false, certifying_body: 'Hidden Body', sites: [{ city: 'Pune', employees: 320, shifts: 'two' }, {}],
    audit_month: '2026-11-01', stray: 'x', note: 'not an answer',
  });
  assert.deepEqual(errors, {});
  assert.deepEqual(values, {
    legal_name: 'Example Industries', employee_count: 450, turnover: 12000000, standards: ['iso_9001'],
    previously_certified: false, sites: [{ city: 'Pune', employees: 320, shifts: 'two' }], audit_month: '2026-11-01',
  });
  const bad = checkAnswers(def, {
    employee_count: 4.5, standards: ['iso_27001'], previously_certified: 'yes', audit_month: '31/12/2026',
    sites: [{ city: 'Pune', shifts: 'three' }], org_chart: ['abc'],
  });
  assert.deepEqual(Object.keys(bad.errors).sort(), ['audit_month', 'employee_count', 'org_chart', 'previously_certified', 'sites.0.shifts', 'standards']);
  assert.equal(checkAnswers(def, { employee_count: 0 }).errors.employee_count, 'At least 1');
});

test('on submit every visible required question is answered, inside tables too', () => {
  const def = checkDefinition(example()).definition;
  const partial = checkAnswers(def, { legal_name: 'Example Industries' });
  assert.deepEqual(partial.errors, {}, 'saving as you go needs nothing');
  const submit = checkAnswers(def, { legal_name: 'Example Industries', previously_certified: true, sites: [{ employees: 3 }] }, { submit: true });
  assert.deepEqual(Object.keys(submit.errors).sort(), ['certifying_body', 'employee_count', 'sites.0.city', 'standards']);
  const done = checkAnswers(def, {
    legal_name: 'Example Industries', employee_count: 12, standards: ['iso_14001'], previously_certified: false, sites: [{ city: 'Chennai' }],
  }, { submit: true });
  assert.deepEqual(done.errors, {});
});

test('prefill from the company and contact, and what the client changed offered back, never written', () => {
  const def = checkDefinition(example()).definition;
  const company = { name: 'Example Industries', gstin: '27AAAAA0000A1Z5' };
  assert.deepEqual(prefillAnswers(def, { company }), { legal_name: 'Example Industries', gstin: '27AAAAA0000A1Z5' });
  const diff = prefillDifferences(def, { legal_name: 'Example Industries', gstin: '27BBBBB0000B1Z5' }, { company });
  assert.deepEqual(diff.map((d) => [d.key, d.was, d.now]), [['gstin', '27AAAAA0000A1Z5', '27BBBBB0000B1Z5']]);
});
