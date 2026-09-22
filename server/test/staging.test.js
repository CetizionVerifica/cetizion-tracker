import { test } from 'node:test';
import assert from 'node:assert/strict';

// Staging (#35): nothing leaves it, and it sits behind a shared credential.

process.env.APP_ENV = 'staging';
process.env.STAGING_BASIC_AUTH = 'team:long-shared-secret';
const { decideDelivery } = await import('../src/lib/mail.js');
const { stagingGate, assertNotStaging } = await import('../src/lib/ops/environment.js');
const { runWebhooks } = await import('../src/lib/webhooks.js');

test('staging never sends real email; the team sandbox still works', () => {
  assert.deepEqual(decideDelivery({ to: 'client@x.example', mode: 'live', configured: true }), { deliver: false, reason: 'staging: outbound email is off' });
  assert.equal(decideDelivery({ to: 'sami@cetizionverifica.com', mode: 'sandbox', allowlist: ['@cetizionverifica.com'] }).deliver, true);
});

test('webhooks, the books and mailboxes are refused on staging', async () => {
  assert.equal((await runWebhooks()).skipped, 'staging');
  assert.throws(() => assertNotStaging('Mailbox sync'), /switched off on staging/);
});

function run(path, auth) {
  let status = 200; let nexted = false;
  const req = { path, get: (h) => (h === 'authorization' ? auth : undefined) };
  const res = { set() { return this; }, status(s) { status = s; return this; }, send() { return this; } };
  stagingGate(req, res, () => { nexted = true; });
  return nexted ? 'through' : status;
}

test('the whole site needs the shared credential, except the platform health check', () => {
  const basic = (s) => `Basic ${Buffer.from(s).toString('base64')}`;
  assert.equal(run('/quotations'), 401);
  assert.equal(run('/api/projects', basic('team:wrong')), 401);
  assert.equal(run('/portal', basic('team:long-shared-secret')), 'through');
  assert.equal(run('/api/health'), 'through');
});
