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
const SELECT = 'id,conversationId,internetMessageId,subject,bodyPreview,body,from,toRecipients,ccRecipients,sentDateTime,receivedDateTime,hasAttachments,isDraft';

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
    const r = await fetch(path.startsWith('http') ? path : `${GRAPH}${path}`, {
      method, signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${current.access_token}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 204 || r.status === 202) return null;
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.error?.message || `Graph ${r.status}`); e.status = r.status; e.reconnect = r.status === 401; throw e; }
    return j;
  }
  const person = (x) => (x?.emailAddress ? { email: x.emailAddress.address, name: x.emailAddress.name } : null);
  const toMessage = (m) => ({
    provider_id: m.id, conversation_id: m.conversationId, internet_message_id: m.internetMessageId,
    subject: m.subject, body_html: m.body?.contentType === 'html' ? m.body.content : `<pre>${String(m.body?.content || '').replace(/</g, '&lt;')}</pre>`,
    preview: m.bodyPreview, from: person(m.from), to: (m.toRecipients || []).map(person).filter(Boolean), cc: (m.ccRecipients || []).map(person).filter(Boolean),
    sent_at: m.sentDateTime || m.receivedDateTime, has_attachments: Boolean(m.hasAttachments), draft: Boolean(m.isDraft),
  });

  return {
    tokens: () => current,
    async me() { return graph(`${who}?$select=displayName,mail,userPrincipalName`); },
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
      const messages = []; let next = null;
      for (let page = 0; page < maxPages && url; page += 1) {
        const j = await graph(url, { headers: { Prefer: 'odata.maxpagesize=50, outlook.body-content-type="html"' } });
        for (const m of j.value || []) if (!m['@removed'] && !m.isDraft) messages.push(toMessage(m));
        url = j['@odata.nextLink'] || null;
        next = j['@odata.deltaLink'] || next;
      }
      return { messages, deltaLink: url || next || deltaLink, more: Boolean(url) };
    },
    /** One message by its id; a 404 when the mailbox no longer has it under that id. */
    async message(providerId) {
      return toMessage(await graph(`${who}/messages/${providerId}?$select=${SELECT}`, { headers: { Prefer: 'outlook.body-content-type="html"' } }));
    },
    /**
     * One page of a folder, oldest first, from a date — for reading back
     * through past mail. A plain list rather than delta, so the live sync's
     * cursor is never touched. `cursor` is the nextLink of the page before.
     */
    async page(folder, { sinceIso, cursor = null, top = 50 } = {}) {
      const url = cursor || `${who}/mailFolders/${folder}/messages?$select=${SELECT}&$filter=receivedDateTime+ge+${sinceIso}&$orderby=receivedDateTime+asc&$top=${top}`;
      const j = await graph(url, { headers: { Prefer: 'outlook.body-content-type="html"' } });
      return { messages: (j.value || []).filter((m) => !m.isDraft).map(toMessage), next: j['@odata.nextLink'] || null };
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
    /** Reply in the same conversation; Outlook keeps it in Sent Items. */
    async reply(providerId, html, { replyAll = true } = {}) {
      await graph(`${who}/messages/${providerId}/${replyAll ? 'replyAll' : 'reply'}`, { method: 'POST', body: { comment: html } });
    },
    async send({ to, cc = [], subject, html }) {
      const rec = (list) => list.map((address) => ({ emailAddress: { address } }));
      await graph(`${who}/sendMail`, { method: 'POST', body: { message: { subject, body: { contentType: 'HTML', content: html }, toRecipients: rec(to), ccRecipients: rec(cc) }, saveToSentItems: true } });
    },
    async subscribe(folder, clientState) {
      const expires = new Date(Date.now() + 4200 * 60 * 1000).toISOString(); // under Graph's mail limit of ~7 days
      return graph('/subscriptions', { method: 'POST', body: { changeType: 'created', notificationUrl: ms().webhookUrl, lifecycleNotificationUrl: ms().webhookUrl, resource: `${who}/mailFolders('${folder}')/messages`, expirationDateTime: expires, clientState } });
    },
    async renew(subscriptionId) {
      const expires = new Date(Date.now() + 4200 * 60 * 1000).toISOString();
      return graph(`/subscriptions/${subscriptionId}`, { method: 'PATCH', body: { expirationDateTime: expires } });
    },
    async unsubscribe(subscriptionId) { await graph(`/subscriptions/${subscriptionId}`, { method: 'DELETE' }).catch(() => {}); },
  };
}
