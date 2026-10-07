/**
 * What folding one company into another actually moved (#103 item 5).
 *
 * A merge is the most destructive thing the API does and the one thing it
 * cannot undo: lib/companies.js rewrites the client name on every quotation,
 * enquiry and project of the company being folded in, drops the duplicate
 * contacts, and deletes the company row. It already reports what it touched —
 * `moved`, a row count per table — and both merge screens threw that away, so
 * a merge into the wrong company read exactly like a correct one.
 *
 * Only counts worth saying are said. The route returns all three keys every
 * time, zeroes included, and "moved 0 quotations, 0 enquiries, 6 projects" is
 * three facts where one was wanted; a merge that moved nothing at all — a
 * duplicate spelling with no records behind it — keeps the plain message
 * rather than claiming an empty summary. The same guard covers a `moved` that
 * is missing or malformed, because a successful, irreversible merge must not
 * surface as a failure over the shape of its own receipt.
 */
import { number } from './format.js';

/**
 * The tables a merge moves rows between, in the order lib/companies.js
 * updates them, each with the singular its count needs when it is 1.
 * A table added to that loop later still gets named, just unhumanised —
 * saying "4 purchase_orders" beats saying nothing about them.
 */
const LABELS = {
  quotations: ['quotation', 'quotations'],
  enquiries: ['enquiry', 'enquiries'],
  projects: ['project', 'projects'],
};
const ORDER = Object.keys(LABELS);

/** The keys to read, known ones in the route's order, then anything new. */
function keysOf(moved) {
  if (!moved || typeof moved !== 'object' || Array.isArray(moved)) return [];
  return [...ORDER, ...Object.keys(moved).filter((key) => !ORDER.includes(key))];
}

/**
 * A count only when it is a whole number of rows above zero. Row counts
 * arrive as JSON numbers, but a null, a string or a NaN here would reach a
 * toast as "null quotations", so anything that is not a usable count is
 * treated as nothing to report.
 */
function countOf(moved, key) {
  const n = Number(moved?.[key]);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

const label = (key, n) => LABELS[key]?.[n === 1 ? 0 : 1] ?? key;

/**
 * The per-table counts of several merges run one after another, added up.
 * The Companies screen folds every ticked spelling into the survivor with one
 * request each, and reports the lot in a single toast.
 */
export function sumMoved(results) {
  const total = {};
  for (const result of Array.isArray(results) ? results : []) {
    const moved = result?.moved;
    for (const key of keysOf(moved)) {
      const n = countOf(moved, key);
      if (n) total[key] = (total[key] || 0) + n;
    }
  }
  return total;
}

/** `base`, followed by what the merge moved when it moved anything. */
export function mergeMessage(base, moved) {
  const parts = [];
  for (const key of keysOf(moved)) {
    const n = countOf(moved, key);
    if (n) parts.push(`${number(n)} ${label(key, n)}`);
  }
  return parts.length ? `${base} — moved ${parts.join(', ')}` : base;
}
