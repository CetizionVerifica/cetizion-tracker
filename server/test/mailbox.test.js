import { test } from 'node:test';
import assert from 'node:assert/strict';
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
