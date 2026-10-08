/**
 * Connected mailboxes (#29).
 *
 * Signed in:
 *   GET    /api/mailboxes                        accounts, their folders and state
 *   GET    /api/mailboxes/connect/microsoft?shared=1   start the Microsoft sign-in
 *   GET    /api/mailboxes/oauth/microsoft        the sign-in comes back here
 *   POST   /api/mailboxes/test                   { email, shared } a test mailbox (not in production)
 *   POST   /api/mailboxes/:id/test-messages      { messages } feed a test mailbox
 *   PATCH  /api/mailboxes/:id                    { visibility, import_days, exclude_internal, auto_create_contacts, read_scope; is_shared (admin); may_send_reports (owner) }
 *   PATCH  /api/mailboxes/:id/owner              { user_id } (admin) who a personal mailbox belongs to
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
import { isUnrestricted, mailboxClause, scopeOf, threadClause } from '../auth/ownership.js';
import { pool, query } from '../db.js';
import { ACTIONS, actorFrom, logActivity } from '../lib/activity.js';
import { config } from '../config.js';
import { ApiError } from '../middleware/error.js';
import { publicAttachment } from '../lib/mailbox/attachmentView.js';
import { applyVisibility, canReadLive, mayViewAttachments, sealTokens } from '../lib/mailbox/rules.js';
import { isStaging } from '../lib/ops/environment.js';
import { authUrl, exchangeCode, microsoftConfigured } from '../lib/mailbox/microsoft.js';
import { disconnect, ensureSubscriptions, pushTestMessages, refreshBodies, replyToThread, syncAccount } from '../lib/mailbox/sync.js';

export const mailboxRouter = Router();
export const mailThreadRouter = Router();
export const mailWebhookRouter = Router();

const who = (req) => req.user?.username || 'admin';
const isAdmin = (req) => isUnrestricted(req.user);

/**
 * Whose mailbox this is, and who may do what with it
 * (docs/per-user-mailboxes-plan.md §2). The rule lives in
 * auth/ownership.js — mailboxClause and threadClause — beside the record
 * ownership rules it leans on; these three wrap it for this file's queries.
 *
 *   readable        mailboxes the caller may read mail from: their own, and
 *                   the shared ones. Pushes onto params, returns the SQL or
 *                   'TRUE' for an admin.
 *   readableThread  those mailboxes' threads, plus a thread on a record the
 *                   caller owns (owner_user_id, not the sales_person text).
 *   administrable   the one mailbox the caller may change, sync or
 *                   disconnect — their own; shared ones are an admin's.
 *                   404 when it is not theirs, the same as when it does not
 *                   exist: whether a colleague has connected a mailbox is
 *                   not a question this API answers.
 */
const readable = (req, params, alias = 'a') => mailboxClause(scopeOf(req), params, { alias, kind: 'read' }) || 'TRUE';
const readableThread = (req, params, accountAlias = 'a', threadAlias = 't') => threadClause(scopeOf(req), params, { accountAlias, threadAlias }) || 'TRUE';
async function administrable(req, id) {
  const params = [Number(id)];
  const mine = mailboxClause(scopeOf(req), params, { alias: 'a', kind: 'administer' });
  const { rows: [a] } = await query(`SELECT a.* FROM connected_accounts a WHERE a.id = $1 ${mine ? `AND ${mine}` : ''}`, params);
  if (!a) throw new ApiError(404, 'Mailbox not found');
  return a;
}

const fields = (parsed) => new ApiError(422, 'Please check the highlighted fields', { fields: Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.'), i.message])) });

/** What a newly connected personal mailbox stores (setting, 074); 'subject' unless an admin chose another valid level. */
async function personalDefaultVisibility() {
  const { rows: [r] } = await query(`SELECT value FROM settings WHERE key = 'personal_mailbox_default_visibility'`);
  const v = String(r?.value || '').trim();
  return ['metadata', 'subject', 'share_everything'].includes(v) ? v : 'subject';
}

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
  const params = [];
  const mine = readable(req, params);
  const { rows } = await query(
    `SELECT a.id, a.username, a.provider, a.email, a.display_name, a.is_shared, a.status, a.visibility, a.import_days, a.exclude_internal,
            a.auto_create_contacts, a.read_scope, a.may_send_reports, a.last_synced_at, a.last_error, a.token_expires_at, a.created_at,
            -- Who it belongs to (074): a personal mailbox's owner, as a users row; null for shared, or unassigned.
            a.user_id, (SELECT json_build_object('id', u.id, 'name', u.name, 'active', u.active) FROM users u WHERE u.id = a.user_id) AS owner,
            a.connected_by, (SELECT u.name FROM users u WHERE u.id = a.connected_by) AS connected_by_name,
            (SELECT COUNT(*)::int FROM email_threads t WHERE t.account_id = a.id) AS threads,
            -- Whether mail from this mailbox actually reaches the Inbox.
            -- Being shared is not enough: routing needs an active inboxes
            -- row, and without one a shared mailbox stores threads that
            -- nobody ever sees on the Inbox page.
            EXISTS (SELECT 1 FROM inboxes i WHERE i.account_id = a.id AND i.active) AS feeds_inbox,
            (SELECT COUNT(*)::int FROM email_messages m WHERE m.account_id = a.id) AS messages,
            (SELECT json_agg(json_build_object('folder', f.folder, 'subscribed_until', f.subscription_expires_at, 'synced', f.delta_link IS NOT NULL)) FROM mail_folders f WHERE f.account_id = a.id) AS folders
       FROM connected_accounts a WHERE ${mine} ORDER BY a.status = 'disconnected', a.is_shared DESC, a.email`, params);
  res.json({ data: rows, configured: { microsoft: microsoftConfigured(), token_key: Boolean(config.microsoft.tokenKey), webhook: Boolean(config.microsoft.webhookUrl), test_mailboxes: config.nodeEnv !== 'production' } });
});

mailboxRouter.get('/connect/microsoft', (req, res) => {
  if (isStaging()) throw new ApiError(409, 'Connecting real mailboxes is switched off on staging');
  if (!microsoftConfigured() || !config.microsoft.tokenKey) throw new ApiError(503, 'Microsoft 365 is not set up on this server yet. The lead needs to register the app and set MS_CLIENT_ID, MS_CLIENT_SECRET, MS_TENANT_ID, MS_REDIRECT_URI and MAIL_TOKEN_KEY.');
  // A shared mailbox is the team's, and the team's things are an admin's to
  // set up. Anybody signed in may connect their own.
  if (req.query.shared === '1' && !isAdmin(req)) throw new ApiError(403, 'Only an admin can connect a shared mailbox');
  res.redirect(authUrl(makeState({ u: who(req), uid: req.user?.id ?? null, shared: req.query.shared === '1' })));
});

mailboxRouter.get('/oauth/microsoft', async (req, res) => {
  // /settings/mailboxes, not /mailboxes: the page moved into the Settings
  // area in the redesign. The old path still redirects, but a redirect
  // that drops the query string turned every outcome of this flow —
  // success and failure alike — into a silent return to the page.
  const back = (msg) => res.redirect(`/settings/mailboxes?${new URLSearchParams(msg)}`);
  const state = readState(req.query.state);
  // The session that comes back must be the one that set out: the mailbox
  // is attributed to it (user_id), so a session changed on the way — a
  // re-login, a shared machine — would hand one person's mail to another.
  if (!state || state.u !== who(req) || (state.uid ?? null) !== (req.user?.id ?? null)) return back({ error: 'The sign-in could not be verified. Please try again.' });
  if (req.query.error) return back({ error: String(req.query.error_description || req.query.error).slice(0, 200) });
  try {
    const tokens = await exchangeCode(String(req.query.code || ''));
    const me = await fetch('https://graph.microsoft.com/v1.0/me?$select=displayName,mail,userPrincipalName', { headers: { Authorization: `Bearer ${tokens.access_token}` } }).then((r) => r.json());
    const email = (me.mail || me.userPrincipalName || '').toLowerCase();
    if (!email) return back({ error: 'Microsoft did not say which mailbox this is.' });
    const shared = Boolean(state.shared);
    // The owner is the signed-in user, not a typed name (074). Null in the
    // legacy shared login, which has no users row; null for a shared mailbox.
    const uid = shared ? null : (req.user?.id ?? null);
    // Reconnecting must not quietly change hands. The same address already
    // connected and owned by somebody else is theirs until an admin
    // reassigns it; a shared mailbox cannot be re-connected as personal.
    const { rows: [held] } = await query(
      `SELECT a.id, a.user_id, a.is_shared, u.name AS owner_name FROM connected_accounts a LEFT JOIN users u ON u.id = a.user_id
        WHERE lower(a.email) = lower($1) AND a.status <> 'disconnected'`, [email]);
    if (held && !held.is_shared && held.user_id !== null && held.user_id !== uid) {
      return back({ error: `That mailbox is already connected by ${held.owner_name || 'somebody else'}. Ask an admin to reassign it.` });
    }
    if (held && held.is_shared !== shared) {
      return back({ error: held.is_shared ? 'That mailbox is connected as a shared mailbox. Reconnect it from the shared button.' : 'That mailbox is connected as a personal mailbox. Its owner reconnects it, or an admin disconnects it first.' });
    }
    const visibility = shared ? 'metadata' : await personalDefaultVisibility();
    const { rows: [a] } = await query(
      `INSERT INTO connected_accounts (username, provider, email, display_name, is_shared, tokens_encrypted, token_expires_at, scopes, status, user_id, connected_by, visibility, read_scope)
       VALUES ($1,'microsoft',$2,$3,$4,$5,$6,$7,'active',$8,$9,$10,$11)
       ON CONFLICT ((lower(email))) WHERE status <> 'disconnected'
       DO UPDATE SET tokens_encrypted = EXCLUDED.tokens_encrypted, token_expires_at = EXCLUDED.token_expires_at, scopes = EXCLUDED.scopes, status = 'active', last_error = NULL,
                     -- An unowned personal mailbox is claimed by whoever reconnects it; an owned one keeps its owner (checked above).
                     user_id = COALESCE(connected_accounts.user_id, EXCLUDED.user_id), connected_by = COALESCE(EXCLUDED.connected_by, connected_accounts.connected_by)
       RETURNING id`,
      [who(req), email, me.displayName || null, shared, sealTokens(tokens, config.microsoft.tokenKey), tokens.expires_at, tokens.scope || null,
        uid, req.user?.id ?? null, visibility, shared ? 'all' : 'inbox_sent']);
    syncAccount(a.id).catch(() => {});
    return back({ connected: email });
  } catch (err) {
    return back({ error: `Could not connect: ${err.message}`.slice(0, 200) });
  }
});

mailboxRouter.post('/test', requireAdmin, async (req, res) => {
  if (config.nodeEnv === 'production') throw new ApiError(404, 'Not found');
  const parsed = z.object({ email: z.string().trim().email(), shared: z.boolean().optional().default(false), display_name: z.string().max(120).optional(), user_id: z.coerce.number().int().positive().nullable().optional() }).safeParse(req.body || {});
  if (!parsed.success) throw fields(parsed);
  const userId = parsed.data.shared ? null : (parsed.data.user_id ?? null);
  const { rows: [a] } = await query(
    `INSERT INTO connected_accounts (username, provider, email, display_name, is_shared, user_id, connected_by, read_scope) VALUES ($1,'test',$2,$3,$4,$5,$6,$7) RETURNING *`,
    [who(req), parsed.data.email.toLowerCase(), parsed.data.display_name || null, parsed.data.shared, userId, req.user?.id ?? null, parsed.data.shared ? 'all' : 'inbox_sent'])
    .catch((e) => { if (e.code === '23505') throw new ApiError(409, 'That mailbox is already connected'); if (e.code === '23503') throw new ApiError(422, 'No such user'); throw e; });
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
  // Which folders the readers read (074): every folder, or Inbox and Sent Items.
  read_scope: z.enum(['all', 'inbox_sent']).optional(),
  is_shared: z.boolean().optional(),
  // The owner allows the scheduled reports to be sent from their personal mailbox (090).
  may_send_reports: z.boolean().optional(),
});

mailboxRouter.patch('/:id', async (req, res) => {
  const account = await administrable(req, req.params.id);
  const parsed = settingsSchema.safeParse(req.body || {});
  if (!parsed.success) throw fields(parsed);
  // Sending reports from somebody's own mailbox puts mail in their name in
  // their Sent Items: their decision, not an admin's (mis-report-sender-plan.md §A3).
  if (parsed.data.may_send_reports !== undefined) {
    if (account.is_shared) throw new ApiError(422, 'A shared mailbox can always send the reports; the switch is for personal mailboxes');
    if (account.user_id === null || account.user_id !== (req.user?.id ?? null)) throw new ApiError(403, 'Only the owner of this mailbox can allow reports to be sent from it');
  }
  // Making a mailbox the team's, or taking it back, is an admin's decision.
  if (parsed.data.is_shared !== undefined && !isAdmin(req)) throw new ApiError(403, 'Only an admin can make a mailbox shared');
  const set = Object.entries(parsed.data).filter(([, v]) => v !== undefined);
  if (!set.length) throw new ApiError(422, 'Nothing to change');
  // A shared mailbox has no personal owner (connected_accounts_shared_unowned).
  if (parsed.data.is_shared === true) set.push(['user_id', null]);
  // Making a mailbox personal while an Inbox routes it would leave the team
  // reading, and replying from, mail that is now one person's. The Inbox
  // goes first (Inbox → settings), then the mailbox can change hands.
  if (parsed.data.is_shared === false) {
    const { rows: [inbox] } = await query('SELECT name FROM inboxes WHERE account_id = $1', [Number(req.params.id)]);
    if (inbox) throw new ApiError(409, `This mailbox feeds the Inbox "${inbox.name}". Remove that Inbox first, then make the mailbox personal.`);
  }
  const { rows: [a] } = await query(`UPDATE connected_accounts SET ${set.map(([k], i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING id, visibility, import_days, exclude_internal, auto_create_contacts, read_scope, is_shared, user_id, may_send_reports`, [Number(req.params.id), ...set.map(([, v]) => v)]);
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
  // A change of which folders are read: the PO and invoice reads of past
  // mail hold a cursor into whichever stream they were on, so they start
  // their stream again. Decisions stay; nothing is made twice. The enquiry
  // read checks its own folder on each run (autoEnquiry.js backfillAccount).
  if (parsed.data.read_scope !== undefined) {
    await query('UPDATE mailbox_po_backfills SET next_link = NULL, reached = NULL WHERE account_id = $1 AND finished_at IS NULL', [a.id]);
    await query('UPDATE mailbox_invoice_backfills SET next_link = NULL, reached = NULL WHERE account_id = $1 AND finished_at IS NULL', [a.id]);
    if (parsed.data.read_scope === 'all') await query(`UPDATE mailbox_enquiry_backfills SET folder = 'all', next_link = NULL, reached = NULL WHERE account_id = $1 AND finished_at IS NULL`, [a.id]);
  }
  res.json({ data: a });
});

/**
 * Who a personal mailbox belongs to (docs/per-user-mailboxes-plan.md §4.3).
 * Mail read from now on makes records for the new owner; records already
 * made stay where they are — the ownership-transfer screen moves those, and
 * keeps the history honest while doing it.
 */
mailboxRouter.patch('/:id/owner', requireAdmin, async (req, res) => {
  const parsed = z.object({ user_id: z.coerce.number().int().positive().nullable() }).safeParse(req.body || {});
  if (!parsed.success) throw fields(parsed);
  const { rows: [a] } = await query('SELECT id, email, is_shared, user_id FROM connected_accounts WHERE id = $1', [Number(req.params.id)]);
  if (!a) throw new ApiError(404, 'Mailbox not found');
  if (a.is_shared) throw new ApiError(422, 'A shared mailbox has no owner; it is the team\'s');
  let owner = null;
  if (parsed.data.user_id !== null) {
    const { rows: [u] } = await query('SELECT id, name, role, active FROM users WHERE id = $1', [parsed.data.user_id]);
    if (!u || !u.active) throw new ApiError(422, 'Please check the highlighted fields', { fields: { user_id: 'Choose an active user' } });
    owner = u;
  }
  const { rows: [updated] } = await query(
    `UPDATE connected_accounts SET user_id = $2 WHERE id = $1 RETURNING id, email, is_shared, user_id`, [a.id, owner?.id ?? null]);
  // Allowed, but said out loud: records are owned by salespeople (ownerFor),
  // so an admin's mailbox makes records nobody owns, for an admin to hand out.
  const warning = owner && owner.role !== 'sales' ? `${owner.name} is an admin: enquiries and POs read from this mailbox will be unassigned until an admin hands them out.` : null;
  if (a.user_id !== (owner?.id ?? null)) {
    await logActivity(pool, {
      actor: actorFrom(req.user), action: ACTIONS.MAILBOX_OWNER_CHANGED, entityType: 'mailbox', entityId: a.id,
      metadata: { mailbox: a.email, old_user_id: a.user_id, new_user_id: owner?.id ?? null },
    });
  }
  res.json({ data: { ...updated, owner: owner ? { id: owner.id, name: owner.name } : null, warning } });
});

mailboxRouter.post('/:id/sync', async (req, res) => {
  await administrable(req, req.params.id);
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
  await administrable(req, req.params.id);
  const days = req.body?.days === undefined ? undefined : Number(req.body.days);
  if (days !== undefined && (!Number.isFinite(days) || days < 1 || days > 3650)) {
    throw new ApiError(422, 'days must be between 1 and 3650');
  }
  const r = await refreshBodies(Number(req.params.id), { days });
  if (r.skipped === 'not active') throw new ApiError(409, 'This mailbox is not active; reconnect it first');
  res.json({ data: r });
});

mailboxRouter.post('/:id/disconnect', async (req, res) => {
  await administrable(req, req.params.id);
  const r = await disconnect(Number(req.params.id), { removeBodies: req.body?.remove_bodies !== false });
  if (!r) throw new ApiError(404, 'Mailbox not found');
  res.json({ data: r });
});

// ------------------------------------------------------------ automatic enquiries
// docs/email-enquiries.md. The on/off switch is the auto_enquiries_enabled
// setting, written through PATCH /api/settings/:key like any other.

/** Per mailbox: how far the read of past mail has got, and what was decided. */
/**
 * The mail auto-entry panel (docs/email-auto-entry-plan.md §3.10): per day,
 * the emails the readers decided, what they entered, what went to review,
 * what triage kept from the readers, and the AI calls and spend; the review
 * reasons over the period; and what is waiting or failing now. Counts only.
 */
mailboxRouter.get('/auto-entry', requireAdmin, async (req, res) => {
  const { aiConfig, readsPdf } = await import('../lib/ai.js');
  const days =Math.min(60, Math.max(1, Number(req.query.days) || 14));
  const { rows: perDay } = await query(
    `WITH span AS (SELECT generate_series((now() AT TIME ZONE 'Asia/Kolkata')::date - ($1::int - 1), (now() AT TIME ZONE 'Asia/Kolkata')::date, interval '1 day')::date AS day),
          dec AS (
            SELECT (decided_at AT TIME ZONE 'Asia/Kolkata')::date AS day, account_id, provider_id,
                   outcome IN ('registered','linked') AS entered, review_reason IS NOT NULL AS review, ai_calls FROM email_po_decisions
             UNION ALL
            SELECT (decided_at AT TIME ZONE 'Asia/Kolkata')::date, account_id, provider_id,
                   outcome IN ('recorded','linked'), review_reason IS NOT NULL, ai_calls FROM email_invoice_decisions
             UNION ALL
            SELECT (decided_at AT TIME ZONE 'Asia/Kolkata')::date, account_id, provider_id,
                   outcome IN ('created','linked') OR quotation_extraction IN ('created','revised'), false, ai_calls FROM email_enquiry_decisions),
          d AS (SELECT day, count(DISTINCT (account_id, provider_id))::int AS read, count(*) FILTER (WHERE entered)::int AS entered,
                       count(*) FILTER (WHERE review)::int AS review FROM dec GROUP BY day),
          t AS (SELECT (decided_at AT TIME ZONE 'Asia/Kolkata')::date AS day, count(*)::int AS triaged,
                       count(*) FILTER (WHERE label IN ('other','payment_advice'))::int AS set_aside FROM email_triage GROUP BY 1),
          s AS (SELECT day, sum(calls)::int AS ai_calls, round(sum(cost_usd), 4)::float8 AS cost_usd FROM ai_usage_daily GROUP BY day)
     SELECT span.day::text AS day, COALESCE(d.read, 0) AS read, COALESCE(d.entered, 0) AS entered, COALESCE(d.review, 0) AS review,
            COALESCE(t.triaged, 0) AS triaged, COALESCE(t.set_aside, 0) AS set_aside, COALESCE(s.ai_calls, 0) AS ai_calls, COALESCE(s.cost_usd, 0) AS cost_usd
       FROM span LEFT JOIN d USING (day) LEFT JOIN t USING (day) LEFT JOIN s USING (day) ORDER BY span.day DESC`, [days]);
  const { rows: reasons } = await query(
    `SELECT reader, review_reason AS reason, count(*)::int AS n FROM (
       SELECT 'po' AS reader, review_reason, decided_at FROM email_po_decisions
        UNION ALL SELECT 'invoice', review_reason, decided_at FROM email_invoice_decisions) r
      WHERE review_reason IS NOT NULL AND decided_at >= now() - make_interval(days => $1::int)
      GROUP BY 1, 2 ORDER BY n DESC, reason`, [days]);
  const { rows: [now] } = await query(
    `SELECT (SELECT count(*) FROM email_po_decisions WHERE outcome = 'review')::int + (SELECT count(*) FROM email_invoice_decisions WHERE outcome = 'review')::int AS to_review,
            (SELECT count(*) FROM email_po_decisions WHERE outcome = 'review' AND decided_at < now() - interval '2 days')::int
              + (SELECT count(*) FROM email_invoice_decisions WHERE outcome = 'review' AND decided_at < now() - interval '2 days')::int AS older_than_two_days,
            (SELECT count(*) FROM email_invoice_decisions WHERE outcome = 'waiting')::int AS waiting,
            (SELECT count(*) FROM email_reader_queue WHERE failed_at IS NULL AND attempts > 0)::int AS retrying,
            (SELECT count(*) FROM email_reader_queue WHERE failed_at IS NOT NULL)::int AS failed,
            COALESCE((SELECT value FROM settings WHERE key = 'email_triage_enabled'), 'true') <> 'false' AS triage_enabled`);
  res.json({
    data: {
      days: perDay, reasons, now,
      models: { reader: aiConfig.model, fallbacks: aiConfig.fallbacks, check: aiConfig.checkModel, triage: aiConfig.triageModel, reads_pdf: readsPdf() },
    },
  });
});

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
      // The rollout of the new PO and invoice prompts (docs/email-po-invoice-prompt-plan.md §7).
      review_only: po.reviewOnly, auto_clients: po.autoClients,
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
 * mailbox, and the thread when the caller may read it. ?entity=enquiry&id=,
 * ?entity=quotation&id=, ?entity=purchase_order&id= or ?entity=payment_stage&id=. Nothing when it did not come from email, or
 * when the record is not the caller's to see.
 */
mailThreadRouter.get('/origin', async (req, res) => {
  const { entity, id } = req.query;
  if (!['enquiry', 'quotation', 'purchase_order', 'payment_stage'].includes(entity) || !id) {
    throw new ApiError(422, 'entity (enquiry, quotation, purchase_order or payment_stage) and id are required');
  }
  const { scopeOf, ownerClause, purchaseOrderClause, parentClause } = await import('../auth/ownership.js');
  if (entity === 'purchase_order' || entity === 'payment_stage') {
    // A PO registered from the client's email, or an invoice recorded from
    // ours (docs/email-po-plan.md): reachable through the PO, as the PO is.
    const params = [String(id)];
    const mine = entity === 'purchase_order'
      ? purchaseOrderClause(scopeOf(req), params, { alias: 'po' })
      : parentClause(scopeOf(req), params, { kind: 'via_po', alias: 'ps' });
    const { rows: [record] } = await query(entity === 'purchase_order'
      ? `SELECT 1 FROM purchase_orders po WHERE po.po_number = $1 ${mine ? `AND ${mine}` : ''}`
      : `SELECT 1 FROM payment_stages ps WHERE ps.id::text = $1 ${mine ? `AND ${mine}` : ''}`, params);
    if (!record) return res.json({ data: null });
    const { rows: [d] } = await query(entity === 'purchase_order'
      ? `SELECT d.received_at, d.mode, d.thread_id, d.outcome, a.email AS mailbox FROM email_po_decisions d JOIN connected_accounts a ON a.id = d.account_id
          WHERE d.po_number = $1 AND d.outcome IN ('registered','registered_by_hand') ORDER BY d.decided_at LIMIT 1`
      : `SELECT d.sent_at AS received_at, d.mode, d.thread_id, d.outcome, a.email AS mailbox FROM email_invoice_decisions d JOIN connected_accounts a ON a.id = d.account_id
          WHERE d.stage_id::text = $1 AND d.outcome IN ('recorded','recorded_by_hand') ORDER BY d.decided_at LIMIT 1`, [String(id)]);
    if (!d) return res.json({ data: null });
    let threadId = null;
    if (d.thread_id) {
      const tp = [d.thread_id];
      const { rows: [t] } = await query(
        `SELECT t.id FROM email_threads t JOIN connected_accounts a ON a.id = t.account_id WHERE t.id = $1 AND ${readableThread(req, tp)}`, tp);
      threadId = t?.id ?? null;
    }
    // Undo (docs/email-auto-entry-plan.md §3.10): an admin is told whether it is still possible, and why not.
    let undo;
    if (req.user?.role === 'admin' && !d.outcome.endsWith('_by_hand')) {
      const { poUndoable, invoiceUndoable } = await import('../lib/mailbox/undoEntry.js');
      const u = entity === 'purchase_order' ? await poUndoable({ query }, String(id)) : await invoiceUndoable({ query }, Number(id));
      undo = { possible: Boolean(u.decision), reason: u.reason || null };
    }
    return res.json({ data: { received_at: d.received_at, mode: d.mode, mailbox: d.mailbox, thread_id: threadId, by_hand: d.outcome.endsWith('_by_hand'), undo } });
  }
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
    const tp = [d.thread_id];
    const { rows: [t] } = await query(
      `SELECT t.id FROM email_threads t JOIN connected_accounts a ON a.id = t.account_id WHERE t.id = $1 AND ${readableThread(req, tp)}`, tp);
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
  where.push(readableThread(req, params));
  const { rows } = await query(
    `SELECT t.id, t.subject, t.company_id, t.contact_id, t.entity, t.entity_id, t.first_message_at, t.last_message_at, t.message_count, t.last_direction,
            a.email AS mailbox, a.visibility, a.is_shared, ct.name AS contact_name
       FROM email_threads t JOIN connected_accounts a ON a.id = t.account_id LEFT JOIN contacts ct ON ct.id = t.contact_id
      WHERE ${where.join(' AND ')} ORDER BY t.last_message_at DESC LIMIT 200`, params);
  res.json({ data: rows.map((t) => (t.visibility === 'metadata' ? { ...t, subject: null } : t)) });
});

mailThreadRouter.get('/threads/:id', async (req, res) => {
  // A thread somebody else's mailbox holds answers the same as one that is
  // not there: whether a colleague is talking to a client is not a question
  // this route should answer.
  const params = [Number(req.params.id)];
  const { rows: [t] } = await query(
    `SELECT t.*, a.email AS mailbox, a.visibility, a.status AS mailbox_status, a.is_shared, a.user_id, c.name AS company_name, ct.name AS contact_name
       FROM email_threads t JOIN connected_accounts a ON a.id = t.account_id
       LEFT JOIN companies c ON c.id = t.company_id LEFT JOIN contacts ct ON ct.id = t.contact_id
      WHERE t.id = $1 AND ${readableThread(req, params)}`, params);
  if (!t) throw new ApiError(404, 'Thread not found');
  // Outlook's state of each message and what is attached to it (076), for
  // the reading pane (docs/inbox-outlook-plan.md §3.3). Bcc only on mail we
  // sent; a message deleted in Outlook keeps its place with no body.
  const { rows } = await query(
    `SELECT m.id, m.direction, m.from_email, m.from_name, m.to_emails, m.cc_emails,
            CASE WHEN m.direction = 'outbound' THEN COALESCE(m.bcc_emails, '{}') ELSE '{}' END AS bcc_emails,
            m.subject, CASE WHEN m.removed_at IS NULL THEN m.snippet END AS snippet, CASE WHEN m.removed_at IS NULL THEN m.body_html END AS body_html,
            m.has_attachments, m.sent_at, m.sent_from_tracker_by, m.is_read, m.flag_status, m.importance, m.web_link, m.folder_id, m.removed_at,
            COALESCE((SELECT json_agg(json_build_object('id', x.id, 'name', x.name, 'content_type', x.content_type, 'size_bytes', x.size_bytes, 'is_inline', x.is_inline, 'content_id', x.content_id) ORDER BY x.is_inline, x.id)
                        FROM email_attachments x WHERE x.message_id = m.id), '[]'::json) AS attachments
       FROM email_messages m WHERE m.thread_id = $1 ORDER BY m.sent_at, m.id`, [t.id]);
  // The owner of a personal mailbox that stores less than the whole message
  // reads the rest live (GET /api/mail/messages/:id) and views its
  // attachments; so does anybody, from a mailbox that shares everything,
  // and whoever reads a shared mailbox views its attachments
  // (docs/inbox-attachments-plan.md §8). Nobody downloads them.
  const account = { is_shared: t.is_shared, user_id: t.user_id, visibility: t.visibility, status: t.mailbox_status };
  const canView = mayViewAttachments(req.user?.id, account);
  const { user_id, ...thread } = t;
  res.json({
    data: {
      ...(thread.visibility === 'metadata' ? { ...thread, subject: null } : thread),
      can_view_attachments: canView,
      messages: rows.map((m) => {
        const v = applyVisibility(m, t.visibility);
        return {
          ...v,
          attachments: v.attachments.map((a) => publicAttachment(m.id, a, canView)),
          can_read_live: canReadLive(req.user?.id, account, v),
        };
      }),
    },
  });
});

mailThreadRouter.patch('/threads/:id', async (req, res) => {
  const parsed = z.object({ entity: z.enum(['enquiry', 'quotation', 'project', 'purchase_order', 'payment_stage']).nullable(), entity_id: z.string().max(120).nullable() }).safeParse(req.body || {});
  if (!parsed.success) throw fields(parsed);
  const params = [Number(req.params.id), parsed.data.entity, parsed.data.entity ? parsed.data.entity_id : null];
  const { rows: [t] } = await query(
    `UPDATE email_threads t SET entity = $2, entity_id = $3
       FROM connected_accounts a WHERE a.id = t.account_id AND t.id = $1 AND ${readable(req, params)}
     RETURNING t.id, t.entity, t.entity_id`, params);
  if (!t) throw new ApiError(404, 'Thread not found');
  res.json({ data: t });
});

mailThreadRouter.post('/threads/:id/reply', async (req, res) => {
  const parsed = z.object({ html: z.string().trim().min(1, 'Write a reply').max(100_000), reply_all: z.boolean().optional().default(true) }).safeParse(req.body || {});
  if (!parsed.success) throw fields(parsed);
  // The reply goes out as the mailbox and lands in its Sent Items, so it
  // has to be a mailbox this person is entitled to speak from.
  const params = [Number(req.params.id)];
  const { rows: [ok] } = await query(
    `SELECT t.id FROM email_threads t JOIN connected_accounts a ON a.id = t.account_id WHERE t.id = $1 AND ${readable(req, params)}`, params);
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
