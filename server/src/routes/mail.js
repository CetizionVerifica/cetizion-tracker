/**
 * Reading mail the way Outlook shows it (docs/inbox-outlook-plan.md §3.3,
 * step 2): a mailbox's folders, the conversations in a folder, one message
 * with its recipients and attachments, and the attachments themselves.
 *
 *   GET /api/mail/mailboxes                                   the mailboxes the caller may read, each with its folders and Outlook's unread counts
 *   GET /api/mail/folders/:accountId/:folderId/messages       ?q&unread=1&flagged=1&page&page_size  one row per conversation, newest first
 *   GET /api/mail/messages/:id                                From, To, Cc (Bcc on our own mail), state, attachments, body — read live for the owner
 *   GET /api/mail/messages/:id/attachments/:attId/view        the file for the tracker's viewer, never a download (docs/inbox-attachments-plan.md)
 *   GET /api/mail/messages/:id/inline/:contentId              a cid: image of the message, for the reading pane's frame
 *
 * Nothing here writes to the provider; the actions come with step 3. What
 * is stored follows each mailbox's visibility, as at ingest. Two things go
 * past what is stored, for the **owner** of a personal mailbox only: the
 * live read of a body the mailbox does not store (§3.3), and attachments
 * viewed from a mailbox that stores metadata or subjects — for which a
 * shared mailbox's readers count as its owner (rules.js
 * mayViewAttachments). Neither stores anything; the file and the body pass
 * through. No attachment is ever downloaded from the tracker: it is
 * viewed in the Inbox and lives on in Outlook.
 */
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Router } from 'express';
import { mailboxClause, scopeOf, threadClause } from '../auth/ownership.js';
import { query } from '../db.js';
import { ApiError } from '../middleware/error.js';
import { ACTIONS, actorFrom, logActivity } from '../lib/activity.js';
import { forwardedEmail, officeExt, publicAttachment, toHtml, toSheets, toText, viewKind, viewType } from '../lib/mailbox/attachmentView.js';
import { converterConfigured, toPdf } from '../lib/mailbox/officeConvert.js';
import { liveAttachmentList, providerFailed, withLiveNames } from '../lib/mailbox/liveAttachments.js';
import { canReadLive, cleanHtml, isOwner, mayReadContent, mayViewAttachments, snippet } from '../lib/mailbox/rules.js';
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

/** Who is asking, for the owner rule (rules.js: isOwner, mayReadContent, canReadLive — shared with the thread route). */
const userOf = (req) => req.user?.id ?? null;

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
  // Until the first folder list is stored, the Inbox and Sent Items still
  // answer by name: the sync reads them by it, and mail from before 076
  // carries no folder at all (legacyFolderSql). No other folder is served
  // without a row to serve it from, and a hidden one (drafts) is not
  // served at all: the switcher never lists it.
  const wellKnown = f?.well_known || (['inbox', 'sentitems'].includes(folderId) ? folderId : null);
  if ((!f && !wellKnown) || HIDDEN_FOLDERS.includes(wellKnown)) throw new ApiError(404, 'Folder not found');
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
  // The total rides on the page itself: the list is refetched every few
  // seconds and on every search keystroke, and the conversations are
  // grouped once, not once more to count them. Only a page past the end
  // has no row to carry it and counts on its own.
  const { rows } = await query(`${base.replace('FROM newest c', `SELECT c.thread_id AS id, c.message_id, c.sent_at, c.direction, c.from_email, c.from_name, c.to_emails, c.cc_emails,
                 COALESCE(c.subject, t.subject) AS subject, c.snippet, c.flag_status, c.importance, c.is_read, c.web_link,
                 g.in_folder, g.unread, g.has_attachments, g.flagged, g.high,
                 (SELECT array_agg(x.name ORDER BY x.id) FROM email_attachments x
                   WHERE x.message_id = c.message_id AND NOT x.is_inline AND x.name IS NOT NULL) AS attachment_names,
                 t.message_count, t.entity, t.entity_id, t.company_id, co.name AS company_name, ct.name AS contact_name,
                 count(*) OVER ()::int AS total
            FROM newest c`)}
          ORDER BY c.sent_at DESC, c.message_id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, params);
  const total = rows.length ? rows[0].total : page === 1 ? 0 : (await query(base.replace('FROM newest c', 'SELECT count(*)::int AS total FROM newest c'), params)).rows[0].total;
  res.json({
    data: rows.map(({ total: _total, ...r }) => ({ ...r, snippet: trimQuotedPreview(r.snippet) })),
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

/**
 * The columns a message answers with — named, so that what the join
 * happens to carry (provider ids, Graph's conversation id, the sync's
 * bookkeeping, the mailbox's owner) never leaves with it.
 */
const PUBLIC_COLUMNS = ['id', 'thread_id', 'account_id', 'direction', 'from_email', 'from_name', 'to_emails', 'cc_emails', 'has_attachments', 'sent_at',
  'sent_from_tracker_by', 'web_link', 'folder_id', 'is_read', 'flag_status', 'importance', 'removed_at', 'created_at',
  'mailbox', 'visibility', 'company_id', 'contact_id', 'company_name', 'contact_name', 'entity', 'entity_id', 'live_error'];

/** What a message answers with: the public columns, Bcc only on mail we sent, no body once deleted in Outlook. */
function publicMessage(m, { attachments, live = false, canView }) {
  // Deleted in Outlook: the record timeline still shows that the email
  // existed, with no body (plan §3.4).
  const gone = Boolean(m.removed_at);
  return {
    ...Object.fromEntries(PUBLIC_COLUMNS.filter((k) => k in m).map((k) => [k, m[k]])),
    company_id: m.company_id ?? m.thread_company_id ?? null,
    subject: m.subject ?? m.thread_subject ?? null,
    snippet: gone ? null : m.snippet,
    body_html: gone ? null : m.body_html,
    bcc_emails: m.direction === 'outbound' ? m.bcc_emails || [] : [],
    attachments: attachments.map((a) => publicAttachment(m.id, a, canView)),
    live,
    can_view_attachments: canView,
  };
}

const attachmentsOf = async (messageId) => (await query(
  'SELECT id, provider_id, name, content_type, size_bytes, is_inline, content_id, kind FROM email_attachments WHERE message_id = $1 ORDER BY is_inline, id', [messageId])).rows;

/**
 * The stored attachment rows of a metadata-only mailbox carry no names; its
 * owner, and the readers of a shared one (who may view its attachments),
 * see them read from the provider.
 */
const needsLiveNames = (req, m, account) => account.visibility === 'metadata' && m.has_attachments && !m.removed_at
  && (isOwner(userOf(req), account) || (account.is_shared && mayViewAttachments(userOf(req), account)));

mailRouter.get('/messages/:id', async (req, res) => {
  const m = await readableMessage(req, req.params.id);
  const account = accountOf(m);
  const canView = mayViewAttachments(userOf(req), account);
  let live = false;
  // The owner's live read (plan §3.3): the mailbox stores less than the
  // whole message, and this is its owner asking. The body comes from the
  // provider for this request, is cleaned the way a stored body is, and
  // is returned — never written. A provider that cannot answer (throttled,
  // disconnected) leaves the stored message as it is.
  if (canReadLive(userOf(req), account, m)) {
    try {
      const { rows: [a] } = await query('SELECT * FROM connected_accounts WHERE id = $1', [account.id]);
      const provider = providerFor(a);
      const fresh = await provider.message(m.provider_id);
      await saveTokens(a, provider);
      const html = cleanHtml(fresh.body_html);
      Object.assign(m, { body_html: html, subject: fresh.subject ?? m.subject, snippet: fresh.preview ? snippet(fresh.preview) : snippet(html) });
      live = true;
    } catch (err) {
      await providerFailed(account.id, err);
      m.live_error = err.status === 404 ? 'The message is no longer in the mailbox'
        : err.reconnect ? 'The mailbox needs to be reconnected before it can be read'
          : 'The mailbox could not be read just now';
    }
  }
  const stored = await attachmentsOf(m.id);
  const attachments = needsLiveNames(req, m, account) ? withLiveNames(stored, await liveAttachmentList(m)) : stored;
  res.json({ data: publicMessage(m, { attachments, live, canView }) });
});

// ------------------------------------------------------------ attachments

/**
 * One attachment's bytes from the provider (plan §3.3), after the checks
 * every reader of them shares: the cap, by what the provider said of the
 * file, and a mailbox that can still be read. Throws the ApiError a
 * person can act on; the provider's own words stay on the server.
 */
async function openAttachment(m, att) {
  if (att.size_bytes && att.size_bytes > ATTACHMENT_MAX_BYTES) throw new ApiError(413, 'This attachment is larger than 25 MB; open it in Outlook');
  const { rows: [a] } = await query('SELECT * FROM connected_accounts WHERE id = $1', [m.account_id]);
  if (!a || a.status !== 'active') throw new ApiError(409, 'The mailbox needs to be reconnected before its attachments can be read');
  const provider = providerFor(a);
  if (!provider.attachmentStream) throw new ApiError(501, 'This mailbox cannot serve attachments');
  let got;
  try { got = await provider.attachmentStream(m.provider_id, att.provider_id, { maxBytes: ATTACHMENT_MAX_BYTES }); }
  catch (err) {
    await providerFailed(a.id, err);
    if (err.status === 404) throw new ApiError(404, 'The attachment is no longer in the mailbox');
    if (err.status === 413) throw new ApiError(413, 'This attachment is larger than 25 MB; open it in Outlook');
    if (err.reconnect) throw new ApiError(409, 'The mailbox needs to be reconnected before its attachments can be read');
    throw new ApiError(502, 'The attachment could not be read from the mailbox just now');
  }
  await saveTokens(a, provider).catch(() => {});
  return got;
}

/** Counts bytes on the way through and fails past the cap, whatever the provider said the size was. */
const capped = () => {
  let sent = 0;
  return new Transform({
    transform(chunk, _enc, cb) {
      sent += chunk.length;
      if (sent > ATTACHMENT_MAX_BYTES) return cb(new Error('attachment over the cap'));
      return cb(null, chunk);
    },
  });
};

/**
 * An email forwarded as an attachment (an Outlook item), read from the
 * provider as the message it is. Nothing is stored.
 */
async function readAttachedEmail(m, att) {
  const { rows: [a] } = await query('SELECT * FROM connected_accounts WHERE id = $1', [m.account_id]);
  if (!a || a.status !== 'active') throw new ApiError(409, 'The mailbox needs to be reconnected before its attachments can be read');
  const provider = providerFor(a);
  if (!provider.attachmentItem) throw new ApiError(501, 'This mailbox cannot serve attachments');
  let item;
  try { item = await provider.attachmentItem(m.provider_id, att.provider_id); }
  catch (err) {
    await providerFailed(a.id, err);
    if (err.status === 404) throw new ApiError(404, 'The attachment is no longer in the mailbox');
    if (err.reconnect) throw new ApiError(409, 'The mailbox needs to be reconnected before its attachments can be read');
    throw new ApiError(502, 'The attachment could not be read from the mailbox just now');
  }
  await saveTokens(a, provider).catch(() => {});
  if (!item) throw new ApiError(415, 'This Outlook item is not an email; open the message in Outlook');
  return item;
}

/** The whole file, for the viewers that read it here (a sheet, a text file, a Word document). */
async function readAttachment(m, att) {
  const got = await openAttachment(m, att);
  const chunks = [];
  try {
    for await (const chunk of Readable.fromWeb(got.stream).pipe(capped())) chunks.push(chunk);
  } catch {
    throw new ApiError(413, 'This attachment is larger than 25 MB; open it in Outlook');
  }
  return Buffer.concat(chunks);
}

/**
 * Pass one file through for the browser to draw (a PDF, a picture). Never
 * a download: `inline`, under the type the viewer asked for, `nosniff` so
 * the browser trusts that type and nothing else, not kept in any cache,
 * and under a document policy of its own, so a PDF's scripts or a crafted
 * image cannot touch the app's origin or the network even if the file is
 * opened on its own.
 */
function inlineHeaders(res, { att, type, name = att.name }) {
  const safe = String(name || 'attachment').replace(/[\r\n"\\]/g, '_').slice(0, 200);
  // RFC 6266: the real name goes in filename*, and the plain filename= is
  // for a client that ignores it — so plain ASCII, with anything else
  // replaced, rather than a percent-encoded name it would show as typed.
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_');
  res.status(200);
  res.setHeader('Content-Type', type);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`);
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  res.setHeader('Cache-Control', 'private, no-store');
}

async function streamAttachment(res, { m, att, type, opened = null }) {
  const got = await openAttachment(m, att);
  if (opened) await opened();
  inlineHeaders(res, { att, type });
  if (got.size) res.setHeader('Content-Length', String(got.size));
  try {
    await pipeline(Readable.fromWeb(got.stream), capped(), res);
  } catch (err) {
    // Headers are gone; the only honest answer is to cut the connection.
    if (!res.writableEnded) res.destroy(err);
  }
}

/**
 * The tracker's attachment viewer reads a file here (docs/inbox-attachments-plan.md
 * §4). Only the viewer: it asks with `X-Tracker-View: 1`, which a link, an
 * address typed in the bar or an <a download> cannot send, so pasting this
 * address into a tab gives a refusal rather than the file. A PDF or a
 * picture comes back as bytes for the viewer to draw, and so does a
 * PowerPoint or older Office file, converted to a PDF first; a spreadsheet,
 * a text file or a Word document as data; anything else is not viewable (415). Each view is
 * recorded in the activity log.
 */
mailRouter.get('/messages/:id/attachments/:attId/view', async (req, res) => {
  if (req.get('X-Tracker-View') !== '1') throw new ApiError(403, 'Attachments open in the tracker\'s viewer, in the Inbox');
  const m = await readableMessage(req, req.params.id);
  // Content the mailbox holds back is not reachable by its id either.
  const account = accountOf(m);
  if (!mayViewAttachments(userOf(req), account)) throw new ApiError(404, 'Attachment not found');
  let { rows: [att] } = await query('SELECT * FROM email_attachments WHERE message_id = $1 AND id = $2', [m.id, Number(req.params.attId) || 0]);
  if (!att) throw new ApiError(404, 'Attachment not found');
  // A metadata-only mailbox stores no names; which viewer to use may hang on one.
  if (!att.name && needsLiveNames(req, m, account)) [att] = withLiveNames([att], await liveAttachmentList(m));
  const kind = viewKind(att);
  if (!kind && att.kind === 'reference') throw new ApiError(415, 'This is a link to a file in OneDrive or SharePoint; open the message in Outlook to reach it');
  if (!kind) throw new ApiError(415, 'This kind of file cannot be shown in the tracker yet; open it in Outlook');
  if (kind === 'office' && !converterConfigured()) throw new ApiError(415, 'PowerPoint and older Office files cannot be shown in the tracker yet; open it in Outlook');
  // Recorded once the provider has handed the file over: a view that
  // never happened is not in the log.
  const viewed = () => logActivity(undefined, {
    actor: actorFrom(req.user), action: ACTIONS.MAIL_ATTACHMENT_VIEWED, entityType: 'email_message', entityId: String(m.id),
    metadata: { attachment_id: att.id, name: att.name ?? null, content_type: att.content_type ?? null, mailbox: m.mailbox },
  });
  if (kind === 'pdf' || kind === 'image') return streamAttachment(res, { m, att, type: viewType(att), opened: viewed });
  if (kind === 'email') {
    const item = await readAttachedEmail(m, att);
    await viewed();
    res.setHeader('Cache-Control', 'private, no-store');
    return res.json({ data: { kind, ...forwardedEmail(item) } });
  }
  // Read and turned into data first: a file that cannot be read was not viewed.
  const bytes = await readAttachment(m, att);
  if (kind === 'office') {
    // Converted to a PDF on the private network and drawn by the same
    // viewer as any PDF; the PDF is sent once and kept nowhere.
    let pdf;
    try { pdf = await toPdf(bytes, officeExt(att)); }
    catch (err) {
      console.warn('[mail] an attachment could not be converted:', err.message);
      throw new ApiError(422, 'This file could not be converted for viewing; open it in Outlook');
    }
    await viewed();
    inlineHeaders(res, { att, type: 'application/pdf', name: `${String(att.name || 'attachment').replace(/\.[a-z0-9]{1,8}$/i, '')}.pdf` });
    res.setHeader('Content-Length', String(pdf.length));
    return res.end(pdf);
  }
  let data;
  if (kind === 'text') data = toText(bytes);
  else if (kind === 'word') {
    try { data = await toHtml(bytes); }
    catch { throw new ApiError(422, 'This document could not be read; open it in Outlook'); }
  } else {
    try { data = { sheets: toSheets(bytes, att) }; }
    catch { throw new ApiError(422, 'This spreadsheet could not be read; open it in Outlook'); }
  }
  await viewed();
  res.setHeader('Cache-Control', 'private, no-store');
  return res.json({ data: { kind, ...data } });
});

mailRouter.get('/messages/:id/inline/:contentId', async (req, res) => {
  const m = await readableMessage(req, req.params.id);
  const account = accountOf(m);
  if (!mayReadContent(userOf(req), account)) throw new ApiError(404, 'Image not found');
  const cid = String(req.params.contentId).replace(/^<|>$/g, '');
  // An inline image only: a cid: in the HTML that points at a PDF, or at
  // anything that is not a picture, draws nothing.
  let { rows: [att] } = await query(
    `SELECT * FROM email_attachments WHERE message_id = $1 AND content_id IN ($2, '<' || $2 || '>') AND content_type ILIKE 'image/%' ORDER BY is_inline DESC, id LIMIT 1`,
    [m.id, cid]);
  // A metadata-only mailbox stores no content ids; its owner's body was
  // read live and names its images by them, so the list is read the same way.
  if (!att && needsLiveNames(req, m, account)) {
    const live = withLiveNames(await attachmentsOf(m.id), await liveAttachmentList(m));
    att = live.filter((x) => x.content_id && String(x.content_id).replace(/^<|>$/g, '') === cid && /^image\//i.test(x.content_type || ''))
      .sort((x, y) => Number(y.is_inline) - Number(x.is_inline) || x.id - y.id)[0] || null;
  }
  if (!att) throw new ApiError(404, 'Image not found');
  await streamAttachment(res, { m, att, type: viewType(att) });
});
