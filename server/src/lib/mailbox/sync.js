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
import { applyVisibility, classify, cleanHtml, domainOf, openTokens, PUBLIC_DOMAINS, referencesIn, sealTokens, snippet } from './rules.js';
import { microsoftConfigured, microsoftProvider } from './microsoft.js';
import { isPortalSender } from './poDetect.js';
import { resolveParties } from '../../routes/communications.js';
import { assertNotStaging } from '../ops/environment.js';
import { enqueue, retryQueued, runReaders } from './readerQueue.js';

export const FOLDERS = ['inbox', 'sentitems'];
const key = () => config.microsoft.tokenKey;

// ------------------------------------------------------------ test provider
// A mailbox that lives in memory, for local runs and tests (provider 'test',
// never in production). Sent mail comes back on the next sync, like Outlook.
const testBoxes = new Map();
/** How many messages the test provider's page() returns at once; tests lower it to exercise resuming. */
export const testPaging = { size: 50 };
const testAttachments = new Map();
/** Every message pushed, by id, for message(): the mailbox keeps mail after delta has handed it over. */
const testMessages = new Map();
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
    return mine;
  };
  const sent = (m) => pushTestMessages(account.id, [{ folder: 'sentitems', provider_id: `sent-${crypto.randomUUID()}`, from: { email: account.email, name: account.display_name }, sent_at: new Date().toISOString(), ...m }]);
  return {
    tokens: () => null,
    async delta(folder, deltaLink) { return { messages: take(folder), deltaLink: deltaLink || `test:${folder}` }; },
    async message(providerId) {
      const m = testMessages.get(`${account.id}:${providerId}`);
      if (!m) throw Object.assign(new Error('Not found'), { status: 404 });
      return m;
    },
    async attachments(providerId) {
      return (testAttachments.get(`${account.id}:${providerId}`) || []).map((a) => ({ size: a.content?.length || 0, ...a }));
    },
    async page(folder, { sinceIso, cursor = null } = {}) {
      const past = (testBoxes.get(account.id) || [])
        .filter((m) => m.history && (m.folder || 'inbox') === folder && new Date(m.sent_at) >= new Date(sinceIso))
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
  const { rows } = await db.query(`SELECT key, value FROM settings WHERE key = 'internal_email_domains'`);
  const internalDomains = String(rows[0]?.value || '').split(',').map((s) => s.trim()).filter(Boolean);
  const { rows: bl } = await db.query('SELECT pattern FROM email_blocklist');
  return { internalDomains, blocklist: bl.map((r) => r.pattern) };
}

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
  return (m) => {
    const c = classify(m, { accountEmail: account.email, excludeInternal: account.exclude_internal, ...rules });
    if (!keepAll || !c.skip) return c;
    return { ...c, skip: null, filtered: c.skip };
  };
}

/**
 * Store one classified message, inside the caller's transaction.
 *
 * Returns { skipped: reason } or { thread, message, newThread }.
 * `forceCompanyId` keeps a message a personal mailbox would drop as
 * "no matching client": the enquiry reader (autoEnquiry.js) passes the
 * company it has just created, once the email has turned out to be one.
 */
export async function ingestOne(db, account, m, c, { sentBy = null, forceCompanyId = null } = {}) {
  // Kept only because the mailbox feeds an Inbox (ingestRules): the hooks
  // are told which filter would have dropped it.
  const filtered = c.filtered || null;
  const { rows: [dupe] } = await db.query('SELECT id FROM email_messages WHERE account_id = $1 AND provider_id = $2', [account.id, m.provider_id]);
  if (dupe) return { skipped: 'already synced' };
  let { rows: [thread] } = await db.query('SELECT * FROM email_threads WHERE account_id = $1 AND conversation_id = $2 FOR UPDATE', [account.id, m.conversation_id]);
  const who = thread?.company_id ? { company_id: thread.company_id, contact_id: thread.contact_id } : await matchParticipants(db, c.external, { autoCreate: account.auto_create_contacts });
  if (!who.company_id) {
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
    const link = await linkRecord(db, m.subject, who.company_id);
    ({ rows: [thread] } = await db.query(
      `INSERT INTO email_threads (account_id, conversation_id, subject, company_id, contact_id, entity, entity_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [account.id, m.conversation_id, account.visibility === 'metadata' ? null : m.subject, who.company_id, who.contact_id, link.entity, link.entity_id]));
  } else if (!thread.company_id && who.company_id) {
    const link = thread.entity ? { entity: thread.entity, entity_id: thread.entity_id } : await linkRecord(db, m.subject, who.company_id);
    await db.query('UPDATE email_threads SET company_id = $2, contact_id = $3, entity = $4, entity_id = $5 WHERE id = $1', [thread.id, who.company_id, who.contact_id, link.entity, link.entity_id]);
  }
  const html = cleanHtml(m.body_html);
  const row = applyVisibility({ subject: m.subject, snippet: m.preview ? snippet(m.preview) : snippet(html), body_html: html }, account.visibility);
  const { rows: [saved] } = await db.query(
    `INSERT INTO email_messages (account_id, thread_id, provider_id, internet_message_id, direction, from_email, from_name, to_emails, cc_emails,
                                 subject, snippet, body_html, has_attachments, sent_at, company_id, contact_id, sent_from_tracker_by, filtered_as)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
    [account.id, thread.id, m.provider_id, m.internet_message_id || null, c.direction, m.from?.email || null, m.from?.name || null,
      (m.to || []).map((p) => p.email), (m.cc || []).map((p) => p.email), row.subject, row.snippet, row.body_html, Boolean(m.has_attachments),
      m.sent_at, thread.company_id || who.company_id || null, who.contact_id || null, sentBy, filtered]);
  for (const hook of messageHooks) await hook({ db, account, thread, message: saved, participants: c.external, folder: m.folder || null, filtered });
  return { thread, message: saved, newThread };
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
export async function ingest(account, messages, { sentBy = null } = {}) {
  const judge = await ingestRules(account, undefined, { forInbox: true });
  const portals = await portalSenders();
  const result = { stored: 0, skipped: {}, threads: new Set(), candidates: [], poCandidates: [] };
  const skip = (why) => { result.skipped[why] = (result.skipped[why] || 0) + 1; };
  // The PO reader (autoPurchaseOrder.js) looks at every inbound message
  // that might hold an order, later ones in a thread included: that is
  // where most POs arrive. A cheap test; its prefilter does the rest.
  const mayBePo = (m, c) => c.direction === 'inbound' && (m.has_attachments || MAY_BE_PO.test(`${m.subject || ''} ${m.preview || ''}`));
  const isPortal = (m) => isPortalSender(m.from?.email, portals);
  const portalCand = (m, c, threadId, newThread) => ({ m, c: { ...c, direction: 'inbound', external: [m.from] }, threadId, newThread, dropped: !threadId });
  /** Which readers a candidate goes to: the enquiry reader takes outbound mail and new threads, the invoice reader outbound mail. */
  const readersOf = (cand, { enquiry }) => [
    ...(mayBePo(cand.m, cand.c) ? ['po'] : []),
    ...(enquiry && cand.c.direction === 'outbound' ? ['invoice'] : []),
    ...(enquiry ? ['enquiry'] : []),
  ];
  const route = (cand, readers) => {
    if (readers.includes('enquiry')) result.candidates.push(cand);
    if (readers.includes('po')) result.poCandidates.push(cand);
  };
  for (const m of messages.sort((a, b) => new Date(a.sent_at) - new Date(b.sent_at))) {
    if (!m.provider_id || !m.conversation_id || m.draft) { skip('incomplete'); continue; }
    const c = judge(m);
    if (c.skip) {
      skip(c.skip);
      // A procurement portal's notification reads as a robot; for POs it is not one.
      if (c.skip === 'blocked sender' && isPortal(m)) {
        const cand = portalCand(m, c, null, false);
        await enqueue({ query }, account, cand, ['po']);
        route(cand, ['po']);
      }
      continue;
    }
    let r;
    try {
      r = await transaction(async (db) => {
        const stored = await ingestOne(db, account, m, c, { sentBy });
        if (stored.skipped) return stored;
        // Stored for the Inbox only (ingestRules). The readers see it exactly
        // as they did when the filters dropped it: a portal's notification
        // still goes to the PO reader, nothing else goes anywhere.
        const cand = c.filtered
          ? (c.filtered === 'blocked sender' && isPortal(m) ? portalCand(m, c, stored.thread.id, stored.newThread) : null)
          : { m, c, threadId: stored.thread.id, newThread: stored.newThread, dropped: false };
        const readers = !cand ? [] : c.filtered ? ['po'] : readersOf(cand, { enquiry: c.direction === 'outbound' || stored.newThread });
        if (readers.length) await enqueue(db, account, cand, readers);
        return { ...stored, cand, readers };
      });
    } catch (err) {
      // Another sync, or a reply sent from the tracker, stored it a moment ago.
      if (err.code === '23505' && err.constraint?.startsWith('email_messages')) { skip('already synced'); continue; }
      throw err;
    }
    if (r.skipped) {
      skip(r.skipped);
      if (r.skipped === 'no matching client') {
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
    for (const folder of FOLDERS) {
      const { rows: [f] } = await query(
        `INSERT INTO mail_folders (account_id, folder) VALUES ($1,$2) ON CONFLICT (account_id, folder) DO UPDATE SET folder = EXCLUDED.folder RETURNING *`, [account.id, folder]);
      const since = f.delta_link ? null : new Date(Date.now() - account.import_days * 864e5).toISOString();
      const { messages, deltaLink } = await provider.delta(folder, f.delta_link, since);
      // Which folder each message came from, for the Inbox's routing.
      const r = await ingest(account, messages.map((m) => ({ ...m, folder: m.folder || folder })));
      candidates.push(...r.candidates);
      poCandidates.push(...r.poCandidates);
      out.stored += r.stored;
      for (const [k, v] of Object.entries(r.skipped)) out.skipped[k] = (out.skipped[k] || 0) + v;
      await query('UPDATE mail_folders SET delta_link = $2 WHERE id = $1', [f.id, deltaLink]);
    }
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
          `UPDATE email_messages SET body_html = $3, snippet = $4
            WHERE account_id = $1 AND provider_id = $2
              AND (body_html IS DISTINCT FROM $3 OR snippet IS DISTINCT FROM $4)`,
          [account.id, m.provider_id, row.body_html, row.snippet]
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

/** Keep push notifications alive; the delta sweep covers any gap. */
export async function ensureSubscriptions(account, provider = providerFor(account)) {
  if (account.provider !== 'microsoft' || !config.microsoft.webhookUrl) return 0;
  let changed = 0;
  const { rows } = await query('SELECT * FROM mail_folders WHERE account_id = $1', [account.id]);
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
  await query('DELETE FROM email_reader_queue WHERE account_id = $1', [id]);
  if (removeBodies) await query('UPDATE email_messages SET body_html = NULL, snippet = NULL WHERE account_id = $1', [id]);
  return { id, status: 'disconnected', bodies_removed: removeBodies, upstream, withdraw_consent_at: CONSENT_URL };
}
