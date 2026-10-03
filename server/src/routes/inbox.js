/**
 * The shared sales inbox (#30).
 *
 *   GET    /api/inbox/inboxes                       inboxes and their shared mailboxes
 *   POST   /api/inbox/inboxes                       { name, account_id, default_assignment, members, first_response_hours, signature }
 *   PATCH  /api/inbox/inboxes/:id
 *   GET    /api/inbox?view=mine|unassigned|all|overdue&status=&inbox_id=&q=&page=&page_size=
 *                                                   { data, meta: { page, page_size, total, pages } }
 *   GET    /api/inbox/summary                       counts for the sidebar
 *   POST   /api/inbox/sync                          pull new mail now (the API also does every minute)
 *   GET    /api/inbox/:id                           the conversation with its thread
 *   PATCH  /api/inbox/:id                           { assignee, status, priority, labels, snoozed_until }
 *   POST   /api/inbox/:id/reply                     { html | body, canned_id }  from the shared address
 *   POST   /api/inbox/:id/convert                   { service, sales_person, source_id, ... } a prefilled enquiry
 *   GET    /api/inbox/canned · POST · PATCH /canned/:id · DELETE /canned/:id
 */
import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../auth/middleware.js';
import { query, transaction } from '../db.js';
import { ApiError } from '../middleware/error.js';
import { sentFields } from '../lib/sentFields.js';
import { replyToThread } from '../lib/mailbox/sync.js';
import { createEnquiryFromEmail } from '../lib/mailbox/enquiryFromEmail.js';
import { trimQuotedPreview } from '../lib/mailbox/quotes.js';
import { fillTemplate, wake } from '../lib/inbox.js';
import { isSyncing, kickSync } from '../lib/mailbox/autoSync.js';

export const inboxRouter = Router();

const who = (req) => req.user?.username || 'admin';
const fields = (parsed) => new ApiError(422, 'Please check the highlighted fields', { fields: Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.'), i.message])) });
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const toHtml = (text) => String(text).split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');

// ------------------------------------------------------------ inboxes
const inboxSchema = z.object({
  name: z.string().trim().min(1).max(120),
  account_id: z.coerce.number().int().positive(),
  default_assignment: z.enum(['owner_of_company', 'round_robin', 'unassigned']).default('owner_of_company'),
  members: z.array(z.string().trim().min(1).max(120)).max(50).default([]),
  first_response_hours: z.coerce.number().int().min(1).max(720).nullish(),
  signature: z.string().max(2000).nullish(),
  active: z.boolean().optional(),
});

inboxRouter.get('/inboxes', async (req, res) => {
  const { rows } = await query(
    `SELECT i.*, a.email, a.status AS mailbox_status,
            (SELECT COUNT(*)::int FROM inbox_conversations c WHERE c.inbox_id = i.id AND c.status = 'open') AS open,
            (SELECT COUNT(*)::int FROM inbox_conversations c WHERE c.inbox_id = i.id) AS conversations
       FROM inboxes i JOIN connected_accounts a ON a.id = i.account_id ORDER BY i.name`);
  const { rows: shared } = await query(`SELECT id, email FROM connected_accounts WHERE is_shared AND status <> 'disconnected' AND id NOT IN (SELECT account_id FROM inboxes) ORDER BY email`);
  res.json({ data: rows, available_mailboxes: shared });
});

inboxRouter.post('/inboxes', requireAdmin, async (req, res) => {
  const parsed = inboxSchema.safeParse(req.body || {});
  if (!parsed.success) throw fields(parsed);
  const v = parsed.data;
  const { rows: [a] } = await query(`SELECT is_shared FROM connected_accounts WHERE id = $1 AND status <> 'disconnected'`, [v.account_id]);
  if (!a) throw new ApiError(422, 'Please check the highlighted fields', { fields: { account_id: 'Choose a connected mailbox' } });
  if (!a.is_shared) await query('UPDATE connected_accounts SET is_shared = true WHERE id = $1', [v.account_id]);
  const { rows: [i] } = await query(
    `INSERT INTO inboxes (name, account_id, default_assignment, members, first_response_hours, signature) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [v.name, v.account_id, v.default_assignment, v.members, v.first_response_hours ?? null, v.signature ?? null]).catch((e) => { if (e.code === '23505') throw new ApiError(409, 'That mailbox already has an inbox'); throw e; });
  res.status(201).json({ data: i });
});

inboxRouter.patch('/inboxes/:id', requireAdmin, async (req, res) => {
  const parsed = inboxSchema.partial().omit({ account_id: true }).safeParse(req.body || {});
  if (!parsed.success) throw fields(parsed);
  const set = Object.entries(sentFields(parsed.data, req.body)).filter(([, x]) => x !== undefined);
  if (!set.length) throw new ApiError(422, 'Nothing to change');
  const { rows: [i] } = await query(`UPDATE inboxes SET ${set.map(([k], n) => `${k} = $${n + 2}`).join(', ')} WHERE id = $1 RETURNING *`, [Number(req.params.id), ...set.map(([, x]) => x)]);
  if (!i) throw new ApiError(404, 'Inbox not found');
  res.json({ data: i });
});

/**
 * Delete an inbox.
 *
 * inbox_conversations.inbox_id cascades, and that table is the triage: the
 * status, the owner, the labels, the reply clock and the link to an enquiry.
 * The mail itself lives in email_threads and stays — the mailbox keeps every
 * message either way — but the work done on top of it does not come back.
 *
 * So a delete that would discard any of it refuses once and says how much.
 * ?discard=yes is the caller saying it read that sentence.
 */
inboxRouter.delete('/inboxes/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { rows: [i] } = await query('SELECT id, name FROM inboxes WHERE id = $1', [id]);
  if (!i) throw new ApiError(404, 'Inbox not found');
  const { rows: [{ count }] } = await query('SELECT COUNT(*)::int AS count FROM inbox_conversations WHERE inbox_id = $1', [id]);
  if (count > 0 && req.query.discard !== 'yes') {
    throw new ApiError(409, `${i.name} has ${count} conversation${count === 1 ? '' : 's'}. Deleting it discards their status, owner and reply clock. The emails themselves stay under the mailbox.`, { conversations: count });
  }
  await query('DELETE FROM inboxes WHERE id = $1', [id]);
  res.json({ data: { deleted: i.name, conversations: count } });
});

// ------------------------------------------------------------ canned responses
inboxRouter.get('/canned', async (req, res) => {
  const { rows } = await query('SELECT * FROM canned_responses WHERE shared OR owner = $1 ORDER BY name', [who(req)]);
  res.json({ data: rows });
});
const cannedSchema = z.object({ name: z.string().trim().min(1).max(120), body: z.string().trim().min(1).max(10000), shared: z.boolean().default(true) });
inboxRouter.post('/canned', async (req, res) => {
  const parsed = cannedSchema.safeParse(req.body || {});
  if (!parsed.success) throw fields(parsed);
  const { rows: [c] } = await query('INSERT INTO canned_responses (name, body, shared, owner) VALUES ($1,$2,$3,$4) RETURNING *', [parsed.data.name, parsed.data.body, parsed.data.shared, who(req)]);
  res.status(201).json({ data: c });
});
// Yours to change, or an admin's. The GET already filters by owner.
inboxRouter.patch('/canned/:id', ownCanned, async (req, res) => {
  const parsed = cannedSchema.partial().safeParse(req.body || {});
  if (!parsed.success) throw fields(parsed);
  const set = Object.entries(sentFields(parsed.data, req.body)).filter(([, x]) => x !== undefined);
  if (!set.length) throw new ApiError(422, 'Nothing to change');
  const { rows: [c] } = await query(`UPDATE canned_responses SET ${set.map(([k], n) => `${k} = $${n + 2}`).join(', ')} WHERE id = $1 RETURNING *`, [Number(req.params.id), ...set.map(([, x]) => x)]);
  if (!c) throw new ApiError(404, 'Not found');
  res.json({ data: c });
});
inboxRouter.delete('/canned/:id', ownCanned, async (req, res) => {
  await query('DELETE FROM canned_responses WHERE id = $1', [Number(req.params.id)]);
  res.status(204).end();
});

// ------------------------------------------------------------ conversations
/**
 * Whose queue this is. An inbox lists its members; an admin sees every
 * inbox. An inbox with no members named is the whole team's, which is how
 * they start and how a small team will leave them.
 *
 * Both spellings of a person are matched — the address they sign in with
 * and the name on their account — because members and assignees are typed
 * by hand.
 */
const isAdmin = (req) => req.user?.role === 'admin';

/** A canned response belongs to whoever wrote it; an admin may tidy any. */
async function ownCanned(req, res, next) {
  try {
    const { rows } = await query('SELECT owner FROM canned_responses WHERE id = $1', [Number(req.params.id)]);
    if (!rows.length) return next(new ApiError(404, 'Canned response not found'));
    const mine = [req.user?.username, req.user?.name].filter(Boolean)
      .some((name) => String(rows[0].owner || '').toLowerCase() === String(name).toLowerCase());
    if (!mine && !isAdmin(req)) return next(new ApiError(403, 'That reply belongs to somebody else'));
    return next();
  } catch (err) { return next(err); }
}
const identities = (req) => [req.user?.username || 'admin', req.user?.name || req.user?.username || 'admin'];
// Members are typed names, so both sides are folded (076): "Asha Kumar" in
// the setting and asha kumar signing in are one person. MCP's list_inbox
// (lib/mcp/data.js) folds them the same way.
const inboxScope = (req, from) => (isAdmin(req)
  ? { clause: 'TRUE', params: [] }
  : { clause: `(i.members = '{}'
       OR EXISTS (SELECT 1 FROM unnest(i.members) m WHERE lower(btrim(m)) IN (lower($${from}), lower($${from + 1})))
       OR c.assignee IS NULL OR lower(btrim(c.assignee)) IN (lower($${from}), lower($${from + 1})))`, params: identities(req) });

const LIST = `
  SELECT c.*, i.name AS inbox_name, ia.email AS inbox_email,
         t.subject, t.message_count, t.last_message_at, t.last_direction, t.entity, t.entity_id,
         co.name AS company_name, ct.name AS contact_name,
         (c.status = 'open' AND c.response_due_at IS NOT NULL AND c.response_due_at < now()) AS overdue,
         -- Two things the list has to say about a thread without anybody
         -- opening it, because they decide who picks it up. Both are read
         -- off what is already joined: no extra tables, no second query.
         --
         -- looks_new: nobody has turned it into an enquiry and it is not
         -- attached to any record, so it is either new business or noise.
         -- Mail kept only because the Inbox shows everything (filtered_as)
         -- is a colleague or a robot, never new business.
         (c.enquiry_no IS NULL AND t.entity IS NULL AND c.status = 'open' AND c.filtered_as IS NULL) AS looks_new,
         -- for_finance: it is about money that has already been invoiced,
         -- so it is finance's to answer even though it arrived in sales.
         -- COALESCE, because a thread attached to nothing gives NULL here
         -- and the client would then have three states to handle for a
         -- question with two answers.
         COALESCE(t.entity = 'payment_stage', false) AS for_finance,
         -- Nobody has opened it yet. Not the same as having no owner: a
         -- thread can be read and left deliberately unassigned.
         (c.first_opened_at IS NULL) AS unread,
         -- The first line of the newest message, so the list can be
         -- triaged without opening anything. It is already stored on the
         -- message; LATERAL keeps it one row per conversation instead of
         -- a second query per row.
         --
         -- Safe to read straight out: applyVisibility runs at ingest
         -- (lib/mailbox/sync.js), so a mailbox set to metadata-only has
         -- already stored this as NULL. The privacy choice was made
         -- before the row existed, not on the way out.
         last.snippet,
         COALESCE(last.has_attachments, false) AS has_attachments
    FROM inbox_conversations c
    JOIN inboxes i ON i.id = c.inbox_id
    -- Which shared address the thread actually arrived at. With more than
    -- one inbox the reading pane otherwise cannot say whether a client
    -- wrote to sales@ or to somebody's own mailbox, and the reply goes out
    -- from whichever it was.
    JOIN connected_accounts ia ON ia.id = i.account_id
    JOIN email_threads t ON t.id = c.thread_id
    LEFT JOIN companies co ON co.id = c.company_id
    LEFT JOIN contacts ct ON ct.id = c.contact_id
    LEFT JOIN LATERAL (
      SELECT m.snippet, m.has_attachments
        FROM email_messages m
       WHERE m.thread_id = t.id
       ORDER BY m.sent_at DESC, m.id DESC
       LIMIT 1
    ) last ON true`;



inboxRouter.get('/summary', async (req, res) => {
  await wake();
  const scope = inboxScope(req, 2);
  const { rows: [r] } = await query(
    `SELECT COUNT(*) FILTER (WHERE c.status = 'open')::int AS open,
            COUNT(*) FILTER (WHERE c.status = 'open' AND c.assignee IS NULL)::int AS unassigned,
            COUNT(*) FILTER (WHERE c.status = 'open' AND c.assignee = $1)::int AS mine,
            COUNT(*) FILTER (WHERE c.status = 'open' AND c.response_due_at < now())::int AS overdue
       FROM inbox_conversations c JOIN inboxes i ON i.id = c.inbox_id
      WHERE ${scope.clause}`, [who(req), ...scope.params]);
  res.json({ data: r });
});

/**
 * Pull new mail now, without waiting for the API's minute timer.
 *
 * The Inbox page calls this when it opens and while it stays open; there
 * is no button. It answers at once — a sweep can take minutes when the
 * enquiry reader calls the AI — and the page's own polling shows what the
 * sweep stored. Asking again within 15 seconds starts nothing new.
 */
inboxRouter.post('/sync', async (req, res) => {
  const { started } = kickSync();
  const { rows: [r] } = await query(
    `SELECT MAX(a.last_synced_at) AS last_synced_at
       FROM inboxes i JOIN connected_accounts a ON a.id = i.account_id
      WHERE i.active AND a.status = 'active'`);
  res.status(202).json({ data: { started, syncing: isSyncing(), last_synced_at: r?.last_synced_at || null } });
});

/** Conversations per page of the list, by default and at most. */
export const PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

inboxRouter.get('/', async (req, res) => {
  await wake();
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number.parseInt(req.query.page_size, 10) || PAGE_SIZE));
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const params = []; const where = [];
  const add = (sql, v) => { params.push(v); where.push(sql.replaceAll('?', `$${params.length}`)); };
  const view = String(req.query.view || 'all');
  if (view === 'mine') add('c.assignee = ?', String(req.query.assignee || who(req)));
  if (view === 'unassigned') where.push('c.assignee IS NULL');
  if (view === 'overdue') where.push(`c.status = 'open' AND c.response_due_at < now()`);
  if (req.query.status) add('c.status = ANY(?)', String(req.query.status).split(','));
  else if (view !== 'overdue') where.push(`c.status IN ('open','pending_client')`);
  if (req.query.inbox_id) add('c.inbox_id = ?', Number(req.query.inbox_id));
  if (req.query.q) add('(t.subject ILIKE ? OR c.from_email ILIKE ? OR c.from_name ILIKE ? OR co.name ILIKE ?)', `%${req.query.q}%`);
  const scope = inboxScope(req, params.length + 1);
  where.push(scope.clause);
  params.push(...scope.params);
  // Newest first, the way every mail client lists mail. Ordering by the
  // reply deadline first read as shuffled: a thread's place depended on a
  // clock nobody sees in the list. The overdue view is the exception — it
  // exists to work through the deadlines, so the longest overdue leads.
  const order = view === 'overdue'
    ? 'c.response_due_at, t.last_message_at DESC NULLS LAST, c.id DESC'
    : 't.last_message_at DESC NULLS LAST, c.id DESC';
  const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
  // A page at a time: with every message in the shared mailbox kept, the
  // list is the whole mailbox, and the old flat LIMIT 500 simply hid
  // everything after the 500th thread. The count uses the same joins and
  // the same filter, so `total` is the number the pages add up to.
  const [{ rows }, { rows: [{ total }] }] = await Promise.all([
    query(`${LIST} ${filter} ORDER BY ${order} LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, params),
    query(`SELECT COUNT(*)::int AS total FROM inbox_conversations c
              JOIN inboxes i ON i.id = c.inbox_id
              JOIN email_threads t ON t.id = c.thread_id
              LEFT JOIN companies co ON co.id = c.company_id
            ${filter}`, params),
  ]);
  // The preview is a column written at ingest, so mail synced before the
  // quoted history was split out still carries it — which is every thread
  // in the inbox today. Cutting it here fixes the backlog without dropping
  // a sync cursor and re-reading a year of mail to rewrite one text field.
  res.json({
    data: rows.map((r) => ({ ...r, snippet: trimQuotedPreview(r.snippet) })),
    meta: { page, page_size: pageSize, total, pages: Math.max(1, Math.ceil(total / pageSize)) },
  });
});

async function loadConversation(id, req) {
  // A conversation in somebody else's queue answers the same as one that is
  // not there.
  const scope = req ? inboxScope(req, 2) : { clause: 'TRUE', params: [] };
  const { rows: [c] } = await query(`${LIST} WHERE c.id = $1 AND ${scope.clause}`, [id, ...scope.params]);
  if (!c) throw new ApiError(404, 'Conversation not found');
  return c;
}

/**
 * What this thread looks like, and the one thing worth doing about it.
 *
 * The inbox is not a second CRM: rather than making somebody work out
 * whether an email is new business, the thread says so and offers the
 * single action that follows. Only one suggestion is ever returned,
 * because two suggestions is a decision again.
 *
 * Every read here is scoped the same way the conversation itself is —
 * the caller has already been shown this conversation, so its company's
 * own deals are no wider a disclosure.
 */
async function suggestionFor(conversation) {
  if (conversation.enquiry_no) return null;        // already converted
  if (conversation.entity) return null;            // already attached to a record
  if (conversation.status !== 'open') return null;
  if (conversation.filtered_as) return null;     // a colleague or a robot, not a lead

  if (!conversation.company_id) {
    return {
      kind: 'unknown_company',
      headline: `Nothing on file matches ${conversation.from_email}.`,
      detail: 'Converting it will create the company as well as the enquiry.',
      action: 'Create the enquiry',
    };
  }

  const { rows: [open] } = await query(
    `SELECT count(*)::int AS n FROM quotations
      WHERE company_id = $1 AND status IN ('Draft', 'Submitted', 'Under Negotiation', 'On Hold')`,
    [conversation.company_id]
  );
  if (open.n > 0) {
    return {
      kind: 'open_deal',
      headline: `${conversation.company_name} already has ${open.n} open deal${open.n === 1 ? '' : 's'}.`,
      detail: 'This may belong to one of them rather than being new business.',
      action: 'Create the enquiry anyway',
    };
  }
  return {
    kind: 'new_enquiry',
    headline: `This looks like a new enquiry from ${conversation.company_name}.`,
    detail: 'A company already on file, with no open deal.',
    action: 'Create the deal',
  };
}

inboxRouter.get('/:id', async (req, res) => {
  const conversation = await loadConversation(Number(req.params.id), req);
  // Opening it is what marks it seen — the same gesture a mail client has
  // always used, and the only one that needs no extra button. Written once
  // and never overwritten, so the dot answers "has anybody looked at this"
  // rather than "who looked most recently"; WHERE first_opened_at IS NULL
  // makes a re-read a no-op rather than a write on every GET.
  if (conversation.unread) {
    await query(
      'UPDATE inbox_conversations SET first_opened_at = now(), first_opened_by = $2 WHERE id = $1 AND first_opened_at IS NULL',
      [conversation.id, who(req)]);
  }
  res.json({ data: { ...conversation, suggestion: await suggestionFor(conversation) } });
});

const patchSchema = z.object({
  assignee: z.string().trim().max(120).nullish(),
  status: z.enum(['open', 'pending_client', 'snoozed', 'closed']).optional(),
  priority: z.enum(['low', 'normal', 'high']).optional(),
  labels: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  snoozed_until: z.string().datetime({ offset: true }).nullish(),
});

inboxRouter.patch('/:id', async (req, res) => {
  const parsed = patchSchema.safeParse(req.body || {});
  if (!parsed.success) throw fields(parsed);
  const v = { ...parsed.data };
  if (v.assignee === '') v.assignee = null;
  if (v.status === 'snoozed' && !v.snoozed_until) throw new ApiError(422, 'Please check the highlighted fields', { fields: { snoozed_until: 'Until when?' } });
  if (v.status && v.status !== 'snoozed') v.snoozed_until = null;
  const set = Object.entries(v).filter(([, x]) => x !== undefined);
  if (v.status === 'closed') set.push(['closed_at', new Date().toISOString()]);
  else if (v.status) set.push(['closed_at', null]);
  if (!set.length) throw new ApiError(422, 'Nothing to change');
  // Scoped like every read of a conversation (076): one in somebody else's
  // queue answers as one that is not there, and is not changed.
  const scope = inboxScope(req, set.length + 2);
  const { rowCount } = await query(
    `UPDATE inbox_conversations c SET ${set.map(([k], n) => `${k} = $${n + 2}`).join(', ')}
       FROM inboxes i WHERE i.id = c.inbox_id AND c.id = $1 AND ${scope.clause}`,
    [Number(req.params.id), ...set.map(([, x]) => x), ...scope.params]);
  if (!rowCount) throw new ApiError(404, 'Conversation not found');
  res.json({ data: await loadConversation(Number(req.params.id), req) });
});

inboxRouter.post('/:id/reply', async (req, res) => {
  const parsed = z.object({ body: z.string().max(20000).optional(), html: z.string().max(100000).optional(), canned_id: z.coerce.number().int().positive().optional(), close: z.boolean().optional() }).safeParse(req.body || {});
  if (!parsed.success) throw fields(parsed);
  const c = await loadConversation(Number(req.params.id), req);
  const { rows: [inbox] } = await query('SELECT signature FROM inboxes WHERE id = $1', [c.inbox_id]);
  let text = parsed.data.body || '';
  if (parsed.data.canned_id) {
    const { rows: [t] } = await query('SELECT body FROM canned_responses WHERE id = $1', [parsed.data.canned_id]);
    if (!t) throw new ApiError(422, 'Unknown canned response');
    text = text || t.body;
  }
  text = fillTemplate(text, { contact_name: c.contact_name || c.from_name || 'Sir/Madam', company_name: c.company_name || '', my_name: who(req) });
  const html = parsed.data.html || (text.trim() ? toHtml(text) : '');
  if (!html) throw new ApiError(422, 'Please check the highlighted fields', { fields: { body: 'Write a reply' } });
  const signed = inbox?.signature ? `${html}${toHtml(fillTemplate(inbox.signature, { my_name: who(req) }))}` : html;
  try {
    const r = await replyToThread(c.thread_id, signed, who(req));
    if (!c.assignee) await query('UPDATE inbox_conversations SET assignee = $2 WHERE id = $1 AND assignee IS NULL', [c.id, who(req)]);
    if (parsed.data.close) await query(`UPDATE inbox_conversations SET status = 'closed', closed_at = now() WHERE id = $1`, [c.id]);
    res.json({ data: { ...r, conversation: await loadConversation(c.id, req) } });
  } catch (err) {
    if (err.status) throw new ApiError(err.status, err.message);
    throw new ApiError(502, `The reply could not be sent: ${err.message}`);
  }
});

const convertSchema = z.object({
  client_name: z.string().trim().max(200).optional(),
  contact_person: z.string().trim().max(120).optional(),
  service: z.string().trim().max(300).optional(),
  sales_person: z.string().trim().max(120).optional(),
  source_id: z.coerce.number().int().positive().optional(),
  notes: z.string().max(2000).optional(),
});

inboxRouter.post('/:id/convert', async (req, res) => {
  const parsed = convertSchema.safeParse(req.body || {});
  if (!parsed.success) throw fields(parsed);
  const c = await loadConversation(Number(req.params.id), req);
  if (c.enquiry_no) throw new ApiError(409, `Already converted to ${c.enquiry_no}`);
  const v = parsed.data;
  const client = v.client_name || c.company_name;
  if (!client) throw new ApiError(422, 'Please check the highlighted fields', { fields: { client_name: 'Which company is this?' } });
  const enquiry = await transaction(async (db) => {
    const { rows: [src] } = v.source_id ? { rows: [{ id: v.source_id }] } : await db.query(`SELECT id FROM lead_sources WHERE name = 'Inbound email or call'`);
    const { rows: [{ first }] } = await db.query('SELECT MIN(sent_at) AS first FROM email_messages WHERE thread_id = $1', [c.thread_id]);
    return createEnquiryFromEmail(db, {
      threadId: c.thread_id, fromEmail: c.from_email, fromName: c.from_name,
      enquiry: {
        dated_at: first || new Date().toISOString(), client_name: client, status: 'New',
        contact_person: v.contact_person || c.contact_name || c.from_name || null, sales_person: v.sales_person || c.assignee || null,
        service: v.service || c.subject || null, source_id: src?.id ?? null,
        notes: v.notes || `From the ${c.inbox_name} inbox: "${c.subject || ''}" from ${c.from_email}`, first_responded_at: c.first_response_at,
      },
    });
  });
  res.status(201).json({ data: enquiry });
});
