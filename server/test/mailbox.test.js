import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dueAfter, fillTemplate, pickAssignee } from '../src/lib/inbox.js';
import { applyVisibility, classify, cleanHtml, isBlocked, openTokens, referencesIn, sealTokens, snippet } from '../src/lib/mailbox/rules.js';

// The rules behind mailbox sync (#29); none of these needs a database.

const opts = { accountEmail: 'sami@cetizionverifica.com', internalDomains: ['cetizionverifica.com'], blocklist: ['newsletter.example'] };
const p = (email, name) => ({ email, name });

test('mail only between colleagues is left out', () => {
  const r = classify({ from: p('Sami@cetizionverifica.com'), to: [p('ravi@cetizionverifica.com')] }, opts);
  assert.equal(r.skip, 'internal only');
  assert.equal(r.direction, 'outbound');
});

test('a client email is kept, inbound, with the client as the external party', () => {
  const r = classify({ from: p('asha@hetero.example', 'Asha'), to: [p('sami@cetizionverifica.com')], cc: [p('ravi@cetizionverifica.com'), p('ASHA@hetero.example')] }, opts);
  assert.equal(r.skip, null);
  assert.equal(r.direction, 'inbound');
  assert.deepEqual(r.external.map((x) => x.email), ['asha@hetero.example']);
});

test('blocked senders and robots are skipped', () => {
  assert.equal(classify({ from: p('news@newsletter.example'), to: [p('sami@cetizionverifica.com')] }, opts).skip, 'blocked sender');
  assert.equal(isBlocked('no-reply@bank.example'), true);
  assert.equal(isBlocked('x@sub.news.example', ['*.news.example']), true);
  assert.equal(isBlocked('asha@hetero.example', ['news.example']), false);
});

test('visibility levels strip what the owner did not share', () => {
  const m = { subject: 'Quote', snippet: 'Hi', body_html: '<p>Hi</p>' };
  assert.deepEqual(applyVisibility(m, 'share_everything'), m);
  assert.deepEqual(applyVisibility(m, 'subject'), { subject: 'Quote', snippet: null, body_html: null });
  assert.deepEqual(applyVisibility(m, 'metadata'), { subject: null, snippet: null, body_html: null });
});

test('stored HTML loses scripts and handlers; previews are plain text', () => {
  const html = '<p onclick="x()">Hello&nbsp;<b>there</b></p><script>alert(1)</script><a href="javascript:bad()">x</a><iframe src="y"></iframe>';
  const clean = cleanHtml(html);
  assert.doesNotMatch(clean, /script|onclick|javascript:|iframe/i);
  assert.equal(snippet(html), 'Hello there x');
});

test('record numbers in a subject are found', () => {
  const r = referencesIn('RE: CTZ/QT/2026/062 and PO 77455 — enquiry CTZ/ENQ/2026/003');
  assert.deepEqual(r.quotations, ['CTZ/QT/2026/062']);
  assert.deepEqual(r.enquiries, ['CTZ/ENQ/2026/003']);
  assert.deepEqual(r.pos, ['PO-77455']);
});

test('tokens are sealed with the key and cannot be read or altered without it', () => {
  const sealed = sealTokens({ refresh_token: 'abc' }, 'key-1');
  assert.doesNotMatch(sealed, /abc/);
  assert.deepEqual(openTokens(sealed, 'key-1'), { refresh_token: 'abc' });
  assert.throws(() => openTokens(sealed, 'key-2'));
  const parts = sealed.split('.'); parts[3] = Buffer.from('tampered').toString('base64');
  assert.throws(() => openTokens(parts.join('.'), 'key-1'));
});

// The shared inbox (#30)

test('a new conversation goes to the company owner, else round robin, else nobody', () => {
  assert.equal(pickAssignee({ rule: 'owner_of_company', companyOwner: 'Priya', members: ['A', 'B'] }).assignee, 'Priya');
  assert.deepEqual(pickAssignee({ rule: 'owner_of_company', companyOwner: null, members: ['A', 'B'], last: 'A' }), { assignee: 'B', last: 'B' });
  assert.deepEqual(pickAssignee({ rule: 'round_robin', companyOwner: 'Priya', members: ['A', 'B'], last: 'B' }), { assignee: 'A', last: 'A' });
  assert.equal(pickAssignee({ rule: 'unassigned', companyOwner: 'Priya', members: ['A'] }).assignee, null);
});

test('a first-response deadline that lands on a Sunday moves to Monday', () => {
  assert.equal(dueAfter('2026-09-17T10:00:00Z', 24), '2026-09-18T10:00:00.000Z');
  assert.equal(dueAfter('2026-09-19T10:00:00Z', 24), '2026-09-21T10:00:00.000Z');
});

test('Sunday is judged where the business is, not on the container clock', () => {
  // 20:00 UTC on Saturday is 01:30 on Sunday morning in Mumbai. Read as
  // UTC it is still Saturday, so this deadline used to stay on a Sunday.
  assert.equal(dueAfter('2026-09-19T16:00:00Z', 4), '2026-09-20T20:00:00.000Z');
  // And the other way: 19:30 UTC on Sunday is Monday here, so there is
  // nothing to move. It used to be pushed to Tuesday morning IST.
  assert.equal(dueAfter('2026-09-20T19:30:00Z', 0), '2026-09-20T19:30:00.000Z');
});

test('a stored email cannot carry anything that runs', () => {
  // The two the review found: the handler needed no whitespace in front of
  // it, and the scheme was entity-encoded.
  // It survives only as part of the src value, which is a relative URL
  // and not a handler: what matters is that no attribute called on* is left.
  assert.doesNotMatch(cleanHtml('<img src=x/onerror=alert(1)>'), /\son\w+\s*=/i);
  assert.doesNotMatch(cleanHtml('<a href="&#106;avascript:alert(1)">x</a>'), /href/i);
  for (const bad of ['<script>x()</script>', '<iframe src="//evil.example"></iframe>', '<form action="//evil.example"><input name="p"></form>', '<div onclick="x()">t</div>', '<object data="x"></object>', '<base href="//evil.example">', '<a href="javascript:alert(1)">x</a>']) {
    const out = cleanHtml(bad);
    assert.doesNotMatch(out, /<(script|iframe|form|input|object|base)|javascript:|\son\w+=/i, `${bad} survived as ${out}`);
  }
  // And what an email actually is survives intact.
  assert.match(cleanHtml('<table><tr><td><b>Total</b></td></tr></table>'), /<table><tr><td><b>Total<\/b><\/td><\/tr><\/table>/);
  const link = cleanHtml('<a href="https://client.example/quote">Quotation</a>');
  assert.match(link, /href="https:\/\/client\.example\/quote"/);
  assert.match(link, /rel="noopener noreferrer"/, 'a link opens away from the tracker and cannot reach back');
});

test('canned responses fill their variables and blank the unknown ones', () => {
  assert.equal(fillTemplate('Dear {{contact_name}}, from {{ my_name }}{{nope}}', { contact_name: 'Asha', my_name: 'Sami' }), 'Dear Asha, from Sami');
});
