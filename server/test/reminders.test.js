import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planReminders, runPaymentReminders } from '../src/lib/reminders.js';
import { decideDelivery } from '../src/lib/mail.js';
import { financeDigest, paymentReminder } from '../src/lib/emailTemplates.js';

// The rules behind the reminders; none of these needs a database.

const stage = (extra = {}) => ({
  id: 1, po_number: 'PO-1', stage_name: 'Advance (50%)', stage_status: 'Overdue', invoice_no: 'CVPL/2026-27/12', invoice_due_date: '2026-09-01',
  days_overdue: 10, stage_amount: 100000, amount_received: 0, currency: 'INR', reminder_sent_on: null,
  company_id: 5, company_name: 'Hetero', client_name: 'Hetero', contact_name: 'Ravi', contact_email: 'ravi@hetero.example', opt_out: false,
  ...extra,
});
const today = '2026-09-17';

test('one reminder per client, listing every overdue invoice', () => {
  const plan = planReminders([stage(), stage({ id: 2, invoice_no: 'CVPL/2026-27/13' }), stage({ id: 3, company_id: 6, company_name: 'Midal', contact_email: 'a@midal.example' })], { today });
  assert.equal(plan.reminders.length, 2);
  assert.deepEqual(plan.reminders[0].stages.map((s) => s.id), [1, 2]);
  assert.equal(plan.reminders[0].to, 'ravi@hetero.example');
});

test('a stage chased inside the interval waits; one chased earlier goes again', () => {
  const plan = planReminders([stage({ reminder_sent_on: '2026-09-14' }), stage({ id: 2, reminder_sent_on: '2026-09-01' })], { today, intervalDays: 7 });
  assert.deepEqual(plan.reminders[0].stages.map((s) => s.id), [2]);
  assert.match(plan.skipped[0].reason, /reminded 3 days ago/);
});

test('grace period, missing email, opt-out and stages without an invoice are skipped with a reason', () => {
  const plan = planReminders([
    stage({ days_overdue: 1 }),
    stage({ id: 2, contact_email: null }),
    stage({ id: 3, opt_out: true }),
    stage({ id: 4, invoice_no: null }),
    stage({ id: 5, stage_status: 'To Invoice' }),
  ], { today, graceDays: 3 });
  assert.equal(plan.reminders.length, 0);
  assert.deepEqual(plan.skipped.map((s) => s.id), [1, 2, 3]);
});

test('delivery follows the mode, the kill switch and the allowlist', () => {
  assert.equal(decideDelivery({ to: 'a@x.com', mode: 'log', configured: true }).deliver, false);
  assert.equal(decideDelivery({ to: 'a@x.com', mode: 'live', configured: true }).deliver, true);
  assert.equal(decideDelivery({ to: 'a@x.com', mode: 'live', configured: false }).deliver, false);
  assert.equal(decideDelivery({ to: 'a@x.com', mode: 'live', enabled: false, configured: true }).deliver, false);
  assert.equal(decideDelivery({ to: 'a@x.com', mode: 'live', optedOut: true, configured: true }).deliver, false);
  assert.equal(decideDelivery({ to: 'a@x.com', mode: 'sandbox', allowlist: ['b@x.com'], configured: true }).deliver, false);
  assert.equal(decideDelivery({ to: 'a@x.com', mode: 'sandbox', allowlist: ['@x.com'], configured: true }).deliver, true);
});

test('the reminder email totals the outstanding amounts and names every invoice', () => {
  const email = paymentReminder({ company: 'Hetero', contactName: 'Ravi', stages: [stage(), stage({ id: 2, invoice_no: 'CVPL/2026-27/13', amount_received: 40000 })], financeEmail: 'finance@cetizion.com' });
  assert.match(email.subject, /2 invoices due from Hetero/);
  assert.match(email.text, /Total outstanding: ₹1,60,000/);
  assert.match(email.text, /CVPL\/2026-27\/13/);
  assert.match(email.html, /finance@cetizion.com/);
});

test('the finance digest counts what is waiting', () => {
  const email = financeDigest({ today, toInvoice: [stage({ stage_status: 'To Invoice' })], overdue: [stage()], remindersSent: 1 });
  assert.match(email.subject, /1 to invoice, 1 overdue/);
  assert.match(email.text, /Reminders sent to clients today: 1/);
});

test('a reminder that was only logged does not mark the stage as chased', async () => {
  // Email is switched off, so sendMail logs the reminder as suppressed.
  const writes = [];
  const db = {
    async query(sql, params = []) {
      if (/key = 'emails_enabled'/.test(sql)) return { rows: [{ value: 'false' }] };
      if (/FROM settings/.test(sql)) return { rows: [] };
      if (/FROM v_payment_stages/.test(sql)) return { rows: [stage()] };
      if (/INSERT INTO email_log/.test(sql)) return { rows: [{ id: 1, status: params[6] }] };
      if (/UPDATE payment_stages/.test(sql)) writes.push(params);
      return { rows: [] };
    },
  };
  const result = await runPaymentReminders({ db, today });
  assert.equal(result.sent[0].status, 'suppressed');
  assert.deepEqual(writes, []);
});
