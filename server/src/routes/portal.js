/**
 * The client portal (#47). Public routes with their own session, separate
 * from the staff sign-in: a different cookie, a different signing key, and
 * a database session checked on every request, so switching the portal off
 * or withdrawing a contact's access blocks them at once.
 *
 *   POST /api/portal/request-link   { email }   always answers the same
 *   POST /api/portal/login          { token }
 *   POST /api/portal/logout
 *   GET  /api/portal/me
 *   GET  /api/portal/projects | /documents | /invoices | /certificates | /messages
 *   GET  /api/portal/invoices/statement.pdf
 *   GET  /api/portal/files/document/:id
 *   GET  /api/portal/files/quotation/:no
 *   POST /api/portal/messages       { subject, body }
 *
 * Staff side (signed in):
 *   GET  /api/portal-admin/companies/:id            switches, contacts, sessions, audit
 *   PATCH /api/portal-admin/companies/:id           { portal_enabled, portal_sections }
 *   PATCH /api/portal-admin/contacts/:id            { portal_access }   (off revokes sessions)
 *   POST /api/portal-admin/contacts/:id/invite      send a sign-in link now
 */
import crypto from 'node:crypto';
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { query, transaction } from '../db.js';
import { authConfig } from '../auth/config.js';
import { signSession, verifySession } from '../auth/session.js';
import { ApiError } from '../middleware/error.js';
import { sendMail } from '../lib/mail.js';
import { notify } from '../lib/notify.js';
import { businessToday } from '../lib/businessDate.js';
import { fetchDocument, isInlineType } from '../lib/documents.js';
import { quotationPdf } from '../lib/quotationPdf.js';
import { companyOwnsDocument, portalCertificates, portalDocuments, portalInvoices, portalProjects, SECTIONS, statementPdf } from '../lib/portal.js';
import { fullQuotation } from './quotations.js';

export const portalRouter = Router();
export const portalAdminRouter = Router();

const COOKIE = 'cetizion_portal';
const LINK_MINUTES = 20;
const SESSION_HOURS = 8;
// A key of its own: a portal token can never pass as a staff session.
const portalKey = () => `${authConfig.sessionSecret}:client-portal`;
const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');
const GENERIC = 'If that address belongs to a client with portal access, a sign-in link is on its way. It works once, for 20 minutes.';

async function audit(req, action, target = null) {
  const s = req.portal;
  await query('INSERT INTO portal_audit (session_id, contact_id, company_id, action, target, ip) VALUES ($1,$2,$3,$4,$5,$6)',
    [s?.sid || null, s?.contact_id || null, s?.company_id || null, action, target, req.ip]).catch(() => {});
}

async function baseUrl(req) {
  const { rows: [r] } = await query(`SELECT value FROM settings WHERE key = 'public_app_url'`);
  return (r?.value || '').trim().replace(/\/+$/, '') || req.get('origin') || `${req.protocol}://${req.get('host')}`;
}

async function sendLink(req, contact) {
  const token = crypto.randomBytes(32).toString('base64url');
  await query('INSERT INTO portal_links (contact_id, token_hash, expires_at, ip) VALUES ($1,$2, now() + make_interval(mins => $3), $4)', [contact.id, hash(token), LINK_MINUTES, req.ip]);
  const url = `${await baseUrl(req)}/portal/login/${token}`;
  const text = `Dear ${contact.name},\n\nUse this link to open the Cetizion Verifica client portal for ${contact.company_name}:\n${url}\n\nIt works once, for ${LINK_MINUTES} minutes. If you did not ask for it, you can ignore this email.\n\nCetizion Verifica`;
  await sendMail({ to: contact.email, subject: 'Your Cetizion Verifica portal link', text, html: `<p>${text.replace(/</g, '&lt;').replace(/\n/g, '<br>').replace(url, `<a href="${url}">Open the client portal</a>`)}</p>`, template: 'portal_link', entity: 'company', entityId: String(contact.company_id), sentBy: 'portal' });
  await query(`INSERT INTO portal_audit (contact_id, company_id, action, ip) VALUES ($1,$2,'link_sent',$3)`, [contact.id, contact.company_id, req.ip]);
  return url;
}

const eligible = `SELECT ct.id, ct.name, ct.email, ct.company_id, co.name AS company_name
                   FROM contacts ct JOIN companies co ON co.id = ct.company_id
                  WHERE co.portal_enabled AND ct.portal_access AND ct.email IS NOT NULL`;

// ------------------------------------------------------------ sign-in (public)

const linkLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: true, legacyHeaders: false, message: { error: { message: 'Too many requests. Please wait a few minutes.' } } });
const portalLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false });
portalRouter.use(portalLimiter);

portalRouter.post('/request-link', linkLimiter, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError(422, 'Please enter your email address', { fields: { email: 'An email address' } });
  const { rows } = await query(`${eligible} AND lower(ct.email) = $1`, [email]);
  // One recent link per contact is enough; the same answer either way.
  for (const c of rows) {
    const { rows: [recent] } = await query(`SELECT 1 FROM portal_links WHERE contact_id = $1 AND created_at > now() - interval '1 minute'`, [c.id]);
    if (!recent) await sendLink(req, c);
  }
  res.json({ data: { message: GENERIC } });
});

// Only failed sign-ins count, so a guessed token is slowed down and a real one never is.
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, skipSuccessfulRequests: true, standardHeaders: true, legacyHeaders: false, message: { error: { message: 'Too many attempts. Please wait a few minutes.' } } });

portalRouter.post('/login', loginLimiter, async (req, res) => {
  const token = String(req.body?.token || '');
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) throw new ApiError(401, 'This link is not valid. Ask for a new one.');
  const session = await transaction(async (db) => {
    const { rows: [l] } = await db.query('SELECT * FROM portal_links WHERE token_hash = $1 FOR UPDATE', [hash(token)]);
    if (!l || l.used_at || new Date(l.expires_at) < new Date()) throw new ApiError(401, 'This link has expired or was already used. Ask for a new one.');
    await db.query('UPDATE portal_links SET used_at = now() WHERE id = $1', [l.id]);
    const { rows: [c] } = await db.query(`${eligible} AND ct.id = $1`, [l.contact_id]);
    if (!c) throw new ApiError(401, 'Portal access is not available for this address any more.');
    const sid = crypto.randomBytes(24).toString('base64url');
    await db.query(`INSERT INTO portal_sessions (id, contact_id, company_id, expires_at, ip, user_agent) VALUES ($1,$2,$3, now() + make_interval(hours => $4), $5, $6)`,
      [sid, c.id, c.company_id, SESSION_HOURS, req.ip, String(req.get('user-agent') || '').slice(0, 300)]);
    return { sid, contact_id: c.id, company_id: c.company_id };
  });
  const exp = Date.now() + SESSION_HOURS * 3600 * 1000;
  res.cookie(COOKIE, signSession({ sid: session.sid, exp }, portalKey()), { httpOnly: true, sameSite: 'strict', secure: authConfig.secureCookie, path: '/api/portal', maxAge: SESSION_HOURS * 3600 * 1000 });
  req.portal = session;
  await audit(req, 'login');
  res.json({ data: { ok: true } });
});

// ------------------------------------------------------------ everything below needs a portal session

async function requirePortal(req, res, next) {
  try {
    const payload = verifySession(req.cookies?.[COOKIE], portalKey());
    if (!payload?.sid) throw new ApiError(401, 'Please sign in again');
    const { rows: [s] } = await query(
      `SELECT s.id, s.contact_id, s.company_id, ct.name AS contact_name, co.name AS company_name, co.portal_sections
         FROM portal_sessions s JOIN contacts ct ON ct.id = s.contact_id JOIN companies co ON co.id = s.company_id
        WHERE s.id = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
          AND co.portal_enabled AND ct.portal_access AND ct.company_id = s.company_id`, [payload.sid]);
    if (!s) { res.clearCookie(COOKIE, { path: '/api/portal' }); throw new ApiError(401, 'Please sign in again'); }
    req.portal = { sid: s.id, contact_id: s.contact_id, company_id: s.company_id, contact_name: s.contact_name, company_name: s.company_name, sections: s.portal_sections };
    query('UPDATE portal_sessions SET last_seen_at = now() WHERE id = $1', [s.id]).catch(() => {});
    res.set('Cache-Control', 'no-store');
    next();
  } catch (err) { next(err); }
}
const section = (name) => (req, res, next) => (req.portal.sections.includes(name) ? next() : next(new ApiError(403, 'This section is not available')));

portalRouter.use(['/logout', '/me', '/projects', '/documents', '/invoices', '/certificates', '/messages', '/files'], requirePortal);

portalRouter.post('/logout', async (req, res) => {
  await query('UPDATE portal_sessions SET revoked_at = now() WHERE id = $1', [req.portal.sid]);
  await audit(req, 'logout');
  res.clearCookie(COOKIE, { path: '/api/portal' });
  res.json({ data: { ok: true } });
});

portalRouter.get('/me', async (req, res) => {
  const { contact_name, company_name, sections } = req.portal;
  res.json({ data: { contact_name, company_name, sections } });
});

portalRouter.get('/projects', section('projects'), async (req, res) => {
  await audit(req, 'view', 'projects');
  res.json({ data: await portalProjects(req.portal.company_id) });
});
portalRouter.get('/documents', section('documents'), async (req, res) => {
  await audit(req, 'view', 'documents');
  res.json({ data: await portalDocuments(req.portal.company_id) });
});
portalRouter.get('/invoices/statement.pdf', section('invoices'), async (req, res) => {
  const invoices = await portalInvoices(req.portal.company_id);
  const today = businessToday();
  const pdf = await statementPdf({ name: req.portal.company_name }, invoices, today);
  await audit(req, 'download', 'statement');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="statement-${today}.pdf"`);
  res.send(pdf);
});
portalRouter.get('/invoices', section('invoices'), async (req, res) => {
  await audit(req, 'view', 'invoices');
  res.json({ data: await portalInvoices(req.portal.company_id) });
});
portalRouter.get('/certificates', section('certificates'), async (req, res) => {
  await audit(req, 'view', 'certificates');
  res.json({ data: await portalCertificates(req.portal.company_id) });
});

portalRouter.get('/files/document/:id', section('documents'), async (req, res) => {
  const id = Number(req.params.id);
  // Same answer for "not yours" and "not there".
  if (!Number.isInteger(id) || !(await companyOwnsDocument(req.portal.company_id, id))) throw new ApiError(404, 'Not found');
  const { document, body } = await fetchDocument(id);
  await audit(req, 'download', `document:${id}`);
  res.setHeader('Content-Type', isInlineType(document.content_type) ? document.content_type : 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(document.file_name)}"`);
  res.send(body);
});

portalRouter.get('/files/quotation/:no', section('documents'), async (req, res) => {
  const no = decodeURIComponent(req.params.no);
  const { rows: [q] } = await query(`SELECT quotation_no FROM quotations WHERE quotation_no = $1 AND company_id = $2 AND (sent_at IS NOT NULL OR status IN ('Won - PO Received','Under Negotiation'))`, [no, req.portal.company_id]);
  if (!q) throw new ApiError(404, 'Not found');
  const pdf = await quotationPdf(await fullQuotation(q.quotation_no));
  await audit(req, 'download', `quotation:${no}`);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${no.replace(/\//g, '-')}.pdf"`);
  res.send(pdf);
});

// ------------------------------------------------------------ messages

portalRouter.get('/messages', section('contact'), async (req, res) => {
  const { rows } = await query(
    `SELECT t.id AS thread_id, t.subject, m.id, m.direction, m.snippet, m.body_html, m.sent_at
       FROM email_threads t JOIN email_messages m ON m.thread_id = t.id
      WHERE t.conversation_id LIKE 'portal-%' AND t.company_id = $1 AND t.contact_id = $2
      ORDER BY t.last_message_at DESC, m.sent_at`, [req.portal.company_id, req.portal.contact_id]);
  res.json({ data: rows });
});

const messageSchema = z.object({ subject: z.string().trim().min(1, 'A subject, please').max(200), body: z.string().trim().min(1, 'Write your message').max(5000), thread_id: z.coerce.number().int().positive().optional() });
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

portalRouter.post('/messages', section('contact'), rateLimit({ windowMs: 60 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false }), async (req, res) => {
  const parsed = messageSchema.safeParse(req.body || {});
  if (!parsed.success) throw new ApiError(422, 'Please check the highlighted fields', { fields: Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.'), i.message])) });
  const v = parsed.data; const p = req.portal;
  const { rows: [c] } = await query('SELECT email FROM contacts WHERE id = $1', [p.contact_id]);
  const { rows: [inbox] } = await query(`SELECT i.id, i.account_id FROM inboxes i JOIN connected_accounts a ON a.id = i.account_id WHERE i.active AND a.status = 'active' ORDER BY i.id LIMIT 1`);
  let threadId = null;
  if (inbox) {
    // Into the shared inbox, as a conversation on this company (#30).
    const { messageHooks } = await import('../lib/mailbox/sync.js');
    await import('../lib/inbox.js');
    threadId = await transaction(async (db) => {
      let thread = null;
      if (v.thread_id) ({ rows: [thread] } = await db.query(`SELECT * FROM email_threads WHERE id = $1 AND company_id = $2 AND contact_id = $3 AND conversation_id LIKE 'portal-%'`, [v.thread_id, p.company_id, p.contact_id]));
      if (!thread) {
        ({ rows: [thread] } = await db.query(
          `INSERT INTO email_threads (account_id, conversation_id, subject, company_id, contact_id) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
          [inbox.account_id, `portal-${crypto.randomUUID()}`, `[Portal] ${v.subject}`, p.company_id, p.contact_id]));
      }
      const { rows: [{ email: mailbox }] } = await db.query('SELECT email FROM connected_accounts WHERE id = $1', [inbox.account_id]);
      const { rows: [msg] } = await db.query(
        `INSERT INTO email_messages (account_id, thread_id, provider_id, direction, from_email, from_name, to_emails, subject, snippet, body_html, sent_at, company_id, contact_id)
         VALUES ($1,$2,$3,'inbound',$4,$5,$6,$7,$8,$9,now(),$10,$11) RETURNING *`,
        [inbox.account_id, thread.id, `portal-${crypto.randomUUID()}`, c?.email || null, `${p.contact_name} (portal)`, [mailbox], v.subject, v.body.slice(0, 240), `<p>${esc(v.body).replace(/\n/g, '<br>')}</p>`, p.company_id, p.contact_id]);
      const { rows: [account] } = await db.query('SELECT * FROM connected_accounts WHERE id = $1', [inbox.account_id]);
      for (const hook of messageHooks) await hook({ db, account: { ...account, is_shared: true }, thread, message: msg, participants: [] });
      return thread.id;
    });
  } else {
    await notify({ kind: 'inbox', title: `Portal message from ${p.contact_name} (${p.company_name})`, body: `${v.subject}: ${v.body.slice(0, 200)}`, link: `/companies/${p.company_id}`, dedupeKey: `portal:${p.sid}:${Date.now()}` });
    await query(`INSERT INTO notes (entity, entity_id, body, author) VALUES ('company', $1, $2, $3)`, [String(p.company_id), `Portal message: ${v.subject}\n\n${v.body}`, `client: ${p.contact_name}`]);
  }
  await audit(req, 'message', v.subject.slice(0, 120));
  res.status(201).json({ data: { thread_id: threadId, message: 'Thank you. Our team will reply by email.' } });
});

// ------------------------------------------------------------ staff side

portalAdminRouter.get('/companies/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { rows: [co] } = await query('SELECT id, name, portal_enabled, portal_sections FROM companies WHERE id = $1', [id]);
  if (!co) throw new ApiError(404, 'Company not found');
  const [contacts, sessions, log] = await Promise.all([
    query(`SELECT ct.id, ct.name, ct.email, ct.portal_access,
                  (SELECT MAX(created_at) FROM portal_sessions s WHERE s.contact_id = ct.id) AS last_login
             FROM contacts ct WHERE ct.company_id = $1 ORDER BY ct.name`, [id]),
    query(`SELECT s.id, ct.name, s.created_at, s.last_seen_at, s.expires_at, s.revoked_at, s.ip FROM portal_sessions s JOIN contacts ct ON ct.id = s.contact_id
            WHERE s.company_id = $1 ORDER BY s.created_at DESC LIMIT 50`, [id]),
    query(`SELECT a.created_at, a.action, a.target, a.ip, ct.name FROM portal_audit a LEFT JOIN contacts ct ON ct.id = a.contact_id
            WHERE a.company_id = $1 ORDER BY a.created_at DESC LIMIT 200`, [id]),
  ]);
  res.json({ data: { ...co, sections: SECTIONS, contacts: contacts.rows, sessions: sessions.rows.map((s) => ({ ...s, id: undefined })), audit: log.rows } });
});

portalAdminRouter.patch('/companies/:id', async (req, res) => {
  const parsed = z.object({ portal_enabled: z.boolean().optional(), portal_sections: z.array(z.enum(SECTIONS)).optional() }).safeParse(req.body || {});
  if (!parsed.success) throw new ApiError(422, 'Invalid settings');
  const set = Object.entries(parsed.data).filter(([, x]) => x !== undefined);
  if (!set.length) throw new ApiError(422, 'Nothing to change');
  const { rows: [co] } = await query(`UPDATE companies SET ${set.map(([k], i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING id, portal_enabled, portal_sections`, [Number(req.params.id), ...set.map(([, x]) => x)]);
  if (!co) throw new ApiError(404, 'Company not found');
  if (parsed.data.portal_enabled === false) await query('UPDATE portal_sessions SET revoked_at = now() WHERE company_id = $1 AND revoked_at IS NULL', [co.id]);
  res.json({ data: co });
});

portalAdminRouter.patch('/contacts/:id', async (req, res) => {
  const access = req.body?.portal_access;
  if (typeof access !== 'boolean') throw new ApiError(422, 'portal_access must be true or false');
  const { rows: [ct] } = await query('UPDATE contacts SET portal_access = $2 WHERE id = $1 RETURNING id, portal_access', [Number(req.params.id), access]);
  if (!ct) throw new ApiError(404, 'Contact not found');
  if (!access) await query('UPDATE portal_sessions SET revoked_at = now() WHERE contact_id = $1 AND revoked_at IS NULL', [ct.id]);
  res.json({ data: ct });
});

portalAdminRouter.post('/contacts/:id/invite', async (req, res) => {
  const { rows: [c] } = await query(`${eligible} AND ct.id = $1`, [Number(req.params.id)]);
  if (!c) throw new ApiError(422, 'Switch the portal on for the company, and give the contact an email and access, first');
  const url = await sendLink(req, c);
  res.json({ data: { sent_to: c.email, ...(process.env.NODE_ENV !== 'production' ? { url } : {}) } });
});
