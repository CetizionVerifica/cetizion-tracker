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
import { disconnect, ensureSubscriptions, pushTestMessages, replyToThread, syncAccount } from '../lib/mailbox/sync.js';

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
  const back = (msg) => res.redirect(`/mailboxes?${new URLSearchParams(msg)}`);
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

mailboxRouter.post('/:id/disconnect', async (req, res) => {
  const allowed = await mayAdminister(req, Number(req.params.id));
  if (allowed === null) throw new ApiError(404, 'Mailbox not found');
  if (!allowed) throw new ApiError(403, NOT_YOURS);
  const r = await disconnect(Number(req.params.id), { removeBodies: req.body?.remove_bodies !== false });
  if (!r) throw new ApiError(404, 'Mailbox not found');
  res.json({ data: r });
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
