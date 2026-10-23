import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { checkAnswers, checkDefinition } from '../src/lib/questionnaireDefinition.js';

/**
 * The first two questionnaires (#208 phase 1b, #239 Step 1), drafted from
 * the ISO audits application form (Word) and the Ecovadis questionnaire on
 * cetizionverifica.com. An admin recreates them in Settings › Templates ›
 * Questionnaires; these files are the reference, never seeded. The pricing
 * rules (Step 2D) refer to their keys, so a renamed key fails here first.
 */
const load = (name) => JSON.parse(readFileSync(new URL(`../../docs/questionnaires/${name}.json`, import.meta.url), 'utf8'));

for (const name of ['iso-audits', 'ecovadis']) {
  test(`${name}: the builder would accept it as it is`, () => {
    const r = checkDefinition(load(name));
    assert.deepEqual(r.errors, []);
    assert.equal(r.ok, true);
  });
}

test('iso-audits: an ISO 9001 client is asked nothing about food, energy or road safety', () => {
  const def = load('iso-audits');
  const answers = {
    application_type: 'new_registration', standards: ['iso_9001'],
    legal_name: 'Example Pvt Ltd', address: '1 Example Road', representative: 'A. Person', email: 'a@example.com',
    certificate_scope: 'Manufacture of example parts', employee_count: 120,
    sites: [{ address: 'Pune', employees: 120, shifts: 2 }],
    previously_certified: false, signatory_position: 'Director', confirmation: ['accurate'],
    haccp_count: 3, bribery_conviction: true,
  };
  const { values, errors } = checkAnswers(def, answers, { submit: true });
  assert.deepEqual(errors, {});
  assert.equal(values.haccp_count, undefined, 'a hidden question is dropped');
  assert.equal(values.bribery_conviction, undefined);
});

test('iso-audits: choosing ISO 37001 asks the anti-bribery question, and it must be answered', () => {
  const def = load('iso-audits');
  const { errors } = checkAnswers(def, {
    application_type: 'transfer', standards: ['iso_9001', 'iso_37001'],
    legal_name: 'Example Pvt Ltd', address: '1 Example Road', representative: 'A. Person', email: 'a@example.com',
    certificate_scope: 'Example', employee_count: 40, sites: [{ address: 'Pune', employees: 40 }],
    previously_certified: true, signatory_position: 'Director', confirmation: ['accurate'],
  }, { submit: true });
  assert.deepEqual(Object.keys(errors), ['bribery_conviction']);
});

test('ecovadis: a past assessment asks for its score, date and the medal targeted', () => {
  const def = load('ecovadis');
  const base = {
    customer_name: 'Example Pvt Ltd', contact_name: 'A. Person', contact_email: 'a@example.com', corporate_address: '1 Example Road',
    facilities: [{ name: 'Plant 1', address: 'Hyderabad' }],
    permanent_male: 200, permanent_female: 80, contractor_male: 50, contractor_female: 10,
    has_sustainability_function: true, has_esg_report: false, plant_area_sqm: 12000, main_products: 'APIs', desired_timeline: 'Q1 2027',
  };
  assert.deepEqual(checkAnswers(def, { ...base, past_assessment: false }, { submit: true }).errors, {});
  assert.deepEqual(Object.keys(checkAnswers(def, { ...base, past_assessment: true }, { submit: true }).errors).sort(),
    ['assessment_date', 'ecovadis_score', 'medal_target']);
});
