/**
 * A message's attachment list read from the provider for one request, for
 * a mailbox that stores metadata only and so keeps no names (sync.js: a
 * file name is content). Shared by the message route (routes/mail.js) and
 * the thread route (routes/mailboxes.js): whoever may view a mailbox's
 * attachments sees their names, read live and never written.
 */
import { query } from '../../db.js';
import { providerFor, saveTokens } from './sync.js';

/**
 * A provider that would not answer a route. A revoked or expired grant
 * (`err.reconnect`, microsoft.js) marks the mailbox the way the sync does,
 * so the thread route stops promising live reads and the switcher shows
 * the reconnect; anything else is left for the next sync to judge. The
 * provider's own words never reach the client: a fixed message does.
 */
export async function providerFailed(accountId, err) {
  if (!err?.reconnect) return;
  await query(`UPDATE connected_accounts SET status = 'needs_reconnect', last_error = $2 WHERE id = $1 AND status = 'active'`,
    [accountId, String(err.message || 'The mailbox needs to be reconnected').slice(0, 500)]).catch(() => {});
}

/**
 * The list for `m` ({ account_id, provider_id }), or null when the provider
 * would not answer, so the stored rows stand as they are.
 */
export async function liveAttachmentList(m) {
  const { rows: [a] } = await query('SELECT * FROM connected_accounts WHERE id = $1', [m.account_id]);
  if (!a || a.status !== 'active') return null;
  const provider = providerFor(a);
  if (!provider.attachmentList) return null;
  try {
    const list = await provider.attachmentList(m.provider_id);
    await saveTokens(a, provider).catch(() => {});
    return list || [];
  } catch (err) {
    await providerFailed(a.id, err);
    return null;
  }
}

/** The stored rows, with what a withheld list leaves out filled in from the provider's. */
export const withLiveNames = (stored, live) => (live ? stored.map((s) => {
  const l = live.find((x) => x.provider_id === s.provider_id);
  return l ? { ...s, name: s.name ?? l.name ?? null, content_id: s.content_id ?? l.content_id ?? null } : s;
}) : stored);
