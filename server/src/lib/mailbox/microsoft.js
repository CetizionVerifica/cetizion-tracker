/**
 * Microsoft 365 through Microsoft Graph (#29), with plain fetch.
 *
 * Delegated sign-in (each person connects their own mailbox) with
 * Mail.ReadWrite, Mail.Send and offline_access. A shared mailbox can use
 * the same flow by a person with access, or an application permission
 * limited by an Exchange application access policy (MS_APP_ONLY=true).
 */
import { config } from '../../config.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';
/**
 * The shared pair matter for a shared mailbox, which is the case the
 * Inbox is built around.
 *
 * Every folder read goes to `/users/{email}/...` — somebody else's mailbox
 * whenever the account is shared — and plain Mail.ReadWrite covers only
 * the signed-in user's own. Graph refuses the rest with "The requested
 * user 'x' is invalid", which reads like the address is wrong rather than
 * like a missing permission, and cost an afternoon to recognise.
 *
 * Mail.ReadWrite.Shared explicitly does not include sending, so
 * Mail.Send.Shared is listed separately — without it, replying as the
 * shared address fails on its own.
 *
 * Both still require the connecting person to have been granted access to
 * that mailbox in Exchange. A scope is permission for the app to act as
 * them; it is not permission they did not already have.
 */
const SCOPES = [
  'offline_access',
  'User.Read',
  'Mail.ReadWrite',
  'Mail.ReadWrite.Shared',
  'Mail.Send',
  'Mail.Send.Shared',
];
const SELECT = 'id,conversationId,internetMessageId,subject,bodyPreview,body,from,toRecipients,ccRecipients,bccRecipients,sentDateTime,receivedDateTime,hasAttachments,isDraft,parentFolderId,webLink,isRead,flag,importance';

/** Folders synced for display only (docs/inbox-outlook-plan.md §3.5): shown in the Inbox, never read by the email readers or routed to the team queue. */
export const DISPLAY_ONLY_FOLDERS = ['deleteditems', 'junkemail'];

/**
 * Folders never read, with everything under them: spam, deleted mail,
 * drafts, mail not sent yet, and Outlook's own (Teams chat history, sync
 * conflicts). Every other folder is (073).
 */
export const SKIPPED_FOLDERS = ['junkemail', 'deleteditems', 'drafts', 'outbox', 'conversationhistory', 'syncissues'];

const ms = () => config.microsoft;
export const microsoftConfigured = () => Boolean(ms().clientId && ms().clientSecret && ms().tenantId && ms().redirectUri);
const tokenUrl = () => `https://login.microsoftonline.com/${ms().tenantId}/oauth2/v2.0/token`;

export function authUrl(state) {
  const p = new URLSearchParams({
    client_id: ms().clientId, response_type: 'code', redirect_uri: ms().redirectUri, response_mode: 'query',
    scope: SCOPES.join(' '), state, prompt: 'select_account',
  });
  return `https://login.microsoftonline.com/${ms().tenantId}/oauth2/v2.0/authorize?${p}`;
}

async function tokenRequest(params) {
  const r = await fetch(tokenUrl(), {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: ms().clientId, client_secret: ms().clientSecret, ...params }),
    signal: AbortSignal.timeout(20_000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error_description || j.error || `Token request failed (${r.status})`); e.reconnect = ['invalid_grant', 'interaction_required'].includes(j.error); throw e; }
  return { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: new Date(Date.now() + (j.expires_in - 60) * 1000).toISOString(), scope: j.scope };
}

export const exchangeCode = (code) => tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: ms().redirectUri, scope: SCOPES.join(' ') });

async function freshTokens(tokens) {
  if (ms().appOnly) {
    if (tokens?.access_token && new Date(tokens.expires_at) > new Date()) return tokens;
    return tokenRequest({ grant_type: 'client_credentials', scope: 'https://graph.microsoft.com/.default' });
  }
  if (tokens?.access_token && new Date(tokens.expires_at) > new Date()) return tokens;
  if (!tokens?.refresh_token) { const e = new Error('Not connected'); e.reconnect = true; throw e; }
  const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, scope: SCOPES.join(' ') });
  return { ...t, refresh_token: t.refresh_token || tokens.refresh_token };
}

/**
 * A provider bound to one account. `tokens` in, and `tokens()` out after
 * any call, so the caller can store refreshed ones.
 */
export function microsoftProvider(account, tokens) {
  let current = tokens;
  const who = `/users/${encodeURIComponent(account.email)}`;
  async function graph(path, { method = 'GET', body, headers = {} } = {}) {
    current = await freshTokens(current);
    // Immutable ids (docs/inbox-outlook-plan.md §3.5): a message keeps its id
    // when it is moved between folders, so a move is a change to one row,
    // not a new message. A message stored under its old, mutable id is
    // known again by its Internet Message-ID and its row takes the new id
    // (sync.js ingestOne).
    const prefer = ['IdType="ImmutableId"', headers.Prefer].filter(Boolean).join(', ');
    const r = await fetch(path.startsWith('http') ? path : `${GRAPH}${path}`, {
      method, signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${current.access_token}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers, Prefer: prefer },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 204 || r.status === 202) return null;
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.error?.message || `Graph ${r.status}`); e.status = r.status; e.code = j.error?.code || null; e.reconnect = r.status === 401; throw e; }
    return j;
  }
  const person = (x) => (x?.emailAddress ? { email: x.emailAddress.address, name: x.emailAddress.name } : null);
  const toMessage = (m) => ({
    provider_id: m.id, conversation_id: m.conversationId, internet_message_id: m.internetMessageId,
    subject: m.subject, body_html: m.body?.contentType === 'html' ? m.body.content : `<pre>${String(m.body?.content || '').replace(/</g, '&lt;')}</pre>`,
    preview: m.bodyPreview, from: person(m.from), to: (m.toRecipients || []).map(person).filter(Boolean), cc: (m.ccRecipients || []).map(person).filter(Boolean),
    sent_at: m.sentDateTime || m.receivedDateTime, has_attachments: Boolean(m.hasAttachments), draft: Boolean(m.isDraft),
    web_link: m.webLink || null,
    // Outlook's state of the message (076): facts, stored as they come.
    folder_id: m.parentFolderId || null, is_read: typeof m.isRead === 'boolean' ? m.isRead : null,
    flag_status: m.flag?.flagStatus || null, importance: m.importance || null,
    bcc: (m.bccRecipients || []).map(person).filter(Boolean),
  });

  /**
   * Every folder under `url` (a mailFolders or childFolders list), depth
   * first, each page followed. Child folders are asked for the same
   * fields as the top level (`select`), so a nested folder carries its
   * name, parent and counts like any other.
   */
  async function walk(url, visit, select = 'id,childFolderCount') {
    for (let next = url; next;) {
      const j = await graph(next);
      for (const f of j.value || []) {
        if (await visit(f) === false) continue;
        if (f.childFolderCount > 0) await walk(`${who}/mailFolders/${f.id}/childFolders?$select=${select}&$top=100`, visit, select);
      }
      next = j['@odata.nextLink'] || null;
    }
  }
  /** The ids of the well-known folders, asked once per provider: they never change. */
  let wellKnownIds = null;
  const wellKnown = () => {
    wellKnownIds ||= (async () => {
      const known = new Map();
      for (const name of ['inbox', 'sentitems', 'drafts', 'archive', 'deleteditems', 'junkemail', 'outbox']) {
        const f = await graph(`${who}/mailFolders/${name}?$select=id`).catch(() => null);
        if (f?.id) known.set(f.id, name);
      }
      return known;
    })().catch((err) => { wellKnownIds = null; throw err; });
    return wellKnownIds;
  };
  /** The ids of SKIPPED_FOLDERS and of every folder under them; asked once per provider. */
  let skippedIds = null;
  const skipped = () => {
    skippedIds ||= (async () => {
      const ids = new Set();
      for (const name of SKIPPED_FOLDERS) {
        // A mailbox without one of them (no Teams history) just has nothing to skip there.
        const f = await graph(`${who}/mailFolders/${name}?$select=id,childFolderCount`).catch(() => null);
        if (!f?.id) continue;
        ids.add(f.id);
        if (f.childFolderCount > 0) await walk(`${who}/mailFolders/${f.id}/childFolders?$select=id,childFolderCount&$top=100`, (c) => { ids.add(c.id); });
      }
      return ids;
    })().catch((err) => { skippedIds = null; throw err; });
    return skippedIds;
  };

  return {
    tokens: () => current,
    async me() { return graph(`${who}?$select=displayName,mail,userPrincipalName`); },
    /**
     * Every folder mail is read from (073): Inbox first and Sent Items last,
     * by name, and between them every other folder by id: Archive, the
     * folders people file client mail into, their subfolders. Never
     * SKIPPED_FOLDERS or anything under them.
     */
    async folders() {
      const skip = await skipped();
      const named = new Map();
      for (const name of ['inbox', 'sentitems']) named.set((await graph(`${who}/mailFolders/${name}?$select=id`)).id, name);
      const others = [];
      await walk(`${who}/mailFolders?$select=id,childFolderCount&$top=100`, (f) => {
        if (skip.has(f.id)) return false;
        if (!named.has(f.id)) others.push(f.id);
        return true;
      });
      return ['inbox', ...others, 'sentitems'];
    },
    /**
     * Every folder of the mailbox as Outlook has it, with Outlook's own
     * counts, for the folder switcher (076). Well-known names are read off
     * the folders that answer by name; everything else is a plain folder.
     */
    async folderList() {
      const known = await wellKnown();
      const select = 'id,parentFolderId,displayName,childFolderCount,unreadItemCount,totalItemCount';
      const out = [];
      await walk(`${who}/mailFolders?$select=${select}&$top=100`, (f) => {
        out.push({ folder_id: f.id, parent_id: f.parentFolderId || null, display_name: f.displayName || '', well_known: known.get(f.id) || null, unread_count: f.unreadItemCount || 0, total_count: f.totalItemCount || 0 });
        return true;
      }, select);
      return out;
    },
    /**
     * The immutable id of each message id given (Graph translateExchangeIds),
     * as a Map old → new. Ids Graph cannot translate (a message gone since)
     * are left out. At most 1,000 per call, as Graph allows.
     */
    async translateIds(ids) {
      const out = new Map();
      for (let i = 0; i < ids.length; i += 1000) {
        const j = await graph(`${who}/translateExchangeIds`, { method: 'POST', body: { inputIds: ids.slice(i, i + 1000), sourceIdType: 'restId', targetIdType: 'restImmutableEntryId' } });
        for (const r of j?.value || []) if (r.sourceId && r.targetId) out.set(r.sourceId, r.targetId);
      }
      return out;
    },
    /** The attachments of a message, metadata only (076): the file stays in Outlook. */
    async attachmentList(providerId) {
      const j = await graph(`${who}/messages/${providerId}/attachments?$select=id,name,contentType,size,isInline,contentId`);
      return (j.value || []).filter((a) => !a['@odata.type'] || a['@odata.type'] === '#microsoft.graph.fileAttachment')
        .map((a) => ({ provider_id: a.id, name: a.name, content_type: a.contentType || null, size_bytes: a.size ?? null, is_inline: Boolean(a.isInline), content_id: a.contentId || null }));
    },
    /**
     * New and changed messages in a folder since the last delta link, at
     * most `maxPages` pages of 50 at a time.
     *
     * The link returned is where the next call starts. Graph gives a delta
     * link only on the last page of a round; a round cut off at `maxPages`
     * returns the next page's link instead, which resumes the same round.
     * Returning the old link there (or none, on a first sync) started the
     * round over every time, so a mailbox with more than 2,500 changes
     * re-read the same messages for ever and never reached new mail.
     */
    async delta(folder, deltaLink, sinceIso, { maxPages = 50 } = {}) {
      let url = deltaLink || `${who}/mailFolders/${folder}/messages/delta?$select=${SELECT}${sinceIso ? `&$filter=receivedDateTime+ge+${sinceIso}` : ''}`;
      const messages = []; const removed = []; let next = null;
      for (let page = 0; page < maxPages && url; page += 1) {
        const j = await graph(url, { headers: { Prefer: 'odata.maxpagesize=50, outlook.body-content-type="html"' } });
        for (const m of j.value || []) {
          // Gone from this folder (076): a move shows it again elsewhere, a
          // delete does not; sync.js decides after ten minutes.
          if (m['@removed']) removed.push(m.id);
          else if (!m.isDraft) messages.push(toMessage(m));
        }
        url = j['@odata.nextLink'] || null;
        next = j['@odata.deltaLink'] || next;
      }
      return { messages, removed, deltaLink: url || next || deltaLink, more: Boolean(url) };
    },
    /** One message by its id; a 404 when the mailbox no longer has it under that id. */
    async message(providerId) {
      return toMessage(await graph(`${who}/messages/${providerId}?$select=${SELECT}`, { headers: { Prefer: 'outlook.body-content-type="html"' } }));
    },
    /**
     * One page of a folder, oldest first, from a date — for reading back
     * through past mail. A plain list rather than delta, so the live sync's
     * cursor is never touched. `cursor` is the nextLink of the page before.
     *
     * folder 'all': the whole mailbox as one stream, oldest first, without
     * SKIPPED_FOLDERS (073). A page can come back with fewer messages than
     * asked for, or none, and still have a next one.
     */
    async page(folder, { sinceIso, cursor = null, top = 50 } = {}) {
      const base = folder === 'all' ? `${who}/messages` : `${who}/mailFolders/${folder}/messages`;
      const url = cursor || `${base}?$select=${SELECT}&$filter=receivedDateTime+ge+${sinceIso}&$orderby=receivedDateTime+asc&$top=${top}`;
      const j = await graph(url, { headers: { Prefer: 'outlook.body-content-type="html"' } });
      // A cursor carries its own query, which may run over every folder
      // whatever `folder` now says, so the skip list applies to it too; for
      // a single folder's cursor it simply matches nothing.
      const skip = (folder === 'all' || cursor) ? await skipped() : null;
      return {
        messages: (j.value || []).filter((m) => !m.isDraft && !(skip && skip.has(m.parentFolderId))).map(toMessage),
        next: j['@odata.nextLink'] || null,
      };
    },
    /**
     * A message's file attachments, as buffers. Graph returns small files
     * inline as base64; one larger than about 3 MB comes without its bytes
     * and is fetched from its $value. Mail.ReadWrite already covers this.
     */
    async attachments(providerId, { maxBytes = 15 * 1024 * 1024 } = {}) {
      const j = await graph(`${who}/messages/${providerId}/attachments?$select=id,name,contentType,size`);
      const out = [];
      for (const a of j.value || []) {
        if (a['@odata.type'] && a['@odata.type'] !== '#microsoft.graph.fileAttachment') continue;
        if (a.size > maxBytes) { out.push({ name: a.name, contentType: a.contentType, size: a.size, content: null }); continue; }
        let content = null;
        const full = await graph(`${who}/messages/${providerId}/attachments/${a.id}`).catch(() => null);
        if (full?.contentBytes) content = Buffer.from(full.contentBytes, 'base64');
        else {
          current = await freshTokens(current);
          const r = await fetch(`${GRAPH}${who}/messages/${providerId}/attachments/${a.id}/$value`, { headers: { Authorization: `Bearer ${current.access_token}` }, signal: AbortSignal.timeout(60_000) });
          if (r.ok) content = Buffer.from(await r.arrayBuffer());
        }
        out.push({ name: a.name, contentType: a.contentType, size: a.size, content });
      }
      return out;
    },
    /**
     * One attachment's bytes, as a stream straight from Graph's $value
     * (docs/inbox-outlook-plan.md §3.3), for a download or a preview. The
     * file never lands on our disk; `maxBytes` refuses one Graph says is
     * larger before a byte is read, and the caller counts the rest. Returns
     * { stream, size } — a web ReadableStream and Content-Length when known.
     */
    async attachmentStream(providerId, attachmentId, { maxBytes = 25 * 1024 * 1024 } = {}) {
      current = await freshTokens(current);
      const r = await fetch(`${GRAPH}${who}/messages/${providerId}/attachments/${attachmentId}/$value`, {
        headers: { Authorization: `Bearer ${current.access_token}`, Prefer: 'IdType="ImmutableId"' }, signal: AbortSignal.timeout(120_000),
      });
      if (!r.ok) { await r.body?.cancel().catch(() => {}); const e = new Error(`Graph ${r.status}`); e.status = r.status; e.reconnect = r.status === 401; throw e; }
      const size = Number(r.headers.get('content-length')) || null;
      if (size && size > maxBytes) { await r.body?.cancel().catch(() => {}); throw Object.assign(new Error('The attachment is larger than the tracker will download'), { status: 413 }); }
      return { stream: r.body, size };
    },
    /** Reply in the same conversation; Outlook keeps it in Sent Items. */
    async reply(providerId, html, { replyAll = true } = {}) {
      await graph(`${who}/messages/${providerId}/${replyAll ? 'replyAll' : 'reply'}`, { method: 'POST', body: { comment: html } });
    },
    /**
     * Send a new message from the mailbox; it lands in its Sent Items.
     * `attachments`: [{ name, contentType, content: Buffer }], sent inline
     * as Graph's fileAttachment, which takes a file of up to about 3 MB —
     * plenty for a report PDF (docs/mis-reports-plan.md §3.6).
     *
     * `from`: { address, name } to send as another address (Send As or
     * Send on Behalf, granted in Exchange); Graph refuses it with
     * ErrorSendAsDenied otherwise. Omitted, the mailbox's own address.
     */
    async send({ to, cc = [], subject, html, attachments = [], from = null }) {
      const rec = (list) => list.map((address) => ({ emailAddress: { address } }));
      const files = attachments.map((a) => ({ '@odata.type': '#microsoft.graph.fileAttachment', name: a.name, contentType: a.contentType || 'application/octet-stream', contentBytes: Buffer.from(a.content).toString('base64') }));
      await graph(`${who}/sendMail`, { method: 'POST', body: { message: { subject, body: { contentType: 'HTML', content: html }, toRecipients: rec(to), ccRecipients: rec(cc), ...(from?.address ? { from: { emailAddress: { address: from.address, ...(from.name ? { name: from.name } : {}) } } } : {}), ...(files.length ? { attachments: files } : {}) }, saveToSentItems: true } });
    },
    async subscribe(folder, clientState) {
      const expires = new Date(Date.now() + 4200 * 60 * 1000).toISOString(); // under Graph's mail limit of ~7 days
      // Read, flag and move changes made in Outlook arrive in seconds too (076), not only new mail.
      return graph('/subscriptions', { method: 'POST', body: { changeType: 'created,updated,deleted', notificationUrl: ms().webhookUrl, lifecycleNotificationUrl: ms().webhookUrl, resource: `${who}/mailFolders('${folder}')/messages`, expirationDateTime: expires, clientState } });
    },
    async renew(subscriptionId) {
      const expires = new Date(Date.now() + 4200 * 60 * 1000).toISOString();
      return graph(`/subscriptions/${subscriptionId}`, { method: 'PATCH', body: { expirationDateTime: expires } });
    },
    async unsubscribe(subscriptionId) { await graph(`/subscriptions/${subscriptionId}`, { method: 'DELETE' }).catch(() => {}); },
  };
}
