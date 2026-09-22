import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextId } from '../src/lib/sequences.js';

// The numbers the import review shows come from nextId, the same preview the
// forms use, so they are this year's series and match what a save will take.
// Reading the highest number across every year showed one already in use.

/** A stand-in database holding one series' records and its counter. */
const db = ({ refs = [], counter = null }) => ({
  async query(sql, params) {
    if (/FROM sequence_counters/.test(sql)) return { rows: counter === null ? [] : [{ last_n: counter }] };
    const prefix = params[0].replace(/%$/, '');
    return { rows: refs.filter((r) => r.startsWith(prefix)).map((value) => ({ value })) };
  },
});

test('last year is left where it is: a new year starts again at 001', async () => {
  const refs = ['CTZ/QT/2025/061', 'CTZ/QT/2025/062', 'CTZ/QT/2026/003'];
  assert.equal(await nextId('quotation', db({ refs }), '2026'), 'CTZ/QT/2026/004');
  assert.equal(await nextId('quotation', db({ refs: ['CTZ/QT/2025/062'] }), '2026'), 'CTZ/QT/2026/001');
});

test('the counter counts too, so a number handed out is never offered again', async () => {
  // The record for 007 was deleted; the counter remembers it was issued.
  assert.equal(await nextId('project', db({ refs: ['PRJ-2026-005'], counter: 7 }), '2026'), 'PRJ-2026-008');
});

test('projects and quotations each read their own series', async () => {
  const refs = ['PRJ-2026-012', 'CTZ/QT/2026/090'];
  assert.equal(await nextId('project', db({ refs }), '2026'), 'PRJ-2026-013');
  assert.equal(await nextId('quotation', db({ refs }), '2026'), 'CTZ/QT/2026/091');
});
