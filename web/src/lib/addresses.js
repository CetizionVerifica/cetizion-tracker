/**
 * Email addresses in a To or Cc setting, as the server reads them
 * (server/src/lib/mail.js, #195): split on commas and semicolons, only
 * real addresses, each once whatever its case, and nobody copied who is
 * already a recipient. A setting cannot be saved blank, so "none" is
 * nobody.
 */

/** Each address once, compared without regard to case; the first spelling is kept. */
export function uniqueAddresses(list) {
  const seen = new Map();
  for (const a of list) if (a && !seen.has(a.toLowerCase())) seen.set(a.toLowerCase(), a);
  return [...seen.values()];
}

/** The addresses in a setting's value. */
export const addresses = (v) => uniqueAddresses(String(v ?? '').split(/[,;]/).map((a) => a.trim()).filter((a) => a.includes('@')));

/** To and Cc as they are sent: Cc without anybody already in To. */
export function recipientLists(to, cc) {
  const recipients = addresses(to);
  const taken = new Set(recipients.map((a) => a.toLowerCase()));
  return { to: recipients, cc: addresses(cc).filter((a) => !taken.has(a.toLowerCase())) };
}
