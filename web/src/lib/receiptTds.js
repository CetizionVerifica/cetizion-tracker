/**
 * TDS on a client payment: the client pays the tax to the government on our
 * behalf, so it settles the invoice as cash does. A receipt (or a client's
 * payment advice) settles cash + TDS, and the server refuses one that comes
 * to more than is outstanding.
 */

const paise = (n) => Math.round(Number(n || 0) * 100) / 100;

/** The cash still to come in on `outstanding` once `tds` is deducted. */
export function cashAfterTds(outstanding, tds) {
  return Math.max(paise(Number(outstanding || 0) - Number(tds || 0)), 0);
}

/** What a receipt of `amount` in cash with `tds` deducted settles. */
export function settledBy(amount, tds) {
  return paise(Number(amount || 0) + Number(tds || 0));
}

/** Nothing left to receive: an advice on such an invoice is resolved or rejected, not recorded. */
export function isSettled(outstanding) {
  return paise(outstanding) <= 0;
}

/** A client's payment advice for one invoice, held to what it has outstanding. */
export function advicePrefill(advice, outstanding) {
  const tds = Math.min(paise(advice.tds_amount), paise(outstanding));
  return { tds, amount: Math.min(paise(advice.amount), cashAfterTds(outstanding, tds)) };
}
