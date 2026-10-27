import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeMessage, sumMoved } from '../src/lib/companyMerge.js';

/**
 * Folding one company into another rewrites the client name on every record
 * behind it and deletes the loser, with no undo. The route has always
 * reported what it moved; before #103 both merge screens dropped it, so a
 * merge into the wrong company read exactly like a correct one.
 *
 * What is worth pinning here is the wording rather than the arithmetic. The
 * route returns all three counts every time, zeroes included, so an
 * unfiltered summary reads "moved 0 quotations, 0 enquiries, 6 projects"; and
 * a merge is not allowed to surface as a failure over the shape of its own
 * receipt, which is what a thrown TypeError on a missing `moved` would do.
 */

const base = 'Acme Ltd merged into ABC Pvt Ltd';

test('every count that moved is named, in the order the route moves them', () => {
  assert.equal(
    mergeMessage(base, { quotations: 6, enquiries: 4, projects: 2 }),
    `${base} — moved 6 quotations, 4 enquiries, 2 projects`,
  );
});

test('object order does not decide reading order', () => {
  // The route builds `moved` by looping quotations, enquiries, projects, but
  // the message should read the same either way round.
  assert.equal(
    mergeMessage(base, { projects: 2, enquiries: 4, quotations: 6 }),
    `${base} — moved 6 quotations, 4 enquiries, 2 projects`,
  );
});

test('one category is the only thing said', () => {
  assert.equal(mergeMessage(base, { quotations: 0, enquiries: 0, projects: 3 }), `${base} — moved 3 projects`);
});

test('zeroes are left out rather than listed', () => {
  // "moved 0 quotations, 0 enquiries, 6 projects" is three facts where one
  // was wanted. The route sends all three keys on every merge.
  assert.equal(mergeMessage(base, { quotations: 0, enquiries: 4, projects: 0 }), `${base} — moved 4 enquiries`);
});

test('a single row of a kind is singular', () => {
  assert.equal(
    mergeMessage(base, { quotations: 1, enquiries: 1, projects: 1 }),
    `${base} — moved 1 quotation, 1 enquiry, 1 project`,
  );
});

test('a merge that moved nothing keeps the plain message', () => {
  // A duplicate spelling with no records behind it. There is no summary to
  // give, and an empty "— moved" would look like one went missing.
  assert.equal(mergeMessage(base, { quotations: 0, enquiries: 0, projects: 0 }), base);
  assert.equal(mergeMessage(base, {}), base);
});

test('a missing or malformed moved never fails the merge it describes', () => {
  // The merge already happened and cannot be undone. Whatever shape the
  // receipt arrives in, the toast still says the merge succeeded.
  for (const moved of [undefined, null, 0, '', 'quotations', 7, [], [1, 2], NaN, { quotations: null }, { quotations: 'six' }, { quotations: NaN }, { quotations: -3 }, { quotations: 1.5 }]) {
    assert.equal(mergeMessage(base, moved), base, `malformed moved changed the message: ${JSON.stringify(moved)}`);
  }
});

test('large counts are grouped the way the rest of the app groups numbers', () => {
  // number() uses en-IN, so this is 1,234 and 1,00,000.
  assert.equal(mergeMessage(base, { quotations: 1234 }), `${base} — moved 1,234 quotations`);
  assert.equal(mergeMessage(base, { enquiries: 100000 }), `${base} — moved 1,00,000 enquiries`);
});

test('a table the route starts moving later is still named', () => {
  // Unhumanised, but saying "4 purchase_orders" beats saying nothing, and it
  // lands after the three the route moves today.
  assert.equal(
    mergeMessage(base, { quotations: 2, purchase_orders: 4 }),
    `${base} — moved 2 quotations, 4 purchase_orders`,
  );
});

test('no message ever carries a dash, undefined or null where a count belongs', () => {
  const cases = [{ quotations: 6, enquiries: 4, projects: 2 }, { projects: 1 }, {}, undefined, null, { quotations: null }, { enquiries: 'four' }];
  for (const moved of cases) {
    const message = mergeMessage(base, moved);
    assert.doesNotMatch(message, /—\s+moved\s*$/, `an empty summary was promised: ${message}`);
    assert.doesNotMatch(message, /undefined|null|NaN/, `a non-value reached the toast: ${message}`);
  }
});

/* --------------------------------------------------- several merges at once */

/**
 * The Companies screen folds every ticked spelling into the survivor with one
 * request each, and reports the lot in a single toast, so the counts of those
 * separate merges have to be added before they are worded.
 */

test('the counts of several merges are added up per table', () => {
  const summed = sumMoved([
    { merged: 'Acme', into: 'ABC', moved: { quotations: 6, enquiries: 4, projects: 0 } },
    { merged: 'Acme Ltd.', into: 'ABC', moved: { quotations: 1, enquiries: 0, projects: 2 } },
  ]);
  assert.deepEqual(summed, { quotations: 7, enquiries: 4, projects: 2 });
  assert.equal(mergeMessage('2 spellings folded into ABC', summed), '2 spellings folded into ABC — moved 7 quotations, 4 enquiries, 2 projects');
});

test('one merge sums to its own counts', () => {
  assert.deepEqual(sumMoved([{ moved: { quotations: 3 } }]), { quotations: 3 });
});

test('merges that moved nothing sum to nothing, and say nothing', () => {
  const summed = sumMoved([{ moved: { quotations: 0, enquiries: 0, projects: 0 } }, { moved: {} }]);
  assert.deepEqual(summed, {});
  assert.equal(mergeMessage('2 spellings folded into ABC', summed), '2 spellings folded into ABC');
});

test('a result with no usable moved is skipped rather than poisoning the total', () => {
  // api.action answers null for a 204 and for a body that would not parse, so
  // a result in this list can be undefined while the merge itself succeeded.
  const summed = sumMoved([
    { moved: { quotations: 2 } },
    undefined,
    null,
    {},
    { moved: null },
    { moved: 'quotations' },
    { moved: { quotations: 'two', enquiries: 3 } },
  ]);
  assert.deepEqual(summed, { quotations: 2, enquiries: 3 });
});

test('a missing or non-array list of results sums to nothing', () => {
  for (const results of [undefined, null, {}, 'nope', 0]) {
    assert.deepEqual(sumMoved(results), {}, `unexpected total for ${JSON.stringify(results)}`);
  }
});
