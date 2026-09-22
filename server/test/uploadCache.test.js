import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UploadCache } from '../src/import/uploadCache.js';

// The uploaded sheets held in memory between an upload and its commit.

const sheet = (n) => Buffer.alloc(n, 1);
/** A cache with a clock the test moves by hand. */
const withClock = (opts = {}) => {
  let t = 0;
  const cache = new UploadCache({ ...opts, now: () => t });
  return { cache, tick: (ms) => { t += ms; } };
};

test('an uploaded sheet is there to re-plan with, until it is dropped', () => {
  const { cache } = withClock();
  cache.set(1, sheet(10));
  assert.equal(cache.get(1).length, 10);
  cache.delete(1);
  assert.equal(cache.get(1), undefined);
});

test('an upload nobody came back to is forgotten after the time to live', () => {
  const { cache, tick } = withClock({ ttlMs: 60_000 });
  cache.set(1, sheet(10));
  tick(59_000);
  assert.ok(cache.get(1), 'still within the hour someone might re-plan');
  tick(2_000);
  assert.equal(cache.get(1), undefined);
  assert.equal(cache.size, 0);
});

test('only so many uploads are held at once; the oldest goes first', () => {
  const { cache, tick } = withClock({ maxEntries: 2 });
  cache.set(1, sheet(10)); tick(1);
  cache.set(2, sheet(10)); tick(1);
  cache.set(3, sheet(10));
  assert.deepEqual([...cache.entries.keys()], [2, 3]);
});

test('re-uploading the same batch refreshes it rather than ageing out mid-review', () => {
  const { cache, tick } = withClock({ ttlMs: 60_000 });
  cache.set(1, sheet(10));
  tick(50_000);
  cache.set(1, sheet(20));
  tick(50_000);
  assert.equal(cache.get(1).length, 20);
});

test('it can say how much it is holding', () => {
  const { cache } = withClock();
  cache.set(1, sheet(1024));
  cache.set(2, sheet(2048));
  assert.equal(cache.bytes(), 3072);
});
