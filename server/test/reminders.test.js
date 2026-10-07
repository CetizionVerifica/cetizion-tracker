import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planReminders, runPaymentReminders } from '../src/lib/reminders.js';
import { decideDelivery } from '../src/lib/mail.js';
import { financeDigest, paymentReminder } from '../src/lib/emailTemplates.js';

// The rules behind the reminders; none of these needs a database.

const stage = (extra = {}) => ({
  id: 1, po_number: 'PO-1', stage_name: 'Advance (50%)', stage_status: 'Overdue', invoice_no: 'CVPL/2026-27/12', invoice_due_date: '2026-09-01',
  days_overdue: 10, stage_amount: 100000, amount_received: 0, currency: 'INR', reminder_sent_on: null, reminder_level: 0, on_hold: false, promise_to_pay_date: null,
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

test('a stage already reminded at its level waits; one that has earned the next level goes again', () => {
  const plan = planReminders([stage({ reminder_sent_on: '2026-09-14', reminder_level: 1 }), stage({ id: 2, reminder_sent_on: '2026-09-01', reminder_level: 1, days_overdue: 20 })], { today, intervalDays: 7 });
  assert.deepEqual(plan.reminders[0].stages.map((s) => s.id), [2]);
  assert.equal(plan.reminders[0].level, 2);
  assert.match(plan.skipped[0].reason, /reminded 3 days ago at level 1/);
});

test('after the final level a reminder repeats every interval; holds and promises pause it', () => {
  const plan = planReminders([
    stage({ reminder_sent_on: '2026-09-01', reminder_level: 3, days_overdue: 45 }),
    stage({ id: 2, reminder_sent_on: '2026-09-14', reminder_level: 3, days_overdue: 45 }),
    stage({ id: 3, days_overdue: 45, on_hold: true, hold_reason: 'disputed' }),
    stage({ id: 4, days_overdue: 45, promise_to_pay_date: '2026-09-30' }),
  ], { today, intervalDays: 7 });
  assert.deepEqual(plan.reminders[0].stages.map((s) => s.id), [1]);
  assert.equal(plan.reminders[0].level, 3);
  assert.deepEqual(plan.skipped.map((s) => s.id), [2, 3, 4]);
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

// What each outcome of a send does to the stage. The stamp is what silences a
// client for the whole interval, so only a mail that truly left may set it.
/** A database that records the writes a run makes, with one overdue stage. */
const recordingDb = (stages = [stage()]) => {
  const writes = { stamps: [], collectionLog: [] };
  return {
    writes,
    async query(sql, params = []) {
      if (/FROM settings/.test(sql)) return { rows: [] };
      if (/FROM v_payment_stages/.test(sql)) return { rows: stages };
      if (/UPDATE payment_stages/.test(sql)) writes.stamps.push(params);
      if (/INSERT INTO collection_log/.test(sql)) writes.collectionLog.push(params);
      return { rows: [] };
    },
  };
};
/** A stand-in for lib/mail.js that reports the outcome a real server would. */
const sender = (status, reason = null) => async () => ({ id: 7, status, reason });

test('a reminder that really goes out stamps the stage and logs the contact', async () => {
  const db = recordingDb();
  const result = await runPaymentReminders({ db, today, send: sender('sent') });
  assert.equal(result.sent[0].status, 'sent');
  assert.deepEqual(db.writes.stamps, [[today, 1, 1]]);       // date, stage id, level 1
  assert.equal(db.writes.collectionLog.length, 1);
});

test('log mode, a suppressed address and a failed send all leave the stage due', async () => {
  for (const [status, reason] of [['suppressed', 'EMAIL_MODE=log'], ['suppressed', 'not on EMAIL_ALLOWLIST'], ['failed', 'SMTP refused']]) {
    const db = recordingDb();
    const result = await runPaymentReminders({ db, today, send: sender(status, reason) });
    assert.equal(result.sent[0].status, status, reason);
    assert.deepEqual(db.writes.stamps, [], reason);
    assert.deepEqual(db.writes.collectionLog, [], reason);
  }
});

test('a stage chased by hand keeps its date: the run reads it and never rewrites it', async () => {
  // Someone recorded a chase yesterday on the stages form. Nothing today
  // touches that column, whatever the send did.
  const db = recordingDb([stage({ reminder_sent_on: '2026-09-16', reminder_level: 1 })]);
  await runPaymentReminders({ db, today, send: sender('suppressed', 'EMAIL_MODE=log') });
  assert.deepEqual(db.writes.stamps, []);
});

// #198 phase 3: a reminder to somebody who can sign in to the client portal
// ends with its address, unless Settings says not to.
const portalStage = (extra = {}) => stage({ portal_enabled: true, portal_access: true, portal_sections: ['projects', 'invoices'], ...extra });

test('a reminder carries the portal only for a contact who can sign in to its invoices', () => {
  assert.equal(planReminders([portalStage()], { today }).reminders[0].portal, true);
  for (const off of [{ portal_enabled: false }, { portal_access: false }, { portal_sections: ['projects'] }]) {
    assert.equal(planReminders([portalStage(off)], { today }).reminders[0].portal, false, JSON.stringify(off));
  }
  const withLink = paymentReminder({ company: 'Hetero', contactName: 'Ravi', stages: [stage()], portalUrl: 'https://tracker.example/portal' });
  assert.match(withLink.text, /client portal you can download your invoices.*https:\/\/tracker\.example\/portal/);
  assert.match(withLink.html, /href="https:\/\/tracker\.example\/portal"/);
  const without = paymentReminder({ company: 'Hetero', contactName: 'Ravi', stages: [stage()] });
  assert.doesNotMatch(without.text, /portal/);
});

test('the run adds the public portal address, and leaves it out when switched off', async () => {
  const run = async (linkSetting) => {
    const mails = [];
    const settings = { public_app_url: 'https://tracker.example/', portal_link_in_reminders: linkSetting };
    const db = {
      async query(sql, params = []) {
        if (/FROM settings/.test(sql)) {
          const key = params[0] ?? sql.match(/key = '(\w+)'/)?.[1];
          return { rows: settings[key] === undefined ? [] : [{ value: settings[key] }] };
        }
        if (/FROM v_payment_stages/.test(sql)) return { rows: [portalStage()] };
        return { rows: [] };
      },
    };
    await runPaymentReminders({ db, today, send: async (m) => { mails.push(m); return { id: 1, status: 'logged' }; } });
    return mails[0].text;
  };
  assert.match(await run('true'), /https:\/\/tracker\.example\/portal\n/);
  assert.doesNotMatch(await run('false'), /portal/);
});
