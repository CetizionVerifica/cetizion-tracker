import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityTitle } from '../src/lib/timelineTitle.js';

/**
 * GET /api/timeline has always answered `{ data: [...], open_tasks: n }`.
 * Before #103 item 7 the Activity card rendered a static title and dropped
 * `open_tasks`, so whether anything was outstanding on a record could only
 * be learnt by reading every row.
 *
 * The count is the server's. The rows on screen merge notes, files, emails,
 * touches and milestones with the tasks, and the card's filter narrows them,
 * so counting what is visible would answer a different question. What is
 * worth pinning here is the wording: a plural "1 open tasks", or a zero
 * announced where the title used to be clean, is the kind of thing that
 * reads as correct until somebody sees it on a page.
 */

test('no open tasks keeps the plain title', () => {
  // Also the filtered case: asking for only notes means no task was counted,
  // not that none exists, so announcing a zero would be wrong twice over.
  assert.equal(activityTitle('Activity', 0), 'Activity');
});

test('one open task is singular', () => {
  assert.equal(activityTitle('Activity', 1), 'Activity · 1 open task');
});

test('more than one is plural', () => {
  assert.equal(activityTitle('Activity', 2), 'Activity · 2 open tasks');
  assert.equal(activityTitle('Activity', 11), 'Activity · 11 open tasks');
});

test('a missing count is not announced at all', () => {
  // While the fetch is in flight `data` is null, so the card asks with
  // undefined and must render exactly the title it always had.
  assert.equal(activityTitle('Activity', undefined), 'Activity');
  assert.equal(activityTitle('Activity', null), 'Activity');
  assert.equal(activityTitle('Activity'), 'Activity');
});

test('a count that is not a whole number above zero says nothing', () => {
  for (const openTasks of ['2', '', 'two', 1.5, -1, -0, NaN, Infinity, true, [], [2], {}, () => 2]) {
    assert.equal(activityTitle('Activity', openTasks), 'Activity', `unusable count reached the title: ${String(openTasks)}`);
  }
});

test('a title the caller overrides keeps its own wording', () => {
  // The prop exists, so the count has to compose with whatever it is given
  // rather than hard-coding "Activity".
  assert.equal(activityTitle('History', 3), 'History · 3 open tasks');
  assert.equal(activityTitle('History', 0), 'History');
});

test('an unusable title falls back to the card\'s own default', () => {
  // Not invention: 'Activity' is the Timeline prop default, so a caller that
  // passes nothing usable gets the heading the card has always shown rather
  // than "null · 2 open tasks".
  for (const title of [undefined, null, '', '   ', 7, {}, []]) {
    assert.equal(activityTitle(title, 2), 'Activity · 2 open tasks', `unusable title survived: ${String(title)}`);
    assert.equal(activityTitle(title, 0), 'Activity', `unusable title survived at zero: ${String(title)}`);
  }
});

test('a padded title is trimmed rather than left with a gap before the dot', () => {
  assert.equal(activityTitle('  Activity  ', 2), 'Activity · 2 open tasks');
});

test('no title ever carries undefined, null or NaN', () => {
  const counts = [0, 1, 2, 11, undefined, null, NaN, '3', -4, 1.5];
  const titles = ['Activity', 'History', undefined, null, '', 7];
  for (const openTasks of counts) {
    for (const title of titles) {
      const out = activityTitle(title, openTasks);
      assert.equal(typeof out, 'string');
      assert.doesNotMatch(out, /undefined|null|NaN|Infinity/, `a non-value reached the title: ${out}`);
      assert.doesNotMatch(out, /·\s*$/, `a dangling separator was left: ${out}`);
      assert.doesNotMatch(out, /\b0 open/, `a zero was announced: ${out}`);
    }
  }
});

test('the separator matches the Tasks page, which shows the same count', () => {
  // pages/Tasks.jsx subtitles with `${s.open} open · ${s.overdue} overdue`
  // from /api/tasks/summary. Same word, same middle dot, counts ungrouped.
  assert.match(activityTitle('Activity', 4), /^Activity · 4 open tasks$/);
  assert.ok(activityTitle('Activity', 1234).includes('1234'), 'counts are left ungrouped, as on the Tasks page');
});
