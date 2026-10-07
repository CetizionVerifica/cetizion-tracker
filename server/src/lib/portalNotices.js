/**
 * The emails that bring clients into the portal (#198 phase 3, G6).
 *
 *   emailNewInvoice(stageId)   when an invoice is recorded, its company's
 *                              portal contacts hear it is in the portal
 *                              (portal_notify_new_invoice, on by default:
 *                              decision 4)
 *   portalAddress()            the portal's address for an email, used by
 *                              the payment reminders too
 *                              (portal_link_in_reminders)
 *
 * Only a company with the portal and its Invoices section switched on, and
 * only contacts allowed in, with an email, who have not opted out of
 * automatic email. An invoice is announced once, however often it is
 * recorded again.
 */
import { query } from '../db.js';
import { portalNewInvoice } from './emailTemplates.js';
import { sendMail } from './mail.js';

/** A yes/no setting; a missing row is the default. */
export async function settingOn(db, key, fallback = true) {
  const { rows: [r] } = await db.query('SELECT value FROM settings WHERE key = $1', [key]);
  return r ? String(r.value).trim().toLowerCase() !== 'false' : fallback;
}

/**
 * The client portal's address: the public address in Settings, else the
 * one the request came from (`base`), else none: an email with no address
 * to open is not worth sending.
 */
export async function portalAddress(db, base = null) {
  const { rows: [r] } = await db.query(`SELECT value FROM settings WHERE key = 'public_app_url'`);
  const root = String(r?.value || '').trim().replace(/\/+$/, '') || String(base || '').replace(/\/+$/, '');
  return root ? `${root}/portal` : null;
}

/** Of a company's contacts, those a portal email goes to. */
export const PORTAL_RECIPIENTS = `SELECT id, name, email FROM contacts
  WHERE company_id = $1 AND portal_access AND email IS NOT NULL AND NOT opt_out_reminders ORDER BY id`;

/**
 * Tell the client's portal contacts that this invoice is in the portal.
 * Called once the invoice is committed; returns { sent, skipped } where
 * skipped says why nothing went out. Never throws for a delivery failure
 * (sendMail logs it).
 */
export async function emailNewInvoice(stageId, { db = { query }, base = null, send = sendMail, sentBy = 'system' } = {}) {
  if (!(await settingOn(db, 'portal_notify_new_invoice'))) return { sent: 0, skipped: 'switched off in Settings' };
  const { rows: [s] } = await db.query(
    `SELECT s.id, s.invoice_no, s.invoice_date, s.invoice_due_date, s.po_number, s.stage_name, s.stage_amount, s.currency, s.document_id,
            p.company_id, co.name AS company_name, g.taxable, g.gst
       FROM v_payment_stages s
       JOIN purchase_orders po ON po.po_number = s.po_number
       JOIN projects p ON p.project_id = po.project_id
       JOIN companies co ON co.id = p.company_id
      CROSS JOIN LATERAL po_gst_split(s.po_number, s.stage_amount, s.id) g
      WHERE s.id = $1 AND s.invoice_no IS NOT NULL AND co.portal_enabled AND 'invoices' = ANY(co.portal_sections)`, [stageId]);
  if (!s) return { sent: 0, skipped: 'the portal, or its Invoices section, is off for this client' };
  const { rowCount: told } = await db.query(
    `SELECT 1 FROM email_log WHERE template = 'portal_new_invoice' AND entity = 'payment_stage' AND entity_id = $1 LIMIT 1`, [String(s.id)]);
  if (told) return { sent: 0, skipped: 'already announced' };
  const url = await portalAddress(db, base);
  if (!url) return { sent: 0, skipped: 'the public address is not set (Settings)' };
  const { rows: contacts } = await db.query(PORTAL_RECIPIENTS, [s.company_id]);
  for (const c of contacts) {
    const mail = portalNewInvoice({ contactName: c.name, company: s.company_name, invoice: s, url });
    await send({ ...mail, to: c.email, template: 'portal_new_invoice', entity: 'payment_stage', entityId: s.id, sentBy }, db);
  }
  return { sent: contacts.length, skipped: contacts.length ? null : 'no contact allowed into the portal has an email' };
}
