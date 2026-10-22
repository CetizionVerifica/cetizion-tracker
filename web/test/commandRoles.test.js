import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STEPS, bodyFor, commandsFor, fieldBound, initialValues } from '../src/lib/commands.js';

/**
 * Who the palette offers which verb to (#214).
 *
 * The leak this closes: ⌘K listed "Pay a travel vendor bill" to a sales
 * user, who then filled the form in and got a 403 from the server. The
 * filter understood `adminOnly` and nothing else, and `adminOnly` is the
 * wrong gate — it would have hidden the verb from the travel desk, which is
 * the role whose work it is.
 */

const ids = ({ steps, jumps }) => [...steps, ...jumps].map((c) => c.id);

const ADMIN = { isAdmin: true, isHr: false, mode: 'database' };
const HR = { isAdmin: false, isHr: true, mode: 'database' };
const SALES = { isAdmin: false, isHr: false, mode: 'database' };

test('an administrator sees the vendor-pay verb', () => {
  assert.ok(ids(commandsFor(ADMIN)).includes('pay-vendor-bill'));
});

test('HR sees the vendor-pay verb — this is the travel desk\'s work', () => {
  assert.ok(ids(commandsFor(HR)).includes('pay-vendor-bill'));
});

test('sales does not see the vendor-pay verb', () => {
  assert.ok(!ids(commandsFor(SALES)).includes('pay-vendor-bill'));
});

test('the shared-mode account is an administrator, so it sees it', () => {
  // One full-access account from an environment variable: it has no role to
  // read, and it may do everything.
  assert.ok(ids(commandsFor({ isAdmin: true, isHr: false, mode: 'shared' })).includes('pay-vendor-bill'));
});

test('`roles` is a gate of its own: it does not hide the verb from HR the way adminOnly would', () => {
  const step = STEPS.find((s) => s.id === 'pay-vendor-bill');
  assert.deepEqual(step.roles, ['admin', 'hr']);
  assert.equal(step.adminOnly, undefined, 'adminOnly here would lock the travel desk out');
});

test('the admin-only jumps stay admin-only: HR does not inherit them', () => {
  const hr = ids(commandsFor(HR));
  for (const id of ['go-users', 'go-accounting', 'go-profitability', 'go-tokens']) {
    assert.ok(!hr.includes(id), `${id} is an administrator's`);
    assert.ok(ids(commandsFor(ADMIN)).includes(id), `${id} is listed for an administrator`);
  }
});

test('a verb with neither gate is offered to everybody, as before', () => {
  for (const who of [ADMIN, HR, SALES]) {
    assert.ok(ids(commandsFor(who)).includes('record-payment'));
  }
});

test('the personal-only entry still depends on the sign-in mode, not the role', () => {
  assert.ok(!ids(commandsFor({ ...ADMIN, mode: 'shared' })).includes('go-account'));
  assert.ok(ids(commandsFor(ADMIN)).includes('go-account'));
});

/* ------------------------------------------- the verb's own form, in ⌘K */

test('the palette asks for the same fields as the dialog, and the six modes', () => {
  const step = STEPS.find((s) => s.id === 'pay-vendor-bill');
  const names = step.fields.map((f) => f.name);
  assert.deepEqual(names, ['amount_paid', 'tds_amount', 'payment_date', 'payment_mode', 'reference']);

  const mode = step.fields.find((f) => f.name === 'payment_mode');
  assert.deepEqual(mode.options.map((o) => o.value),
    ['bank_transfer', 'upi', 'cheque', 'cash', 'card', 'other']);
});

test('the palette cannot offer a future paid-on date', () => {
  const step = STEPS.find((s) => s.id === 'pay-vendor-bill');
  const paidOn = step.fields.find((f) => f.name === 'payment_date');
  // Written as the same helper the default uses, so it has to be resolved
  // before it reaches the input — a function on `max` would do nothing.
  assert.equal(typeof paidOn.max, 'function');
  assert.equal(fieldBound(paidOn.max), new Date().toISOString().slice(0, 10));
  assert.equal(initialValues(step).payment_date, fieldBound(paidOn.max));
});

test('the palette posts the transfer, not a running total', () => {
  const step = STEPS.find((s) => s.id === 'pay-vendor-bill');
  const body = bodyFor(step, { id: 7 }, { amount_paid: '40000', tds_amount: '', payment_date: '2026-10-07', payment_mode: 'upi', reference: '' });
  // `mode: add` is what keeps 40,000 from being read as the new total of a
  // bill that already settles 60,000.
  assert.equal(body.mode, 'add');
  assert.equal(body.amount_paid, '40000');
  assert.equal(body.tds_amount, undefined, 'blanks are dropped, not sent as empty');
  assert.equal(step.endpoint({ id: 7 }), '/vendor-invoices/7/pay');
});
