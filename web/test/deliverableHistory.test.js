import { test } from 'node:test';
import assert from 'node:assert/strict';
import { earlierLabel, reissueChain } from '../src/lib/deliverableHistory.js';

/**
 * GET /api/deliverables/:id has always returned the supersede chain as
 * `history`; before #103 item 6 nothing in web/src asked for it, so the
 * register showed a one-hop "by CERT-2026-003" and no way to see the rest.
 *
 * The payloads below are the real ones, captured from the local API against
 * a three-step chain built through POST /deliverables and two
 * /supersede calls — not invented shapes. The two facts worth pinning are
 * the route's, not the browser's: `superseded_by_id` points old → new, and
 * `history` carries ancestors only and never the record you asked for. A
 * dialog that assumed otherwise would present half a chain as the whole one.
 */

// GET /api/deliverables/3 — the newest issue of 1 → 2 → 3.
const CURRENT = {
  id: 3, reference: 'ITEM6 TEST CERT-2026-003', status: 'issued',
  issued_on: '2026-01-05', valid_until: '2027-01-04', document_id: null,
  superseded_by_id: null, notes: null, created_by: 'admin', engagement_id: 1,
  history: [
    { id: 2, reference: 'ITEM6 TEST CERT-2025-002', status: 'superseded', issued_on: '2025-01-10', valid_until: '2025-12-31', document_id: null },
    { id: 1, reference: 'ITEM6 TEST CERT-2024-001', status: 'superseded', issued_on: '2024-01-15', valid_until: '2024-12-31', document_id: null },
  ],
};

test('the newest issue shows itself and every issue it replaced', () => {
  const { current, earlier, supersededById } = reissueChain(CURRENT);
  assert.equal(current.id, 3);
  assert.equal(current.current, true, 'the opened record is marked as the one being viewed');
  assert.deepEqual(earlier.map((e) => e.id), [2, 1]);
  assert.equal(supersededById, null, 'the newest issue has no successor');
});

test('the record asked for is never repeated among the earlier ones', () => {
  // The route seeds its recursion with `superseded_by_id = $1`, so `history`
  // is ancestors only. Listing the current one twice would invent an issue.
  const { earlier } = reissueChain(CURRENT);
  assert.ok(!earlier.some((e) => e.id === 3), 'the current issue leaked into the earlier list');
  assert.ok(earlier.every((e) => e.current === false));
});

test('order is the route\'s own, not a second opinion', () => {
  // ORDER BY valid_until DESC NULLS LAST: most recent predecessor first.
  const { earlier } = reissueChain(CURRENT);
  assert.deepEqual(earlier.map((e) => e.reference), ['ITEM6 TEST CERT-2025-002', 'ITEM6 TEST CERT-2024-001']);
});

test('one reissue back is a single earlier entry', () => {
  // GET /api/deliverables/2 — the middle of the same chain.
  const { current, earlier, supersededById } = reissueChain({
    id: 2, reference: 'ITEM6 TEST CERT-2025-002', status: 'superseded',
    issued_on: '2025-01-10', valid_until: '2025-12-31', document_id: null,
    superseded_by_id: 3,
    history: [{ id: 1, reference: 'ITEM6 TEST CERT-2024-001', status: 'superseded', issued_on: '2024-01-15', valid_until: '2024-12-31', document_id: null }],
  });
  assert.equal(current.id, 2);
  assert.deepEqual(earlier.map((e) => e.id), [1]);
  // The newer issue 3 is absent, because the route does not walk forwards.
  // supersededById is how the dialog knows to say so rather than imply this
  // is the end of the chain.
  assert.equal(supersededById, 3);
});

test('the first issue of a chain has no history, and that is not an error', () => {
  // GET /api/deliverables/1 — history is [] even though it was superseded.
  const { current, earlier, supersededById } = reissueChain({
    id: 1, reference: 'ITEM6 TEST CERT-2024-001', status: 'superseded',
    issued_on: '2024-01-15', valid_until: '2024-12-31', document_id: null,
    superseded_by_id: 2, history: [],
  });
  assert.equal(current.id, 1);
  assert.deepEqual(earlier, []);
  assert.equal(supersededById, 2);
});

test('a certificate never reissued shows itself and nothing else', () => {
  const { current, earlier, supersededById } = reissueChain({
    id: 9, reference: 'CERT-ONLY', status: 'issued', issued_on: '2026-02-01',
    valid_until: '2027-02-01', document_id: null, superseded_by_id: null, history: [],
  });
  assert.equal(current.id, 9);
  assert.deepEqual(earlier, []);
  assert.equal(supersededById, null);
});

test('only the fields the endpoint returns for a chain member are carried', () => {
  // The detail response is SELECT *, so it also holds notes, created_by and
  // engagement_id. A reissue history has no reason to surface those, and the
  // register never has.
  const { current } = reissueChain(CURRENT);
  assert.deepEqual(Object.keys(current).sort(), ['current', 'document_id', 'id', 'issued_on', 'reference', 'status', 'valid_until']);
  for (const leaked of ['notes', 'created_by', 'engagement_id', 'superseded_by_id']) {
    assert.ok(!(leaked in current), `${leaked} reached the dialog`);
  }
});

test('a file is carried as an id only when it is a real one', () => {
  const [withFile] = reissueChain({ id: 1, history: [{ id: 2, document_id: 44 }] }).earlier;
  assert.equal(withFile.document_id, 44);
  for (const document_id of [null, undefined, '44', 0.5, NaN, {}]) {
    const [e] = reissueChain({ id: 1, history: [{ id: 2, document_id }] }).earlier;
    assert.equal(e.document_id, null, `unusable document_id became a link: ${String(document_id)}`);
  }
});

test('a blank reference is null rather than empty-looking text', () => {
  // reference is nullable in the schema, so a chain member can have none.
  for (const reference of [null, undefined, '', '   ', 7, {}]) {
    const [e] = reissueChain({ id: 1, history: [{ id: 2, reference }] }).earlier;
    assert.equal(e.reference, null, `unusable reference survived: ${String(reference)}`);
  }
  const [trimmed] = reissueChain({ id: 1, history: [{ id: 2, reference: '  CERT-7  ' }] }).earlier;
  assert.equal(trimmed.reference, 'CERT-7');
});

test('a malformed or missing payload is an empty chain, never a throw', () => {
  // A failed fetch leaves data null. This dialog is read-only and sits beside
  // the register; it must not be able to take the list down with it.
  for (const detail of [undefined, null, 0, '', 'nope', [], [{ id: 1 }], {}, { id: null }, { id: '3' }, { id: 1.5 }]) {
    const chain = reissueChain(detail);
    assert.deepEqual(chain, { current: null, earlier: [], supersededById: null }, `unexpected chain for ${JSON.stringify(detail)}`);
  }
});

test('a history that is not an array, or holds junk, degrades to what is usable', () => {
  for (const history of [null, undefined, 'CERT-1', 42, { 0: { id: 2 } }]) {
    assert.deepEqual(reissueChain({ id: 1, history }).earlier, [], `junk history produced entries: ${String(history)}`);
  }
  // A good member beside unusable ones is still shown; the rest are dropped
  // rather than rendered as blank rows with no key.
  const { earlier } = reissueChain({ id: 1, history: [null, { id: 2, reference: 'CERT-2' }, 'x', {}, { id: '3' }, []] });
  assert.deepEqual(earlier.map((e) => e.id), [2]);
});

test('a successor id is only reported when it is a real id', () => {
  for (const superseded_by_id of [null, undefined, '2', 0.5, NaN]) {
    assert.equal(reissueChain({ id: 1, superseded_by_id, history: [] }).supersededById, null);
  }
  assert.equal(reissueChain({ id: 1, superseded_by_id: 2, history: [] }).supersededById, 2);
});

/* ------------------------------------------------------------- the heading */

test('the earlier-issues heading counts and pluralises', () => {
  assert.equal(earlierLabel(1), '1 earlier issue');
  assert.equal(earlierLabel(2), '2 earlier issues');
  assert.equal(earlierLabel(11), '11 earlier issues');
});

test('no earlier issues gets a plain heading, not "0 earlier issues"', () => {
  for (const count of [0, -1, null, undefined, 'two', 1.5, NaN]) {
    assert.equal(earlierLabel(count), 'Earlier issues', `unexpected heading for ${String(count)}`);
  }
});

test('no heading ever carries undefined, null or NaN', () => {
  for (const count of [0, 1, 2, 11, null, undefined, NaN, 'two']) {
    assert.doesNotMatch(earlierLabel(count), /undefined|null|NaN/);
  }
});
