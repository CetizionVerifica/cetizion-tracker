import { ApiError } from '../middleware/error.js';
import { assertPricedForClient } from './serviceQuotes/priceNeeded.js';

/** A quotation in one of these is decided; nothing more goes to the client on it. */
export const CLOSED_STATUSES = ['Won - PO Received', 'Lost', 'Dropped'];

/**
 * Whether a quotation may go to the client, or be recorded as accepted by
 * them: the one rule for sending it, creating an acceptance link, recording
 * a client's acceptance by hand, and the client accepting through a link.
 *
 *   - a discount above the approval threshold must be approved: not still
 *     waiting (pending), and not turned down (rejected);
 *   - every line must have a price (price needed, #208).
 *
 * Recording an acceptance by hand used to skip both, so a discount an admin
 * had not approved, or had rejected, could reach "accepted, waiting for the
 * PO" anyway. One function, so the paths can no longer differ.
 *
 * `q` is a v_quotations row (approval_status, price_needed_count).
 * Refuses with 422 and the reason; returns nothing when the quotation is ready.
 */
export function assertReadyForClient(q) {
  if (q.approval_status === 'pending') throw new ApiError(422, 'The discount on this quotation is awaiting approval');
  if (q.approval_status === 'rejected') throw new ApiError(422, 'The discount on this quotation was rejected; revise it first');
  assertPricedForClient(q);
}

/** What a client is told when their link cannot be accepted yet: no internal detail. */
export const NOT_READY_FOR_CLIENT = 'This quotation is being updated and cannot be accepted just now. Please contact Cetizion Verifica for a current copy.';

/**
 * Record that the client accepted a quotation, inside the caller's
 * transaction: the one place `accepted_at` is written.
 *
 * The quotation is locked and checked again here, not only before the
 * transaction, so an edit that raises the discount or empties a price
 * between the two cannot slip an acceptance through. Refused when:
 *   - it is closed (won, lost, dropped);
 *   - it is not ready for the client (assertReadyForClient);
 *   - it has neither lines nor a value: there is nothing to accept;
 *   - `once` and it is already accepted (recording by hand twice).
 * `clientFacing` turns every refusal into the client's plain sentence.
 *
 * Moves an open quotation to "Under Negotiation" (verbal yes, awaiting the PO).
 * @returns the quotation's id, accepted_at, accepted_by_name and status
 */
export async function recordAcceptance(db, quotationId, acceptedBy, { once = false, clientFacing = false } = {}) {
  await db.query('SELECT id FROM quotations WHERE id = $1 FOR UPDATE', [quotationId]);
  const { rows: [q] } = await db.query(
    `SELECT v.id, v.status, v.accepted_at, v.approval_status, v.price_needed_count, v.quotation_value,
            (SELECT count(*)::int FROM quotation_lines l WHERE l.quotation_id = v.id) AS line_count
       FROM v_quotations v WHERE v.id = $1`, [quotationId]);
  if (!q) throw new ApiError(404, 'Quotation not found');
  try {
    if (CLOSED_STATUSES.includes(q.status)) throw new ApiError(422, `The quotation is already ${q.status.toLowerCase()}`);
    assertReadyForClient(q);
    if (!q.line_count && !Number(q.quotation_value)) throw new ApiError(422, 'Add the quotation lines or a value before recording an acceptance');
    if (once && q.accepted_at) throw new ApiError(409, 'This quotation is already recorded as accepted');
  } catch (err) {
    if (clientFacing && err instanceof ApiError) throw new ApiError(409, NOT_READY_FOR_CLIENT);
    throw err;
  }
  const { rows: [u] } = await db.query(
    `UPDATE quotations SET accepted_at = now(), accepted_by_name = $2,
            status = CASE WHEN status IN ('Draft','Submitted','On Hold') THEN 'Under Negotiation' ELSE status END
      WHERE id = $1 RETURNING id, accepted_at, accepted_by_name, status`,
    [quotationId, acceptedBy]);
  return u;
}
