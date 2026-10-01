import { test } from 'node:test';
import assert from 'node:assert/strict';
import { followUpEscalatedNotice, followUpEscalation, followUpReminder } from '../src/lib/emailTemplates.js';

// The follow-up emails (docs/follow-up-escalation-test-plan.md §7).

const appUrl = 'https://tracker.example/';
const today = '2026-10-05';
const respondBy = '2026-10-07';

const enq = (x = {}) => ({ entity: 'enquiry', entity_id: 'ENQ-1', number: 'ENQ-1', client: 'Hetero', why: 'follow_up_date', due_on: '2026-09-28', link: '/enquiries?q=ENQ-1', owner_name: 'Asha', owner_user_id: 1, owner_email: 'asha@qa.example', ...x });
const quo = (x = {}) => ({ entity: 'quotation', entity_id: 'Q-1', number: 'Q-1', client: 'Midal', why: 'idle', sent_on: '2026-09-25', idle_days: 6, link: '/quotations/Q-1', owner_name: 'Asha', owner_user_id: 1, ...x });
const inv = (x = {}) => ({ entity: 'payment_stage', entity_id: '7', number: 'CVPL/26-27/40', client: 'Hetero', amount: 120000, currency: 'INR', days_overdue: 12, link: '/collections?stage=7', owner_name: 'Asha', owner_user_id: 1, ...x });
const escalated = (x = {}) => ({ ...enq(), reminded_on: '2026-10-05', respond_by: respondBy, idle_days: 3, amount: 5000, currency: 'USD', ...x });

test('E-01: the subject counts each kind, singular and plural', () => {
  const email = followUpReminder({ ownerName: 'Asha', today, respondBy, appUrl, items: [enq(), enq({ entity_id: 'ENQ-2', number: 'ENQ-2' }), quo(), inv()] });
  assert.equal(email.subject, 'Follow up today: 2 enquiries, 1 quotation, 1 invoice');
  assert.equal(followUpReminder({ ownerName: 'Asha', today, respondBy, appUrl, items: [inv(), inv({ entity_id: '8' })] }).subject, 'Follow up today: 2 invoices');
});

test('E-02/03: each row has the number, client, reason, respond-by date and a link that opens the log dialog', () => {
  const { text, html } = followUpReminder({ ownerName: 'Asha', today, respondBy, appUrl, items: [enq(), quo(), inv()] });
  assert.match(text, /ENQ-1 · Hetero · follow-up date 28 Sep 2026 · respond by 07 Oct 2026/);
  assert.match(text, /Q-1 · Midal · sent 25 Sep 2026, no contact for 6 working days/);
  assert.match(text, /CVPL\/26-27\/40 · Hetero · ₹1,20,000 overdue 12 days/);
  assert.match(text, /https:\/\/tracker\.example\/enquiries\?q=ENQ-1&log=1/);
  assert.match(text, /https:\/\/tracker\.example\/quotations\/Q-1\?log=1/);
  assert.doesNotMatch(text, /example\/\//);
  assert.match(html, /href="https:\/\/tracker\.example\/collections\?stage=7&amp;log=1"/);
  assert.match(text, /by 07 Oct 2026 or this goes to management/);
});

test('E-04: "Still waiting" appears only when something is waiting', () => {
  assert.doesNotMatch(followUpReminder({ ownerName: 'Asha', today, respondBy, appUrl, items: [enq()] }).text, /STILL WAITING/);
  const { text, html } = followUpReminder({ ownerName: 'Asha', today, respondBy, appUrl, items: [enq()], waiting: [quo({ respond_by: '2026-10-06' })] });
  assert.match(text, /STILL WAITING \(1\)\n- Q-1 · Midal · respond by 06 Oct 2026/);
  assert.match(html, /Still waiting \(1\)/);
});

test('E-05/06: the escalation is grouped by owner, sections only when they have rows, counts in the subject', () => {
  const email = followUpEscalation({
    today, appUrl,
    escalated: [escalated(), escalated({ entity_id: 'ENQ-3', number: 'ENQ-3', owner_name: 'Ben', owner_user_id: 2 })],
    stillOpen: [],
    unowned: [quo({ owner_name: null, owner_user_id: null, idle_days: 6 })],
  });
  assert.equal(email.subject, 'Follow-ups missed: 2 new, 1 with no owner');
  assert.match(email.text, /MISSED \(2\)\nAsha\n {2}- ENQ-1 · Hetero · \$5,000 · reminded 05 Oct 2026 · respond by 07 Oct 2026 · 3 working days quiet/);
  assert.match(email.text, /\nBen\n/);
  assert.doesNotMatch(email.text, /STILL OPEN/);
  assert.match(email.text, /NO OWNER \(1\)/);
  assert.match(email.html, /No owner \(1\)/);
});

test('E-07: values are escaped in the HTML and plain in the text', () => {
  const nasty = '<script>alert(1)</script> & Co';
  const r = followUpReminder({ ownerName: 'A & <b>', today, respondBy, appUrl, items: [enq({ client: nasty, number: 'Q<1>' })] });
  assert.doesNotMatch(r.html, /<script>/);
  assert.match(r.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; Co/);
  assert.match(r.html, /Q&lt;1&gt;/);
  assert.match(r.text, /<script>alert\(1\)<\/script> & Co/);
  const e = followUpEscalation({ today, appUrl, escalated: [escalated({ client: nasty, owner_name: '<i>Asha</i>' })] });
  assert.doesNotMatch(e.html, /<script>|<i>Asha/);
});

test('E-08: an owner digest is capped at 50 rows', () => {
  const items = Array.from({ length: 60 }, (_, n) => enq({ entity_id: `ENQ-${n}`, number: `ENQ-${n}` }));
  const { text, html } = followUpReminder({ ownerName: 'Asha', today, respondBy, appUrl, items });
  assert.equal(text.match(/^- ENQ-/gm).length, 50);
  assert.match(text, /And 10 more in the tracker/);
  assert.match(html, /And 10 more in the tracker/);
  assert.match(followUpReminder({ ownerName: 'Asha', today, respondBy, appUrl, items }).subject, /60 enquiries/);
});

test('E-09: the owner notice lists only the items it is given', () => {
  const notice = followUpEscalatedNotice({ ownerName: 'Asha', appUrl, items: [escalated()] });
  assert.equal(notice.subject, 'Sent to management: 1 follow-up with nothing logged');
  assert.match(notice.text, /ENQ-1 · Hetero · respond by 07 Oct 2026/);
  assert.doesNotMatch(notice.text, /ENQ-3/);
});

test('E-10: the text and HTML versions carry the same records', () => {
  const items = [enq(), quo(), inv()];
  const { text, html } = followUpReminder({ ownerName: 'Asha', today, respondBy, appUrl, items });
  for (const i of items) {
    assert.ok(text.includes(i.number), `text has ${i.number}`);
    assert.ok(html.includes(i.number), `html has ${i.number}`);
  }
});
