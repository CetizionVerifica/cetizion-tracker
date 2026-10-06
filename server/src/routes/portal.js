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
 *   GET  /api/portal/files/invoice/:id    an invoice's PDF, from the Invoices section (#198)
 *   GET  /api/portal/files/po/:no         a live PO's file, from Projects & orders (#198)
 *   POST /api/portal/messages       { subject, body }
 *   GET  /api/portal/actions        the client's confirmations, queries and payment advice (#198)
 *   POST /api/portal/actions        { kind, stage_ids, po_number?, note?, amount?, tds_amount?, paid_on?, reference? } [+ file]
 *   POST /api/portal/documents      multipart { entity, entity_id, label, file }: an upload onto a project or PO
 *   DELETE /api/portal/documents/:id   the client's own upload, until our team has seen it
 *
 * Staff side (signed in):
 *   GET  /api/portal-admin/companies/:id            switches, contacts, sessions, audit
 *   PATCH /api/portal-admin/companies/:id           { portal_enabled, portal_sections }
 *   PATCH /api/portal-admin/contacts/:id            { portal_access }   (off revokes sessions)
 *   POST /api/portal-admin/contacts/:id/invite      send a sign-in link now
 *   GET  /api/portal-admin/companies/:id/preview/:section   what the client sees (#198)
 */
import crypto from 'node:crypto';
import { Router } from 'express';
import multer from 'multer';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { requireAdmin } from '../auth/middleware.js';
import { query, transaction } from '../db.js';
import { authConfig } from '../auth/config.js';
import { signSession, verifySession } from '../auth/session.js';
import { ApiError } from '../middleware/error.js';
import { sendMail } from '../lib/mail.js';
import { notify } from '../lib/notify.js';
import { businessToday } from '../lib/businessDate.ts';
import { config } from '../config.js';
import { fetchDocument, isInlineType, purgeAfterCommit, uploadDocument } from '../lib/documents.js';
import { quotationPdf } from '../lib/quotationPdf.js';
import {
  companyOwnsDocument, invoiceDocument, ownedInvoices, ownsUploadTarget, poDocument, portalActions, portalAudience, portalCertificates,
  portalDocuments, portalInvoices, portalProjects, SECTION_DATA, SECTIONS, statementPdf,
} from '../lib/portal.js';
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

portalRouter.use(['/logout', '/me', '/projects', '/documents', '/invoices', '/certificates', '/messages', '/files', '/actions'], requirePortal);

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
  res.json({ data: await portalDocuments(req.portal.company_id, { contactId: req.portal.contact_id }) });
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

/** Send a stored file the caller has already checked belongs to the company, and audit it. */
async function serveDocument(req, res, id, target) {
  const { document, body } = await fetchDocument(id);
  await audit(req, 'download', target);
  res.setHeader('Content-Type', isInlineType(document.content_type) ? document.content_type : 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(document.file_name)}"`);
  res.send(body);
}

portalRouter.get('/files/document/:id', section('documents'), async (req, res) => {
  const id = Number(req.params.id);
  // Same answer for "not yours" and "not there".
  if (!Number.isInteger(id) || !(await companyOwnsDocument(req.portal.company_id, id))) throw new ApiError(404, 'Not found');
  await serveDocument(req, res, id, `document:${id}`);
});

// An invoice's PDF opens from the Invoices section (#198, G3), whether or
// not the Documents section is on: it is the invoice the client is asked to pay.
portalRouter.get('/files/invoice/:id', section('invoices'), async (req, res) => {
  const id = Number(req.params.id);
  const invoice = Number.isInteger(id) ? await invoiceDocument(req.portal.company_id, id) : null;
  if (!invoice) throw new ApiError(404, 'Not found');
  await serveDocument(req, res, invoice.document_id, `invoice:${invoice.invoice_no}`);
});

// A live PO's file opens from Projects & orders, where the PO is shown.
portalRouter.get('/files/po/:no', section('projects'), async (req, res) => {
  const no = decodeURIComponent(req.params.no);
  const po = await poDocument(req.portal.company_id, no);
  if (!po) throw new ApiError(404, 'Not found');
  await serveDocument(req, res, po.document_id, `po:${no}`);
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
  const threadId = await postPortalMessage(req.portal, parsed.data);
  await audit(req, 'message', parsed.data.subject.slice(0, 120));
  res.status(201).json({ data: { thread_id: threadId, message: 'Thank you. Our team will reply by email.' } });
});

/**
 * A client's message into the shared inbox, as a conversation on their
 * company (#30); with no shared inbox connected, a notification and a note
 * instead. Used by Contact us and by a query on an invoice or PO (#198).
 */
async function postPortalMessage(p, v) {
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
  return threadId;
}

// ------------------------------------------------------------ the client answers (#198 phase 2)
//
// Confirm an invoice, raise a query on an invoice or a PO, or tell us a
// payment was made. Each is a claim (§4): it writes no payment and changes no
// stage; finance matches a payment advice to a receipt they record. Every
// invoice and PO named is checked against the session's company first.

const clientWrites = rateLimit({ windowMs: 60 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });
const REMITTANCE_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp']);
const UPLOAD_TYPES = new Set([...REMITTANCE_TYPES,
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']);
const fileUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.documentMaxBytes, files: 1 } });
/** One optional file, with a too-large file said in words rather than as a server error. */
const oneFile = (field) => (req, res, next) => fileUpload.single(field)(req, res, (err) => {
  if (err?.code === 'LIMIT_FILE_SIZE') return next(new ApiError(422, `That file is larger than ${Math.round(config.documentMaxBytes / 1024 / 1024)} MB`));
  return next(err);
});
const fileName = (name) => String(name || 'file').replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 200);
const blankToUndefined = (v) => (v === '' || v === null ? undefined : v);
const fieldsOf = (error) => Object.fromEntries(error.issues.map((i) => [i.path.join('.'), i.message]));

const actionSchema = z.object({
  kind: z.enum(['confirmed', 'query', 'payment_advice']),
  stage_ids: z.preprocess((v) => (Array.isArray(v) ? v : String(v ?? '').split(',').filter(Boolean)).map(Number),
    z.array(z.number().int().positive()).max(50)),
  po_number: z.preprocess(blankToUndefined, z.string().trim().min(1).max(60).optional()),
  note: z.preprocess(blankToUndefined, z.string().trim().min(1).max(2000).optional()),
  amount: z.preprocess(blankToUndefined, z.coerce.number().positive('An amount above zero').max(1e12).optional()),
  tds_amount: z.preprocess(blankToUndefined, z.coerce.number().min(0).max(1e12).optional()),
  paid_on: z.preprocess(blankToUndefined, z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').optional()),
  reference: z.preprocess(blankToUndefined, z.string().trim().max(120).optional()),
});

portalRouter.get('/actions', section('invoices'), async (req, res) => {
  res.json({ data: await portalActions(req.portal.company_id) });
});

portalRouter.post('/actions', section('invoices'), clientWrites, oneFile('file'), async (req, res) => {
  const parsed = actionSchema.safeParse(req.body || {});
  if (!parsed.success) throw new ApiError(422, 'Please check the highlighted fields', { fields: fieldsOf(parsed.error) });
  const v = parsed.data; const p = req.portal;
  // What each kind needs, said in the client's terms.
  const missing = {};
  if (v.kind !== 'query' && !v.stage_ids.length) missing.stage_ids = 'Choose the invoice, or invoices, this is about';
  if (v.kind === 'query' && !v.stage_ids.length && !v.po_number) missing.stage_ids = 'Choose the invoice or PO this is about';
  if (v.kind === 'query' && !v.note) missing.note = 'Tell us what is wrong';
  if (v.kind === 'payment_advice' && !v.amount) missing.amount = 'How much was paid?';
  if (v.kind === 'payment_advice' && !v.paid_on) missing.paid_on = 'When was it paid?';
  if (req.file && v.kind !== 'payment_advice') missing.file = 'A file goes with a payment advice only';
  if (req.file && !REMITTANCE_TYPES.has(req.file.mimetype)) missing.file = 'A PDF or an image, please';
  if (Object.keys(missing).length) throw new ApiError(422, 'Please check the highlighted fields', { fields: missing });
  const invoices = await ownedInvoices(p.company_id, v.stage_ids, v.po_number);
  if (!invoices) throw new ApiError(404, 'Not found');
  const pos = [...new Set([v.po_number, ...invoices.map((i) => i.po_number)].filter(Boolean))];
  const poNumber = v.po_number || (pos.length === 1 ? pos[0] : null);
  const about = invoices.length ? `invoice ${invoices.map((i) => i.invoice_no).join(', ')}` : `PO ${poNumber}`;

  // A query opens a conversation in the shared inbox, so the reply is an email thread.
  const threadId = v.kind === 'query'
    ? await postPortalMessage(p, { subject: `Query on ${about}`.slice(0, 200), body: v.note })
    : null;
  const doc = req.file ? await uploadDocument({ buffer: req.file.buffer, fileName: fileName(req.file.originalname), contentType: req.file.mimetype, owner: 'attachments' }) : null;
  const action = await transaction(async (db) => {
    const { rows: [a] } = await db.query(
      // A confirmation is a record with nothing to act on, so it is settled as it is made.
      `INSERT INTO portal_client_actions (company_id, contact_id, kind, po_number, note, amount, tds_amount, paid_on, reference, document_id, thread_id, status, resolved_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, CASE WHEN $3 = 'confirmed' THEN 'resolved' ELSE 'open' END, CASE WHEN $3 = 'confirmed' THEN now() END)
       RETURNING id, kind, status, created_at`,
      [p.company_id, p.contact_id, v.kind, poNumber, v.note ?? null, v.kind === 'payment_advice' ? v.amount : null,
        v.kind === 'payment_advice' ? v.tds_amount ?? 0 : 0, v.kind === 'payment_advice' ? v.paid_on : null,
        v.kind === 'payment_advice' ? v.reference ?? null : null, doc?.id ?? null, threadId]);
    for (const i of invoices) await db.query('INSERT INTO portal_client_action_stages (action_id, stage_id) VALUES ($1, $2)', [a.id, i.id]);
    return a;
  });
  // A confirmation is a record, nothing to do; a query or a payment advice is work for somebody.
  if (v.kind !== 'confirmed') {
    const title = v.kind === 'query' ? `Query from ${p.contact_name} (${p.company_name}) on ${about}` : `${p.company_name} reports a payment on ${about}`;
    const body = v.kind === 'query' ? v.note.slice(0, 200) : `${v.amount}${v.tds_amount ? ` + TDS ${v.tds_amount}` : ''} on ${v.paid_on}${v.reference ? `, ref ${v.reference}` : ''}`;
    for (const username of await portalAudience(v.kind, pos)) {
      await notify({ username, kind: 'portal_action', title, body, link: '/collections?tab=portal', dedupeKey: `portal-action:${action.id}:${username || 'all'}` });
    }
  }
  await audit(req, v.kind, about.slice(0, 120));
  const said = { confirmed: 'Thank you for confirming.', query: 'Thank you. Our team will look into it and reply by email.', payment_advice: 'Thank you. Our finance team will check the payment and update the invoice.' };
  res.status(201).json({ data: { ...action, message: said[v.kind] } });
});

// ------------------------------------------------------------ the client's files (#198, G10)

const uploadSchema = z.object({
  entity: z.enum(['project', 'purchase_order']),
  entity_id: z.string().trim().min(1).max(60),
  label: z.string().trim().min(1, 'Say what the file is').max(120),
});

portalRouter.post('/documents', section('documents'), clientWrites, oneFile('file'), async (req, res) => {
  if (!req.file) throw new ApiError(422, 'Please check the highlighted fields', { fields: { file: 'Choose a file' } });
  if (!UPLOAD_TYPES.has(req.file.mimetype)) throw new ApiError(422, 'Please check the highlighted fields', { fields: { file: 'PDF, image, Word or Excel files only' } });
  const parsed = uploadSchema.safeParse(req.body || {});
  if (!parsed.success) throw new ApiError(422, 'Please check the highlighted fields', { fields: fieldsOf(parsed.error) });
  const v = parsed.data; const p = req.portal;
  if (!(await ownsUploadTarget(p.company_id, v.entity, v.entity_id))) throw new ApiError(404, 'Not found');
  const doc = await uploadDocument({ buffer: req.file.buffer, fileName: fileName(req.file.originalname), contentType: req.file.mimetype, owner: 'attachments' });
  // Shared by nature: the client can always see their own upload.
  const { rows: [a] } = await query(
    `INSERT INTO attachments (entity, entity_id, document_id, label, uploaded_by, shared_with_client, uploaded_by_contact_id)
     VALUES ($1,$2,$3,$4,$5,true,$6) RETURNING id, created_at`,
    [v.entity, v.entity_id, doc.id, v.label, `client: ${p.contact_name}`, p.contact_id]);
  const pos = v.entity === 'purchase_order' ? [v.entity_id] : [];
  const link = v.entity === 'project' ? `/projects/${encodeURIComponent(v.entity_id)}` : `/purchase-orders/${encodeURIComponent(v.entity_id)}`;
  for (const username of await portalAudience('upload', pos, v.entity === 'project' ? [v.entity_id] : [])) {
    await notify({ username, kind: 'portal_upload', title: `${p.company_name} uploaded "${v.label}"`, body: `On ${v.entity === 'project' ? 'project' : 'PO'} ${v.entity_id}, by ${p.contact_name}`, link, dedupeKey: `portal-upload:${a.id}:${username || 'all'}` });
  }
  await audit(req, 'upload', `${v.entity}:${v.entity_id}`);
  res.status(201).json({ data: { id: a.id, message: 'Uploaded. Our team will see it on the record.' } });
});

// A client may take back their own upload until our team has seen it (§3).
portalRouter.delete('/documents/:id', section('documents'), async (req, res) => {
  const id = Number(req.params.id);
  const { rows: [a] } = Number.isInteger(id) ? await query(
    `DELETE FROM attachments WHERE id = $1 AND uploaded_by_contact_id = $2 AND seen_by_staff_at IS NULL RETURNING document_id`,
    [id, req.portal.contact_id]) : { rows: [] };
  if (!a) throw new ApiError(404, 'Not found, or our team has already seen it');
  purgeAfterCommit(a.document_id);
  await audit(req, 'delete_upload', String(id));
  res.status(204).end();
});

// ------------------------------------------------------------ staff side

// Turning the portal on for a company, and inviting a contact into it,
// decides who outside the company sees its invoices and certificates.
portalAdminRouter.use(requireAdmin);

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

// Preview as client (#198, G7): the very functions the portal serves, for
// this company, so what staff see cannot drift from what the client sees.
// Staff also see where each GST split came from. Not audited as the client.
portalAdminRouter.get('/companies/:id/preview/:section', async (req, res) => {
  const { rows: [co] } = await query('SELECT id, portal_sections FROM companies WHERE id = $1', [Number(req.params.id)]);
  if (!co) throw new ApiError(404, 'Company not found');
  const load = SECTION_DATA[req.params.section];
  if (!load) throw new ApiError(404, 'No such section');
  res.json({ data: await load(co.id, { staff: true }), meta: { enabled: co.portal_sections.includes(req.params.section) } });
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
