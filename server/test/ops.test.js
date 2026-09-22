import { test } from 'node:test';
import assert from 'node:assert/strict';

// Monitoring (#38): what leaves the server in logs and error reports.

process.env.SENTRY_DSN = 'https://publickey@errors.example.com/42';
process.env.RELEASE = 'abc1234';
process.env.APP_ENV = 'production';
const { maskUrl } = await import('../src/lib/ops/logger.js');
const { reportError } = await import('../src/lib/ops/errors.js');

test('one-time tokens never reach a log line', () => {
  assert.equal(maskUrl('/accept/yF-UBamV2TG0kPnXoBw8N2AZNkE2lORFKqm4zNVYeVg'), '/accept/…');
  assert.equal(maskUrl('/api/public/accept/yF-UBamV2TG0kPnXoBw8N2AZNkE2lORFKqm4zNVYeVg/pdf'), '/api/public/accept/…/pdf');
  assert.equal(maskUrl('/portal/login/ChajOTbo5weadLhlXmKnMQJcjyCEF5lkR_XQ5_7y7Dk'), '/portal/login/…');
  assert.equal(maskUrl('/api/mailboxes/oauth/microsoft?code=abc&state=xyz&x=1'), '/api/mailboxes/oauth/microsoft?code=…&state=…&x=1');
  assert.equal(maskUrl('/api/mail/notifications?validationToken=secret'), '/api/mail/notifications?validationToken=…');
  assert.equal(maskUrl('/api/quotations/CTZ%2FQT%2F2026%2F062'), '/api/quotations/CTZ%2FQT%2F2026%2F062');
});

test('an error report carries release and route, and no secrets or personal data', async () => {
  let sent;
  const fetchImpl = async (url, opts) => { sent = { url, opts }; return { ok: true }; };
  const err = new Error('Login failed for asha@client.example with password=hunter2 and token ctz_abcdefghijklmnopqrstuvwxyz0123456789');
  const id = await reportError(err, { source: 'api', route: '/api/quotations/:key', method: 'GET', url: '/api/quotations/X?token=zzz', requestId: 'req-1', user: 'admin' }, { fetchImpl });
  assert.ok(id);
  assert.equal(sent.url, 'https://errors.example.com/api/42/envelope/');
  assert.match(sent.opts.headers['X-Sentry-Auth'], /sentry_key=publickey/);
  const event = JSON.parse(sent.opts.body.trim().split('\n')[2]);
  assert.equal(event.release, 'abc1234');
  assert.equal(event.environment, 'production');
  assert.equal(event.tags.route, '/api/quotations/:key');
  assert.equal(event.request.url, '/api/quotations/X');
  const text = JSON.stringify(event);
  for (const leak of ['hunter2', 'asha@client.example', 'ctz_abcdefghijklmnopqrstuvwxyz', 'zzz']) assert.ok(!text.includes(leak), leak);
  assert.equal(event.request.data, undefined);
  assert.equal(event.request.cookies, undefined);
});

test('a failing error tracker never breaks the request', async () => {
  const id = await reportError(new Error('x'), {}, { fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(id, null);
});
