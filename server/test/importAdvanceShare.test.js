import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advanceShare } from '../src/import/ai.js';

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
