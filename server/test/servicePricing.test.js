import assert from 'node:assert/strict';
import test from 'node:test';
import { priceLines, validatePricing } from '../src/lib/serviceQuotes/pricing.js';

/**
 * A questionnaire version's pricing rules (#208 phase 2): the check an
 * admin's rules must pass, and the lines a set of answers produces. The
 * form and the rates are made up (an ISO certification form of the usual
 * shape), not the business's own rate card.
 */
const definition = () => ({
  steps: [
    {
      key: 'organisation', title: 'Your organisation', questions: [
        { key: 'legal_name', type: 'text', label: 'Legal name' },
        { key: 'employee_count', type: 'number', label: 'Employees in scope', integer: true, min: 1 },
        { key: 'turnover', type: 'money', label: 'Annual turnover', currency: 'INR' },
      ],
    },
    {
      key: 'scope', title: 'Scope', questions: [
        { key: 'standards', type: 'multiselect', label: 'Standards', options: [{ key: 'iso_9001', label: 'ISO 9001' }, { key: 'iso_14001', label: 'ISO 14001' }, { key: 'iso_45001', label: 'ISO 45001' }] },
        { key: 'previously_certified', type: 'yesno', label: 'Certified before?' },
        { key: 'outside_pune', type: 'yesno', label: 'Any site outside Pune?' },
        { key: 'travel_sites', type: 'number', label: 'Sites outside Pune', show_if: { key: 'outside_pune', op: 'eq', value: true } },
        { key: 'sites', type: 'table', label: 'Sites', columns: [
          { key: 'city', type: 'text', label: 'City' },
          { key: 'employees', type: 'number', label: 'Employees' },
        ] },
        { key: 'org_chart', type: 'file', label: 'Organisation chart' },
        { key: 'audit_type', type: 'select', label: 'Audit', options: [{ key: 'initial', label: 'Initial' }, { key: 'surveillance', label: 'Surveillance' }] },
        { key: 'audit_month', type: 'date', label: 'Preferred audit month' },
        // A key that is also a property every JavaScript object inherits.
        { key: 'constructor', type: 'multiselect', label: 'Add-ons', options: [{ key: 'gap_review', label: 'Gap review' }] },
      ],
    },
  ],
});

const service = { default_rate: '25000.00', unit: 'engagement', gst_rate: '18.00', sac_code: '998311' };
const MAN_DAYS = [[1, 45, 3], [46, 125, 5], [126, 425, 7], [426, 1000, 9]];

/** One line under test, priced against answers. */
const price = (pricingLine, answers, svc = service) =>
  priceLines({ definition: definition(), pricing: { lines: [{ key: 'line', description: 'A line', ...pricingLine }] } }, answers, svc);

// ── validatePricing ─────────────────────────────────────────────────────

test('well-formed rules have no problems, and empty pricing is fine', () => {
  const pricing = { lines: [{
    key: 'stage1_audit', description: 'Stage 1 audit',
    include_if: { key: 'previously_certified', op: 'eq', value: false },
    qty: { band: { of: { answer: 'employee_count' }, bands: MAN_DAYS } },
    rate: { catalogue: true },
    multiply: [{ count: 'standards' }, { rows: 'sites' }],
    unit: 'man-day',
  }] };
  assert.deepEqual(validatePricing(pricing, definition()), []);
  assert.deepEqual(validatePricing({ lines: [] }, definition()), []);
  assert.deepEqual(validatePricing(null, definition()), []);
});

test('a block outside the vocabulary is refused, so no rule can run code', () => {
  for (const rate of [{ eval: '1+1' }, { function: 'return 1' }, { fixed: '25000' }, { fixed: 1, answer: 'employee_count' }]) {
    const problems = validatePricing({ lines: [{ key: 'x', description: 'X', rate }] }, definition());
    assert.equal(problems.length > 0, true, JSON.stringify(rate));
    assert.match(problems[0], /^lines\.0\.rate/);
  }
  assert.notDeepEqual(validatePricing({ lines: [{ key: 'x', description: 'X', rate: { fixed: 1 }, extra: true }] }, definition()), []);
  assert.notDeepEqual(validatePricing({ lines: [{ key: 'Bad Key', description: 'X', rate: { fixed: 1 } }] }, definition()), []);
});

test('a key the definition does not have is named', () => {
  const problems = validatePricing({ lines: [{ key: 'x', description: 'X', rate: { fixed: 1 }, qty: { answer: 'headcount' } }] }, definition());
  assert.deepEqual(problems, ['Line 1 (x), quantity: "headcount" is not a question in this version']);
});

test('each reference needs a question of a compatible type', () => {
  const problems = (v) => validatePricing({ lines: [{ key: 'x', description: 'X', rate: v }] }, definition());
  assert.deepEqual(problems({ answer: 'turnover' }), []);
  assert.match(problems({ answer: 'legal_name' })[0], /text question; a quantity or rate needs a number or money answer/);
  assert.match(problems({ answer: 'standards' })[0], /multiselect question/);
  assert.match(problems({ count: 'employee_count' })[0], /counting needs a multi-select or checkbox question/);
  assert.match(problems({ rows: 'standards' })[0], /counting rows needs a table question/);
  assert.deepEqual(problems({ sum: { table: 'sites', column: 'employees' } }), []);
  assert.match(problems({ sum: { table: 'sites', column: 'city' } })[0], /column "city" of "sites" is text/);
  assert.match(problems({ sum: { table: 'sites', column: 'floors' } })[0], /the table "sites" has no column "floors"/);
  assert.match(problems({ sum: { table: 'employee_count', column: 'x' } })[0], /adding up a column needs a table question/);
  // Inside other blocks too.
  assert.match(problems({ multiply: [{ fixed: 2 }, { band: { of: { answer: 'legal_name' }, bands: [[0, 1, 1]] } }] })[0], /text question/);
});

test('bands must run upwards and must not share a number', () => {
  const problems = (bands) => validatePricing({ lines: [{ key: 'x', description: 'X', rate: { fixed: 1 }, qty: { band: { of: { answer: 'employee_count' }, bands } } }] }, definition());
  assert.deepEqual(problems(MAN_DAYS), []);
  assert.deepEqual(problems([[1, 45, 3], [45, 125, 5]]), ['Line 1 (x), quantity: bands 1 and 2 overlap']);
  assert.deepEqual(problems([[46, 125, 5], [1, 50, 3]]), ['Line 1 (x), quantity: bands 2 and 1 overlap']);
  assert.deepEqual(problems([[125, 46, 5]]), ['Line 1 (x), quantity: band 1 starts above where it ends']);
});

test('include-when follows the show-if rules', () => {
  const problems = (include_if) => validatePricing({ lines: [{ key: 'x', description: 'X', rate: { fixed: 1 }, include_if }] }, definition());
  assert.deepEqual(problems({ key: 'previously_certified', op: 'eq', value: true }), []);
  assert.match(problems({ key: 'nope', op: 'eq', value: true })[0], /"nope", which is not a question/);
  assert.match(problems({ key: 'sites', op: 'answered' })[0], /cannot depend on a table question/);
  assert.match(problems({ key: 'org_chart', op: 'answered' })[0], /cannot depend on a file question/);
  assert.match(problems({ key: 'standards', op: 'in', value: 'iso_9001' })[0], /needs a list of values/);
  assert.match(problems({ key: 'employee_count', op: 'gt' })[0], /needs a value to compare with/);
});

test('include-when values must fit the question they compare with, or the line would silently never appear', () => {
  const problems = (include_if) => validatePricing({ lines: [{ key: 'x', description: 'X', rate: { fixed: 1 }, include_if }] }, definition());
  // yes/no: true or false, and only equal or not equal
  assert.deepEqual(problems({ key: 'previously_certified', op: 'eq', value: true }), []);
  assert.deepEqual(problems({ key: 'previously_certified', op: 'eq', value: 'no' }), ['Line 1 (x): "include when" on "previously_certified" needs true or false']);
  assert.deepEqual(problems({ key: 'previously_certified', op: 'gt', value: 0 }), ['Line 1 (x): "include when" on a yesno question cannot use "gt"']);
  // number and money: a number; the only kinds "greater than" and the like work on
  assert.deepEqual(problems({ key: 'employee_count', op: 'gt', value: 250 }), []);
  assert.deepEqual(problems({ key: 'turnover', op: 'lte', value: 1e8 }), []);
  assert.deepEqual(problems({ key: 'employee_count', op: 'in', value: [100, 200] }), []);
  assert.deepEqual(problems({ key: 'employee_count', op: 'eq', value: '5' }), ['Line 1 (x): "include when" on "employee_count" needs a number']);
  assert.deepEqual(problems({ key: 'employee_count', op: 'in', value: [100, 'many'] }), ['Line 1 (x): "include when" on "employee_count" needs a number']);
  // choices: one of the question's own options
  assert.deepEqual(problems({ key: 'audit_type', op: 'eq', value: 'initial' }), []);
  assert.deepEqual(problems({ key: 'audit_type', op: 'eq', value: 'recertification' }), ['Line 1 (x): "recertification" is not an option of "audit_type"']);
  assert.deepEqual(problems({ key: 'audit_type', op: 'in', value: ['initial', 'nope'] }), ['Line 1 (x): "nope" is not an option of "audit_type"']);
  assert.deepEqual(problems({ key: 'audit_type', op: 'gt', value: 'initial' }), ['Line 1 (x): "include when" on a select question cannot use "gt"']);
  assert.deepEqual(problems({ key: 'standards', op: 'eq', value: 'iso_9001' }), []);
  assert.deepEqual(problems({ key: 'standards', op: 'eq', value: 'iso_27001' }), ['Line 1 (x): "iso_27001" is not an option of "standards"']);
  // text and dates: text; a date is never "greater than" (isVisible compares numbers)
  assert.deepEqual(problems({ key: 'legal_name', op: 'eq', value: 'Example Industries' }), []);
  assert.deepEqual(problems({ key: 'legal_name', op: 'eq', value: 5 }), ['Line 1 (x): "include when" on "legal_name" needs text']);
  assert.deepEqual(problems({ key: 'audit_month', op: 'eq', value: '2026-11-01' }), []);
  assert.deepEqual(problems({ key: 'audit_month', op: 'gt', value: '2026-11-01' }), ['Line 1 (x): "include when" on a date question cannot use "gt"']);
  // "answered" works on any question that can be compared, with no value
  for (const k of ['previously_certified', 'employee_count', 'audit_type', 'standards', 'legal_name', 'audit_month']) {
    assert.deepEqual(problems({ key: k, op: 'answered' }), [], k);
  }
  // one value, or a list only with "is one of"
  assert.deepEqual(problems({ key: 'audit_type', op: 'eq', value: ['initial'] }), ['Line 1 (x): "include when" compares with one value; use "is one of" for a list']);
});

test('two lines with one key, and a rule nested too deep, are named', () => {
  const twice = validatePricing({ lines: [
    { key: 'audit', description: 'A', rate: { fixed: 1 } },
    { key: 'audit', description: 'B', rate: { fixed: 1 } },
  ] }, definition());
  assert.deepEqual(twice, ['Line 2 (audit): the key "audit" is used twice']);

  let deep = { fixed: 1 };
  for (let i = 0; i < 6; i++) deep = { round_up: deep };
  assert.match(validatePricing({ lines: [{ key: 'x', description: 'X', rate: deep }] }, definition())[0], /nested more than 6 deep/);
});

// ── priceLines: the vocabulary ──────────────────────────────────────────

const answers = () => ({
  employee_count: 300,
  turnover: 50000000,
  standards: ['iso_9001', 'iso_14001'],
  previously_certified: false,
  outside_pune: false,
  sites: [{ city: 'Pune', employees: 220 }, { city: 'Chennai', employees: 80 }],
});

const qtyOf = (qty) => price({ qty, rate: { fixed: 1 } }, answers())[0].qty;

test('each vocabulary item works out as named', () => {
  assert.equal(qtyOf({ fixed: 4 }), 4);
  assert.equal(qtyOf({ answer: 'employee_count' }), 300);
  assert.equal(qtyOf({ count: 'standards' }), 2);
  assert.equal(qtyOf({ rows: 'sites' }), 2);
  assert.equal(qtyOf({ sum: { table: 'sites', column: 'employees' } }), 300);
  assert.equal(qtyOf({ band: { of: { answer: 'employee_count' }, bands: MAN_DAYS } }), 7);
  assert.equal(qtyOf({ multiply: [{ fixed: 3 }, { count: 'standards' }] }), 6);
  assert.equal(qtyOf({ add: [{ fixed: 1 }, { rows: 'sites' }] }), 3);
  assert.equal(qtyOf({ min: [{ fixed: 5 }, { rows: 'sites' }] }), 2);
  assert.equal(qtyOf({ max: [{ fixed: 5 }, { rows: 'sites' }] }), 5);
  assert.equal(qtyOf({ round_up: { multiply: [{ answer: 'employee_count' }, { fixed: 0.011 }] } }), 4);
  assert.equal(price({ rate: { catalogue: true } }, answers())[0].rate, 25000);
});

test('the quantity defaults to 1, multipliers apply to it, and it rounds up to 2 decimals', () => {
  const qty = (n) => price({ qty: { fixed: n }, rate: { fixed: 100 } }, answers())[0].qty;
  assert.equal(price({ rate: { fixed: 100 } }, answers())[0].qty, 1);
  assert.equal(price({ rate: { fixed: 100 }, multiply: [{ count: 'standards' }, { rows: 'sites' }] }, answers())[0].qty, 4);
  assert.equal(qty(1 / 3), 0.34, 'up, never down');
  assert.equal(qty(2.001), 2.01);
  assert.equal(qty(0.1 * 3), 0.3, 'floating-point noise is not rounded up');
  assert.equal(qty(2.5), 2.5);
});

test('bands are inclusive at both ends', () => {
  const at = (n) => price({ qty: { band: { of: { answer: 'employee_count' }, bands: MAN_DAYS } }, rate: { fixed: 1 } }, { ...answers(), employee_count: n })[0];
  assert.equal(at(1).qty, 3);
  assert.equal(at(45).qty, 3);
  assert.equal(at(46).qty, 5);
  assert.equal(at(125).qty, 5);
  assert.equal(at(126).qty, 7);
  assert.equal(at(1000).qty, 9);
});

test('unit, GST and SAC come from the service unless the line names them', () => {
  const [fromService] = price({ rate: { fixed: 1 } }, answers());
  assert.equal(fromService.unit, 'engagement');
  assert.equal(fromService.gst_rate, 18);
  assert.equal(fromService.sac_code, '998311');
  const [own] = price({ rate: { fixed: 1 }, unit: 'man-day', gst_rate: 0, sac_code: '998312' }, answers());
  assert.equal(own.unit, 'man-day');
  assert.equal(own.gst_rate, 0);
  assert.equal(own.sac_code, '998312');
});

// ── priceLines: never a guess ───────────────────────────────────────────

const needed = (line) => {
  assert.equal(line.price_needed, true);
  assert.equal(line.qty, 1);
  assert.equal(line.rate, 0);
  return line.why;
};

test('a value outside every band needs a price, and says which answer', () => {
  const [line] = price({ qty: { band: { of: { answer: 'employee_count' }, bands: MAN_DAYS } }, rate: { fixed: 1 } }, { ...answers(), employee_count: 2000 });
  assert.equal(needed(line), '"employee_count" is 2000, outside every band');
});

test('a missing answer needs a price, and says which answer', () => {
  const { employee_count, standards, sites, ...rest } = answers();
  assert.equal(needed(price({ qty: { answer: 'employee_count' }, rate: { fixed: 1 } }, rest)[0]), '"employee_count" is not answered');
  assert.equal(needed(price({ qty: { count: 'standards' }, rate: { fixed: 1 } }, rest)[0]), '"standards" is not answered');
  assert.equal(needed(price({ qty: { rows: 'sites' }, rate: { fixed: 1 } }, rest)[0]), '"sites" has no rows');
  assert.equal(needed(price({ rate: { fixed: 1 }, multiply: [{ rows: 'sites' }] }, rest)[0]), '"sites" has no rows');
  const gap = { ...answers(), sites: [{ city: 'Pune', employees: 220 }, { city: 'Chennai' }] };
  assert.equal(needed(price({ qty: { sum: { table: 'sites', column: 'employees' } }, rate: { fixed: 1 } }, gap)[0]), '"employees" is missing in row 2 of "sites"');
});

test('a catalogue rate needs a price when the service has none', () => {
  for (const default_rate of [null, undefined, '0', 0]) {
    assert.equal(needed(price({ rate: { catalogue: true } }, answers(), { ...service, default_rate })[0]), 'the service has no default rate in the catalogue');
  }
});

test('a quantity of zero or a negative rate needs a price', () => {
  assert.match(needed(price({ qty: { fixed: 0 }, rate: { fixed: 1 } }, answers())[0]), /quantity came to 0/);
  assert.match(needed(price({ rate: { fixed: -5 } }, answers())[0]), /rate came to -5/);
});

test('a quantity, rate or amount a quotation line cannot hold needs a price, never a priced line', () => {
  // quotation_lines: qty numeric(12,2), rate numeric(16,2), amount numeric(16,2) = qty × rate.
  const line = (qty, rate) => price({ qty, rate }, answers())[0];
  const { employee_count, ...rest } = answers();
  const huge = (n) => price({ qty: { answer: 'employee_count' }, rate: { fixed: 1 } }, { ...rest, employee_count: n })[0];

  // A client's answer: number questions need not have a maximum.
  assert.match(needed(huge(1e300)), /the quantity came to 1\.00e\+300, more than a quotation line can hold/);
  assert.match(needed(price({ qty: { answer: 'employee_count' }, multiply: [{ answer: 'employee_count' }], rate: { fixed: 1 } }, { ...rest, employee_count: 1e200 })[0]),
    /the quantity could not be worked out/);
  assert.match(needed(price({ rate: { multiply: [{ fixed: 1e200 }, { fixed: 1e200 }] } }, answers())[0]), /the rate could not be worked out/);

  // The column limits exactly, and just past them.
  assert.equal(line({ fixed: 9_999_999_999.99 }, { fixed: 1 }).price_needed, false);
  assert.match(needed(line({ fixed: 10_000_000_000 }, { fixed: 1 })), /quantity came to 10,00,00,00,000, more than a quotation line can hold \(9,99,99,99,999\.99\)/);
  assert.equal(line({ fixed: 1 }, { fixed: 99_999_999_999_999.99 }).price_needed, false);
  assert.match(needed(line({ fixed: 1 }, { fixed: 1e14 })), /the rate came to .*, more than a quotation line can hold \(9,99,99,99,99,99,999\.99\)$/);
  assert.equal(line({ fixed: 1000 }, { fixed: 99_999_999_999.99 }).price_needed, false, 'amount 99,999,999,999,990: fits');
  assert.match(needed(line({ fixed: 1e9 }, { fixed: 1e6 })), /the amount came to .*, more than a quotation line can hold \(9,99,99,99,99,99,999\.99\)$/,
    'the limit as the column holds it, not 1 paisa short as a JavaScript number reads it');
});

// ── priceLines: which lines appear ──────────────────────────────────────

test('a line is left out when its include-when is false', () => {
  const line = { include_if: { key: 'previously_certified', op: 'eq', value: false }, rate: { fixed: 1 } };
  assert.equal(price(line, answers()).length, 1);
  assert.equal(price(line, { ...answers(), previously_certified: true }).length, 0);
});

test('a line that reads a question hidden by show-if is left out', () => {
  const travel = { qty: { answer: 'travel_sites' }, rate: { fixed: 8000 } };
  // Hidden: every site is in Pune, so the travel question never showed.
  assert.deepEqual(price(travel, answers()), []);
  // Shown but left blank: that is a gap to price, not a line to drop.
  assert.equal(needed(price(travel, { ...answers(), outside_pune: true })[0]), '"travel_sites" is not answered');
  assert.equal(price(travel, { ...answers(), outside_pune: true, travel_sites: 2 })[0].qty, 2);
});

test('only the client\'s own answers are read, so a question keyed "constructor" is not answered until it is', () => {
  const count = { qty: { count: 'constructor' }, rate: { fixed: 1 } };
  assert.equal(needed(price(count, answers())[0]), '"constructor" is not answered');
  assert.equal(price(count, { ...answers(), constructor: ['gap_review'] })[0].qty, 1);
  const included = { include_if: { key: 'constructor', op: 'answered' }, rate: { fixed: 1 } };
  assert.deepEqual(price(included, answers()), []);
  assert.equal(price(included, { ...answers(), constructor: ['gap_review'] }).length, 1);
  // A count over something that is not a list of choices is a gap, not one choice.
  assert.equal(needed(price({ qty: { count: 'standards' }, rate: { fixed: 1 } }, { ...answers(), standards: 'iso_9001' })[0]), '"standards" is not a list of choices');
});

test('include-when on a question hidden by show-if leaves the line out', () => {
  const travel = { include_if: { key: 'travel_sites', op: 'gt', value: 0 }, rate: { fixed: 8000 } };
  assert.deepEqual(price(travel, { ...answers(), outside_pune: false, travel_sites: 3 }), [], 'hidden: its answer does not count');
  assert.equal(price(travel, { ...answers(), outside_pune: true, travel_sites: 3 }).length, 1);
  assert.deepEqual(price(travel, { ...answers(), outside_pune: true, travel_sites: 0 }), []);
});

test('a value missing deep inside add or min still names the answer', () => {
  const { employee_count, sites, ...rest } = answers();
  assert.equal(needed(price({ qty: { add: [{ fixed: 1 }, { answer: 'employee_count' }] }, rate: { fixed: 1 } }, rest)[0]), '"employee_count" is not answered');
  assert.equal(needed(price({ qty: { min: [{ fixed: 5 }, { rows: 'sites' }] }, rate: { fixed: 1 } }, rest)[0]), '"sites" has no rows');
  assert.equal(needed(price({ qty: { round_up: { multiply: [{ fixed: 2 }, { max: [{ fixed: 1 }, { answer: 'employee_count' }] }] } }, rate: { fixed: 1 } }, rest)[0]),
    '"employee_count" is not answered');
});

test('a band can look up a computed value', () => {
  const band = (of, a = answers()) => price({ qty: { band: { of, bands: MAN_DAYS } }, rate: { fixed: 1 } }, a)[0];
  assert.equal(band({ sum: { table: 'sites', column: 'employees' } }).qty, 7, '220 + 80 employees');
  assert.equal(band({ multiply: [{ rows: 'sites' }, { fixed: 100 }] }).qty, 7, '2 sites × 100');
  assert.equal(needed(band({ add: [{ answer: 'employee_count' }, { fixed: 1700 }] })), 'the value is 2000, outside every band');
  assert.equal(needed(band({ sum: { table: 'sites', column: 'employees' } }, { ...answers(), sites: [{ city: 'Pune', employees: 2000 }] })),
    'the total "employees" in "sites" is 2000, outside every band');
});

test('include-when: greater than, is one of, and answered', () => {
  const when = (include_if, a) => price({ include_if, rate: { fixed: 1 } }, a).length === 1;
  const gt = { key: 'employee_count', op: 'gt', value: 250 };
  assert.equal(when(gt, answers()), true, '300 > 250');
  assert.equal(when(gt, { ...answers(), employee_count: 250 }), false, 'greater than, not equal');
  const oneOf = { key: 'standards', op: 'in', value: ['iso_45001'] };
  assert.equal(when(oneOf, answers()), false);
  assert.equal(when(oneOf, { ...answers(), standards: ['iso_9001', 'iso_45001'] }), true);
  const typeIn = { key: 'audit_type', op: 'in', value: ['initial', 'surveillance'] };
  assert.equal(when(typeIn, { ...answers(), audit_type: 'surveillance' }), true);
  const answered = { key: 'turnover', op: 'answered' };
  assert.equal(when(answered, answers()), true);
  const { turnover, ...rest } = answers();
  assert.equal(when(answered, rest), false);
});

test('a rate factor converts every rate, the catalogue\'s and the rules\' alike, and leaves quantities alone', () => {
  const pricing = { lines: [
    { key: 'audit', description: 'Audit', qty: { fixed: 5 }, rate: { catalogue: true } },
    { key: 'report', description: 'Report', rate: { fixed: 15000 } },
    { key: 'band', description: 'Band', rate: { band: { of: { answer: 'employee_count' }, bands: [[1, 1000, 8350]] } } },
  ] };
  const lines = priceLines({ definition: definition(), pricing }, answers(), service, { rateFactor: 1 / 83.5 });
  assert.deepEqual(lines.map((l) => [l.rule_key, l.qty, l.rate, l.price_needed]), [
    ['audit', 5, 299.4, false],     // 25,000 / 83.5 = 299.401…
    ['report', 1, 179.64, false],   // 15,000 / 83.5 = 179.640…
    ['band', 1, 100, false],        //  8,350 / 83.5 = 100
  ]);
  // The other way: a factor above 1.
  assert.equal(price({ rate: { fixed: 300 } }, answers(), service)[0].rate, 300);
  assert.equal(priceLines({ definition: definition(), pricing: { lines: [{ key: 'x', description: 'X', rate: { fixed: 300 } }] } }, answers(), service, { rateFactor: 83.5 })[0].rate, 25050);
});

test('the line limits apply to the converted rate', () => {
  const pricing = { lines: [{ key: 'x', description: 'X', rate: { fixed: 2e12 } }] };
  assert.equal(priceLines({ definition: definition(), pricing }, answers(), service)[0].price_needed, false, 'fits before conversion');
  const [converted] = priceLines({ definition: definition(), pricing }, answers(), service, { rateFactor: 100 });
  assert.match(needed(converted), /the rate came to .*, more than a quotation line can hold/);
});

test('with no exchange rate, every line that would have been priced needs a price, with the reason given', () => {
  const pricing = { lines: [
    { key: 'audit', description: 'Audit', rate: { catalogue: true } },
    { key: 'travel', description: 'Travel', qty: { answer: 'travel_sites' }, rate: { fixed: 8000 } },
  ] };
  const reason = 'no exchange rate for GBP on or before 22 Oct 2026 to convert the INR rate card into GBP';
  const lines = priceLines({ definition: definition(), pricing }, { ...answers(), outside_pune: true }, service, { rateUnavailable: reason });
  assert.equal(needed(lines[0]), reason);
  assert.equal(needed(lines[1]), '"travel_sites" is not answered', 'a line already short of an answer keeps its own reason');
});

test('an exchange factor that is not a positive number is refused rather than used', () => {
  for (const rateFactor of [0, -1, NaN, Infinity]) {
    assert.throws(() => priceLines({ definition: definition(), pricing: { lines: [] } }, answers(), service, { rateFactor }), /exchange factor/, String(rateFactor));
  }
});

test('lines come back in sort order, then rule order', () => {
  const pricing = { lines: [
    { key: 'a', description: 'A', rate: { fixed: 1 } },
    { key: 'b', description: 'B', rate: { fixed: 1 }, sort_order: -1 },
    { key: 'c', description: 'C', rate: { fixed: 1 } },
  ] };
  assert.deepEqual(priceLines({ definition: definition(), pricing }, answers(), service).map((l) => l.rule_key), ['b', 'a', 'c']);
});

test('a worked example: the usual ISO quotation', () => {
  const pricing = { lines: [
    { key: 'stage1_audit', description: 'Stage 1 audit', include_if: { key: 'previously_certified', op: 'eq', value: false },
      qty: { band: { of: { answer: 'employee_count' }, bands: MAN_DAYS } }, rate: { catalogue: true },
      multiply: [{ count: 'standards' }, { rows: 'sites' }], unit: 'man-day', sort_order: 10 },
    { key: 'travel', description: 'Travel outside Pune', qty: { answer: 'travel_sites' }, rate: { fixed: 8000 }, unit: 'site', sort_order: 20 },
    { key: 'report', description: 'Audit report', rate: { fixed: 15000 }, sort_order: 30 },
  ] };
  const lines = priceLines({ definition: definition(), pricing }, { ...answers(), outside_pune: true, travel_sites: 1 }, service);
  assert.deepEqual(lines.map(({ rule_key, qty, rate, unit, price_needed }) => ({ rule_key, qty, rate, unit, price_needed })), [
    { rule_key: 'stage1_audit', qty: 28, rate: 25000, unit: 'man-day', price_needed: false },
    { rule_key: 'travel', qty: 1, rate: 8000, unit: 'site', price_needed: false },
    { rule_key: 'report', qty: 1, rate: 15000, unit: 'engagement', price_needed: false },
  ]);
  assert.equal(lines.reduce((t, l) => t + l.qty * l.rate, 0), 723000);
});

test('rules that are not valid are refused rather than priced', () => {
  assert.throws(() => priceLines({ definition: definition(), pricing: { lines: [{ key: 'x', description: 'X', rate: { eval: '1' } }] } }, answers(), service), /not valid/);
});
