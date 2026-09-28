import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BACKOFF_MINUTES, sign, stripPersonal, verify } from '../src/lib/webhooks.js';

// Outgoing webhooks (#49); none of these needs a database.

test('a signature verifies with the right secret, fresh timestamp and exact body only', () => {
  const now = Date.UTC(2026, 8, 17, 10, 0, 0);
  const t = Math.floor(now / 1000);
  const body = '{"event":"quotation.won"}';
  const header = `t=${t},v1=${sign('whsec_1', t, body)}`;
  assert.equal(verify('whsec_1', header, body, { now }), true);
  assert.equal(verify('whsec_2', header, body, { now }), false);
  assert.equal(verify('whsec_1', header, `${body} `, { now }), false);
  assert.equal(verify('whsec_1', header, body, { now: now + 10 * 60 * 1000 }), false);
  assert.equal(verify('whsec_1', 'nonsense', body, { now }), false);
});

test('personal data is removed at every depth unless allowed', () => {
  const out = stripPersonal({ quotation_no: 'Q1', contact_person: 'Asha', sales_person: 'Ravi', lines: [{ contact_email: 'a@b.c', amount: 5 }] });
  assert.deepEqual(out, { quotation_no: 'Q1', lines: [{ amount: 5 }] });
});

test('retries back off and stop within a day', () => {
  const total = BACKOFF_MINUTES.reduce((a, b) => a + b, 0);
  assert.ok(total <= 24 * 60, `${total} minutes`);
  assert.deepEqual([...BACKOFF_MINUTES].sort((a, b) => a - b), BACKOFF_MINUTES);
});

/**
 * Where a delivery may be sent (#49, review of batch 5).
 *
 * The scheme check was the whole of it, so loopback, the private ranges,
 * the cloud metadata address and a bare container hostname were all valid
 * endpoints — and the response code and first 2 KB of body come back
 * through the deliveries API, which makes an endpoint a readable probe of
 * whatever the container can reach. The resolver is injected here, so
 * these assert the rule and never touch the network.
 */
const resolves = (...ips) => async () => ips.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

test('an address on a private network is refused, whichever way it is written', async () => {
  const { checkDestination, isPrivateAddress } = await import('../src/lib/webhooks.js');
  for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.4.1', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '::1', '::ffff:127.0.0.1', 'fd00::1', 'fe80::1']) {
    assert.equal(isPrivateAddress(ip), true, `${ip} should be refused`);
  }
  for (const ip of ['1.1.1.1', '8.8.8.8', '20.190.128.1', '2606:4700::1111']) {
    assert.equal(isPrivateAddress(ip), false, `${ip} should be allowed`);
  }
  assert.match(await checkDestination('https://169.254.169.254/latest/meta-data/'), /private address/);
  assert.match(await checkDestination('https://[::1]/hook'), /private address/);
});

test('the resolved address is judged, not the host name', async () => {
  const { checkDestination } = await import('../src/lib/webhooks.js');
  // A name anyone can register, pointed at the network the container is on.
  assert.match(await checkDestination('https://inside.example.com/hook', { resolve: resolves('10.1.2.3') }), /10\.1\.2\.3.*private/);
  // One address public and one private is still a refusal.
  assert.match(await checkDestination('https://mixed.example.com/hook', { resolve: resolves('93.184.216.34', '127.0.0.1') }), /private/);
  assert.equal(await checkDestination('https://hooks.example.com/x', { resolve: resolves('93.184.216.34') }), null);
});

test('a bare container name is not a destination', async () => {
  const { checkDestination } = await import('../src/lib/webhooks.js');
  for (const url of ['https://traefik/hook', 'https://postgres.internal/hook', 'https://api.local/hook']) {
    assert.match(await checkDestination(url), /not a public host name/);
  }
});

test('a name that does not resolve is refused at delivery and allowed when saved', async () => {
  const { checkDestination } = await import('../src/lib/webhooks.js');
  const dead = async () => { throw new Error('ENOTFOUND'); };
  assert.match(await checkDestination('https://not-yet.example.com/x', { resolve: dead }), /does not resolve/);
  assert.equal(await checkDestination('https://not-yet.example.com/x', { resolve: dead, requireResolvable: false }), null);
});
