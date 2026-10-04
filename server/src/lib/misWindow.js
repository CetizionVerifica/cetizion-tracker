/**
 * The briefing's mail window, said in one line (docs/mis-briefing-fix-plan.md §2).
 * Its own module, with no imports, so the email and the PDF can print it
 * without loading the AI module.
 */
/**
 * The footnote line under the highlights: how much mail there was, what was
 * left out and why, a mailbox the briefing could not read, and threads cut
 * for room ("12 threads in the window; 3 left out: 2 our own report, 1
 * marketing mail").
 */
export function windowNote(w) {
  if (!w) return '';
  const left = w.excluded.reduce((n, e) => n + e.count, 0);
  const parts = [`${w.threads} thread${w.threads === 1 ? '' : 's'} in the window`];
  if (left) parts.push(`${left} left out: ${w.excluded.map((e) => `${e.count} ${e.reason}`).join(', ')}`);
  if (w.cut) parts.push(`${w.cut} not read for lack of room`);
  if (w.not_read?.length) parts.push(`not read: ${w.not_read.map((b) => `${b.email} (shared as ${b.shared_as} only)`).join(', ')}`);
  return parts.join('; ');
}
