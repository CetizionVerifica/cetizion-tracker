/**
 * A workflow action that also emails somebody returns how that email went,
 * beside whatever it changed — `{ status, reason }` from the email_log row
 * (lib/mail.js). The two are separate outcomes: the decision saved even when
 * the email did not leave, so the action's own success message says so rather
 * than the toast turning red (#103 item 1).
 *
 * `status` is one of sent, failed or suppressed. `reason` carries the why for
 * a suppressed one — EMAIL_MODE=log, SMTP_HOST not set, an address off the
 * sandbox allowlist. A failed one has no reason here: the SMTP error is in
 * email_log.error, which this payload does not carry, so "failed" on its own
 * is the honest answer and Settings → Emails & jobs has the detail.
 *
 * No email object means nothing was attempted, and the base message stands
 * unchanged.
 */

/** `base`, with the email outcome in brackets after it when there is one. */
export function withEmailResult(base, email) {
  const status = email?.status;
  if (!status) return base;
  const reason = email.reason ? `: ${email.reason}` : '';
  return `${base} (email ${status}${reason})`;
}
