/**
 * Client acceptance of quotations (#53).
 *
 * Signed in:
 *   POST /api/quotations/:key/acceptance-link  { email, to, message }  a new link (earlier open ones are revoked)
 *   GET  /api/quotations/:key/acceptances                              the links and what happened to them
 *   POST /api/quotations/:key/acceptances/:id/revoke
 *
 * Public, by token, rate limited, showing that one quotation only:
 *   GET  /api/public/accept/:token          the quotation as the client sees it
 *   GET  /api/public/accept/:token/pdf
 *   POST /api/public/accept/:token/accept   { name, email, agree: true }
 *   POST /api/public/accept/:token/changes  { name, email, comment }
 */
import crypto from 'node:crypto';
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { query, transaction } from '../db.js';
import { ApiError } from '../middleware/error.js';
import { sendMail } from '../lib/mail.js';
import { notify } from '../lib/notify.js';
import { quotationPdf } from '../lib/quotationPdf.js';
import { documentStorageReady, uploadDocument } from '../lib/documents.js';
import { fullQuotation } from './quotations.js';

export const acceptanceRouter = Router();
export const publicAcceptanceRouter = Router();

const hash = (token) => crypto.createHash('sha256').update(token).digest('hex');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const CLOSED = ['Won - PO Received', 'Lost', 'Dropped'];

async function baseUrl(req) {
  const { rows: [r] } = await query(`SELECT value FROM settings WHERE key = 'public_app_url'`);
  const set = (r?.value || '').trim().replace(/\/+$/, '');
  if (set) return set;
  const origin = req.get('origin');
  return origin || `${req.protocol}://${req.get('host')}`;
}

const linkSchema = z.object({
  email: z.boolean().optional().default(false),
  to: z.string().trim().email().max(160).optional().or(z.literal('')),
  message: z.string().trim().max(2000).optional().default(''),
});

acceptanceRouter.post('/:key/acceptance-link', async (req, res) => {
  const body = linkSchema.parse(req.body || {});
  const q = await fullQuotation(req.params.key);
  if (CLOSED.includes(q.status)) throw new ApiError(422, `The quotation is already ${q.status.toLowerCase()}`);
  if (q.approval_status === 'pending') throw new ApiError(422, 'The discount on this quotation is awaiting approval');
  if (q.approval_status === 'rejected') throw new ApiError(422, 'The discount on this quotation was rejected; revise it first');
  if (!q.lines.length && !q.quotation_value) throw new ApiError(422, 'Add the quotation lines or a value before sending it for acceptance');
  const to = body.to || q.contact?.email || null;
  if (body.email && !to) throw new ApiError(422, 'No email address: add one on the contact, or type one', { fields: { to: 'Required' } });

  const token = crypto.randomBytes(32).toString('base64url');
  const today = new Date().toISOString().slice(0, 10);
  const until = q.valid_until && q.valid_until >= today ? `${q.valid_until}T23:59:59+05:30` : new Date(Date.now() + 30 * 864e5).toISOString();
  const who = req.user?.username || 'admin';
  const row = await transaction(async (db) => {
    await db.query(`UPDATE quotation_acceptances SET status = 'revoked' WHERE quotation_id = $1 AND status IN ('sent','viewed')`, [q.id]);
    const { rows: [a] } = await db.query(
      `INSERT INTO quotation_acceptances (quotation_id, revision, token_hash, sent_to, expires_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, status, expires_at, sent_to, created_at`,
      [q.id, q.revision || 0, hash(token), to, until, who]);
    await db.query('UPDATE quotations SET sent_at = COALESCE(sent_at, now()) WHERE id = $1', [q.id]);
    return a;
  });
  const url = `${await baseUrl(req)}/accept/${token}`;
  let email = null;
  if (body.email) {
    const text = `Dear ${q.contact?.name || q.client_name},\n\n${body.message || `Please find our quotation ${q.quotation_no} for ${q.service_quoted || 'the services discussed'}.`}\n\nYou can review it and accept it, or ask for changes, here:\n${url}\n${q.valid_until ? `\nThis quotation is valid until ${q.valid_until}.\n` : ''}\nRegards,\n${q.sales_person || 'Cetizion Verifica'}`;
    const pdf = await quotationPdf(q);
    email = await sendMail({
      to, subject: `Quotation ${q.quotation_no}${q.revision ? ` (rev ${q.revision})` : ''} from Cetizion Verifica: review and accept`,
      text, html: `<p>${esc(text).replace(/\n/g, '<br>').replace(esc(url), `<a href="${esc(url)}">Review and accept the quotation</a>`)}</p>`,
      template: 'quotation_acceptance', entity: 'quotation', entityId: q.quotation_no, sentBy: who,
      attachments: [{ filename: `${q.quotation_no.replace(/\//g, '-')}.pdf`, content: pdf, contentType: 'application/pdf' }],
    });
  }
  // The token is shown once, here; only its hash is kept.
  res.status(201).json({ data: { ...row, url, email: email && { status: email.status, reason: email.reason } } });
});

acceptanceRouter.get('/:key/acceptances', async (req, res) => {
  const { rows } = await query(
    `SELECT a.id, a.revision, a.sent_to, a.status, a.expires_at, a.viewed_at, a.view_count, a.decided_at, a.decided_by_name,
            a.decided_by_email, a.comments, a.ip, a.pdf_sha256, a.pdf_document_id, a.created_by, a.created_at
       FROM quotation_acceptances a JOIN quotations q ON q.id = a.quotation_id
      WHERE q.quotation_no = $1 ORDER BY a.created_at DESC`, [decodeURIComponent(req.params.key)]);
  res.json({ data: rows });
});

acceptanceRouter.post('/:key/acceptances/:id/revoke', async (req, res) => {
  const { rows } = await query(
    `UPDATE quotation_acceptances a SET status = 'revoked' FROM quotations q
      WHERE q.id = a.quotation_id AND q.quotation_no = $1 AND a.id = $2 AND a.status IN ('sent','viewed') RETURNING a.id, a.status`,
    [decodeURIComponent(req.params.key), Number(req.params.id)]);
  if (!rows.length) throw new ApiError(404, 'No open link to revoke');
  res.json({ data: rows[0] });
});

// ---------------------------------------------------------------- public

publicAcceptanceRouter.use(rateLimit({
  windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false,
  message: { error: { message: 'Too many requests. Please wait a few minutes.' } },
}));

// Every failure says the same thing, so a guessed token learns nothing.
const DEAD = 'This link is no longer valid. Please contact Cetizion Verifica for a current copy of the quotation.';

async function openLink(token, { forUpdate = false, db = { query } } = {}) {
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(String(token))) throw new ApiError(404, DEAD);
  const { rows: [a] } = await db.query(`SELECT * FROM quotation_acceptances WHERE token_hash = $1${forUpdate ? ' FOR UPDATE' : ''}`, [hash(token)]);
  if (!a) throw new ApiError(404, DEAD);
  const { rows: [q] } = await db.query('SELECT quotation_no, revision, status FROM quotations WHERE id = $1', [a.quotation_id]);
  const expired = new Date(a.expires_at) < new Date();
  const stale = !q || (q.revision || 0) !== a.revision || CLOSED.includes(q.status);
  if (['sent', 'viewed'].includes(a.status) && (expired || stale)) {
    await db.query(`UPDATE quotation_acceptances SET status = $2 WHERE id = $1`, [a.id, expired ? 'expired' : 'revoked']);
    throw new ApiError(410, DEAD);
  }
  if (['expired', 'revoked'].includes(a.status)) throw new ApiError(410, DEAD);
  return { a, key: q.quotation_no };
}

/** Only what the client needs to see: no internal notes, owners, probabilities or other records. */
function clientView(q, a) {
  return {
    status: a.status,
    decided_at: a.decided_at,
    decided_by_name: a.decided_by_name,
    expires_at: a.expires_at,
    quotation: {
      quotation_no: q.quotation_no, revision: q.revision, quotation_date: q.quotation_date, valid_until: q.valid_until,
      client_name: q.client_name, contact_name: q.contact?.name || q.contact_person || null, service_quoted: q.service_quoted,
      currency: q.currency, subtotal: q.subtotal, tax_total: q.tax_total, total: q.total ?? q.quotation_value, terms: q.terms,
      lines: q.lines.map((l) => ({ description: l.description || l.service_name, qty: l.qty, unit: l.unit, rate: l.rate, discount_percent: l.discount_percent, gst_rate: l.gst_rate, amount: l.amount })),
    },
    seller: { name: q.settings.company_name || 'Cetizion Verifica', address: q.settings.company_address || null, gstin: q.settings.company_gstin || null },
  };
}

const client = (req) => ({ ip: req.ip, ua: String(req.get('user-agent') || '').slice(0, 300) });

publicAcceptanceRouter.get('/:token', async (req, res) => {
  const { a, key } = await openLink(req.params.token);
  if (a.status === 'sent' || a.status === 'viewed') {
    await query(`UPDATE quotation_acceptances SET status = 'viewed', viewed_at = COALESCE(viewed_at, now()), view_count = view_count + 1 WHERE id = $1`, [a.id]);
    a.status = 'viewed';
  }
  const q = a.snapshot && a.status === 'accepted' ? a.snapshot : await fullQuotation(key);
  res.set('Cache-Control', 'no-store');
  res.json({ data: clientView(q, a) });
});

publicAcceptanceRouter.get('/:token/pdf', async (req, res) => {
  const { a, key } = await openLink(req.params.token);
  const q = a.snapshot && a.status === 'accepted' ? a.snapshot : await fullQuotation(key);
  const pdf = await quotationPdf(q);
  res.set('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${q.quotation_no.replace(/\//g, '-')}${q.revision ? `-R${q.revision}` : ''}.pdf"`);
  res.send(pdf);
});

const decideSchema = z.object({
  name: z.string().trim().min(2, 'Please type your full name').max(160),
  email: z.string().trim().email('Please enter a valid email').max(160).optional().or(z.literal('')),
  agree: z.boolean().optional(),
  comment: z.string().trim().max(4000).optional().default(''),
});

function fieldsError(parsed) {
  return new ApiError(422, 'Please check the highlighted fields', { fields: Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.'), i.message])) });
}

publicAcceptanceRouter.post('/:token/accept', async (req, res) => {
  const parsed = decideSchema.safeParse(req.body || {});
  if (!parsed.success) throw fieldsError(parsed);
  if (parsed.data.agree !== true) throw new ApiError(422, 'Please tick the box to confirm', { fields: { agree: 'Required' } });
  const { ip, ua } = client(req);
  const { a: pre, key } = await openLink(req.params.token);
  if (!['sent', 'viewed'].includes(pre.status)) throw new ApiError(409, 'This quotation has already been answered through this link.');
  const q = await fullQuotation(key);
  const pdf = await quotationPdf(q);
  const sha = crypto.createHash('sha256').update(pdf).digest('hex');
  let documentId = null;
  if (documentStorageReady) {
    const doc = await uploadDocument({ buffer: pdf, fileName: `${q.quotation_no.replace(/\//g, '-')}-R${q.revision || 0}-accepted.pdf`, contentType: 'application/pdf', owner: 'attachments' }).catch(() => null);
    documentId = doc?.id ?? null;
  }
  const result = await transaction(async (db) => {
    const { a } = await openLink(req.params.token, { forUpdate: true, db });
    if (!['sent', 'viewed'].includes(a.status)) throw new ApiError(409, 'This quotation has already been answered through this link.');
    const { rows: [done] } = await db.query(
      `UPDATE quotation_acceptances SET status = 'accepted', decided_at = now(), decided_by_name = $2, decided_by_email = $3, comments = $4,
              ip = $5, user_agent = $6, snapshot = $7, pdf_sha256 = $8, pdf_document_id = $9, viewed_at = COALESCE(viewed_at, now())
        WHERE id = $1 RETURNING id, status, decided_at, decided_by_name`,
      [a.id, parsed.data.name, parsed.data.email || null, parsed.data.comment || null, ip, ua, JSON.stringify(q), sha, documentId]);
    // The pipeline trigger moves an accepted open quotation to "Verbal yes, awaiting PO".
    await db.query(
      `UPDATE quotations SET accepted_at = now(), accepted_by_name = $2,
              status = CASE WHEN status IN ('Submitted','On Hold') THEN 'Under Negotiation' ELSE status END
        WHERE id = $1`, [q.id, parsed.data.name]);
    if (documentId) await db.query(`INSERT INTO attachments (entity, entity_id, document_id, label, uploaded_by) VALUES ('quotation', $1, $2, $3, 'client')`, [q.quotation_no, documentId, `Accepted by ${parsed.data.name}`]);
    return done;
  });
  await notify({ kind: 'acceptance', title: `${q.quotation_no} accepted by ${parsed.data.name}`, body: `${q.client_name}. Waiting for the PO.`, entity: 'quotation', entityId: q.quotation_no, link: `/quotations/${encodeURIComponent(q.quotation_no)}`, dedupeKey: `acceptance:${result.id}` }).catch(() => {});
  res.json({ data: result });
});

publicAcceptanceRouter.post('/:token/changes', async (req, res) => {
  const parsed = decideSchema.safeParse(req.body || {});
  if (!parsed.success) throw fieldsError(parsed);
  if (!parsed.data.comment) throw new ApiError(422, 'Please tell us what should change', { fields: { comment: 'Required' } });
  const { ip, ua } = client(req);
  const result = await transaction(async (db) => {
    const { a, key } = await openLink(req.params.token, { forUpdate: true, db });
    if (!['sent', 'viewed'].includes(a.status)) throw new ApiError(409, 'This quotation has already been answered through this link.');
    const { rows: [done] } = await db.query(
      `UPDATE quotation_acceptances SET status = 'changes_requested', decided_at = now(), decided_by_name = $2, decided_by_email = $3, comments = $4, ip = $5, user_agent = $6
        WHERE id = $1 RETURNING id, status, decided_at`, [a.id, parsed.data.name, parsed.data.email || null, parsed.data.comment, ip, ua]);
    // Back to negotiation, and the comment on the timeline.
    await db.query(
      `UPDATE quotations SET status = 'Under Negotiation', accepted_at = NULL, accepted_by_name = NULL,
              stage_id = COALESCE((SELECT id FROM pipeline_stages WHERE name = 'Negotiation'), stage_id)
        WHERE quotation_no = $1`, [key]);
    await db.query(`INSERT INTO notes (entity, entity_id, body, author) VALUES ('quotation', $1, $2, $3)`,
      [key, `Changes requested by the client:\n${parsed.data.comment}`, `client: ${parsed.data.name}`]);
    return { ...done, key };
  });
  await notify({ kind: 'acceptance', title: `${result.key}: client asked for changes`, body: `${parsed.data.name}: ${parsed.data.comment.slice(0, 140)}`, entity: 'quotation', entityId: result.key, link: `/quotations/${encodeURIComponent(result.key)}`, dedupeKey: `changes:${result.id}` }).catch(() => {});
  res.json({ data: { id: result.id, status: result.status, decided_at: result.decided_at } });
});
