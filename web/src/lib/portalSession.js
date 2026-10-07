/**
 * Whether a client-portal session is still one somebody can use (#103 item 4).
 *
 * GET /api/portal-admin/companies/:id has always sent the last fifty sessions
 * for the company, in every state, and the page dropped them. Rendering them
 * needs a status, and the server does not send one: the rows carry only
 * `revoked_at` and `expires_at`, and the answer is a comparison.
 *
 * `!revoked_at` on its own is the wrong answer, and would be wrong most of the
 * time. A portal session is given eight hours at sign-in and the column is
 * never extended afterwards; nothing sweeps the table either, so a row that
 * simply ran out is the ordinary resting state here and has no `revoked_at` to
 * show for it. Treating those as live would report an eight-hour-old sign-in as
 * somebody still reading the invoices.
 *
 * Revoked is checked first. Turning the portal off, and withdrawing a contact's
 * access, both stamp `revoked_at` on every row where it was null — expiry not
 * considered — so a session that had already run out before the administrator
 * turned the portal off carries both marks. Reading expiry first would relabel
 * it as expired and lose the more recent fact about it.
 *
 * The boundary is the server's. requirePortal admits a session on
 * `expires_at > now()`, so an expiry exactly at `now` is already refused there
 * and is called expired here.
 *
 * It answers about the row, not about the whole sign-in chain. requirePortal
 * also requires the company to still be portal-enabled, the contact to still
 * be permitted, and the contact to still belong to the session's company — and
 * a contact moved to another company fails that last test with nothing written
 * to the row. Those gates are not in the payload per session, and guessing at
 * them from the name would be the browser inventing an authorisation opinion.
 * The two that an administrator acts on are already folded in, because both of
 * those actions revoke on their way through.
 */

/** 'revoked' | 'expired' | 'active' — never active on an expiry it cannot read. */
export function sessionStatus(session, now = Date.now()) {
  if (session?.revoked_at) return 'revoked';
  // NOT NULL in the table, so a missing or unparseable one means a payload
  // that lost it rather than a session without one. Either way it is not
  // something to call live: no expiry, no claim that there is time left.
  const expires = new Date(session?.expires_at ?? NaN).getTime();
  if (!Number.isFinite(expires)) return 'expired';
  return expires > now ? 'active' : 'expired';
}

/** The tone each status is drawn in; the word still carries the state. */
export const SESSION_TONE = { active: 'success', expired: 'neutral', revoked: 'danger' };
