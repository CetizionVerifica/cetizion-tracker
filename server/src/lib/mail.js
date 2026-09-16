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
 * SMTP details come from the environment only, never the database.
 */
import nodemailer from 'nodemailer';
import { config } from '../config.js';
import { query } from '../db.js';

let transport = null;
function smtp() {
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

/** Where a given address would go under the current mode and switches. */
export function decideDelivery({ to, mode = config.mail.mode, enabled = true, allowlist = config.mail.allowlist, optedOut = false, configured = mailConfigured() }) {
  if (!enabled) return { deliver: false, reason: 'emails_enabled is false' };
  if (optedOut) return { deliver: false, reason: 'contact opted out of automatic email' };
  if (mode === 'log') return { deliver: false, reason: 'EMAIL_MODE=log' };
  if (mode === 'sandbox') {
    const ok = allowlist.some((a) => a.toLowerCase() === String(to).toLowerCase() || (a.startsWith('@') && String(to).toLowerCase().endsWith(a.toLowerCase())));
    return ok ? { deliver: true } : { deliver: false, reason: `EMAIL_MODE=sandbox and ${to} is not on EMAIL_ALLOWLIST` };
  }
  if (!configured) return { deliver: false, reason: 'SMTP_HOST or EMAIL_FROM not set' };
  return { deliver: true };
}

async function emailsEnabled(db) {
  const { rows } = await db.query(`SELECT value FROM settings WHERE key = 'emails_enabled'`);
  return !rows.length || rows[0].value.trim().toLowerCase() !== 'false';
}

/**
 * Compose, log and (when allowed) send one email. Returns the email_log row.
 * Never throws for a delivery failure: the row records it, the caller goes on.
 */
export async function sendMail({ to, cc = null, subject, text, html, template, entity = null, entityId = null, sentBy = 'system', optedOut = false }, db = { query }) {
  const enabled = await emailsEnabled(db);
  const decision = decideDelivery({ to, enabled, optedOut });
  const { rows: [row] } = await db.query(
    `INSERT INTO email_log (to_email, cc, subject, template, entity, entity_id, status, mode, reason, body_text, body_html, sent_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [to, cc, subject, template, entity, entityId === null ? null : String(entityId), decision.deliver ? 'queued' : 'suppressed', config.mail.mode, decision.reason || null, text, html, sentBy]
  );
  if (!decision.deliver) return row;

  try {
    const info = await smtp().sendMail({
      from: config.mail.from, to, cc: cc || undefined, replyTo: config.mail.replyTo || undefined,
      bcc: config.mail.bcc || undefined, subject, text, html,
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
