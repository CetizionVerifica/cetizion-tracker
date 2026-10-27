/**
 * Mailbox sync (#29): pull, filter, match, link, store.
 *
 *   syncAccount(id)      one mailbox: delta on Inbox and Sent Items
 *   syncAll()            every active mailbox; renews expiring subscriptions
 *   ingest(account, messages)  the provider-agnostic part, used by both
 *   replyToThread(threadId, html, by)  answer from the tracker
 *   disconnect(id)       drop tokens, subscriptions and (by policy) bodies
 */
import crypto from 'node:crypto';
import pg from 'pg';
import { query, transaction } from '../../db.js';
import { config } from '../../config.js';
import { applyVisibility, classify, cleanHtml, domainOf, forReaders, openTokens, PUBLIC_DOMAINS, referencesIn, sealTokens, snippet } from './rules.js';
import { DISPLAY_ONLY_FOLDERS, microsoftConfigured, microsoftProvider, SKIPPED_FOLDERS } from './microsoft.js';
import { isPortalSender } from './poDetect.js';
import { resolveParties } from '../../routes/communications.js';
import { assertNotStaging } from '../ops/environment.js';
import { clientEmailHold } from '../clientEmails.js';
import { enqueue, retryQueued, runReaders } from './readerQueue.js';

/** The two folders every mailbox has, read by name; push notifications come from these. */
export const FOLDERS = ['inbox', 'sentitems'];
const key = () => config.microsoft.tokenKey;

/** Replaceable in tests: the clock the ten-minute "moved or deleted" rule reads. */
export const clock = { now: () => new Date() };
/** How long a message reported gone from its folder may stay unseen before it counts as deleted (docs/inbox-outlook-plan.md §3.5). */
export const REMOVED_GRACE_MS = 10 * 60_000;

/**
 * Whether this mailbox's every folder is read, or Inbox and Sent Items only
 * (074, docs/per-user-mailboxes-plan.md §10.2). email_read_everything opens
 * every folder; a mailbox's own read_scope can hold it to the two, which is
 * where a personal mailbox starts — its Archive and private folders are
 * its owner's to open to the readers, not read by default.
 */
export const readsAllFolders = (account, readAll) => Boolean(readAll) && account.read_scope !== 'inbox_sent';

/**
 * The folders a mailbox's mail is synced from: every folder the provider
 * lists (073), Inbox first and Sent Items last. Listing them costs a few
 * calls, so the list is kept for a quarter of an hour; a folder made since
 * is picked up then. A provider that cannot list folders gets Inbox and
 * Sent Items; a listing that fails, the last one, else null: the caller
 * reads Inbox and Sent Items and forgets no other folder's cursor.
 */
const folderLists = new Map();
const FOLDER_LIST_MS = 15 * 60_000;
export async function foldersOf(account, provider) {
  if (!provider.folders) return FOLDERS;
  const held = folderLists.get(account.id);
  if (held && Date.now() - held.at < FOLDER_LIST_MS) return held.folders;
  try {
    const folders = await provider.folders();
    folderLists.set(account.id, { at: Date.now(), folders });
    return folders;
  } catch (err) {
    console.warn(`[mail.sync] ${account.email}: folders not listed:`, err.message);
    return held?.folders || null;
  }
}

// ------------------------------------------------------------ test provider
// A mailbox that lives in memory, for local runs and tests (provider 'test',
// never in production). Sent mail comes back on the next sync, like Outlook.
const testBoxes = new Map();
/** How many messages the test provider's page() returns at once; tests lower it to exercise resuming. */
export const testPaging = { size: 50 };
const testAttachments = new Map();
/** Every message pushed, by id, for message(): the mailbox keeps mail after delta has handed it over. */
const testMessages = new Map();
/** The folder list a test mailbox reports (076); see testProvider.folderList. */
const testFolders = new Map();
export function pushTestFolders(accountId, folders) { testFolders.set(accountId, folders); }
/** Failures a test mailbox's next call makes: { delta: { folder, status }, attachments: true }. Each fires once. */
const testFailures = new Map();
export function pushTestFailure(accountId, failure) { testFailures.set(accountId, { ...(testFailures.get(accountId) || {}), ...failure }); }
/** An id translation a test mailbox offers (old → new); set, the provider has translateIds. */
const testIdMaps = new Map();
export function pushTestIdTranslation(accountId, map) { testIdMaps.set(accountId, new Map(Object.entries(map))); }
const takeFailure = (accountId, key) => {
  const f = testFailures.get(accountId);
  if (!f?.[key]) return null;
  const { [key]: taken, ...rest } = f;
  testFailures.set(accountId, rest);
  return taken;
};
export function pushTestMessages(accountId, messages) {
  for (const m of messages) {
    if (m.attachments) testAttachments.set(`${accountId}:${m.provider_id}`, m.attachments);
    testMessages.set(`${accountId}:${m.provider_id}`, m);
  }
  const box = testBoxes.get(accountId) || [];
  box.push(...messages);
  testBoxes.set(accountId, box);
  return box.length;
}
function testProvider(account) {
  // Messages pushed with `history: true` are the mailbox's past: delta
  // never hands them over, page() does, and they stay in the mailbox.
  const take = (folder) => {
    const box = testBoxes.get(account.id) || [];
    const mine = box.filter((m) => !m.history && (m.folder || 'inbox') === folder);
    testBoxes.set(account.id, box.filter((m) => m.history || (m.folder || 'inbox') !== folder));
    // A message pushed with `removed: true` is one Outlook reports gone
    // from that folder; the rest come with the folder they are in, so a
    // move or a read in "Outlook" is a push of the same id again (076).
    return {
      messages: mine.filter((m) => !m.removed).map((m) => ({ folder_id: m.folder_id || folder, ...m })),
      removed: mine.filter((m) => m.removed).map((m) => m.provider_id),
    };
  };
  const sent = (m) => pushTestMessages(account.id, [{ folder: 'sentitems', provider_id: `sent-${crypto.randomUUID()}`, from: { email: account.email, name: account.display_name }, sent_at: new Date().toISOString(), ...m }]);
  return {
    tokens: () => null,
    async delta(folder, deltaLink) {
      const fail = testFailures.get(account.id)?.delta;
      if (fail && fail.folder === folder) { takeFailure(account.id, 'delta'); throw Object.assign(new Error(fail.message || 'cursor refused'), { status: fail.status || 400 }); }
      const { messages, removed } = take(folder); return { messages, removed, deltaLink: deltaLink || `test:${folder}` };
    },
    ...(testIdMaps.has(account.id) ? { async translateIds(ids) { const map = testIdMaps.get(account.id); return new Map(ids.filter((id) => map.has(id)).map((id) => [id, map.get(id)])); } } : {}),
    /** The folders a test pushed with pushTestFolders, else Inbox and Sent Items with no counts. */
    async folderList() {
      return testFolders.get(account.id) || [
        { folder_id: 'inbox', parent_id: null, display_name: 'Inbox', well_known: 'inbox', unread_count: 0, total_count: 0 },
        { folder_id: 'sentitems', parent_id: null, display_name: 'Sent Items', well_known: 'sentitems', unread_count: 0, total_count: 0 },
      ];
    },
    async attachmentList(providerId) {
      if (takeFailure(account.id, 'attachments')) throw Object.assign(new Error('throttled'), { status: 429 });
      return (testAttachments.get(`${account.id}:${providerId}`) || []).map((a, i) => ({ provider_id: a.provider_id || `att-${i}`, name: a.name, content_type: a.contentType || a.content_type || null, size_bytes: a.content?.length ?? a.size ?? null, is_inline: Boolean(a.is_inline), content_id: a.content_id || null, kind: a.kind || 'file' }));
    },
    /** A forwarded email attached as an Outlook item: `item` on the pushed attachment, shaped as a message. */
    async attachmentItem(providerId, attachmentId) {
      const list = testAttachments.get(`${account.id}:${providerId}`) || [];
      const a = list.find((x, n) => (x.provider_id || `att-${n}`) === attachmentId);
      if (!a) throw Object.assign(new Error('Not found'), { status: 404 });
      return a.item || null;
    },
    async message(providerId) {
      // pushTestFailure(id, { message: { status, reconnect, message } }): the next live read fails like Graph would.
      const fail = takeFailure(account.id, 'message');
      if (fail) throw Object.assign(new Error(fail.message || 'AADSTS70000: the refresh token has expired'), { status: fail.status, reconnect: Boolean(fail.reconnect) });
      const m = testMessages.get(`${account.id}:${providerId}`);
      if (!m) throw Object.assign(new Error('Not found'), { status: 404 });
      return m;
    },
    async attachments(providerId) {
      return (testAttachments.get(`${account.id}:${providerId}`) || []).map((a) => ({ size: a.content?.length || 0, ...a }));
    },
    /** One attachment's bytes, by the id attachmentList gave it; a 404 for one the message does not have. */
    async attachmentStream(providerId, attachmentId) {
      const list = testAttachments.get(`${account.id}:${providerId}`) || [];
      const i = list.findIndex((a, n) => (a.provider_id || `att-${n}`) === attachmentId);
      if (i < 0) throw Object.assign(new Error('Not found'), { status: 404 });
      const content = Buffer.from(list[i].content || '');
      return { stream: new Blob([content]).stream(), size: content.length };
    },
    /** Inbox, the other folders its mail was pushed to, Sent Items; never the skipped ones (microsoft.js). */
    async folders() {
      const others = (testBoxes.get(account.id) || []).map((m) => m.folder).filter((f) => f && !FOLDERS.includes(f) && !SKIPPED_FOLDERS.includes(f));
      return ['inbox', ...new Set(others), 'sentitems'];
    },
    async page(folder, { sinceIso, cursor = null } = {}) {
      const inFolder = (m) => (folder === 'all' ? !SKIPPED_FOLDERS.includes(m.folder) : (m.folder || 'inbox') === folder);
      const past = (testBoxes.get(account.id) || [])
        .filter((m) => m.history && inFolder(m) && new Date(m.sent_at) >= new Date(sinceIso))
        .sort((a, b) => new Date(a.sent_at) - new Date(b.sent_at));
      const from = Number(cursor || 0);
      const to = from + testPaging.size;
      return { messages: past.slice(from, to), next: to < past.length ? String(to) : null };
    },
    async reply(providerId, html) {
      const { rows: [m] } = await query('SELECT m.*, t.conversation_id FROM email_messages m JOIN email_threads t ON t.id = m.thread_id WHERE m.account_id = $1 AND m.provider_id = $2', [account.id, providerId]);
      sent({ conversation_id: m.conversation_id, subject: `RE: ${m.subject || ''}`, body_html: html, to: [{ email: m.direction === 'inbound' ? m.from_email : m.to_emails[0] }], cc: [] });
    },
    async send({ to, cc = [], subject, html, conversation_id }) { sent({ conversation_id: conversation_id || `conv-${crypto.randomUUID()}`, subject, body_html: html, to: to.map((email) => ({ email })), cc: cc.map((email) => ({ email })) }); },
    async subscribe() { return null; },
    async renew() { return null; },
    async unsubscribe() {},
  };
}

export function providerFor(account) {
  if (account.provider === 'test') {
    if (config.nodeEnv === 'production') throw new Error('Test mailboxes are not available in production');
    return testProvider(account);
  }
  if (account.provider === 'microsoft') {
    assertNotStaging('Mailbox sync');
    if (!microsoftConfigured()) throw new Error('Microsoft 365 is not configured on this server (MS_CLIENT_ID, MS_CLIENT_SECRET, MS_TENANT_ID, MS_REDIRECT_URI)');
    return microsoftProvider(account, openTokens(account.tokens_encrypted, key()));
  }
  throw new Error(`Provider ${account.provider} is not supported yet`);
}

export async function saveTokens(account, provider) {
  const t = provider.tokens();
  if (!t) return;
  await query('UPDATE connected_accounts SET tokens_encrypted = $2, token_expires_at = $3 WHERE id = $1', [account.id, sealTokens(t, key()), t.expires_at || null]);
}

// ------------------------------------------------------------ matching
async function settingsFor(db) {
  const { rows } = await db.query(`SELECT key, value FROM settings WHERE key IN ('internal_email_domains', 'email_read_everything')`);
  const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const internalDomains = String(s.internal_email_domains || '').split(',').map((x) => x.trim()).filter(Boolean);
  const { rows: bl } = await db.query('SELECT pattern FROM email_blocklist');
  return { internalDomains, blocklist: bl.map((r) => r.pattern), readAll: readsEverything(s.email_read_everything) };
}

/** email_read_everything, on unless set to false (073). */
export const readsEverything = (value) => String(value ?? 'true').trim().toLowerCase() !== 'false';

/** The contact and company behind a set of external participants. */
export async function matchParticipants(db, external, { autoCreate }) {
  const emails = external.map((p) => p.email.toLowerCase());
  const { rows: contacts } = await db.query('SELECT id, company_id, lower(email) AS email FROM contacts WHERE lower(email) = ANY($1)', [emails]);
  if (contacts.length) {
    const first = external.map((p) => contacts.find((c) => c.email === p.email.toLowerCase())).find(Boolean);
    return { contact_id: first.id, company_id: first.company_id };
  }
  // By domain: a company whose contacts or website use it. The website's
  // host is compared, not its text: a substring match put a sender at
  // pharma.com on the company whose website is sunpharma.com. A sender on
  // a subdomain (mail.acme.com) is still Acme's.
  for (const p of external) {
    const d = domainOf(p.email);
    if (!d || PUBLIC_DOMAINS.has(d)) continue;
    const { rows: [co] } = await db.query(
      `SELECT c.id FROM companies c
        CROSS JOIN LATERAL (SELECT regexp_replace(lower(btrim(c.website)), '^([a-z]+://)?(www[0-9]*\\.)?([^/:?#]+).*$', '\\3') AS host) w
        WHERE (c.website IS NOT NULL AND btrim(c.website) <> '' AND (w.host = $1 OR right($1, length(w.host) + 1) = '.' || w.host))
           OR EXISTS (SELECT 1 FROM contacts ct WHERE ct.company_id = c.id AND split_part(lower(ct.email), '@', 2) = $1)
        ORDER BY c.id LIMIT 1`, [d]);
    if (!co) continue;
    let contactId = null;
    if (autoCreate) {
      const name = (p.name && !p.name.includes('@') ? p.name : p.email.split('@')[0]).slice(0, 160);
      const { rows: [ct] } = await db.query(
        `INSERT INTO contacts (company_id, name, email, notes) VALUES ($1,$2,$3,'Added from email')
         ON CONFLICT (company_id, lower(regexp_replace(btrim(name), '\\s+', ' ', 'g'))) DO UPDATE SET email = COALESCE(contacts.email, EXCLUDED.email)
         RETURNING id`, [co.id, name, p.email]);
      contactId = ct.id;
    }
    return { contact_id: contactId, company_id: co.id };
  }
  return { contact_id: null, company_id: null };
}

/** The record a thread belongs to: a number in the subject, else the client's open deal. */
async function linkRecord(db, subject, companyId) {
  const refs = referencesIn(subject);
  for (const no of refs.quotations) {
    const { rows: [q] } = await db.query('SELECT quotation_no FROM quotations WHERE quotation_no = $1', [no]);
    if (q) return { entity: 'quotation', entity_id: q.quotation_no };
  }
  for (const no of refs.enquiries) {
    const { rows: [e] } = await db.query('SELECT enquiry_no FROM enquiries WHERE enquiry_no = $1', [no]);
    if (e) return { entity: 'enquiry', entity_id: e.enquiry_no };
  }
  for (const no of refs.pos) {
    const { rows: [p] } = await db.query('SELECT po_number FROM purchase_orders WHERE upper(po_number) = $1', [no]);
    if (p) return { entity: 'purchase_order', entity_id: p.po_number };
  }
  if (!companyId) return { entity: null, entity_id: null };
  const { rows: [q] } = await db.query(
    `SELECT q.quotation_no FROM quotations q JOIN pipeline_stages ps ON ps.id = q.stage_id
      WHERE q.company_id = $1 AND ps.type IN ('open','paused') ORDER BY COALESCE(q.last_contacted_at, q.created_at) DESC LIMIT 1`, [companyId]);
  if (q) return { entity: 'quotation', entity_id: q.quotation_no };
  const { rows: [e] } = await db.query(`SELECT enquiry_no FROM enquiries WHERE company_id = $1 AND status IN ('New','Contacted','Qualified','Nurture') ORDER BY created_at DESC LIMIT 1`, [companyId]);
  if (e) return { entity: 'enquiry', entity_id: e.enquiry_no };
  return { entity: null, entity_id: null };
}

/** Hooks run for each stored message (the shared inbox, #30, registers one). */
export const messageHooks = [];

/** Whether this mailbox's mail is routed into an active Inbox (lib/inbox.js). */
export async function feedsInbox(account, db = { query }) {
  if (!account.is_shared) return false;
  const { rows: [r] } = await db.query('SELECT EXISTS (SELECT 1 FROM inboxes WHERE account_id = $1 AND active) AS yes', [account.id]);
  return Boolean(r?.yes);
}

/**
 * The rules every message is classified under, for one account.
 *
 * A mailbox that feeds an Inbox keeps every message: the Inbox is a mail
 * client for the shared address, and one that silently drops colleagues'
 * mail, no-reply senders and anything on the "Never sync" list is not
 * showing the mailbox. The verdict the filters would have given is kept
 * as `filtered`, so ingest can still keep that mail away from the
 * enquiry and PO readers — the filters exist for those, not for reading.
 */
export async function ingestRules(account, db = { query }, { forInbox = false } = {}) {
  const rules = await settingsFor(db);
  // Only live ingest asks for this. The enquiry, PO and invoice backfills
  // call ingestRules too and must keep seeing the filters' verdict.
  const keepAll = forInbox && await feedsInbox(account, db);
  const judge = (m) => {
    const c = classify(m, { accountEmail: account.email, excludeInternal: account.exclude_internal, ...rules });
    if (!keepAll || !c.skip) return c;
    return { ...c, skip: null, filtered: c.skip };
  };
  // ingest routes every email to its readers when this is on.
  judge.readAll = rules.readAll;
  return judge;
}

/**
 * Store one classified message, inside the caller's transaction.
 *
 * Returns { skipped: reason } or { thread, message, newThread }.
 * `forceCompanyId` keeps a message a personal mailbox would drop as
 * "no matching client": the enquiry reader (autoEnquiry.js) passes the
 * company it has just created, once the email has turned out to be one.
 */
export async function ingestOne(db, account, m, c, { sentBy = null, forceCompanyId = null, hooks = true, displayOnly = false } = {}) {
  // Kept only because the mailbox feeds an Inbox (ingestRules): the hooks
  // are told which filter would have dropped it.
  const filtered = c.filtered || null;
  // Known by its id, or — while the mailbox's stored ids are still the
  // old, mutable ones (immutable_ids false) — as the same email under
  // another id (073: a moved message got a new id). Once the ids are
  // immutable a move keeps the id, and a second copy with the same
  // Internet Message-ID (Sent Items and Inbox, when we were on copy) is
  // a second copy: left alone, as before, never merged into one row.
  const { rows: [byId] } = await db.query('SELECT id, provider_id FROM email_messages WHERE account_id = $1 AND provider_id = $2', [account.id, m.provider_id]);
  let dupe = byId;
  if (!dupe && m.internet_message_id) {
    const { rows: [byImid] } = await db.query('SELECT id, provider_id FROM email_messages WHERE account_id = $1 AND lower(internet_message_id) = lower($2) LIMIT 1', [account.id, m.internet_message_id]);
    if (byImid && account.immutable_ids) return { skipped: 'already synced', copy: true };
    dupe = byImid;
  }
  if (dupe) {
    // Known: Outlook's state of it moved, not the message (076). The folder,
    // read flag, flag and importance are overwritten with what the provider
    // says; a message seen again is not deleted, whatever delta said before.
    // The readers are not told again: only new mail goes to them.
    const { rows: [updated] } = await db.query(
      `UPDATE email_messages SET provider_id = $2,
              folder_id = COALESCE($3, folder_id), is_read = COALESCE($4, is_read), flag_status = COALESCE($5, flag_status), importance = COALESCE($6, importance),
              web_link = COALESCE($7, web_link), removed_seen_at = NULL, removed_at = NULL
        WHERE id = $1 AND (provider_id IS DISTINCT FROM $2 OR folder_id IS DISTINCT FROM $3::text OR is_read IS DISTINCT FROM $4::boolean
                           OR flag_status IS DISTINCT FROM $5::text OR importance IS DISTINCT FROM $6::text OR removed_seen_at IS NOT NULL OR removed_at IS NOT NULL)
        RETURNING id`,
      [dupe.id, m.provider_id, m.folder_id || null, m.is_read ?? null, m.flag_status || null, m.importance || null, m.web_link || null]);
    return { skipped: 'already synced', updated: Boolean(updated) };
  }
  let { rows: [thread] } = await db.query('SELECT * FROM email_threads WHERE account_id = $1 AND conversation_id = $2 FOR UPDATE', [account.id, m.conversation_id]);
  // Mail kept for display only (Deleted Items, Junk) is matched to people
  // already on file but makes nothing: no contact is added for a sender
  // found in Junk, and no record is linked to by a subject line there.
  const who = thread?.company_id ? { company_id: thread.company_id, contact_id: thread.contact_id } : await matchParticipants(db, c.external, { autoCreate: account.auto_create_contacts && !displayOnly });
  if (!who.company_id && !displayOnly) {
    // A record number in the subject names the client even from a free-mail address.
    const named = await linkRecord(db, m.subject, null);
    if (named.entity) Object.assign(who, { company_id: (await resolveParties(named.entity, named.entity_id, db)).company_id || null });
  }
  if (!who.company_id && forceCompanyId) who.company_id = forceCompanyId;
  // "New" for the readers means the first real message: a thread opened
  // by a robot or a colleague (kept only for the Inbox) is still new
  // business when the client's first message lands in it.
  const newThread = !thread || (!filtered && !(await db.query(
    'SELECT 1 FROM email_messages WHERE thread_id = $1 AND filtered_as IS NULL LIMIT 1', [thread.id])).rows.length);
  if (!thread) {
    // A personal mailbox keeps only client mail; a shared one keeps everything external (new leads).
    if (!who.company_id && !account.is_shared) return { skipped: 'no matching client' };
    const link = displayOnly ? { entity: null, entity_id: null } : await linkRecord(db, m.subject, who.company_id);
    ({ rows: [thread] } = await db.query(
      `INSERT INTO email_threads (account_id, conversation_id, subject, company_id, contact_id, entity, entity_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [account.id, m.conversation_id, account.visibility === 'metadata' ? null : m.subject, who.company_id, who.contact_id, link.entity, link.entity_id]));
  } else if (!thread.company_id && who.company_id && !displayOnly) {
    const link = thread.entity ? { entity: thread.entity, entity_id: thread.entity_id } : await linkRecord(db, m.subject, who.company_id);
    await db.query('UPDATE email_threads SET company_id = $2, contact_id = $3, entity = $4, entity_id = $5 WHERE id = $1', [thread.id, who.company_id, who.contact_id, link.entity, link.entity_id]);
  }
  const html = cleanHtml(m.body_html);
  const row = applyVisibility({ subject: m.subject, snippet: m.preview ? snippet(m.preview) : snippet(html), body_html: html }, account.visibility);
  const { rows: [saved] } = await db.query(
    `INSERT INTO email_messages (account_id, thread_id, provider_id, internet_message_id, direction, from_email, from_name, to_emails, cc_emails,
                                 subject, snippet, body_html, has_attachments, sent_at, company_id, contact_id, sent_from_tracker_by, filtered_as, web_link,
                                 folder_id, is_read, flag_status, importance, bcc_emails)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) RETURNING *`,
    [account.id, thread.id, m.provider_id, m.internet_message_id || null, c.direction, m.from?.email || null, m.from?.name || null,
      (m.to || []).map((p) => p.email), (m.cc || []).map((p) => p.email), row.subject, row.snippet, row.body_html, Boolean(m.has_attachments),
      m.sent_at, thread.company_id || who.company_id || null, who.contact_id || null, sentBy, filtered, m.web_link || null,
      m.folder_id || null, m.is_read ?? null, m.flag_status || null, m.importance || null, m.bcc?.length ? m.bcc.map((p) => p.email) : null]);
  // Mail synced for display only (Deleted Items, Junk) is stored and shown,
  // but opens no conversation in the team queue (076).
  if (hooks) for (const hook of messageHooks) await hook({ db, account, thread, message: saved, participants: c.external, folder: m.folder || null, filtered });
  return { thread, message: saved, newThread };
}

/**
 * What is attached to a stored message, metadata only (076): the file stays
 * in Outlook and is fetched when somebody downloads it. The names are
 * withheld for a mailbox that stores metadata only — a file name is content.
 */
async function storeAttachmentList(account, message, provider) {
  if (!message.has_attachments || !provider?.attachmentList) return false;
  // One provider call per message, after the message's own transaction:
  // not while a thread row is locked. A call that fails (throttled, timed
  // out) leaves attachments_listed_at empty, and the sync tries again later.
  let list;
  try { list = await provider.attachmentList(message.provider_id); }
  catch (err) {
    // Logged: a list that fails every time (as a $select Graph refused did)
    // is otherwise invisible, and no attachment ever shows.
    console.warn(`[mail.attachments] the attachment list of a message in mailbox ${account.id} could not be read: ${err.status || ''} ${err.message}`.trim());
    return false;
  }
  await transaction(async (db) => {
    for (const a of list || []) {
      await db.query(
        `INSERT INTO email_attachments (message_id, provider_id, name, content_type, size_bytes, is_inline, content_id, kind) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (message_id, provider_id) DO UPDATE SET name = EXCLUDED.name, content_type = EXCLUDED.content_type, size_bytes = EXCLUDED.size_bytes, is_inline = EXCLUDED.is_inline, content_id = EXCLUDED.content_id, kind = EXCLUDED.kind`,
        [message.id, a.provider_id, account.visibility === 'metadata' ? null : a.name, a.content_type || null, a.size_bytes ?? null, Boolean(a.is_inline), account.visibility === 'metadata' ? null : a.content_id || null,
          ['file', 'item', 'reference'].includes(a.kind) ? a.kind : 'file']);
    }
    await db.query('UPDATE email_messages SET attachments_listed_at = now() WHERE id = $1', [message.id]);
  });
  return true;
}

/**
 * The attachment lists of messages about to be shown that the sync has not
 * read yet (a backlog it works through a few per sync), read now so the
 * reader sees the files on opening the conversation, not some syncs later.
 * Stored as the sync stores them, under the mailbox's visibility.
 */
export async function listAttachmentsNow(accountId, messages) {
  const pending = messages.filter((m) => m.has_attachments && !m.attachments_listed_at && !m.removed_at).slice(0, 10);
  if (!pending.length) return 0;
  const { rows: [account] } = await query('SELECT * FROM connected_accounts WHERE id = $1', [accountId]);
  if (!account || account.status !== 'active') return 0;
  const provider = providerFor(account);
  let n = 0;
  for (const m of pending) if (await storeAttachmentList(account, m, provider)) n += 1;
  if (n) await saveTokens(account, provider).catch(() => {});
  return n;
}

/** Messages whose attachment list is still to be read (a failed call earlier), newest first, a few per sync. */
async function retryAttachmentLists(account, provider, { limit = 25 } = {}) {
  if (!provider?.attachmentList) return 0;
  const { rows } = await query(
    `SELECT id, provider_id, has_attachments FROM email_messages WHERE account_id = $1 AND has_attachments AND attachments_listed_at IS NULL AND removed_at IS NULL
      ORDER BY sent_at DESC LIMIT $2`, [account.id, limit]);
  let n = 0;
  for (const m of rows) if (await storeAttachmentList(account, m, provider)) n += 1;
  return n;
}

/**
 * Store a batch of messages, each in its own transaction.
 *
 * Also returns `candidates` (for the enquiry reader, autoEnquiry.js) and
 * `poCandidates` (for the PO reader): a new conversation started in this
 * call, anything we sent, and anything a personal mailbox dropped for not
 * matching a client go to the enquiry reader; outbound mail to the invoice
 * reader too. Each is also queued for its readers (readerQueue.js) — a
 * stored message in the same transaction that stores it — so an email
 * whose reading fails, or never starts, is read again.
 */
export async function ingest(account, messages, { sentBy = null, provider = null, displayOnly = false } = {}) {
  const judge = await ingestRules(account, undefined, { forInbox: true });
  const portals = await portalSenders();
  const result = { stored: 0, updated: 0, skipped: {}, threads: new Set(), candidates: [], poCandidates: [], seen: new Set() };
  const skip = (why) => { result.skipped[why] = (result.skipped[why] || 0) + 1; };
  // The PO reader (autoPurchaseOrder.js) looks at every inbound message
  // that might hold an order, later ones in a thread included: that is
  // where most POs arrive. A cheap test; its prefilter does the rest.
  // Reading everything (email_read_everything): every inbound email may be
  // an order, and every email, replies included, goes to the enquiry reader.
  const mayBePo = (m, c) => c.direction === 'inbound' && (judge.readAll || m.has_attachments || MAY_BE_PO.test(`${m.subject || ''} ${m.preview || ''}`));
  const isPortal = (m) => isPortalSender(m.from?.email, portals);
  const portalCand = (m, c, threadId, newThread) => ({ m, c: { ...c, direction: 'inbound', external: [m.from] }, threadId, newThread, dropped: !threadId });
  /** Which readers a candidate goes to: the enquiry reader takes outbound mail and new threads (every email when reading everything), the invoice reader outbound mail. */
  const readersOf = (cand, { enquiry: firstOrOurs }) => {
    const enquiry = firstOrOurs || judge.readAll;
    return [
      ...(mayBePo(cand.m, cand.c) ? ['po'] : []),
      ...(enquiry && cand.c.direction === 'outbound' ? ['invoice'] : []),
      ...(enquiry ? ['enquiry'] : []),
    ];
  };
  const route = (cand, readers) => {
    if (readers.includes('enquiry')) result.candidates.push(cand);
    if (readers.includes('po')) result.poCandidates.push(cand);
  };
  for (const m of messages.sort((a, b) => new Date(a.sent_at) - new Date(b.sent_at))) {
    if (!m.provider_id || !m.conversation_id || m.draft) { skip('incomplete'); continue; }
    const c = judge(m);
    // What the readers see of it: while reading everything, mail between
    // our own people and from automatic senders too (rules.js forReaders).
    // Nothing from a display-only folder (Deleted Items, Junk) goes to them.
    const seen = displayOnly ? null : forReaders(c, judge.readAll);
    if (c.skip && !displayOnly) {
      skip(c.skip);
      if (seen) {
        // Not stored, so not queued in a transaction, as for "no matching client" below.
        const cand = { m, c: seen, threadId: null, newThread: false, dropped: true };
        const readers = readersOf(cand, { enquiry: true });
        await enqueue({ query }, account, cand, readers);
        route(cand, readers);
      } else if (c.skip === 'blocked sender' && isPortal(m)) {
        // A procurement portal's notification reads as a robot; for POs it is not one.
        const cand = portalCand(m, c, null, false);
        await enqueue({ query }, account, cand, ['po']);
        route(cand, ['po']);
      }
      continue;
    }
    let r;
    try {
      r = await transaction(async (db) => {
        const stored = await ingestOne(db, account, m, c, { sentBy, hooks: !displayOnly, displayOnly });
        if (stored.skipped) return stored;
        if (displayOnly) return stored;
        // Stored for the Inbox only (ingestRules). The readers see it as they
        // would had the filters dropped it: while reading everything, as any
        // email (forReaders); otherwise a portal's notification still goes
        // to the PO reader, and nothing else goes anywhere.
        const portalOnly = c.filtered && !seen;
        const cand = !portalOnly
          ? { m, c: seen, threadId: stored.thread.id, newThread: stored.newThread, dropped: false }
          : (c.filtered === 'blocked sender' && isPortal(m) ? portalCand(m, c, stored.thread.id, stored.newThread) : null);
        const readers = !cand ? [] : portalOnly ? ['po'] : readersOf(cand, { enquiry: cand.c.direction === 'outbound' || stored.newThread });
        if (readers.length) await enqueue(db, account, cand, readers);
        return { ...stored, cand, readers };
      });
    } catch (err) {
      // Another sync, or a reply sent from the tracker, stored it a moment ago.
      if (err.code === '23505' && err.constraint?.startsWith('email_messages')) { skip('already synced'); continue; }
      throw err;
    }
    if (r.skipped !== 'no matching client') result.seen.add(m.provider_id);
    if (r.skipped) {
      if (r.updated) result.updated += 1; else skip(r.skipped);
      if (r.skipped === 'no matching client' && !displayOnly) {
        // Not stored, so not queued in a transaction: should this fail, the
        // delta link has not moved and the next sync hands it over again.
        const cand = { m, c, threadId: null, newThread: false, dropped: true };
        const readers = readersOf(cand, { enquiry: true });
        await enqueue({ query }, account, cand, readers);
        route(cand, readers);
      }
      continue;
    }
    result.stored += 1;
    await storeAttachmentList(account, r.message, provider);
    result.threads.add(r.thread.id);
    if (r.cand) route(r.cand, r.readers);
  }
  return { ...result, threads: result.threads.size };
}

const MAY_BE_PO = /order|\bP\.?O\b|\bW\.?O\b|\bLOI\b|contract|letter of (intent|award)/i;

async function portalSenders() {
  const { rows: [r] } = await query(`SELECT value FROM settings WHERE key = 'po_portal_senders'`);
  return r?.value || '';
}

/** The first half of the advisory lock key a mailbox's sync holds; the second is its id. */
const SYNC_LOCK = 2900;

/**
 * Sync one mailbox, unless a sync of it is already running somewhere.
 *
 * Mail is pulled from several places now — the API's own timer
 * (autoSync.js), the worker's mail.sync job, Graph's webhook and the Sync
 * now button — in more than one process. Two of them reading the same
 * delta at once would both try to store the same messages, and the
 * second one's insert fails on the unique key and fails its whole sync.
 * A session-level advisory lock, held on its own connection for the
 * length of the sync, makes the second caller step aside instead.
 *
 * That connection comes from a pool of its own. Taken from the main pool,
 * ten mailboxes syncing at once (a burst of webhooks) would hold all ten
 * connections as locks and then wait for ever on the main pool for the
 * queries the syncs themselves need — and with them every API request.
 */
const lockPool = new pg.Pool({ connectionString: config.databaseUrl, max: 10, idleTimeoutMillis: 30_000, allowExitOnIdle: true });
lockPool.on('error', (err) => console.error('[mail.sync] lock connection', err.message));

export async function syncAccount(id) {
  const lock = await lockPool.connect();
  let held = false;
  try {
    ({ rows: [{ held }] } = await lock.query('SELECT pg_try_advisory_lock($1, $2) AS held', [SYNC_LOCK, Number(id)]));
    if (!held) return { id, skipped: 'already syncing' };
    return await syncAccountUnlocked(id);
  } finally {
    // A connection whose unlock failed may still hold the lock, and back in
    // the pool it would keep this mailbox from ever syncing again. It is
    // destroyed instead; closing the session is what releases the lock.
    let broken = false;
    if (held) await lock.query('SELECT pg_advisory_unlock($1, $2)', [SYNC_LOCK, Number(id)]).catch(() => { broken = true; });
    lock.release(broken);
  }
}

async function syncAccountUnlocked(id) {
  const { rows: [account] } = await query('SELECT * FROM connected_accounts WHERE id = $1', [id]);
  if (!account || account.status !== 'active') return { id, skipped: 'not active' };
  const out = { id, email: account.email, stored: 0, skipped: {} };
  const candidates = [];
  const poCandidates = [];
  try {
    // Inside the try: a mailbox whose provider cannot even be built (bad
    // tokens, Microsoft not configured) records its own error rather than
    // throwing out of syncAll and stopping every mailbox after it.
    const provider = providerFor(account);
    // What earlier syncs could not read, before the new mail: oldest first.
    const retried = await retryQueued(account, provider);
    if (retried) out.retried = retried;
    // A mailbox connected before immutable ids (076) has its stored ids
    // translated once, so a change or a removal Graph reports under the
    // new id finds its row.
    if (await translateStoredIds(account, provider)) out.ids_translated = true;
    const readsAll = readsAllFolders(account, (await settingsFor({ query })).readAll);
    const listed = readsAll ? await foldersOf(account, provider) : FOLDERS;
    const folders = listed || FOLDERS;
    // Every id handed over in this sweep: a removal reported for one of
    // them (it left one folder for another) is a move, not a deletion.
    const seen = new Set();
    let removedAny = false;
    // Deleted Items and Junk are synced for display only (076): they appear
    // in the Inbox's folder switcher, and a message deleted in Outlook is
    // seen arriving there (a move) rather than vanishing.
    const displayOnly = DISPLAY_ONLY_FOLDERS.filter((f) => !folders.includes(f));
    for (const folder of [...folders, ...displayOnly]) {
      const { rows: [f] } = await query(
        `INSERT INTO mail_folders (account_id, folder) VALUES ($1,$2) ON CONFLICT (account_id, folder) DO UPDATE SET folder = EXCLUDED.folder RETURNING *`, [account.id, folder]);
      const since = f.delta_link ? null : new Date(Date.now() - account.import_days * 864e5).toISOString();
      let read;
      try {
        read = await provider.delta(folder, f.delta_link, since);
      } catch (err) {
        if (err.status === 404 && !FOLDERS.includes(folder)) {
          // A folder deleted or moved away since it was listed: forget it and
          // go on with the rest. Inbox and Sent Items failing is the mailbox failing.
          await query('DELETE FROM mail_folders WHERE id = $1', [f.id]);
          folderLists.delete(account.id);
          continue;
        }
        // A cursor the provider will not continue (one minted under the
        // old id type, or expired): drop it and start the folder again
        // from the import window. Stored messages are known again by id or
        // Internet Message-ID, so nothing is stored twice. Fails again:
        // the mailbox failing, as before.
        if (!f.delta_link || err.status === 401) throw err;
        console.warn(`[mail.sync] ${account.email}/${folder}: delta cursor refused (${err.message}); starting the folder again`);
        await query('UPDATE mail_folders SET delta_link = NULL WHERE id = $1', [f.id]);
        read = await provider.delta(folder, null, new Date(Date.now() - account.import_days * 864e5).toISOString());
      }
      const { messages, deltaLink, removed = [] } = read;
      // Which folder each message came from, for the Inbox's routing.
      const r = await ingest(account, messages.map((m) => ({ ...m, folder: m.folder || folder })), { provider, displayOnly: displayOnly.includes(folder) });
      candidates.push(...r.candidates);
      poCandidates.push(...r.poCandidates);
      out.stored += r.stored;
      out.updated = (out.updated || 0) + r.updated;
      for (const id of r.seen) seen.add(id);
      // Gone from this folder: noted, not acted on. Seen again in another
      // folder it is a move (ingestOne clears the mark); ten minutes
      // unseen, a delete (below). Not for a message this sweep has already
      // seen elsewhere (restored to the Inbox, then reported gone from
      // Deleted Items), and only while the row still says it is in the
      // folder it was reported gone from.
      const gone = removed.filter((id) => !seen.has(id));
      if (gone.length) {
        removedAny = true;
        const folderIds = await folderIdsOf(account, folder);
        await query(
          `UPDATE email_messages SET removed_seen_at = COALESCE(removed_seen_at, $3)
            WHERE account_id = $1 AND provider_id = ANY($2) AND removed_at IS NULL AND (folder_id IS NULL OR folder_id = ANY($4))`,
          [account.id, gone, clock.now(), folderIds]);
      }
      for (const [k, v] of Object.entries(r.skipped)) out.skipped[k] = (out.skipped[k] || 0) + v;
      await query('UPDATE mail_folders SET delta_link = $2 WHERE id = $1', [f.id, deltaLink]);
    }
    // Folders no longer listed (deleted, moved under Deleted Items, or every
    // other folder once reading everything is off) stop being read; their
    // cursor goes with them. Not after a listing that failed.
    if (listed) await query(`DELETE FROM mail_folders WHERE account_id = $1 AND folder <> ALL($2) AND subscription_id IS NULL`, [account.id, [...folders, ...displayOnly]]);
    // A removal may be a move into a folder made in Outlook just now: list
    // the folders afresh next time rather than in fifteen minutes.
    if (removedAny) folderLists.delete(account.id);
    // "Not seen again anywhere" means deleted only when every folder a
    // message could move to is one this mailbox syncs. Held to Inbox and
    // Sent Items (read_scope), a message gone from the Inbox may sit in
    // Archive unseen: it stays marked as gone from a synced folder, never
    // as deleted.
    if (readsAll) {
      const { rowCount: deleted } = await query(
        `UPDATE email_messages SET removed_at = $2 WHERE account_id = $1 AND removed_at IS NULL AND removed_seen_at IS NOT NULL AND removed_seen_at <= $3`,
        [account.id, clock.now(), new Date(clock.now().getTime() - REMOVED_GRACE_MS)]);
      if (deleted) out.deleted = deleted;
    }
    const listedAttachments = await retryAttachmentLists(account, provider);
    if (listedAttachments) out.attachments_listed = listedAttachments;
    await refreshFolderList(account, provider);
    await saveTokens(account, provider);
    await query('UPDATE connected_accounts SET last_synced_at = now(), last_error = NULL WHERE id = $1', [account.id]);
    // After the mail is stored, never inside its transactions: judging an
    // email may call the AI. Inbox first, then Sent Items — FOLDERS' order —
    // so a quotation answering an emailed enquiry finds it already made.
    // POs before enquiries, for the same batch: a PO email can never also
    // start an enquiry (docs/email-po-plan.md §3.9). Invoices we sent
    // (§3.10) after the POs they bill. Every one was queued as it was
    // stored, and leaves the queue only once its reader is done with it.
    Object.assign(out, await runReaders(account, {
      po: poCandidates,
      invoice: candidates.filter((cand) => cand.c.direction === 'outbound'),
      enquiry: candidates,
    }, { provider }));
  } catch (err) {
    await query(`UPDATE connected_accounts SET last_error = $2, status = CASE WHEN $3 THEN 'needs_reconnect' ELSE status END WHERE id = $1`, [account.id, String(err.message).slice(0, 500), Boolean(err.reconnect)]);
    out.error = err.message;
  }
  return out;
}

/**
 * The ids a message in `folder` carries in folder_id: the folder's own id,
 * and for a well-known folder read by name (inbox, sentitems, deleteditems,
 * junkemail) the id Outlook gave it, from the stored folder list.
 */
async function folderIdsOf(account, folder) {
  const { rows } = await query('SELECT folder_id FROM mail_folder_list WHERE account_id = $1 AND well_known = $2', [account.id, folder]);
  return [folder, ...rows.map((r) => r.folder_id)];
}

/**
 * Translate a mailbox's stored message ids to the provider's immutable ids,
 * once (076, docs/inbox-outlook-plan.md §3.5). Until this has run, a
 * change or a removal Graph reports under an immutable id would find no
 * row. Ids the provider cannot translate (messages gone since) are left as
 * they are. Returns true when it ran.
 */
export async function translateStoredIds(account, provider) {
  if (account.immutable_ids || !provider.translateIds) return false;
  const { rows } = await query('SELECT provider_id FROM email_messages WHERE account_id = $1', [account.id]);
  const ids = rows.map((r) => r.provider_id);
  const map = ids.length ? await provider.translateIds(ids) : new Map();
  await transaction(async (db) => {
    for (const [from, to] of map) {
      if (from === to) continue;
      await db.query('UPDATE email_messages SET provider_id = $3 WHERE account_id = $1 AND provider_id = $2 AND NOT EXISTS (SELECT 1 FROM email_messages x WHERE x.account_id = $1 AND x.provider_id = $3)', [account.id, from, to]);
    }
    await db.query('UPDATE connected_accounts SET immutable_ids = true WHERE id = $1', [account.id]);
  });
  account.immutable_ids = true;
  return true;
}

/**
 * The mailbox's folders as Outlook has them, with Outlook's own counts
 * (076): what the Inbox's folder switcher shows. A folder deleted in
 * Outlook disappears; its messages arrive as removed and move to Deleted
 * Items. A listing that fails leaves the last one standing.
 */
export async function refreshFolderList(account, provider) {
  if (!provider.folderList) return;
  let list;
  try { list = await provider.folderList(); } catch (err) { console.warn(`[mail.sync] ${account.email}: folder list not read:`, err.message); return; }
  await transaction(async (db) => {
    for (const f of list) {
      await db.query(
        `INSERT INTO mail_folder_list (account_id, folder_id, parent_id, display_name, well_known, unread_count, total_count, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,now())
         ON CONFLICT (account_id, folder_id) DO UPDATE SET parent_id = EXCLUDED.parent_id, display_name = EXCLUDED.display_name, well_known = EXCLUDED.well_known,
           unread_count = EXCLUDED.unread_count, total_count = EXCLUDED.total_count, synced_at = now()`,
        [account.id, f.folder_id, f.parent_id || null, f.display_name || '', f.well_known || null, f.unread_count || 0, f.total_count || 0]);
    }
    await db.query('DELETE FROM mail_folder_list WHERE account_id = $1 AND folder_id <> ALL($2)', [account.id, list.map((f) => f.folder_id)]);
  });
}

/**
 * Re-read the bodies of mail we already have, and store them again under
 * the sanitiser as it is now.
 *
 * cleanHtml runs once, at ingest, and what it dropped is dropped for good:
 * the message we keep is the cleaned one, and the original never touched
 * our disk. So when the sanitiser learned to keep a sender's styling, every
 * mail already stored stayed as the bare paragraphs the old rules had left
 * of it. This is how those catch up — the provider still holds the real
 * message, so it is fetched again and re-cleaned.
 *
 * Deliberately narrow:
 *
 *   It only UPDATEs. Nothing is inserted, no thread is created, no
 *   conversation is opened or reopened, and a message the sweep finds that
 *   we never stored is left alone — ingest decides what we keep, and that
 *   decision is not being revisited here.
 *
 *   It does not touch the delta cursor. syncAccount stores a delta link per
 *   folder and this sweep asks for a window instead, so a backfill cannot
 *   cost the next sync the changes it had not seen yet.
 *
 *   applyVisibility is applied again, so a metadata-only mailbox still
 *   stores no subject and no body. A backfill must not be a way for the
 *   text to arrive where the mailbox's owner said it should not.
 *
 * Bounded by the same import_days window the first sync used, unless asked
 * for more. Older mail than that was never fetched in the first place.
 */
export async function refreshBodies(id, { days } = {}) {
  const { rows: [account] } = await query('SELECT * FROM connected_accounts WHERE id = $1', [id]);
  if (!account || account.status !== 'active') return { id, skipped: 'not active' };
  const provider = providerFor(account);
  const since = new Date(Date.now() - (Number(days) || account.import_days) * 864e5).toISOString();
  const out = { id, email: account.email, seen: 0, updated: 0, unchanged: 0, not_ours: 0 };
  try {
    for (const folder of FOLDERS) {
      const { messages } = await provider.delta(folder, null, since);
      for (const m of messages) {
        if (!m.provider_id || !m.body_html) continue;
        out.seen += 1;
        const html = cleanHtml(m.body_html);
        const row = applyVisibility(
          { subject: m.subject, snippet: m.preview ? snippet(m.preview) : snippet(html), body_html: html },
          account.visibility
        );
        const { rowCount } = await query(
          `UPDATE email_messages SET body_html = $3, snippet = $4, web_link = COALESCE($5::text, web_link)
            WHERE account_id = $1 AND provider_id = $2
              AND (body_html IS DISTINCT FROM $3 OR snippet IS DISTINCT FROM $4 OR (web_link IS NULL AND $5::text IS NOT NULL))`,
          [account.id, m.provider_id, row.body_html, row.snippet, m.web_link || null]
        );
        if (rowCount) out.updated += 1; else out.unchanged += 1;
      }
    }
    await saveTokens(account, provider);
  } catch (err) {
    out.error = err.message;
  }
  // Counted rather than inferred: "unchanged" includes messages the sweep
  // returned that we never stored, and saying so keeps the numbers honest.
  const { rows: [held] } = await query('SELECT count(*)::int AS n FROM email_messages WHERE account_id = $1', [account.id]);
  out.messages_held = held.n;
  return out;
}

/**
 * Keep push notifications alive; the delta sweep covers any gap. Inbox and
 * Sent Items only: mail filed into other folders is picked up by the sync
 * every minute (autoSync.js), without a subscription per folder.
 */
export async function ensureSubscriptions(account, provider = providerFor(account)) {
  if (account.provider !== 'microsoft' || !config.microsoft.webhookUrl) return 0;
  let changed = 0;
  const { rows } = await query('SELECT * FROM mail_folders WHERE account_id = $1 AND folder = ANY($2)', [account.id, FOLDERS]);
  for (const f of rows) {
    const soon = !f.subscription_expires_at || new Date(f.subscription_expires_at) < new Date(Date.now() + 12 * 3600 * 1000);
    if (!soon) continue;
    let sub = null;
    if (f.subscription_id) sub = await provider.renew(f.subscription_id).catch(() => null);
    if (!sub) {
      const state = crypto.randomBytes(24).toString('base64url');
      sub = await provider.subscribe(f.folder, state);
      await query('UPDATE mail_folders SET subscription_client_state = $2 WHERE id = $1', [f.id, state]);
    }
    if (sub) {
      await query('UPDATE mail_folders SET subscription_id = $2, subscription_expires_at = $3 WHERE id = $1', [f.id, sub.id, sub.expirationDateTime]);
      changed += 1;
    }
  }
  await saveTokens(account, provider);
  return changed;
}

export async function syncAll() {
  const { rows } = await query(`SELECT id FROM connected_accounts WHERE status = 'active'`);
  const results = [];
  for (const { id } of rows) {
    const r = await syncAccount(id).catch((err) => ({ id, error: err.message }));
    // A mailbox another process is syncing has its subscriptions seen to
    // there; renewing them here too could create a second one.
    if (!r.error && !r.skipped) {
      const { rows: [a] } = await query('SELECT * FROM connected_accounts WHERE id = $1', [id]);
      r.subscriptions = await ensureSubscriptions(a).catch((e) => `failed: ${e.message}`);
    }
    results.push(r);
  }
  return { mailboxes: results.length, results };
}

export async function replyToThread(threadId, html, by, { replyAll = true } = {}) {
  const { rows: [t] } = await query(
    `SELECT t.*, a.status AS account_status FROM email_threads t JOIN connected_accounts a ON a.id = t.account_id WHERE t.id = $1`, [threadId]);
  if (!t) throw Object.assign(new Error('Thread not found'), { status: 404 });
  if (t.account_status !== 'active') throw Object.assign(new Error('The mailbox needs to be reconnected before replying'), { status: 409 });
  const { rows: [last] } = await query('SELECT provider_id FROM email_messages WHERE thread_id = $1 ORDER BY sent_at DESC LIMIT 1', [threadId]);
  if (!last) throw Object.assign(new Error('Nothing to reply to'), { status: 422 });
  if (t.contact_id) {
    const { rows: [c] } = await query('SELECT do_not_contact FROM contacts WHERE id = $1', [t.contact_id]);
    if (c?.do_not_contact) throw Object.assign(new Error('This contact is marked do not contact'), { status: 409 });
  }
  const { rows: [account] } = await query('SELECT * FROM connected_accounts WHERE id = $1', [t.account_id]);
  if (t.conversation_id.startsWith('portal-')) return replyToPortal(t, account, html, by);
  // A reply goes to the client from the mailbox, past lib/mail.js, so the
  // admin's hold on client emails (lib/clientEmails.js) is checked here:
  // logged as it would have gone, and refused so the writer knows. Only a
  // thread the tracker tied to a client company or contact counts.
  const held = (t.company_id || t.contact_id) ? await clientEmailHold({ query }, 'mailbox_reply') : null;
  if (held) {
    const { rows: [m] } = await query('SELECT from_email, to_emails FROM email_messages WHERE thread_id = $1 ORDER BY sent_at DESC LIMIT 1', [threadId]);
    const to = [m?.from_email, ...(m?.to_emails || [])].filter((a) => a && a.toLowerCase() !== String(account.email || '').toLowerCase());
    await query(
      `INSERT INTO email_log (to_email, subject, template, entity, entity_id, status, mode, reason, body_text, body_html, sent_by, from_email)
       VALUES ($1,$2,'mailbox_reply','email_thread',$3,'suppressed','mailbox',$4,$5,$6,$7,$8)`,
      [[...new Set(to)].join(', ') || '(thread participants)', `RE: ${t.subject || ''}`, String(t.id), held, snippet(html, 10000), cleanHtml(html), by, account.email]);
    throw Object.assign(new Error('Client emails are held by an admin, so this reply was not sent. It is kept in Settings, Client emails.'), { status: 409 });
  }
  const provider = providerFor(account);
  await provider.reply(last.provider_id, html, { replyAll });
  await saveTokens(account, provider);
  // Pull it straight back so it shows on the timeline now, marked as sent from here.
  const { messages } = await provider.delta('sentitems', (await query(`SELECT delta_link FROM mail_folders WHERE account_id = $1 AND folder = 'sentitems'`, [account.id])).rows[0]?.delta_link || null, new Date(Date.now() - 3600e3).toISOString());
  const r = await ingest(account, messages.map((m) => ({ ...m, folder: 'sentitems' })), { sentBy: by });
  return { sent: true, synced: r.stored };
}

/** A message that came through the client portal (#47) is answered by email. */
async function replyToPortal(t, account, html, by) {
  const { rows: [c] } = await query('SELECT name, email FROM contacts WHERE id = $1', [t.contact_id]);
  if (!c?.email) throw Object.assign(new Error('The client contact has no email address'), { status: 422 });
  const { sendMail } = await import('../mail.js');
  const subject = `RE: ${String(t.subject || '').replace(/^\[Portal\]\s*/, '')}`;
  await sendMail({ to: c.email, subject, text: snippet(html, 10000), html, template: 'portal_reply', entity: 'company', entityId: String(t.company_id), sentBy: by });
  await transaction(async (db) => {
    const { rows: [msg] } = await db.query(
      `INSERT INTO email_messages (account_id, thread_id, provider_id, direction, from_email, to_emails, subject, snippet, body_html, sent_at, company_id, contact_id, sent_from_tracker_by)
       VALUES ($1,$2,$3,'outbound',$4,$5,$6,$7,$8,now(),$9,$10,$11) RETURNING *`,
      [account.id, t.id, `portal-reply-${crypto.randomUUID()}`, account.email, [c.email], subject, snippet(html), cleanHtml(html), t.company_id, t.contact_id, by]);
    for (const hook of messageHooks) await hook({ db, account, thread: t, message: msg, participants: [] });
  });
  return { sent: true, synced: 1, by_email: true };
}

/** Where a person withdraws the tracker's access to their mailbox. */
export const CONSENT_URL = 'https://myaccount.microsoft.com/appconsent';

/**
 * Disconnect a mailbox: stop the mail coming, destroy our copy of the
 * tokens, and optionally drop the stored bodies.
 *
 * What this cannot do, and the review was right to ask: revoke the refresh
 * token at Microsoft. The identity platform has no revocation endpoint an
 * application can call for its own grant -- the two things that exist are
 * revokeSignInSessions, which signs the person out of every application
 * they use, and deleting the tenant-wide permission grant, which would
 * disconnect every other mailbox with it. Neither is what "disconnect this
 * one mailbox" means.
 *
 * So: the subscriptions are deleted, which is what stops Microsoft sending
 * us this mailbox, our copy of the tokens is destroyed, and the result says
 * where the owner withdraws consent. The outcome of the upstream call is
 * recorded rather than swallowed, because a subscription still live at
 * Microsoft is something an admin should be able to see.
 */
export async function disconnect(id, { removeBodies = true } = {}) {
  const { rows: [account] } = await query('SELECT * FROM connected_accounts WHERE id = $1', [id]);
  if (!account) return null;
  let upstream = 'subscriptions removed at the provider';
  try {
    const provider = providerFor(account);
    const { rows } = await query('SELECT subscription_id FROM mail_folders WHERE account_id = $1 AND subscription_id IS NOT NULL', [id]);
    for (const r of rows) await provider.unsubscribe(r.subscription_id);
  } catch (err) {
    // Not fatal: the tokens go either way, and a subscription with nowhere
    // to deliver expires by itself within three days.
    upstream = `subscriptions may still be live at the provider: ${String(err.message || err).slice(0, 200)}`;
  }
  await query(`UPDATE connected_accounts SET status = 'disconnected', tokens_encrypted = NULL, token_expires_at = NULL, last_error = $2 WHERE id = $1`, [id, upstream]);
  await query('DELETE FROM mail_folders WHERE account_id = $1', [id]);
  // Its sweep of past mail stops with it; the decisions stay, for the record.
  await query('DELETE FROM mailbox_enquiry_backfills WHERE account_id = $1', [id]);
  await query('DELETE FROM mailbox_po_backfills WHERE account_id = $1', [id]);
  await query('DELETE FROM mailbox_invoice_backfills WHERE account_id = $1', [id]);
  await query('DELETE FROM email_reader_queue WHERE account_id = $1', [id]);
  if (removeBodies) await query('UPDATE email_messages SET body_html = NULL, snippet = NULL WHERE account_id = $1', [id]);
  return { id, status: 'disconnected', bodies_removed: removeBodies, upstream, withdraw_consent_at: CONSENT_URL };
}
