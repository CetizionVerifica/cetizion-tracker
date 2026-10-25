import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MIN_ROWS, keepPlace, rowsThatFit } from '../src/lib/pageFit.js';

/**
 * The inbox shows one screen of emails and pages for the rest (#250). These
 * are the two sums that decide what "one screen" is and where a resize
 * leaves you.
 */

test('a page holds as many whole rows as the box has room for', () => {
  assert.equal(rowsThatFit(800, 100), 8);
  assert.equal(rowsThatFit(899, 100), 8, 'a row that would be cut off is left for the next page');
  assert.equal(rowsThatFit(900, 100), 9);
});

test('a very short window still lists something', () => {
  assert.equal(rowsThatFit(120, 100), MIN_ROWS);
  assert.equal(rowsThatFit(120, 100, 2), 2);
});

test('a box that has not been laid out yet is not a page of none', () => {
  assert.equal(rowsThatFit(0, 100), MIN_ROWS);
  assert.equal(rowsThatFit(Number.NaN, 100), MIN_ROWS);
  assert.equal(rowsThatFit(800, 0), MIN_ROWS);
});

test('a resize keeps the conversation that was at the top on screen', () => {
  // Page 3 of 8 starts at row 17. With 12 a page, row 17 is on page 2 (13–24).
  assert.equal(keepPlace(3, 8, 12), 2);
  // Page 2 of 12 starts at row 13. With 8 a page, row 13 is on page 2 (9–16).
  assert.equal(keepPlace(2, 12, 8), 2);
  // Page 4 of 6 starts at row 19. With 5 a page, row 19 is on page 4 (16–20).
  assert.equal(keepPlace(4, 6, 5), 4);
});

test('the first page stays the first page, and an unchanged size changes nothing', () => {
  assert.equal(keepPlace(1, 8, 12), 1);
  assert.equal(keepPlace(1, 12, 5), 1);
  assert.equal(keepPlace(5, 7, 7), 5);
  assert.equal(keepPlace(5, null, 7), 5, 'no earlier size: nothing to keep');
});
