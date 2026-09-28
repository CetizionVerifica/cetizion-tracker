import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RULES, rulesSchema, sanitizeRules, buildPlan } from '../src/import/rules.js';

// The rule overrides a request may send to the importer.

test('the defaults and an empty override both pass', () => {
  assert.equal(rulesSchema.safeParse(DEFAULT_RULES).success, true);
  assert.equal(rulesSchema.safeParse({}).success, true);
});

test('a sensible override passes unchanged', () => {
  const parsed = rulesSchema.safeParse({ default_split: [30, 70], invoice_prefix: 'CVPL', default_currency: 'USD' });
  assert.deepEqual(parsed.data, { default_split: [30, 70], invoice_prefix: 'CVPL', default_currency: 'USD' });
});

// A number sent as text ("7") is accepted and read as 7: the settings arrive
// from a form, where every value is text.
test('a number sent as text is read as a number', () => {
  assert.equal(rulesSchema.parse({ po_date_offset_days: '7' }).po_date_offset_days, 7);
});

test('bad values are refused', () => {
  for (const bad of [
    { default_split: [60, 60] },            // does not add up to 100
    { default_split: [0, 100] },            // no advance stage
    { po_date_offset_days: -3 },
    { delivery_offset_months: 1.5 },
    { default_currency: 'rupees' },
    { invoice_prefix: '.*' },               // would change the RegExp
    { exclude_iso: 'yes' },
    { overwrite_existng: true },            // a typo, not a rule
  ]) {
    assert.equal(rulesSchema.safeParse(bad).success, false, JSON.stringify(bad));
  }
});

// Rules already stored on a batch, read back when it is re-planned. These
// predate the schema, so they are judged value by value rather than refused
// whole — an old draft must still be re-plannable.

test('stored rules that are all valid come back untouched', () => {
  assert.deepEqual(sanitizeRules(DEFAULT_RULES), { rules: DEFAULT_RULES, dropped: [] });
  assert.deepEqual(sanitizeRules({ default_split: [30, 70] }), { rules: { default_split: [30, 70] }, dropped: [] });
});

test('a stored value that is no longer allowed is dropped, and the good ones stay', () => {
  const { rules, dropped } = sanitizeRules({
    default_split: [60, 60],        // never added up to 100
    po_date_offset_days: -3,        // would run date arithmetic backwards
    invoice_prefix: '.*',           // would change the invoice-number RegExp
    default_currency: 'USD',        // fine
    exclude_iso: true,              // fine
  });
  assert.deepEqual(rules, { default_currency: 'USD', exclude_iso: true });
  assert.deepEqual(dropped.sort(), ['default_split', 'invoice_prefix', 'po_date_offset_days']);
});

test('a stored key the importer no longer knows is dropped rather than passed on', () => {
  const { rules, dropped } = sanitizeRules({ legacy_mode: 'v1', overwrite_existing: true });
  assert.deepEqual(rules, { overwrite_existing: true });
  assert.deepEqual(dropped, ['legacy_mode']);
});

test('rubbish in place of rules gives the defaults, not a crash', () => {
  for (const junk of [null, undefined, 'rules', 42, []]) {
    assert.deepEqual(sanitizeRules(junk), { rules: {}, dropped: [] }, JSON.stringify(junk));
  }
});

test('a dropped value falls back to its default when the plan is built', () => {
  const mapping = { client: 'Client', stage: 'Stage', service: 'Service', po_number: 'PO', po_amount: 'PO Amount' };
  const rows = [{ __row: 2, Client: 'Hetero', Stage: 'Won - PO Received', Service: 'ASI audit', PO: 'PO-1', 'PO Amount': 100000 }];
  const live = { quotations: [], purchase_orders: [], projects: [], services: [], stages: [], next_quotation_no: 1, next_project_no: 1, year: 2026 };
  const { rules } = sanitizeRules({ default_split: [60, 60] });   // unusable, so dropped
  const plan = buildPlan({ rows, mapping, live, rules });
  assert.deepEqual(
    plan.items.filter((it) => it.step === 'stage').map((it) => Math.round(it.payload.stage_percent * 100)),
    [50, 50]                                                      // DEFAULT_RULES.default_split
  );
});
