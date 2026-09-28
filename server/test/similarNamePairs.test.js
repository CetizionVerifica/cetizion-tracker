import { test } from 'node:test';
import assert from 'node:assert/strict';
import { similarName, similarNamePairs } from '../src/lib/names.ts';

// Finding look-alike company names without comparing every name with every
// other. The answer must stay exactly what comparing them all would give.

/** What the page did before: every pair, in order. */
const everyPair = (names) => {
  const pairs = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) if (similarName(names[i], names[j])) pairs.push([i, j]);
  }
  return pairs;
};

const NAMES = [
  'Hindalco Alupuram', 'Hindalco - Alupuram', 'Hindalco Industries Alupuram unit', 'Hindalco Renukoot',
  'Hetero', 'hetero ', 'Hetero Labs Limited', 'Hetero Drugs Pvt Ltd',
  'Laurus Labs', 'Laurus Labs Pvt Ltd', 'Divis Laboratories', "Divi's Laboratories Ltd",
  'Midal Cables', 'Midal Cables International', 'Vedanta', 'Vedanta Aluminium', 'Balco',
  'Tata Steel', 'Tata Motors', 'JSW Steel', 'Sunsourceenergy', 'Sun Source Energy',
  '', '   ', 'A', 'AB',
];

test('the shortlist finds exactly what comparing every pair finds', () => {
  assert.deepEqual(similarNamePairs(NAMES), everyPair(NAMES));
});

test('the same holds for awkward lists: empty, single, all identical', () => {
  for (const names of [[], ['Hetero'], ['Hetero', 'Hetero', 'Hetero'], ['', '', 'Hetero'], ['A', 'B', 'C']]) {
    assert.deepEqual(similarNamePairs(names), everyPair(names), JSON.stringify(names));
  }
});

test('a name written as one word still matches the spaced spelling', () => {
  assert.deepEqual(similarNamePairs(['Sunsourceenergy', 'Sun Source Energy']), [[0, 1]]);
});

test('different clients that share only a generic word are not paired', () => {
  assert.deepEqual(similarNamePairs(['Tata Steel', 'JSW Steel', 'Laurus Labs', 'Hetero Labs']), []);
});

test('a real-sized list is compared in a fraction of the time', () => {
  // 600 companies: every pair is 179,700 comparisons of freshly split strings.
  const many = Array.from({ length: 600 }, (_, i) => `Company ${i} ${'ABCDEFGH'[i % 8]}industries`);
  many.push('Hindalco Alupuram', 'Hindalco - Alupuram');
  const started = Date.now();
  const pairs = similarNamePairs(many);
  const took = Date.now() - started;
  assert.ok(pairs.some(([i, j]) => many[i].startsWith('Hindalco') && many[j].startsWith('Hindalco')));
  assert.ok(took < 500, `took ${took}ms`);
});
