import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withEmailResult } from '../src/lib/emailResult.js';

/**
 * Deciding an approval saves the decision and emails the salesperson, and the
 * route reports both. Before #103 the toast said only "Quotation rejected", so
 * a decision whose email never left looked exactly like one that arrived — the
 * salesperson waited on an answer already given.
 *
 * The decision succeeding and the email leaving are separate outcomes, so the
 * email's fate is appended to the success message rather than replacing it.
 */

test('a sent email is reported beside the decision', () => {
  assert.equal(
    withEmailResult('Quotation rejected', { status: 'sent', reason: null }),
    'Quotation rejected (email sent)'
  );
});

test('a suppressed email says why it was suppressed', () => {
  assert.equal(
    withEmailResult('Quotation rejected', { status: 'suppressed', reason: 'EMAIL_MODE=log' }),
    'Quotation rejected (email suppressed: EMAIL_MODE=log)'
  );
  assert.equal(
    withEmailResult('Quotation approved', { status: 'suppressed', reason: 'SMTP_HOST or EMAIL_FROM not set' }),
    'Quotation approved (email suppressed: SMTP_HOST or EMAIL_FROM not set)'
  );
});

test('a failed email is named even though the reason is not in this payload', () => {
  // The SMTP error lives in email_log.error, which the route does not send on.
  // "failed" alone is still the difference between a warning and silence.
  assert.equal(
    withEmailResult('Quotation rejected', { status: 'failed', reason: null }),
    'Quotation rejected (email failed)'
  );
});

test('no email attempted leaves the message exactly as it was', () => {
  assert.equal(withEmailResult('Quotation approved', null), 'Quotation approved');
  assert.equal(withEmailResult('Quotation rejected', undefined), 'Quotation rejected');
});

test('an email object that says nothing useful is not announced', () => {
  // The callback runs inside act()'s try block, so a throw here would toast a
  // saved decision as a failure. Nothing in this function may throw, and
  // "(email undefined)" is worse than saying nothing.
  assert.equal(withEmailResult('Quotation approved', {}), 'Quotation approved');
  assert.equal(withEmailResult('Quotation approved', { status: '' }), 'Quotation approved');
  assert.equal(withEmailResult('Quotation approved', { reason: 'EMAIL_MODE=log' }), 'Quotation approved');
});

test('an empty reason does not leave a dangling colon', () => {
  assert.equal(
    withEmailResult('Quotation approved', { status: 'sent', reason: '' }),
    'Quotation approved (email sent)'
  );
});
