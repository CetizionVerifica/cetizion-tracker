/**
 * What the client was billed for a trip (#214 §5.3).
 *
 * The pure half of the read-through: the server decides every figure and
 * the status word, and this maps that word onto something a person reads.
 * Nothing here recomputes money — `billing_status` arrives already derived
 * from the payment stage, and working it out a second time in the browser
 * is how two screens come to disagree about whether a client has paid.
 */

/** The statuses `v_trip_billing.billing_status` can hold. */
export const BILLING_STATUSES = [
  'not_chargeable', 'not_billed', 'due', 'partly_paid', 'overdue', 'paid',
];

/**
 * The chip for the client side of a trip.
 *
 * Prefixed "Client:", because a trip carries two money statuses that are
 * nothing to do with each other — what the client owes us and what we owe
 * the agency — and a bare "Paid" beside a bare "To pay" is unreadable.
 *
 * The tones are the system's own five (`components/sales.jsx`, `Tone`), the
 * same ones the agency's state uses in `components/travel.jsx`, so the two
 * statuses sitting side by side are told apart by their words and never by
 * a palette one of them has to itself.
 */
const CLIENT_CHIPS = {
  not_chargeable: { label: 'Client: not chargeable', tone: 'plain' },
  not_billed: { label: 'Client: not billed', tone: 'wait' },
  due: { label: 'Client: due', tone: 'wait' },
  partly_paid: { label: 'Client: partly paid', tone: 'wait' },
  overdue: { label: 'Client: overdue', tone: 'late' },
  paid: { label: 'Client: paid', tone: 'ok' },
};

/** A trip's client chip, or null when the server sent no billing block. */
export const clientBillingChip = (status) =>
  (status ? CLIENT_CHIPS[status] ?? { label: `Client: ${status}`, tone: 'plain' } : null);

/** Has the client paid the invoice that carried this trip? */
export const clientHasPaid = (billing) => billing?.billing_status === 'paid';

/** Is there an invoice to show figures for at all? */
export const isBilled = (billing) => Boolean(billing?.stage_id);

/**
 * The sentence under a trip with no client invoice.
 *
 * A non-chargeable trip is not waiting for anything, so it never reads
 * "not billed" — that would make a settled thing look outstanding.
 */
export function unbilledReason(billing) {
  if (!billing) return null;
  if (billing.billing_status === 'not_chargeable') {
    return 'This trip is not charged to a client, so there is no invoice to show.';
  }
  if (billing.billed_on_po_stage) {
    // 097 refuses new links of this shape but keeps the old ones (#214
    // §5.1). Saying so is the point: the trip looks billed in the database
    // and is not billed on a travel invoice.
    return 'This trip points at an ordinary PO payment stage, set before travel invoices existed. '
      + 'It is not billed on a travel invoice — an administrator can move it onto one.';
  }
  return 'The client should be charged for this trip, and it is not on a travel invoice yet.';
}

/** How late the client invoice is, as a phrase, or null when it is not. */
export const overdueBy = (billing) =>
  (billing?.billing_status === 'overdue' && Number(billing.days_overdue) > 0
    ? `${billing.days_overdue} day${Number(billing.days_overdue) === 1 ? '' : 's'} overdue`
    : null);
