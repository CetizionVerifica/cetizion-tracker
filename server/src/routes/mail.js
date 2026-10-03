/**
 * Reading mail the way Outlook shows it (docs/inbox-outlook-plan.md §3.3,
 * step 2): a mailbox's folders, the conversations in a folder, one message
 * with its recipients and attachments, and the attachments themselves.
 *
 *   GET /api/mail/mailboxes                                   the mailboxes the caller may read, each with its folders and Outlook's unread counts
 *   GET /api/mail/folders/:accountId/:folderId/messages       ?q&unread=1&flagged=1&page&page_size  one row per conversation, newest first
 *   GET /api/mail/messages/:id                                From, To, Cc (Bcc on our own mail), state, attachments, body — read live for the owner
 *   GET /api/mail/messages/:id/attachments/:attId             ?inline=1  the file, streamed from the provider; never stored here
 *   GET /api/mail/messages/:id/inline/:contentId              a cid: image of the message, for the reading pane's frame
 *
 * Nothing here writes to the provider; the actions come with step 3. What
 * is stored follows each mailbox's visibility, as at ingest. Two things go
 * past what is stored, for the **owner** of a personal mailbox only: the
 * live read of a body the mailbox does not store (§3.3), and attachment
 * downloads from a mailbox that stores metadata or subjects. Neither
 * stores anything; the file and the body pass through.
 */
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Router } from 'express';
import { mailboxClause, scopeOf, threadClause } from '../auth/ownership.js';
import { query } from '../db.js';
import { ApiError } from '../middleware/error.js';
import { cleanHtml, snippet } from '../lib/mailbox/rules.js';
import { trimQuotedPreview } from '../lib/mailbox/quotes.js';
import { providerFor, saveTokens } from '../lib/mailbox/sync.js';

export const mailRouter = Router();

/** The most the tracker will pass through for one attachment (plan §3.3). */
export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

/** Folders the switcher leaves out until compose (step 4) lists drafts live; Outlook's own are never shown. */
const HIDDEN_FOLDERS = ['drafts', 'outbox', 'conversationhistory', 'syncissues'];
/** The order Outlook shows the well-known folders in; everything else follows by name. */
const FOLDER_RANK = ['inbox', 'sentitems', 'archive', 'deleteditems', 'junkemail'];

const readable = (req, params, alias = 'a') => mailboxClause(scopeOf(req), params, { alias, kind: 'read' }) || 'TRUE';
const readableThread = (req, params) => threadClause(scopeOf(req), params, { accountAlias: 'a', threadAlias: 't' }) || 'TRUE';

/**
 * Whose mailbox it is. The owner of a personal mailbox, and nobody else,
 * reads past what the mailbox stores: that is their own mail, which Outlook
 * shows them in full whatever they chose to share with the team.
 */
const isOwner = (req, account) => !account.is_shared && account.user_id !== null && account.user_id === (req.user?.id ?? null);
/** Whether the caller may see the content the mailbox holds back — bodies read live, attachments downloaded. */
const mayReadContent = (req, account) => account.visibility === 'share_everything' || isOwner(req, account);

const pageOf = (req, { size = 50, max = 200 } = {}) => ({
  pageSize: Math.min(max, Math.max(1, Number.parseInt(req.query.page_size, 10) || size)),
  page: Math.max(1, Number.parseInt(req.query.page, 10) || 1),
});

// ------------------------------------------------------------ the switcher

mailRouter.get('/mailboxes', async (req, res) => {
  // $1 the caller, $2 the folder order, $3 the folders left out; the access clause takes $4.
  const params = [req.user?.id ?? null, FOLDER_RANK, HIDDEN_FOLDERS];
  const mine = readable(req, params);
  const { rows } = await query(
    `SELECT a.id, a.email, a.display_name, a.is_shared, a.visibility, a.status, a.last_synced_at, a.last_error,
            (a.user_id IS NOT NULL AND a.user_id = $1) AS mine,
            (SELECT json_build_object('id', i.id, 'name', i.name) FROM inboxes i WHERE i.account_id = a.id AND i.active ORDER BY i.id LIMIT 1) AS inbox,
            COALESCE((SELECT json_agg(json_build_object('folder_id', f.folder_id, 'parent_id', f.parent_id, 'display_name', f.display_name, 'well_known', f.well_known,
                                                        'unread_count', f.unread_count, 'total_count', f.total_count)
                                      ORDER BY COALESCE(array_position($2::text[], f.well_known), 99), lower(f.display_name))
                        FROM mail_folder_list f WHERE f.account_id = a.id AND (f.well_known IS NULL OR f.well_known <> ALL($3::text[]))), '[]'::json) AS folders
       FROM connected_accounts a
      WHERE a.status <> 'disconnected' AND ${mine}
      ORDER BY (a.user_id IS NOT NULL AND a.user_id = $1) DESC, a.is_shared DESC, a.email`, params);
  res.json({ data: rows });
});

// ------------------------------------------------------------ a folder's conversations

/** The mailbox, when the caller may read it; 404 otherwise, the same as when it does not exist. */
async function readableMailbox(req, accountId) {
  const params = [Number(accountId)];
  const mine = readable(req, params);
  const { rows: [a] } = await query(`SELECT a.* FROM connected_accounts a WHERE a.id = $1 AND a.status <> 'disconnected' AND ${mine}`, params);
  if (!a) throw new ApiError(404, 'Mailbox not found');
  return a;
}

/**
 * The folder asked for, by its id or its well-known name, as the ids a
 * message in it carries in folder_id: Outlook's id and, for a well-known
 * folder, the name the sync reads it by (the test provider stores names).
 */
async function folderOf(account, folderId) {
  const { rows: [f] } = await query(
    'SELECT folder_id, well_known, display_name FROM mail_folder_list WHERE account_id = $1 AND (folder_id = $2 OR well_known = $2) ORDER BY (folder_id = $2) DESC LIMIT 1',
    [account.id, folderId]);
  const wellKnown = f?.well_known || (FOLDER_RANK.includes(folderId) || folderId === 'drafts' ? folderId : null);
  if (!f && !wellKnown) throw new ApiError(404, 'Folder not found');
  return { ids: [...new Set([folderId, f?.folder_id, f?.well_known].filter(Boolean))], wellKnown, name: f?.display_name || null };
}

/**
 * Mail synced before 076 carries no folder: it was read from the Inbox or
 * Sent Items, which its direction still says. Shown there until a sync
 * hands it over again with its folder; never in any other folder.
 */
const legacyFolderSql = (wellKnown, alias = 'm') => (wellKnown === 'inbox' ? ` OR (${alias}.folder_id IS NULL AND ${alias}.direction = 'inbound')`
  : wellKnown === 'sentitems' ? ` OR (${alias}.folder_id IS NULL AND ${alias}.direction = 'outbound')` : '');

mailRouter.get('/folders/:accountId/:folderId/messages', async (req, res) => {
  const account = await readableMailbox(req, req.params.accountId);
  const folder = await folderOf(account, String(req.params.folderId));
  const { page, pageSize } = pageOf(req);
  const params = [account.id, folder.ids];
  const where = [];
  const add = (sql, v) => { params.push(v); where.push(sql.replaceAll('?', `$${params.length}`)); };
  if (req.query.q) add(`(c.subject ILIKE ? OR c.from_email ILIKE ? OR c.from_name ILIKE ? OR co.name ILIKE ? OR array_to_string(c.to_emails, ' ') ILIKE ?)`, `%${String(req.query.q).slice(0, 200)}%`);
  if (req.query.unread === '1') where.push('g.unread');
  if (req.query.flagged === '1') where.push('g.flagged');
  const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
  // One row per conversation, as Outlook groups by default: the newest
  // message in this folder stands for it, and the unread, flag and
  // paperclip marks say whether any message of it in the folder carries
  // them. Deleted mail (removed_at) is nowhere.
  const base = `
    WITH in_folder AS (
      SELECT m.* FROM email_messages m
       WHERE m.account_id = $1 AND m.removed_at IS NULL AND (m.folder_id = ANY($2)${legacyFolderSql(folder.wellKnown)})
    ),
    newest AS (
      SELECT DISTINCT ON (thread_id) thread_id, id AS message_id, sent_at, direction, from_email, from_name, to_emails, cc_emails,
             subject, snippet, flag_status, importance, is_read, has_attachments, web_link
        FROM in_folder ORDER BY thread_id, sent_at DESC, id DESC
    ),
    marks AS (
      SELECT thread_id, count(*)::int AS in_folder, COALESCE(bool_or(is_read = false), false) AS unread,
             COALESCE(bool_or(has_attachments), false) AS has_attachments, COALESCE(bool_or(flag_status = 'flagged'), false) AS flagged,
             COALESCE(bool_or(importance = 'high'), false) AS high
        FROM in_folder GROUP BY thread_id
    )
    FROM newest c JOIN marks g ON g.thread_id = c.thread_id
    JOIN email_threads t ON t.id = c.thread_id
    LEFT JOIN companies co ON co.id = t.company_id
    LEFT JOIN contacts ct ON ct.id = t.contact_id
    ${filter}`;
  const [{ rows }, { rows: [{ total }] }] = await Promise.all([
    query(`${base.replace('FROM newest c', `SELECT c.thread_id AS id, c.message_id, c.sent_at, c.direction, c.from_email, c.from_name, c.to_emails, c.cc_emails,
                 COALESCE(c.subject, t.subject) AS subject, c.snippet, c.flag_status, c.importance, c.is_read, c.web_link,
                 g.in_folder, g.unread, g.has_attachments, g.flagged, g.high,
                 t.message_count, t.entity, t.entity_id, t.company_id, co.name AS company_name, ct.name AS contact_name
            FROM newest c`)}
          ORDER BY c.sent_at DESC, c.message_id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, params),
    query(base.replace('FROM newest c', 'SELECT count(*)::int AS total FROM newest c'), params),
  ]);
  res.json({
    data: rows.map((r) => ({ ...r, snippet: trimQuotedPreview(r.snippet) })),
    meta: { page, page_size: pageSize, total, pages: Math.max(1, Math.ceil(total / pageSize)), folder: { id: folder.ids[0], well_known: folder.wellKnown, name: folder.name } },
  });
});

// ------------------------------------------------------------ one message

/** A message the caller may read, with its thread and mailbox; 404 otherwise. */
async function readableMessage(req, id) {
  const params = [Number(id)];
  const { rows: [m] } = await query(
    `SELECT m.*, t.subject AS thread_subject, t.company_id AS thread_company_id, t.entity, t.entity_id, t.conversation_id,
            a.email AS mailbox, a.visibility, a.is_shared, a.user_id AS mailbox_user_id, a.status AS mailbox_status,
            co.name AS company_name, ct.name AS contact_name
       FROM email_messages m JOIN email_threads t ON t.id = m.thread_id JOIN connected_accounts a ON a.id = m.account_id
       LEFT JOIN companies co ON co.id = t.company_id LEFT JOIN contacts ct ON ct.id = t.contact_id
      WHERE m.id = $1 AND ${readableThread(req, params)}`, params);
  if (!m) throw new ApiError(404, 'Message not found');
  return m;
}
const accountOf = (m) => ({ id: m.account_id, is_shared: m.is_shared, user_id: m.mailbox_user_id, visibility: m.visibility, status: m.mailbox_status });

/** What a message answers with: no provider id, no tokens, Bcc only on mail we sent. */
function publicMessage(m, { attachments, live = false, canDownload }) {
  const { provider_id, internet_message_id, mailbox_user_id, thread_company_id, body_html, snippet: preview, ...rest } = m;
  // Deleted in Outlook: the record timeline still shows that the email
  // existed, with no body (plan §3.4).
  const gone = Boolean(m.removed_at);
  return {
    ...rest,
    subject: m.subject ?? m.thread_subject ?? null,
    snippet: gone ? null : preview,
    body_html: gone ? null : body_html,
    bcc_emails: m.direction === 'outbound' ? m.bcc_emails || [] : [],
    attachments: attachments.map((a) => ({ ...a, url: canDownload ? `/api/mail/messages/${m.id}/attachments/${a.id}` : null })),
    live,
    can_download: canDownload,
  };
}

const attachmentsOf = async (messageId) => (await query(
  'SELECT id, name, content_type, size_bytes, is_inline, content_id FROM email_attachments WHERE message_id = $1 ORDER BY is_inline, id', [messageId])).rows;

mailRouter.get('/messages/:id', async (req, res) => {
  const m = await readableMessage(req, req.params.id);
  const account = accountOf(m);
  const canDownload = mayReadContent(req, account);
  let live = false;
  // The owner's live read (plan §3.3): the mailbox stores less than the
  // whole message, and this is its owner asking. The body comes from the
  // provider for this request, is cleaned the way a stored body is, and
  // is returned — never written. A provider that cannot answer (throttled,
  // disconnected) leaves the stored message as it is.
  if (!m.body_html && !m.removed_at && isOwner(req, account) && account.visibility !== 'share_everything' && account.status === 'active') {
    try {
      const { rows: [a] } = await query('SELECT * FROM connected_accounts WHERE id = $1', [account.id]);
      const provider = providerFor(a);
      const fresh = await provider.message(m.provider_id);
      await saveTokens(a, provider);
      const html = cleanHtml(fresh.body_html);
      Object.assign(m, { body_html: html, subject: fresh.subject ?? m.subject, snippet: fresh.preview ? snippet(fresh.preview) : snippet(html) });
      live = true;
    } catch (err) {
      m.live_error = err.status === 404 ? 'The message is no longer in the mailbox' : 'The mailbox could not be read just now';
    }
  }
  res.json({ data: publicMessage(m, { attachments: await attachmentsOf(m.id), live, canDownload }) });
});

// ------------------------------------------------------------ attachments

/** What may open in the browser rather than download: a PDF, an image. Anything else is a file to save. */
const previewable = (type) => /^(application\/pdf|image\/(png|jpe?g|gif|webp|bmp|svg\+xml))$/i.test(String(type || ''));

/**
 * Pass one attachment through from the provider (plan §3.3). The bytes are
 * counted on the way and cut off past the cap; `nosniff` so the browser
 * trusts the declared type and nothing else; and a preview is served with
 * a policy under which nothing in it can run or reach the app's origin.
 */
async function streamAttachment(req, res, { m, att, inline }) {
  if (att.size_bytes && att.size_bytes > ATTACHMENT_MAX_BYTES) throw new ApiError(413, 'This attachment is larger than 25 MB; open it in Outlook');
  const { rows: [a] } = await query('SELECT * FROM connected_accounts WHERE id = $1', [m.account_id]);
  if (!a || a.status !== 'active') throw new ApiError(409, 'The mailbox needs to be reconnected before its attachments can be read');
  const provider = providerFor(a);
  if (!provider.attachmentStream) throw new ApiError(501, 'This mailbox cannot serve attachments');
  let got;
  try { got = await provider.attachmentStream(m.provider_id, att.provider_id, { maxBytes: ATTACHMENT_MAX_BYTES }); }
  catch (err) { throw new ApiError(err.status === 404 ? 404 : err.status === 413 ? 413 : 502, err.status === 404 ? 'The attachment is no longer in the mailbox' : err.message); }
  await saveTokens(a, provider).catch(() => {});
  const name = String(att.name || 'attachment').replace(/[\r\n"]/g, '_').slice(0, 200);
  const type = inline && previewable(att.content_type) ? att.content_type : (att.content_type || 'application/octet-stream');
  res.status(200);
  res.setHeader('Content-Type', type);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `${inline && previewable(att.content_type) ? 'inline' : 'attachment'}; filename="${encodeURIComponent(name).replace(/%20/g, ' ')}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  // A preview is somebody else's file drawn by the browser: it gets a
  // document policy of its own, so a PDF's scripts and a crafted image
  // cannot touch the app's origin or the network.
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  res.setHeader('Cache-Control', 'private, max-age=600');
  if (got.size) res.setHeader('Content-Length', String(got.size));
  let sent = 0;
  const cap = new Transform({
    transform(chunk, _enc, cb) {
      sent += chunk.length;
      if (sent > ATTACHMENT_MAX_BYTES) return cb(new Error('attachment over the cap'));
      return cb(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(got.stream), cap, res);
  } catch (err) {
    // Headers are gone; the only honest answer is to cut the connection.
    if (!res.writableEnded) res.destroy(err);
  }
}

mailRouter.get('/messages/:id/attachments/:attId', async (req, res) => {
  const m = await readableMessage(req, req.params.id);
  // Content the mailbox holds back is not reachable by its id either: a
  // metadata-only mailbox's attachments are its owner's.
  if (!mayReadContent(req, accountOf(m))) throw new ApiError(404, 'Attachment not found');
  const { rows: [att] } = await query('SELECT * FROM email_attachments WHERE message_id = $1 AND id = $2', [m.id, Number(req.params.attId) || 0]);
  if (!att) throw new ApiError(404, 'Attachment not found');
  await streamAttachment(req, res, { m, att, inline: req.query.inline === '1' });
});

mailRouter.get('/messages/:id/inline/:contentId', async (req, res) => {
  const m = await readableMessage(req, req.params.id);
  if (!mayReadContent(req, accountOf(m))) throw new ApiError(404, 'Image not found');
  const cid = String(req.params.contentId).replace(/^<|>$/g, '');
  // An inline image only: a cid: in the HTML that points at a PDF, or at
  // anything that is not a picture, draws nothing.
  const { rows: [att] } = await query(
    `SELECT * FROM email_attachments WHERE message_id = $1 AND content_id IN ($2, '<' || $2 || '>') AND content_type ILIKE 'image/%' ORDER BY is_inline DESC, id LIMIT 1`,
    [m.id, cid]);
  if (!att) throw new ApiError(404, 'Image not found');
  await streamAttachment(req, res, { m, att, inline: true });
});
