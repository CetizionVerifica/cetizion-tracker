/**
 * The Activity card's title, carrying the open-task count the timeline
 * already returns (#103 item 7).
 *
 * GET /api/timeline answers `{ data: [...], open_tasks: n }`, where
 * `open_tasks` is how many of the tasks it just returned are not done.
 * The card rendered a static "Activity" and dropped the number, so the one
 * thing a reader wants at a glance — is there anything outstanding on this
 * record — was only available by reading every row.
 *
 * The count is the server's, never recounted here: the rows on screen are a
 * merge of notes, files, emails, touches and milestones as well as tasks,
 * and filtering the card to "Notes" narrows them. Counting what is visible
 * would answer a different question and would disagree with the server's.
 *
 * Nothing is said when there is nothing to say. A record with no open task
 * keeps the plain title it has always had, rather than announcing a zero —
 * and the same silence covers the filtered case, where asking for only
 * notes means no task was counted rather than that none exists.
 *
 * Wording follows the Tasks page, which has surfaced this same count from
 * /api/tasks/summary all along: "N open", middle dot, counts left ungrouped.
 */

/** "Activity", or "Activity · 2 open tasks" when the record has some. */
export function activityTitle(title, openTasks) {
  // The component's own default, so a caller that passes nothing usable gets
  // the title the card has always shown rather than "undefined · 2 open tasks".
  const base = typeof title === 'string' && title.trim() ? title.trim() : 'Activity';
  // A whole number above zero, or nothing worth saying. Guards a missing
  // count, a string one, and a NaN from reaching the heading.
  const n = Number.isInteger(openTasks) && openTasks > 0 ? openTasks : 0;
  if (!n) return base;
  return `${base} · ${n} open task${n === 1 ? '' : 's'}`;
}
