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
