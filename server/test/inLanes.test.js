import assert from 'node:assert/strict';
import test from 'node:test';
import { inLanes, laneKeys, lanesOf } from '../src/lib/mailbox/inLanes.js';

/**
 * The email readers read a few emails at once, one client's and one
 * conversation's in order (src/lib/mailbox/inLanes.js). No database.
 */

const inbound = (id, email, conv = `c-${id}`) => ({ id, m: { conversation_id: conv, from: { email } }, c: { direction: 'inbound' } });
const outbound = (id, emails, conv = `c-${id}`) => ({ id, m: { conversation_id: conv }, c: { direction: 'outbound', external: emails.map((email) => ({ email })) } });
const ids = (lanes) => lanes.map((l) => l.map((x) => x.id));
const tick = () => new Promise((r) => setImmediate(r));

test('laneKeys: the conversation and the client\'s domain; for mail we sent, every client addressed', () => {
  assert.deepEqual(laneKeys(inbound(1, 'Ravi@Acme.co.in', 'conv-1')), ['conversation:conv-1', 'party:acme.co.in']);
  assert.deepEqual(laneKeys(outbound(2, ['a@one.com', 'b@two.com'], 'conv-2')), ['conversation:conv-2', 'party:one.com', 'party:two.com']);
});

test('lanesOf: one client\'s mail shares a lane, in the order given; a shared conversation joins two clients', () => {
  const items = [
    inbound(1, 'a@acme.com'), inbound(2, 'x@other.com'), inbound(3, 'b@acme.com'),
    inbound(4, 'y@third.com', 'shared'), inbound(5, 'z@fourth.com', 'shared'), inbound(6, 'q@fourth.com'),
  ];
  assert.deepEqual(ids(lanesOf(items, laneKeys)), [[1, 3], [2], [4, 5, 6]]);
});

test('inLanes: at most `concurrency` at once, and a lane never overlaps itself', async () => {
  const items = [inbound(1, 'a@acme.com'), inbound(2, 'b@acme.com'), inbound(3, 'x@two.com'), inbound(4, 'y@three.com'), inbound(5, 'z@four.com')];
  let running = 0; let most = 0; const acmeRunning = new Set(); const order = [];
  await inLanes(items, {
    concurrency: 3,
    each: async (item) => {
      running += 1; most = Math.max(most, running);
      if (item.id <= 2) { assert.equal(acmeRunning.size, 0, 'acme\'s two never run together'); acmeRunning.add(item.id); }
      await tick(); await tick();
      order.push(item.id); acmeRunning.delete(item.id); running -= 1;
    },
  });
  assert.equal(most, 3);
  assert.deepEqual([...order].sort(), [1, 2, 3, 4, 5]);
  assert.ok(order.indexOf(1) < order.indexOf(2), 'the older acme email first');
});

test('inLanes: stops taking new emails once stopped, and with a concurrency of 1 keeps the given order', async () => {
  const items = [1, 2, 3, 4, 5, 6].map((n) => inbound(n, `p@d${n}.com`));
  const done = [];
  await inLanes(items, { concurrency: 2, stopped: () => done.length >= 2, each: async (item) => { await tick(); done.push(item.id); } });
  assert.ok(done.length <= 3, `stopped early: ${done}`);

  const seq = [];
  await inLanes([inbound(1, 'a@acme.com'), inbound(2, 'x@two.com'), inbound(3, 'b@acme.com')], { concurrency: 1, each: async (item) => { seq.push(item.id); } });
  assert.deepEqual(seq, [1, 2, 3]);
});
