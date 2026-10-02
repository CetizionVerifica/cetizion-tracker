/**
 * Read a batch of emails a few at a time.
 *
 * Nearly all the time an email takes is its AI call, and the readers used
 * to wait for one email's call before starting the next, so a year of past
 * mail took days. Now emails that could touch the same record — one
 * client's (by domain), one conversation's — share a lane and are read one
 * after another in the order given, so the older email still decides
 * first. Separate lanes run side by side, at most `concurrency` at once.
 *
 * Each reader's transaction also locks per message and per client or
 * number, as it always has for the live sync and the backfill meeting on
 * one email; lanes keep the order, the locks keep the records whole.
 */
import { domainOf } from './rules.js';

/** A candidate's lane keys: its conversation, and the domain of the client on the other side. */
export function laneKeys({ m, c }) {
  const people = c?.direction === 'outbound' ? (c.external || []).map((p) => p.email) : [m?.from?.email];
  return [
    m?.conversation_id && `conversation:${m.conversation_id}`,
    ...people.filter(Boolean).map((e) => `party:${domainOf(e) || String(e).toLowerCase()}`),
  ];
}

/** The candidates grouped into lanes: any shared key puts two in one lane. Order is kept within each. */
export function lanesOf(items, keysOf) {
  const parent = new Map();
  const find = (k) => {
    while (parent.get(k) !== k) { parent.set(k, parent.get(parent.get(k))); k = parent.get(k); }
    return k;
  };
  const keyed = items.map((item) => {
    const keys = [...new Set(keysOf(item).filter(Boolean))];
    for (const k of keys) if (!parent.has(k)) parent.set(k, k);
    for (const k of keys.slice(1)) { const a = find(keys[0]); const b = find(k); if (a !== b) parent.set(b, a); }
    return keys;
  });
  const lanes = new Map();
  items.forEach((item, i) => {
    const lane = keyed[i].length ? find(keyed[i][0]) : Symbol('alone');
    if (!lanes.has(lane)) lanes.set(lane, []);
    lanes.get(lane).push(item);
  });
  return [...lanes.values()];
}

/**
 * Run `each(item)` over the items, lane by lane, `concurrency` lanes at a
 * time, until `stopped()` says so. `each` must not throw: the readers catch
 * and count their own failures. With a concurrency of 1 the items run in
 * the order given, exactly as before.
 */
export async function inLanes(items, { concurrency = 1, keysOf = laneKeys, stopped = () => false, each }) {
  if (concurrency <= 1) {
    for (const item of items) {
      if (stopped()) return;
      await each(item);
    }
    return;
  }
  const queue = lanesOf(items, keysOf);
  const worker = async () => {
    for (let lane = queue.shift(); lane; lane = queue.shift()) {
      for (const item of lane) {
        if (stopped()) return;
        await each(item);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
}
