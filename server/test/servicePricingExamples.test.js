import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { checkAnswers } from '../src/lib/questionnaireDefinition.js';
import { priceLines, validatePricing } from '../src/lib/serviceQuotes/pricing.js';

/**
 * Worked examples for the first two services' pricing (#208 Step 2D, #239):
 * the proposed lines (docs/issue-208-phase-2.md §4) run against the real
 * ISO audits and Ecovadis questionnaires, with made-up clients, answers
 * worked through by hand.
 *
 * EVERY NUMBER HERE IS AN EXAMPLE, not Cetizion's price. The audit-day
 * bands and the ₹25,000 day rate are issue #208's own illustration; the
 * issue's ₹8,000 is for travel to sites outside Pune, which these forms
 * cannot tell apart (a site's address is free text), so the per-site line
 * here charges every site, at an invented 8,000. The transfer review and
 * Ecovadis fees are invented too. The real figures are
 * entered by an admin on the Pricing tab and in Settings › Service
 * offerings (the day rate), and change there without code. What these tests
 * pin is the shape: which answer each line reads, when it is included, and
 * that anything unpriced comes out Price needed rather than as a guess.
 */
const load = (name) => JSON.parse(readFileSync(new URL(`../../docs/questionnaires/${name}.json`, import.meta.url), 'utf8'));
const ISO = load('iso-audits');
const ECOVADIS = load('ecovadis');

const ISO_PRICING = { lines: [
  { key: 'certification_audit', description: 'Certification audit (Stage 1 and Stage 2)', unit: 'day',
    qty: { band: { of: { answer: 'employee_count' }, bands: [[1, 45, 3], [46, 125, 5], [126, 425, 7], [426, 1000, 9]] } },
    rate: { catalogue: true } },
  { key: 'site_visits', description: 'Site visits and travel', unit: 'site', qty: { rows: 'sites' }, rate: { fixed: 8000 } },
  { key: 'transfer_review', description: 'Transfer review of the current certificate', unit: 'review', include_if: { key: 'application_type', op: 'eq', value: 'transfer' }, rate: { fixed: 15000 } },
] };
const ECOVADIS_PRICING = { lines: [
  { key: 'ecovadis_support', description: 'EcoVadis assessment support',
    rate: { band: { of: { add: [{ answer: 'permanent_male' }, { answer: 'permanent_female' }, { answer: 'contractor_male' }, { answer: 'contractor_female' }] },
      bands: [[1, 250, 350000], [251, 1000, 450000], [1001, 100000, 600000]] } } },
  { key: 'facility_data', description: 'Data collection, per facility', unit: 'facility', qty: { rows: 'facilities' }, rate: { fixed: 25000 } },
] };
const ISO_SERVICE = { default_rate: 25000, unit: 'day', gst_rate: 18 };   // the day rate, as Settings › Service offerings would hold it
const ECOVADIS_SERVICE = { default_rate: null, unit: 'engagement', gst_rate: 18 };

const price = (definition, pricing, answers, service) => {
  const { values, errors } = checkAnswers(definition, answers);
  assert.deepEqual(errors, {}, 'the made-up answers are ones the form accepts');
  const lines = priceLines({ definition, pricing }, values, service);
  // Before GST, as Preview pricing shows it; the quotation adds GST per line.
  return { lines, subtotal: lines.reduce((t, l) => t + l.qty * l.rate, 0), byKey: Object.fromEntries(lines.map((l) => [l.rule_key, l])) };
};

test('the proposed rules are ones the builder accepts for these two forms', () => {
  assert.deepEqual(validatePricing(ISO_PRICING, ISO), []);
  assert.deepEqual(validatePricing(ECOVADIS_PRICING, ECOVADIS), []);
});

test('ISO, a transfer: 120 employees on two sites', () => {
  // 120 employees is in 46–125: 5 days × 25,000 = 125,000; 2 sites × 8,000 = 16,000; transfer review 15,000. 156,000 before GST.
  const { lines, subtotal, byKey } = price(ISO, ISO_PRICING, {
    application_type: 'transfer', standards: ['iso_9001'], employee_count: 120,
    sites: [{ address: 'Pune', employees: 80, shifts: 2 }, { address: 'Chennai', employees: 40, shifts: 1 }],
  }, ISO_SERVICE);
  assert.deepEqual(lines.map((l) => [l.rule_key, l.qty, l.rate, l.price_needed]),
    [['certification_audit', 5, 25000, false], ['site_visits', 2, 8000, false], ['transfer_review', 1, 15000, false]]);
  assert.equal(byKey.certification_audit.unit, 'day');
  assert.equal(byKey.transfer_review.unit, 'review', 'its own unit, not "day" from the service');
  assert.equal(subtotal, 156000);
});

test('ISO, a new registration: 30 employees on one site, no transfer review', () => {
  // 30 employees is in 1–45: 3 days × 25,000 = 75,000; 1 site × 8,000 = 8,000. Total 83,000.
  const { lines, subtotal } = price(ISO, ISO_PRICING, {
    application_type: 'new_registration', standards: ['iso_9001', 'iso_45001'], employee_count: 30, sites: [{ address: 'Hyderabad', employees: 30 }],
  }, ISO_SERVICE);
  assert.deepEqual(lines.map((l) => l.rule_key), ['certification_audit', 'site_visits']);
  assert.equal(subtotal, 83000);
});

test('ISO: what the rules cannot price is Price needed, with the reason, never a guess', () => {
  const answers = { application_type: 'new_registration', standards: ['iso_9001'], employee_count: 120, sites: [{ address: 'Pune', employees: 120 }] };
  const noDayRate = price(ISO, ISO_PRICING, answers, { ...ISO_SERVICE, default_rate: null }).byKey.certification_audit;
  assert.equal(noDayRate.price_needed, true, 'no day rate set in Settings yet');
  assert.match(noDayRate.why, /no default rate in the catalogue/);
  const big = price(ISO, ISO_PRICING, { ...answers, employee_count: 5000 }, ISO_SERVICE).byKey.certification_audit;
  assert.equal(big.price_needed, true, 'beyond the last band');
  assert.equal(big.why, '"employee_count" is 5000, outside every band', 'the reason staff see, word for word');
  // Cannot happen on a submitted form (the sites table needs a row); the rule holds anyway.
  const noSites = price(ISO, ISO_PRICING, { ...answers, sites: [] }, ISO_SERVICE).byKey.site_visits;
  assert.equal(noSites.price_needed, true, 'no site listed');
});

test('Ecovadis: the fee follows all four employee numbers, plus each facility', () => {
  // 200 + 80 + 50 + 10 = 340 employees, in 251–1000: 450,000; 2 facilities × 25,000 = 50,000. 500,000 before GST.
  const { lines, subtotal } = price(ECOVADIS, ECOVADIS_PRICING, {
    permanent_male: 200, permanent_female: 80, contractor_male: 50, contractor_female: 10,
    facilities: [{ name: 'Plant 1', address: 'Hyderabad' }, { name: 'Plant 2', address: 'Vizag' }],
  }, ECOVADIS_SERVICE);
  assert.deepEqual(lines.map((l) => [l.rule_key, l.qty, l.rate, l.price_needed]),
    [['ecovadis_support', 1, 450000, false], ['facility_data', 2, 25000, false]]);
  assert.equal(subtotal, 500000);
  // Cannot happen on a submitted form (all four numbers are required); a missing one is still not read as 0.
  const unanswered = price(ECOVADIS, ECOVADIS_PRICING, { permanent_male: 200, facilities: [{ name: 'Plant 1', address: 'Hyderabad' }] }, ECOVADIS_SERVICE);
  assert.equal(unanswered.byKey.ecovadis_support.price_needed, true, 'a missing employee number is not read as 0');
  // Can happen: each number may be 0, and a total of 0 is below the first band.
  const none = price(ECOVADIS, ECOVADIS_PRICING, {
    permanent_male: 0, permanent_female: 0, contractor_male: 0, contractor_female: 0, facilities: [{ name: 'Office', address: 'Pune' }],
  }, ECOVADIS_SERVICE).byKey.ecovadis_support;
  assert.equal(none.price_needed, true, 'no employees at all: a person prices it');
  assert.equal(none.why, 'the value is 0, outside every band');
});
