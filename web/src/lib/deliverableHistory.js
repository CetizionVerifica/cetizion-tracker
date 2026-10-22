/**
 * A certificate's reissue history, as the dialog shows it (#103 item 6).
 *
 * GET /api/deliverables/:id already walks the supersede chain and returns it
 * as `history`; nothing in web/src called that endpoint, so the register
 * showed a one-hop "by CERT-2026-003" and no way to see the rest.
 *
 * Two things about that payload decide everything here, and both are the
 * route's own semantics rather than a choice made in the browser:
 *
 *   `superseded_by_id` points old → new. The supersede route stamps the id of
 *   the replacement onto the row being replaced, so the newest issue in a
 *   chain is the one whose `superseded_by_id` is null.
 *
 *   `history` holds ancestors only — the issues this one replaced, directly
 *   or further back — and never the record you asked for. Opening the newest
 *   issue therefore shows the whole chain; opening an older one shows only
 *   what came before *it*, because the route does not walk forwards. The
 *   dialog says so rather than quietly presenting a partial chain as whole,
 *   and `superseded_by_id` on the record itself is what it reads to know.
 *
 * Only the six fields `history` actually carries are normalised here. The
 * detail response is `SELECT *`, so it also returns notes, created_by,
 * engagement_id and other internals that the register never shows and that
 * a reissue history has no reason to surface.
 */

/** The entry fields the endpoint returns for a chain member, and nothing more. */
function entry(row, current) {
  const reference = typeof row.reference === 'string' ? row.reference.trim() : '';
  return {
    id: row.id,
    reference: reference || null,
    status: typeof row.status === 'string' && row.status ? row.status : null,
    issued_on: row.issued_on ?? null,
    valid_until: row.valid_until ?? null,
    document_id: Number.isInteger(row.document_id) ? row.document_id : null,
    current,
  };
}

/** A chain member worth rendering: an object the dialog can key by id. */
const usable = (row) => Boolean(row) && typeof row === 'object' && !Array.isArray(row) && Number.isInteger(row.id);

/**
 * The chain for one deliverable: the issue you opened, the issues it
 * replaced in the order the route returned them, and whether this one has
 * itself since been replaced.
 *
 * Anything unusable — a failed fetch, a `history` that is not an array, a
 * member without an id — reduces to an empty chain rather than throwing. A
 * read-only dialog must not be able to take the register down with it.
 */
export function reissueChain(detail) {
  if (!usable(detail)) return { current: null, earlier: [], supersededById: null };
  const history = Array.isArray(detail.history) ? detail.history : [];
  return {
    current: entry(detail, true),
    // Kept in the route's own order (valid_until DESC NULLS LAST), so the
    // most recent predecessor reads first. Not re-sorted here: the dates are
    // on screen beside each entry, and a second opinion about the order
    // would only disagree with the server about its own answer.
    earlier: history.filter(usable).map((row) => entry(row, false)),
    supersededById: Number.isInteger(detail.superseded_by_id) ? detail.superseded_by_id : null,
  };
}

/** The heading over the older issues, counted and singular where it should be. */
export function earlierLabel(count) {
  const n = Number.isInteger(count) && count > 0 ? count : 0;
  if (!n) return 'Earlier issues';
  return `${n} earlier issue${n === 1 ? '' : 's'}`;
}
