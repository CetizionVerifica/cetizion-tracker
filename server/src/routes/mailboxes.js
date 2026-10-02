/**
 * Connected mailboxes (#29).
 *
 * Signed in:
 *   GET    /api/mailboxes                        accounts, their folders and state
 *   GET    /api/mailboxes/connect/microsoft?shared=1   start the Microsoft sign-in
 *   GET    /api/mailboxes/oauth/microsoft        the sign-in comes back here
 *   POST   /api/mailboxes/test                   { email, shared } a test mailbox (not in production)
 *   POST   /api/mailboxes/:id/test-messages      { messages } feed a test mailbox
 *   PATCH  /api/mailboxes/:id                    { visibility, import_days, exclude_internal, auto_create_contacts }
 *   POST   /api/mailboxes/:id/sync
 *   POST   /api/mailboxes/:id/disconnect         { remove_bodies }
 *   GET    /api/mailboxes/blocklist · POST { pattern } · DELETE /blocklist/:id
 *   GET    /api/mail/threads?entity=&id= | ?company_id=
 *   GET    /api/mail/threads/:id                 the messages, as the mailbox's visibility allows
 *   POST   /api/mail/threads/:id/reply           { html, reply_all }
 *   PATCH  /api/mail/threads/:id                 { entity, entity_id } relink
 * Public:
 *   POST   /api/mail/notifications               Graph change notifications
 */
import crypto from 'node:crypto';
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { requireAdmin } from '../auth/middleware.js';
import { query } from '../db.js';
import { config } from '../config.js';
import { ApiError } from '../middleware/error.js';
import { applyVisibility, sealTokens } from '../lib/mailbox/rules.js';
import { isStaging } from '../lib/ops/environment.js';
import { authUrl, exchangeCode, microsoftConfigured } from '../lib/mailbox/microsoft.js';
import { disconnect, ensureSubscriptions, pushTestMessages, refreshBodies, replyToThread, syncAccount } from '../lib/mailbox/sync.js';

export const mailboxRouter = Router();
export const mailThreadRouter = Router();
export const mailWebhookRouter = Router();

const who = (req) => req.user?.username || 'admin';

/**
 * Whose mailbox this is, and who may do what with it.
 *
 * Administering one — its settings, a sync, disconnecting it — belongs to
 * the person who connected it, and to an admin. Reading is wider: a shared
 * mailbox is the team's, which is the whole point of it.
 *
 * A person is matched on both spellings the tracker knows, the address they
 * sign in with and the name on their account, because `username` on a
 * connected account is whatever was recorded when it was connected.
 */
const isAdmin = (req) => req.user?.role === 'admin';
const identities = (req) => [req.user?.username || 'admin', req.user?.name || req.user?.username || 'admin'];

/** "mailboxes this person may read", as SQL with placeholders from $from. */
function readable(req, alias, from) {
  if (isAdmin(req)) return { clause: 'TRUE', params: [] };
  return {
    clause: `(${alias}.is_shared OR lower(${alias}.username) IN (lower($${from}), lower($${from + 1})))`,
    params: identities(req),
  };
}

/**
 * "threads this person may read": the mailboxes above, plus a thread that
 * sits on a record they own.
 *
 * #29 asks for that third case in so many words — "a sales user sees
 * threads on their own records" — and without it the client's reply about
 * your own deal is invisible to you whenever it arrived in a colleague's
 * mailbox, which is most of the time.
 *
 * Reading only. Replying stays on `readable`, because a reply leaves from
 * the mailbox and lands in that person's Sent Items: seeing the thread and
 * speaking as somebody else are different questions.
 */
function readableThread(req, accountAlias, threadAlias, from) {
  const base = readable(req, accountAlias, from);
  if (isAdmin(req)) return base;
  const t = threadAlias;
  const mine = (table, key, column) => `EXISTS (SELECT 1 FROM ${table} x WHERE ${t}.entity = '${column}' AND x.${key} = ${t}.entity_id
      AND (lower(x.sales_person) = lower($${from}) OR lower(x.sales_person) = lower($${from + 1})))`;
  return {
    clause: `(${base.clause}
      OR ${mine('quotations', 'quotation_no', 'quotation')}
      OR ${mine('projects', 'project_id', 'project')}
      OR ${mine('enquiries', 'enquiry_no', 'enquiry')})`,
    params: base.params,
  };
}

/** Null when there is no such mailbox, so the caller can 404 rather than leak. */
async function mayAdminister(req, id) {
  const { rows } = await query('SELECT username FROM connected_accounts WHERE id = $1', [id]);
  if (!rows.length) return null;
  if (isAdmin(req)) return true;
  return identities(req).some((name) => String(rows[0].username || '').toLowerCase() === name.toLowerCase());
}

/** The 403 every one of those routes gives, worded the same way. */
const NOT_YOURS = 'That mailbox belongs to somebody else';
const fields = (parsed) => new ApiError(422, 'Please check the highlighted fields', { fields: Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.'), i.message])) });

// The OAuth state is signed, so a callback cannot be forged or replayed after ten minutes.
const sign = (payload) => crypto.createHmac('sha256', `${config.microsoft.tokenKey}:oauth`).update(payload).digest('base64url');
function makeState(data) {
  const payload = Buffer.from(JSON.stringify({ ...data, t: Date.now(), n: crypto.randomBytes(8).toString('hex') })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}
function readState(state) {
  const [payload, mac] = String(state || '').split('.');
  if (!payload || !mac || mac.length !== sign(payload).length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(sign(payload)))) return null;
  const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
  return Date.now() - data.t < 10 * 60 * 1000 ? data : null;
}

mailboxRouter.get('/', async (req, res) => {
  const listScope = readable(req, 'a', 1);
  const { rows } = await query(
    `SELECT a.id, a.username, a.provider, a.email, a.display_name, a.is_shared, a.status, a.visibility, a.import_days, a.exclude_internal,
            a.auto_create_contacts, a.last_synced_at, a.last_error, a.token_expires_at, a.created_at,
            (SELECT COUNT(*)::int FROM email_threads t WHERE t.account_id = a.id) AS threads,
            -- Whether mail from this mailbox actually reaches the Inbox.
            -- Being shared is not enough: routing needs an active inboxes
            -- row, and without one a shared mailbox stores threads that
            -- nobody ever sees on the Inbox page.
            EXISTS (SELECT 1 FROM inboxes i WHERE i.account_id = a.id AND i.active) AS feeds_inbox,
            (SELECT COUNT(*)::int FROM email_messages m WHERE m.account_id = a.id) AS messages,
            (SELECT json_agg(json_build_object('folder', f.folder, 'subscribed_until', f.subscription_expires_at, 'synced', f.delta_link IS NOT NULL)) FROM mail_folders f WHERE f.account_id = a.id) AS folders
       FROM connected_accounts a WHERE ${listScope.clause} ORDER BY a.status = 'disconnected', a.email`, listScope.params);
  res.json({ data: rows, configured: { microsoft: microsoftConfigured(), token_key: Boolean(config.microsoft.tokenKey), webhook: Boolean(config.microsoft.webhookUrl), test_mailboxes: config.nodeEnv !== 'production' } });
});

mailboxRouter.get('/connect/microsoft', (req, res) => {
  if (isStaging()) throw new ApiError(409, 'Connecting real mailboxes is switched off on staging');
  if (!microsoftConfigured() || !config.microsoft.tokenKey) throw new ApiError(503, 'Microsoft 365 is not set up on this server yet. The lead needs to register the app and set MS_CLIENT_ID, MS_CLIENT_SECRET, MS_TENANT_ID, MS_REDIRECT_URI and MAIL_TOKEN_KEY.');
  res.redirect(authUrl(makeState({ u: who(req), shared: req.query.shared === '1' })));
});

mailboxRouter.get('/oauth/microsoft', async (req, res) => {
  // /settings/mailboxes, not /mailboxes: the page moved into the Settings
  // area in the redesign. The old path still redirects, but a redirect
  // that drops the query string turned every outcome of this flow —
  // success and failure alike — into a silent return to the page.
  const back = (msg) => res.redirect(`/settings/mailboxes?${new URLSearchParams(msg)}`);
  const state = readState(req.query.state);
  if (!state || state.u !== who(req)) return back({ error: 'The sign-in could not be verified. Please try again.' });
  if (req.query.error) return back({ error: String(req.query.error_description || req.query.error).slice(0, 200) });
  try {
    const tokens = await exchangeCode(String(req.query.code || ''));
    const me = await fetch('https://graph.microsoft.com/v1.0/me?$select=displayName,mail,userPrincipalName', { headers: { Authorization: `Bearer ${tokens.access_token}` } }).then((r) => r.json());
    const email = (me.mail || me.userPrincipalName || '').toLowerCase();
    if (!email) return back({ error: 'Microsoft did not say which mailbox this is.' });
    const { rows: [a] } = await query(
      `INSERT INTO connected_accounts (username, provider, email, display_name, is_shared, tokens_encrypted, token_expires_at, scopes, status)
       VALUES ($1,'microsoft',$2,$3,$4,$5,$6,$7,'active')
       ON CONFLICT ((lower(email))) WHERE status <> 'disconnected'
       DO UPDATE SET tokens_encrypted = EXCLUDED.tokens_encrypted, token_expires_at = EXCLUDED.token_expires_at, scopes = EXCLUDED.scopes, status = 'active', last_error = NULL
       RETURNING id`,
      [who(req), email, me.displayName || null, Boolean(state.shared), sealTokens(tokens, config.microsoft.tokenKey), tokens.expires_at, tokens.scope || null]);
    syncAccount(a.id).catch(() => {});
    return back({ connected: email });
  } catch (err) {
    return back({ error: `Could not connect: ${err.message}`.slice(0, 200) });
  }
});

mailboxRouter.post('/test', requireAdmin, async (req, res) => {
  if (config.nodeEnv === 'production') throw new ApiError(404, 'Not found');
  const parsed = z.object({ email: z.string().trim().email(), shared: z.boolean().optional().default(false), display_name: z.string().max(120).optional() }).safeParse(req.body || {});
  if (!parsed.success) throw fields(parsed);
  const { rows: [a] } = await query(
    `INSERT INTO connected_accounts (username, provider, email, display_name, is_shared) VALUES ($1,'test',$2,$3,$4) RETURNING *`,
    [who(req), parsed.data.email.toLowerCase(), parsed.data.display_name || null, parsed.data.shared]).catch((e) => { if (e.code === '23505') throw new ApiError(409, 'That mailbox is already connected'); throw e; });
  res.status(201).json({ data: a });
});

mailboxRouter.post('/:id/test-messages', requireAdmin, async (req, res) => {
  if (config.nodeEnv === 'production') throw new ApiError(404, 'Not found');
  const { rows: [a] } = await query(`SELECT * FROM connected_accounts WHERE id = $1 AND provider = 'test'`, [Number(req.params.id)]);
  if (!a) throw new ApiError(404, 'No test mailbox with that id');
  const messages = (req.body?.messages || []).map((m, i) => ({ provider_id: m.provider_id || `test-${Date.now()}-${i}`, sent_at: m.sent_at || new Date().toISOString(), cc: [], to: [], ...m }));
  res.json({ data: { queued: pushTestMessages(a.id, messages) } });
});

const settingsSchema = z.object({
  visibility: z.enum(['metadata', 'subject', 'share_everything']).optional(),
  import_days: z.coerce.number().int().min(0).max(365).optional(),
  exclude_internal: z.boolean().optional(),
  auto_create_contacts: z.boolean().optional(),
  is_shared: z.boolean().optional(),
});

mailboxRouter.patch('/:id', async (req, res) => {
  const allowed = await mayAdminister(req, Number(req.params.id));
  if (allowed === null) throw new ApiError(404, 'Mailbox not found');
  if (!allowed) throw new ApiError(403, NOT_YOURS);
  const parsed = settingsSchema.safeParse(req.body || {});
  if (!parsed.success) throw fields(parsed);
  const set = Object.entries(parsed.data).filter(([, v]) => v !== undefined);
  if (!set.length) throw new ApiError(422, 'Nothing to change');
  const { rows: [a] } = await query(`UPDATE connected_accounts SET ${set.map(([k], i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING id, visibility, import_days, exclude_internal, auto_create_contacts, is_shared`, [Number(req.params.id), ...set.map(([, v]) => v)]);
  if (!a) throw new ApiError(404, 'Mailbox not found');
  // A stricter level applies to what is already stored, too.
  if (parsed.data.visibility === 'metadata') await query('UPDATE email_messages SET subject = NULL, snippet = NULL, body_html = NULL WHERE account_id = $1', [a.id]);
  if (parsed.data.visibility === 'subject') await query('UPDATE email_messages SET snippet = NULL, body_html = NULL WHERE account_id = $1', [a.id]);
  if (parsed.data.visibility === 'metadata') await query('UPDATE email_threads SET subject = NULL WHERE account_id = $1', [a.id]);
  // How far back to read is only consulted for a folder that has no delta
  // link yet (lib/mailbox/sync.js), because after the first pass Graph
  // hands us a cursor and we follow it. So raising the number on its own
  // changes nothing at all — the next sync resumes from the cursor and
  // never looks further back than it already has.
  //
  // Dropping the cursor is what makes the setting mean something: the next
  // sync walks the new window from the start. It is safe to repeat,
  // because ingest() skips any message already stored for the account
  // (sync.js, the provider_id check), so a second pass over ground already
  // covered stores nothing twice.
  if (parsed.data.import_days !== undefined) {
    await query('UPDATE mail_folders SET delta_link = NULL WHERE account_id = $1', [a.id]);
  }
  res.json({ data: a });
});

mailboxRouter.post('/:id/sync', async (req, res) => {
  const allowed = await mayAdminister(req, Number(req.params.id));
  if (allowed === null) throw new ApiError(404, 'Mailbox not found');
  if (!allowed) throw new ApiError(403, NOT_YOURS);
  const r = await syncAccount(Number(req.params.id));
  if (r.skipped === 'not active') throw new ApiError(409, 'This mailbox is not active; reconnect it first');
  res.json({ data: r });
});

/**
 * Re-read the bodies of mail already stored, under the sanitiser as it is
 * now. Nothing is inserted and no conversation is touched — see
 * refreshBodies. Whoever may administer the mailbox may run it, which is
 * the same gate its sync is behind.
 */
mailboxRouter.post('/:id/refresh-bodies', async (req, res) => {
  const allowed = await mayAdminister(req, Number(req.params.id));
  if (allowed === null) throw new ApiError(404, 'Mailbox not found');
  if (!allowed) throw new ApiError(403, NOT_YOURS);
  const days = req.body?.days === undefined ? undefined : Number(req.body.days);
  if (days !== undefined && (!Number.isFinite(days) || days < 1 || days > 3650)) {
    throw new ApiError(422, 'days must be between 1 and 3650');
  }
  const r = await refreshBodies(Number(req.params.id), { days });
  if (r.skipped === 'not active') throw new ApiError(409, 'This mailbox is not active; reconnect it first');
  res.json({ data: r });
});

mailboxRouter.post('/:id/disconnect', async (req, res) => {
  const allowed = await mayAdminister(req, Number(req.params.id));
  if (allowed === null) throw new ApiError(404, 'Mailbox not found');
  if (!allowed) throw new ApiError(403, NOT_YOURS);
  const r = await disconnect(Number(req.params.id), { removeBodies: req.body?.remove_bodies !== false });
  if (!r) throw new ApiError(404, 'Mailbox not found');
  res.json({ data: r });
});

// ------------------------------------------------------------ automatic enquiries
// docs/email-enquiries.md. The on/off switch is the auto_enquiries_enabled
// setting, written through PATCH /api/settings/:key like any other.

/** Per mailbox: how far the read of past mail has got, and what was decided. */
mailboxRouter.get('/auto-enquiries', requireAdmin, async (req, res) => {
  const { enquirySettings, aiCallsToday } = await import('../lib/mailbox/autoEnquiry.js');
  const { poSettings } = await import('../lib/mailbox/autoPurchaseOrder.js');
  const { invoiceSettings } = await import('../lib/mailbox/autoInvoice.js');
  const { aiConfig } = await import('../lib/ai.js');
  const settings = await enquirySettings();
  const po = await poSettings();
  const { rows } = await query(
    `SELECT a.id, a.email, a.is_shared, a.status, a.visibility,
            b.since, b.folder, b.reached, b.scanned, b.created AS backfill_created, b.linked AS backfill_linked,
            b.started_at, b.finished_at, b.last_error, b.updated_at,
            COALESCE(d.created, 0)::int AS created, COALESCE(d.linked, 0)::int AS linked, COALESCE(d.not_enquiry, 0)::int AS not_enquiry,
            COALESCE(d.from_quotations, 0)::int AS from_quotations, COALESCE(d.quotations_read, 0)::int AS quotations_read,
            COALESCE(d.quotations_failed, 0)::int AS quotations_failed,
            -- Purchase orders (docs/email-po-plan.md): what was decided, and the read of past mail.
            COALESCE(p.registered, 0)::int AS pos_registered, COALESCE(p.linked, 0)::int AS pos_linked,
            COALESCE(p.review, 0)::int AS pos_to_review, COALESCE(p.not_po, 0)::int AS not_po,
            pb.reached AS po_reached, pb.scanned AS po_scanned, pb.started_at AS po_started_at, pb.finished_at AS po_finished_at,
            pb.last_error AS po_last_error,
            -- Invoices we emailed (§3.10).
            COALESCE(i.recorded, 0)::int AS invoices_recorded, COALESCE(i.review, 0)::int AS invoices_to_review,
            COALESCE(i.waiting, 0)::int AS invoices_waiting,
            ib.reached AS invoice_reached, ib.scanned AS invoice_scanned, ib.finished_at AS invoice_finished_at, ib.last_error AS invoice_last_error
       FROM connected_accounts a
       LEFT JOIN mailbox_invoice_backfills ib ON ib.account_id = a.id
       LEFT JOIN (SELECT account_id,
                         count(*) FILTER (WHERE outcome IN ('recorded','recorded_by_hand')) AS recorded,
                         count(*) FILTER (WHERE outcome = 'review') AS review,
                         count(*) FILTER (WHERE outcome = 'waiting') AS waiting
                    FROM email_invoice_decisions GROUP BY account_id) i ON i.account_id = a.id
       LEFT JOIN mailbox_enquiry_backfills b ON b.account_id = a.id
       LEFT JOIN mailbox_po_backfills pb ON pb.account_id = a.id
       LEFT JOIN (SELECT account_id,
                         count(*) FILTER (WHERE outcome IN ('registered','registered_by_hand')) AS registered,
                         count(*) FILTER (WHERE outcome = 'linked') AS linked,
                         count(*) FILTER (WHERE outcome = 'review') AS review,
                         count(*) FILTER (WHERE outcome IN ('not_po','dismissed')) AS not_po
                    FROM email_po_decisions GROUP BY account_id) p ON p.account_id = a.id
       LEFT JOIN (SELECT account_id,
                         count(*) FILTER (WHERE outcome = 'created') AS created,
                         count(*) FILTER (WHERE outcome = 'linked') AS linked,
                         count(*) FILTER (WHERE outcome = 'not_enquiry') AS not_enquiry,
                         count(*) FILTER (WHERE outcome = 'created' AND kind = 'quotation_sent') AS from_quotations,
                         count(*) FILTER (WHERE quotation_extraction IN ('created','revised')) AS quotations_read,
                         count(*) FILTER (WHERE quotation_extraction = 'failed') AS quotations_failed
                    FROM email_enquiry_decisions GROUP BY account_id) d ON d.account_id = a.id
      WHERE a.status <> 'disconnected' ORDER BY a.is_shared DESC, a.email`);
  res.json({
    data: {
      enabled: settings.enabled,
      purchase_orders_enabled: po.enabled,
      invoices_enabled: (await invoiceSettings()).enabled,
      ai: { configured: aiConfig.enabled, used_today: await aiCallsToday(), daily_limit: settings.dailyAiLimit },
      backfill_days: settings.backfillDays,
      mailboxes: rows,
    },
  });
});

/**
 * Judge a mailbox's mail again: its not_enquiry decisions and its progress
 * through past mail are cleared, so the next runs read it afresh — after
 * the rules improved, or an AI key was added. What was created or linked
 * stays, so nothing is made twice.
 */
mailboxRouter.post('/:id/auto-enquiries/rerun', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { rows: [a] } = await query('SELECT id FROM connected_accounts WHERE id = $1', [id]);
  if (!a) throw new ApiError(404, 'Mailbox not found');
  if (req.body?.kind === 'pos') {
    // POs only: the emails decided not to be POs are read again, and the
    // read of past mail restarts. Registered, linked, review and dismissed
    // decisions stay, so nothing is registered twice and no item reappears.
    const { rowCount: cleared } = await query(
      `DELETE FROM email_po_decisions WHERE account_id = $1 AND outcome = 'not_po'
          AND NOT (ai_calls > 0 AND decided_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'))`, [id]);
    await query('DELETE FROM mailbox_po_backfills WHERE account_id = $1', [id]);
    return res.json({ data: { id, kind: 'pos', decisions_cleared: cleared, backfill: 'restarts on the next run' } });
  }
  if (req.body?.kind === 'invoices') {
    // Invoices only, the same way: not_invoice decisions read again, the read of Sent Items restarted.
    const { rowCount: cleared } = await query(
      `DELETE FROM email_invoice_decisions WHERE account_id = $1 AND outcome = 'not_invoice'
          AND NOT (ai_calls > 0 AND decided_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'))`, [id]);
    await query('DELETE FROM mailbox_invoice_backfills WHERE account_id = $1', [id]);
    return res.json({ data: { id, kind: 'invoices', decisions_cleared: cleared, backfill: 'restarts on the next run' } });
  }
  // Today's AI-judged rows stay: they are what the day's AI ceiling is
  // counted from, and judging them again today would change nothing.
  const { rowCount: cleared } = await query(
    `DELETE FROM email_enquiry_decisions WHERE account_id = $1 AND outcome = 'not_enquiry'
        AND NOT (ai_calls > 0 AND decided_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'))`, [id]);
  await query('DELETE FROM mailbox_enquiry_backfills WHERE account_id = $1', [id]);
  res.json({ data: { id, decisions_cleared: cleared, backfill: 'restarts on the next run' } });
});

mailboxRouter.get('/blocklist', async (req, res) => {
  const { rows } = await query('SELECT * FROM email_blocklist ORDER BY pattern');
  res.json({ data: rows });
});
mailboxRouter.post('/blocklist', requireAdmin, async (req, res) => {
  const pattern = String(req.body?.pattern || '').trim().toLowerCase();
  if (!/^(\*\.)?[a-z0-9._%+-]*@?[a-z0-9.-]+\.[a-z]{2,}$/.test(pattern)) throw new ApiError(422, 'Please check the highlighted fields', { fields: { pattern: 'An address or a domain, e.g. news@x.com or x.com' } });
  const { rows: [r] } = await query('INSERT INTO email_blocklist (pattern, created_by) VALUES ($1,$2) ON CONFLICT (pattern) DO UPDATE SET pattern = EXCLUDED.pattern RETURNING *', [pattern, who(req)]);
  res.status(201).json({ data: r });
});
mailboxRouter.delete('/blocklist/:id', requireAdmin, async (req, res) => {
  await query('DELETE FROM email_blocklist WHERE id = $1', [Number(req.params.id)]);
  res.status(204).end();
});

// ------------------------------------------------------------ threads

/**
 * Where a record came from, when it was made from an email: the date, the
 * mailbox, and the thread when the caller may read it. ?entity=enquiry&id=
 * or ?entity=quotation&id=. Nothing when it did not come from email, or
 * when the record is not the caller's to see.
 */
mailThreadRouter.get('/origin', async (req, res) => {
  const { entity, id } = req.query;
  if (!['enquiry', 'quotation'].includes(entity) || !id) throw new ApiError(422, 'entity (enquiry or quotation) and id are required');
  const { scopeOf, ownerClause } = await import('../auth/ownership.js');
  const params = [String(id)];
  const mine = ownerClause(scopeOf(req), params);
  const table = entity === 'enquiry' ? 'enquiries' : 'quotations';
  const key = entity === 'enquiry' ? 'enquiry_no' : 'quotation_no';
  const { rows: [record] } = await query(`SELECT 1 FROM ${table} WHERE ${key} = $1 ${mine ? `AND ${mine}` : ''}`, params);
  if (!record) return res.json({ data: null });
  const { rows: [d] } = await query(
    `SELECT d.received_at, d.kind, d.method, d.thread_id, d.quotation_extraction, a.email AS mailbox
       FROM email_enquiry_decisions d JOIN connected_accounts a ON a.id = d.account_id
      WHERE ${entity === 'enquiry' ? `d.enquiry_no = $1 AND d.outcome = 'created'` : `d.quotation_no = $1 AND d.quotation_extraction IN ('created','revised')`}
      ORDER BY d.decided_at ${entity === 'enquiry' ? 'ASC' : 'DESC'} LIMIT 1`, [String(id)]);
  if (!d) return res.json({ data: null });
  let threadId = null;
  if (d.thread_id) {
    const scope = readableThread(req, 'a', 't', 2);
    const { rows: [t] } = await query(
      `SELECT t.id FROM email_threads t JOIN connected_accounts a ON a.id = t.account_id WHERE t.id = $1 AND ${scope.clause}`, [d.thread_id, ...scope.params]);
    threadId = t?.id ?? null;
  }
  res.json({ data: { received_at: d.received_at, kind: d.kind, method: d.method, mailbox: d.mailbox, thread_id: threadId, quotation_extraction: d.quotation_extraction } });
});

mailThreadRouter.get('/threads', async (req, res) => {
  const params = []; const where = [];
  const { entity, id, company_id: companyId } = req.query;
  if (entity === 'company' || companyId) { params.push(Number(companyId || id)); where.push(`t.company_id = $${params.length}`); }
  else if (entity && id) { params.push(String(entity), String(id)); where.push(`t.entity = $${params.length - 1} AND t.entity_id = $${params.length}`); }
  else throw new ApiError(422, 'entity and id, or company_id, are required');
  const scope = readableThread(req, 'a', 't', params.length + 1);
  where.push(scope.clause);
  const { rows } = await query(
    `SELECT t.id, t.subject, t.company_id, t.contact_id, t.entity, t.entity_id, t.first_message_at, t.last_message_at, t.message_count, t.last_direction,
            a.email AS mailbox, a.visibility, a.is_shared, ct.name AS contact_name
       FROM email_threads t JOIN connected_accounts a ON a.id = t.account_id LEFT JOIN contacts ct ON ct.id = t.contact_id
      WHERE ${where.join(' AND ')} ORDER BY t.last_message_at DESC LIMIT 200`, [...params, ...scope.params]);
  res.json({ data: rows.map((t) => (t.visibility === 'metadata' ? { ...t, subject: null } : t)) });
});

mailThreadRouter.get('/threads/:id', async (req, res) => {
  // A thread somebody else's mailbox holds answers the same as one that is
  // not there: whether a colleague is talking to a client is not a question
  // this route should answer.
  const scope = readableThread(req, 'a', 't', 2);
  const { rows: [t] } = await query(
    `SELECT t.*, a.email AS mailbox, a.visibility, a.status AS mailbox_status, c.name AS company_name, ct.name AS contact_name
       FROM email_threads t JOIN connected_accounts a ON a.id = t.account_id
       LEFT JOIN companies c ON c.id = t.company_id LEFT JOIN contacts ct ON ct.id = t.contact_id
      WHERE t.id = $1 AND ${scope.clause}`, [Number(req.params.id), ...scope.params]);
  if (!t) throw new ApiError(404, 'Thread not found');
  const { rows } = await query('SELECT id, direction, from_email, from_name, to_emails, cc_emails, subject, snippet, body_html, has_attachments, sent_at, sent_from_tracker_by FROM email_messages WHERE thread_id = $1 ORDER BY sent_at', [t.id]);
  res.json({ data: { ...(t.visibility === 'metadata' ? { ...t, subject: null } : t), messages: rows.map((m) => applyVisibility(m, t.visibility)) } });
});

mailThreadRouter.patch('/threads/:id', async (req, res) => {
  const parsed = z.object({ entity: z.enum(['enquiry', 'quotation', 'project', 'purchase_order', 'payment_stage']).nullable(), entity_id: z.string().max(120).nullable() }).safeParse(req.body || {});
  if (!parsed.success) throw fields(parsed);
  const scope = readable(req, 'a', 4);
  const { rows: [t] } = await query(
    `UPDATE email_threads t SET entity = $2, entity_id = $3
       FROM connected_accounts a WHERE a.id = t.account_id AND t.id = $1 AND ${scope.clause}
     RETURNING t.id, t.entity, t.entity_id`,
    [Number(req.params.id), parsed.data.entity, parsed.data.entity ? parsed.data.entity_id : null, ...scope.params]);
  if (!t) throw new ApiError(404, 'Thread not found');
  res.json({ data: t });
});

mailThreadRouter.post('/threads/:id/reply', async (req, res) => {
  const parsed = z.object({ html: z.string().trim().min(1, 'Write a reply').max(100_000), reply_all: z.boolean().optional().default(true) }).safeParse(req.body || {});
  if (!parsed.success) throw fields(parsed);
  // The reply goes out as the mailbox and lands in its Sent Items, so it
  // has to be a mailbox this person is entitled to speak from.
  const scope = readable(req, 'a', 2);
  const { rows: [ok] } = await query(
    `SELECT t.id FROM email_threads t JOIN connected_accounts a ON a.id = t.account_id WHERE t.id = $1 AND ${scope.clause}`,
    [Number(req.params.id), ...scope.params]);
  if (!ok) throw new ApiError(404, 'Thread not found');
  try {
    res.json({ data: await replyToThread(Number(req.params.id), parsed.data.html, who(req), { replyAll: parsed.data.reply_all }) });
  } catch (err) {
    if (err.status) throw new ApiError(err.status, err.message);
    throw new ApiError(502, `The reply could not be sent: ${err.message}`);
  }
});

// ------------------------------------------------------------ webhook (public)

// This sits outside the login because Graph has no session, so a stranger
// can post to it too. The clientState check below is what makes a forged
// notification harmless, but the work still has to be bounded: a real burst
// is a handful of notifications a minute per mailbox, so this ceiling is far
// above genuine traffic and still a ceiling.
mailWebhookRouter.use(rateLimit({
  windowMs: 60 * 1000, limit: 300, standardHeaders: true, legacyHeaders: false,
  message: { error: { message: 'Too many notifications. Please slow down.' } },
}));

mailWebhookRouter.post('/notifications', async (req, res) => {
  // Graph checks the endpoint by sending a token to echo back.
  if (req.query.validationToken) return res.type('text/plain').send(String(req.query.validationToken));
  const items = Array.isArray(req.body?.value) ? req.body.value : [];
  res.status(202).end();
  try {
    // One lookup for the whole batch rather than one per item, so the number
    // of queries an unauthenticated caller can provoke does not grow with
    // the size of the body they send.
    const ids = [...new Set(items.slice(0, 100).map((n) => String(n.subscriptionId || '')).filter(Boolean))];
    if (!ids.length) return;
    const { rows } = await query('SELECT subscription_id, account_id, subscription_client_state FROM mail_folders WHERE subscription_id = ANY($1)', [ids]);
    const bySubscription = new Map(rows.map((f) => [f.subscription_id, f]));
    const accounts = new Set();
    for (const n of items.slice(0, 100)) {
      const f = bySubscription.get(String(n.subscriptionId || ''));
      if (!f || !f.subscription_client_state || n.clientState !== f.subscription_client_state) continue;
      if (n.lifecycleEvent === 'reauthorizationRequired' || n.lifecycleEvent === 'subscriptionRemoved') {
        await query('UPDATE mail_folders SET subscription_expires_at = now() WHERE subscription_id = $1', [n.subscriptionId]);
        const { rows: [a] } = await query('SELECT * FROM connected_accounts WHERE id = $1', [f.account_id]);
        if (a) ensureSubscriptions(a).catch(() => {});
      }
      accounts.add(f.account_id);
    }
    for (const id of accounts) syncAccount(id).catch(() => {});
  } catch {
    // The response has already gone; a failure here must not take the
    // process down. The next delta sync picks the messages up anyway.
  }
});
