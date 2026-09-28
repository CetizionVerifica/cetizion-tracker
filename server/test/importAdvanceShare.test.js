import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advanceShare, mergeAiRow } from '../src/import/ai.js';

// Reading the advance share out of a row's remarks, without the model.

test('a percentage next to an advance word is the advance', () => {
  for (const [text, percent] of [
    ['Invoice shared for 30% adv', 30],
    ['40% advance received', 40],
    ['Invoice shared for 20% adv - 1,59,300/- | TDS deducted', 20],
    ['25% on PO, balance on delivery', 25],
    ['10 percent upfront', 10],
  ]) {
    assert.equal(advanceShare(text).percent, percent, text);
  }
});

test('a tax, discount or interest percentage is never the advance', () => {
  for (const text of [
    '18% GST extra',
    'GST 18% as applicable',
    'TDS 2% deducted',
    'Rate includes 5% discount',
    'Interest 2% per month after due date',
    '1% retention till closure',
  ]) {
    assert.equal(advanceShare(text).percent, null, text);
  }
});

test('the advance wins over a tax percentage in the same remark', () => {
  assert.equal(advanceShare('30% advance, 18% GST extra').percent, 30);
  assert.equal(advanceShare('18% GST | 50% adv on PO').percent, 50);
});

test('a lone percentage with no other clue is still read as the advance', () => {
  assert.equal(advanceShare('Invoice shared for 30%').percent, 30);
});

test('several unexplained percentages are left for a person', () => {
  const share = advanceShare('30% and 40% as agreed');
  assert.equal(share.percent, null);
  assert.equal(share.unclear, true);
});

test('100%, 0% and text without a percentage give nothing', () => {
  for (const text of ['100% on completion', '0% advance', 'Payment as per terms', '']) {
    assert.equal(advanceShare(text).percent, null, text);
  }
});

// What the AI review does to that reading. A model that states a share
// replaces it; one that returns null cannot be told apart from one that simply
// missed it, so the reading stands and the disagreement is flagged.

const hint = (advance_percent = null, flags = []) => ({ advance_percent, flags });
const codes = (h) => h.flags.map((f) => f.code);

test('the AI confirming or correcting the share just sets it, with nothing to review', () => {
  assert.equal(mergeAiRow(hint(30), { advance_percent: 30 }).advance_percent, 30);
  const corrected = mergeAiRow(hint(30), { advance_percent: 20 });
  assert.equal(corrected.advance_percent, 20);
  assert.deepEqual(codes(corrected), []);
});

test('a null from the AI keeps the share and flags it for review', () => {
  const merged = mergeAiRow(hint(30), { advance_percent: null });
  assert.equal(merged.advance_percent, 30, 'the reading is kept');
  assert.deepEqual(codes(merged), ['advance_percent_unconfirmed']);
  assert.match(merged.flags[0].message, /30% advance; the AI review found none/);
  assert.equal(merged.flags[0].level, 'warn');
  assert.equal(merged.flags[0].by, 'ai');
});

test('an unusable percentage from the AI is treated as no answer, not as a value', () => {
  for (const advance_percent of [0, 100, 'thirty', undefined, -5]) {
    const merged = mergeAiRow(hint(30), { advance_percent });
    assert.equal(merged.advance_percent, 30, String(advance_percent));
    assert.deepEqual(codes(merged), ['advance_percent_unconfirmed'], String(advance_percent));
  }
});

test('with no share read from the text there is nothing to disagree about', () => {
  const merged = mergeAiRow(hint(null), { advance_percent: null });
  assert.equal(merged.advance_percent, null);
  assert.deepEqual(codes(merged), []);
});

test('the flag is added once, and the AI\'s own flags still come through', () => {
  const h = hint(30);
  mergeAiRow(h, { advance_percent: null, flags: [{ code: 'signed_quote_as_po', message: 'Client signed the quote' }] });
  mergeAiRow(h, { advance_percent: null });
  assert.deepEqual(codes(h), ['advance_percent_unconfirmed', 'signed_quote_as_po']);
});
