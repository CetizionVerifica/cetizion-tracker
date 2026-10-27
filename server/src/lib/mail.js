/**
 * Sending email (#21), with the safety rails the issue asks for.
 *
 * Every email is written to email_log first, then delivered according to
 * EMAIL_MODE:
 *   log      nothing leaves the server; the row records what would have gone
 *   sandbox  only addresses on EMAIL_ALLOWLIST are sent to; others are logged
 *            as suppressed
 *   live     sent over SMTP
 *
 * The emails_enabled setting is the kill switch an admin flips from the app;
 * it stops delivery (rows are still logged as suppressed) without a deploy.
 * Emails to clients have their own switches on top (lib/clientEmails.js),
 * so the team's mail can go live while clients get nothing.
 * SMTP details come from the environment only, never the database.
 */
import nodemailer from 'nodemailer';
import { config } from '../config.js';
import { isStaging } from './ops/environment.js';
import { query } from '../db.js';
import { clientEmailHold } from './clientEmails.js';

let transport = null;
/** Replaceable in tests: an SMTP transport (nodemailer's jsonTransport) instead of the configured server. */
export const deps = { transport: null };
function smtp() {
  if (deps.transport) return deps.transport;
  if (transport) return transport;
  const m = config.mail;
  transport = nodemailer.createTransport({
    host: m.host, port: m.port, secure: m.secure,
    auth: m.user ? { user: m.user, pass: m.pass } : undefined,
  });
  return transport;
}

export function mailConfigured() {
  return Boolean(config.mail.host && config.mail.from);
}

/** Addresses de-duplicated without regard to case, first spelling kept (#195). */
export function uniqueAddresses(list) {
  const seen = new Map();
  for (const a of list) if (a && !seen.has(a.toLowerCase())) seen.set(a.toLowerCase(), a);
  return [...seen.values()];
}

/** The addresses in a To or Cc string, or list: each once, whatever its case. */
export const addressesIn = (v) => uniqueAddresses((Array.isArray(v) ? v : String(v ?? '').split(/[,;]/)).map((a) => String(a).trim()).filter(Boolean));

/**
 * To, Cc and Bcc as they go out (#195): each address once, and nobody
 * copied who is already a recipient, so nobody gets the email twice.
 * Compared without regard to case.
 */
export function recipientLists(to, cc = [], bcc = []) {
  const recipients = addressesIn(to);
  const taken = new Set(recipients.map((a) => a.toLowerCase()));
  const copies = addressesIn(cc).filter((a) => !taken.has(a.toLowerCase()));
  for (const a of copies) taken.add(a.toLowerCase());
  return { to: recipients, cc: copies, bcc: addressesIn(bcc).filter((a) => !taken.has(a.toLowerCase())) };
}
const onAllowlist = (address, allowlist) => allowlist.some((a) => a.toLowerCase() === address.toLowerCase() || (a.startsWith('@') && address.toLowerCase().endsWith(a.toLowerCase())));

/** Where a given address (or comma-separated addresses) would go under the current mode and switches. */
export function decideDelivery({ to, mode = config.mail.mode, enabled = true, allowlist = config.mail.allowlist, optedOut = false, configured = mailConfigured() }) {
  if (!enabled) return { deliver: false, reason: 'emails_enabled is false' };
  if (optedOut) return { deliver: false, reason: 'contact opted out of automatic email' };
  if (mode === 'log') return { deliver: false, reason: 'EMAIL_MODE=log' };
  // Staging never emails anyone for real (#35); sandbox to the team still works.
  if (isStaging() && mode !== 'sandbox') return { deliver: false, reason: 'staging: outbound email is off' };
  if (mode === 'sandbox') {
    // Each recipient on its own: "a@team.com, b@client.com" is two addresses,
    // and the second being off the allowlist suppresses the email. The
    // joined string used to be compared whole, which never matched and so
    // suppressed every email with more than one recipient — or, had an
    // allowlist entry been the joined string, would have let one through.
    const bad = addressesIn(to).find((address) => !onAllowlist(address, allowlist));
    return bad === undefined ? { deliver: true } : { deliver: false, reason: `EMAIL_MODE=sandbox and ${bad} is not on EMAIL_ALLOWLIST` };
  }
  if (!configured) return { deliver: false, reason: 'SMTP_HOST or EMAIL_FROM not set' };
  return { deliver: true };
}

/** The address in a From such as "Cetizion Tracker <tracker@x.in>", or the string itself. */
export function addressOf(from) {
  const s = String(from ?? '').trim();
  const m = s.match(/<([^>]+)>\s*$/);
  return (m ? m[1] : s).trim() || null;
}

/** Whether the SMTP relay may send as this address: EMAIL_FROM, or one of EMAIL_FROM_ALLOWED. */
export function smtpMaySendAs(address) {
  const a = String(address ?? '').trim().toLowerCase();
  if (!a) return false;
  return [addressOf(config.mail.from), ...config.mail.fromAllowed.map(addressOf)].some((x) => x && x.toLowerCase() === a);
}

/**
 * The SMTP From for a message that asks to go as `sendAs` ({ address, name }):
 * that address when the relay may use it, else EMAIL_FROM; with the name
 * asked for, if any. Returns { header, address } — header for nodemailer.
 */
export function smtpFrom(sendAs = null) {
  const fallback = addressOf(config.mail.from);
  const address = sendAs?.address && smtpMaySendAs(sendAs.address) ? sendAs.address : fallback;
  if (!sendAs?.name && address === fallback) return { header: config.mail.from, address };
  const name = sendAs?.name || (String(config.mail.from).includes('<') ? String(config.mail.from).replace(/<[^>]*>\s*$/, '').trim().replace(/^"|"$/g, '') : '');
  return { header: name ? { name, address } : address, address };
}

/**
 * A mailbox's send failure in words an admin can act on
 * (mis-report-sender-plan.md §A4). `mailbox` is the mailbox's address,
 * `sendAs` the address it was asked to send as, if another.
 */
export function explainSendError(err, { mailbox = 'the mailbox', sendAs = null } = {}) {
  const raw = String(err?.message || err || '');
  const code = err?.code || '';
  if (code === 'ErrorSendAsDenied' || /send ?as|on behalf/i.test(raw)) {
    return `${mailbox} is not allowed to send as ${sendAs || 'that address'}. Your Microsoft 365 admin grants Send As in Exchange. (${raw})`;
  }
  if (err?.reconnect || err?.status === 401 || /not connected|token/i.test(raw)) return `${mailbox} needs reconnecting (Mailboxes). (${raw})`;
  if (/requested user .* is invalid|ErrorInvalidUser/i.test(raw) || code === 'ErrorInvalidUser') {
    return `The tracker cannot reach ${mailbox}. Whoever connected it may have lost access to it. (${raw})`;
  }
  return raw;
}

/** A copy of a body with every secret in it replaced, for the email log. */
export function redact(body, secrets = []) {
  if (body === null || body === undefined) return body;
  return secrets.filter(Boolean).reduce((s, secret) => s.split(String(secret)).join('[redacted]'), String(body));
}

async function emailsEnabled(db) {
  const { rows } = await db.query(`SELECT value FROM settings WHERE key = 'emails_enabled'`);
  return !rows.length || rows[0].value.trim().toLowerCase() !== 'false';
}

/**
 * Compose, log and (when allowed) send one email. Returns the email_log row.
 * Never throws for a delivery failure: the row records it, the caller goes on.
 */
export async function sendMail({ to: rawTo, cc: rawCc = null, subject, text, html, template, entity = null, entityId = null, sentBy = 'system', optedOut = false, attachments = [], secrets = [] }, db = { query }) {
  // Each address once, and nobody copied who is already a recipient (#195).
  const lists = recipientLists(rawTo, rawCc ?? [], config.mail.bcc || []);
  const to = lists.to.join(', ');
  const cc = lists.cc.join(', ') || null;
  const bcc = lists.bcc.join(', ') || undefined;
  const enabled = await emailsEnabled(db);
  // An email to a client an admin has held (lib/clientEmails.js) is logged
  // and goes no further, whatever the mode.
  const held = await clientEmailHold(db, template);
  const decision = held ? { deliver: false, reason: held } : decideDelivery({ to, enabled, optedOut });
  // The client gets the real message; the log keeps a copy with any secret
  // in it masked. An acceptance link is a bearer token and the log is
  // readable inside the tracker: stored in clear, anyone who can list
  // emails could accept a quotation as the client (#53).
  const storedText = redact(text, secrets);
  const storedHtml = redact(html, secrets);
  const { rows: [row] } = await db.query(
    `INSERT INTO email_log (to_email, cc, subject, template, entity, entity_id, status, mode, reason, body_text, body_html, sent_by, from_email)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [to, cc, subject, template, entity, entityId === null ? null : String(entityId), decision.deliver ? 'queued' : 'suppressed', config.mail.mode, decision.reason || null, storedText, storedHtml, sentBy, addressOf(config.mail.from)]
  );
  if (!decision.deliver) return row;

  try {
    const info = await smtp().sendMail({
      from: config.mail.from, to, cc: cc || undefined, replyTo: config.mail.replyTo || undefined,
      bcc, subject, text, html, attachments,
    });
    const { rows: [sent] } = await db.query(
      `UPDATE email_log SET status = 'sent', provider_message_id = $2, sent_at = now() WHERE id = $1 RETURNING *`,
      [row.id, info.messageId || null]
    );
    return sent;
  } catch (err) {
    const { rows: [failed] } = await db.query(
      `UPDATE email_log SET status = 'failed', error = $2 WHERE id = $1 RETURNING *`,
      [row.id, String(err.message || err).slice(0, 1000)]
    );
    return failed;
  }
}

/**
 * Send one email from a connected mailbox, through the same switches as
 * every other email (docs/mis-reports-plan.md §3.6): emails_enabled,
 * EMAIL_MODE, staging, the sandbox allowlist, and a row in email_log either
 * way. `send` is the mailbox provider's send (lib/mailbox/microsoft.js), so
 * the message leaves from that mailbox and lands in its Sent Items; when it
 * fails — the mailbox needs reconnecting, Graph is down — the same message
 * goes by SMTP with the same attachments, and the row says which way it went.
 *
 * `attachments`: [{ name, contentType, content: Buffer }] for both paths.
 * `from` is the mailbox's address. `sendAs` ({ address, name }) asks for
 * another From: through the mailbox it needs Send As in Exchange; by SMTP
 * it is used only when EMAIL_FROM_ALLOWED names it, else EMAIL_FROM with
 * the name. email_log.from_email records the From the email carried.
 * Returns { row, via: 'graph' | 'smtp' | 'log' | null, error, from }.
 */
export async function sendViaMailbox({ send, from = null, sendAs = null, to, cc = [], subject, text, html, template, entity = null, entityId = null, sentBy = 'system', attachments = [] }, db = { query }) {
  // Each address once, and nobody copied who is already a recipient (#195).
  const { to: recipients, cc: copies, bcc: blind } = recipientLists(to, cc, config.mail.bcc || []);
  const enabled = await emailsEnabled(db);
  const decision = recipients.length
    ? decideDelivery({ to: [...recipients, ...copies].join(', '), enabled, configured: Boolean(send) || mailConfigured() })
    : { deliver: false, reason: 'no recipients' };
  // Send As through the mailbox only when it is another address than the mailbox's own.
  const graphAs = sendAs?.address && sendAs.address.toLowerCase() !== String(from || '').toLowerCase() ? sendAs : null;
  const viaSmtp = smtpFrom(sendAs);
  const intended = send ? (graphAs?.address || from) : viaSmtp.address;
  const { rows: [row] } = await db.query(
    `INSERT INTO email_log (to_email, cc, subject, template, entity, entity_id, status, mode, reason, body_text, body_html, sent_by, from_email)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [recipients.join(', '), copies.join(', ') || null, subject, template, entity, entityId === null ? null : String(entityId), decision.deliver ? 'queued' : 'suppressed', config.mail.mode, decision.reason || null, text, html, sentBy, intended || null]
  );
  if (!decision.deliver) return { row, via: 'log', error: null, from: intended || null };

  const mark = (status, extra, values) => db.query(`UPDATE email_log SET status = $2, ${extra} WHERE id = $1 RETURNING *`, [row.id, status, ...values]).then((r) => r.rows[0]);
  let graphError = null;
  if (send) {
    try {
      await send({ to: recipients, cc: copies, subject, html, attachments, ...(graphAs ? { from: graphAs } : {}) });
      return { row: await mark('sent', 'sent_at = now(), provider_message_id = $3', [`graph:${from || 'mailbox'}`]), via: 'graph', error: null, from: intended };
    } catch (err) {
      graphError = explainSendError(err, { mailbox: from || 'the mailbox', sendAs: graphAs?.address }).slice(0, 500);
    }
  }
  if (!mailConfigured()) {
    const error = graphError ? `${graphError}; SMTP_HOST or EMAIL_FROM not set, so no fallback` : 'SMTP_HOST or EMAIL_FROM not set';
    return { row: await mark('failed', 'error = $3', [error]), via: null, error, from: null };
  }
  try {
    const info = await smtp().sendMail({
      from: viaSmtp.header, to: recipients.join(', '), cc: copies.join(', ') || undefined, replyTo: config.mail.replyTo || undefined,
      bcc: blind.join(', ') || undefined, subject, text, html,
      attachments: attachments.map((a) => ({ filename: a.name, content: a.content, contentType: a.contentType })),
    });
    const note = graphError ? `smtp after graph failed: ${graphError}` : null;
    return { row: await mark('sent', 'sent_at = now(), provider_message_id = $3, reason = $4, from_email = $5', [info.messageId || null, note, viaSmtp.address]), via: 'smtp', error: graphError, from: viaSmtp.address };
  } catch (err) {
    const smtpError = /\b55[03]\b/.test(String(err.message || err)) ? `The SMTP server refused to send as ${viaSmtp.address}. (${err.message || err})` : String(err.message || err);
    const error = [graphError, smtpError.slice(0, 500)].filter(Boolean).join('; ');
    return { row: await mark('failed', 'error = $3', [error]), via: null, error, from: null };
  }
}
