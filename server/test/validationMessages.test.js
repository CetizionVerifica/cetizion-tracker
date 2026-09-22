import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';

/**
 * The words a person sees under a form field. Validation runs before any
 * query, so these requests are rejected without touching Postgres.
 *
 * Pinned here because a zod major once changed how custom messages are
 * passed, and every schema kept rejecting bad input — just with zod's own
 * wording in place of ours. Nothing else would have noticed.
 */

process.env.NODE_ENV = 'test';
process.env.AUTH_USERNAME = 'tester';
process.env.AUTH_PASSWORD = 'a-good-long-test-password';
process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-to-pass';

const { default: app } = await import('../src/app.js');

let cookie;

before(async () => {
  const response = await request(app)
    .post('/api/auth/login')
    .send({ username: process.env.AUTH_USERNAME, password: process.env.AUTH_PASSWORD });
  cookie = response.headers['set-cookie'];
});

const fieldsFrom = async (path, body) => {
  const response = await request(app).post(path).set('Cookie', cookie).send(body);
  assert.equal(response.status, 422);
  return response.body.error.fields;
};

describe('required text', () => {
  test('says "Required" when the field is missing', async () => {
    const fields = await fieldsFrom('/api/companies', {});

    assert.equal(fields.name, 'Required');
  });

  test('says "Required" when the field is blank', async () => {
    const fields = await fieldsFrom('/api/companies', { name: '   ' });

    assert.equal(fields.name, 'Required');
  });
});

describe('numbers', () => {
  test('says "Enter a number" for text in a number field', async () => {
    const fields = await fieldsFrom('/api/quotations', {
      client_name: 'Hindalco',
      quotation_value: 'twelve',
    });

    assert.equal(fields.quotation_value, 'Enter a number');
  });
});

describe('amounts', () => {
  test('says "Enter an amount" when a received amount is missing', async () => {
    const fields = await fieldsFrom('/api/payment-stages/1/payment', {});

    assert.equal(fields.amount_received, 'Enter an amount');
  });

  test('says "Enter an amount" when a received amount is not a number', async () => {
    const fields = await fieldsFrom('/api/payment-stages/1/payment', { amount_received: 'lots' });

    assert.equal(fields.amount_received, 'Enter an amount');
  });

  test('says "Enter an amount" for text in an optional amount', async () => {
    const fields = await fieldsFrom('/api/expense-claims/1/reimburse', { amount_reimbursed: 'some' });

    assert.equal(fields.amount_reimbursed, 'Enter an amount');
  });
});

describe('columns the database will not accept as empty', () => {
  // Each of these is NOT NULL with no default. Declared optional, a missing
  // value slipped past validation, reached Postgres and came back as a 500
  // with no field named — so the form had nothing to show the person.
  const cases = [
    ['a pipeline stage without a probability', '/api/pipeline-stages', { name: 'Negotiating', type: 'open' }, 'probability'],
    ['a quotation line with no quotation', '/api/quotation-lines', { description: 'Audit', qty: 1, rate: 100 }, 'quotation_id'],
    ['a payment-terms line with no template', '/api/payment-terms-template-lines', { stage_no: 1, stage_name: 'Advance', percent: 50 }, 'template_id'],
    ['a payment-terms line with no percentage', '/api/payment-terms-template-lines', { template_id: 1, stage_no: 1, stage_name: 'Advance' }, 'percent'],
    ['a checklist line with no step number', '/api/onboarding-template-lines', { template_id: 1, step: 'Kick-off' }, 'step_no'],
    ['a receipt with no stage', '/api/payments', { amount: 1000, received_on: '2026-09-21' }, 'stage_id'],
    ['a receipt with no amount', '/api/payments', { stage_id: 1, received_on: '2026-09-21' }, 'amount'],
    ['an engagement with no next due date', '/api/engagements', { client_name: 'Hetero', service_name: 'EcoVadis' }, 'next_due_on'],
    ['an attachment with no document', '/api/attachments', { entity: 'company', entity_id: '1' }, 'document_id'],
  ];

  for (const [name, path, body, field] of cases) {
    test(`${name} is a field error, not a 500`, async () => {
      const fields = await fieldsFrom(path, body);

      assert.equal(fields[field], 'Required');
    });
  }
});
