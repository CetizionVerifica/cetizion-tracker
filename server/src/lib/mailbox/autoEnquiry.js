/**
 * New enquiries from email, automatically (docs/email-enquiries-plan.md).
 *
 *   processCandidates(account, candidates)   judge what a sync or the
 *                                            backfill found, create or link
 *   decide(account, candidate, ctx)          one email, start to finish
 *
 * An email is judged once per mailbox, and the decision is logged in
 * email_enquiry_decisions without any of its text. The order for one
 * email (plan §3.1):
 *
 *   1. already decided in this mailbox?                      → stop
 *   2. the same email already made or joined an enquiry      → link, log linked
 *   3. prefilter (free rules)                                 → stop, not logged
 *   4. classify: the AI if configured, else rules             → log not_enquiry
 *   5. an open enquiry from the same sender or company        → link, log linked
 *   6. create the enquiry (and store the email a personal mailbox dropped),
 *      log created, tell the owner
 *
 * AI calls are made before any transaction opens, never inside one.
 */
import { query, transaction } from '../../db.js';
import { aiConfig, chatJSON } from '../ai.js';
import { notify } from '../notify.js';
import { addWorkingDays, businessToday } from '../businessDate.ts';
import { ingestOne, ingestRules, providerFor, readsAllFolders, saveTokens } from './sync.js';
import { createEnquiryFromEmail } from './enquiryFromEmail.js';
import { RULES_BAR, buildPrompt, companyNameFromEmail, mainText, numbersIn, parseVerdict, prefilter, rulesVerdict } from './enquiryDetect.js';
import { domainOf, forReaders, PUBLIC_DOMAINS } from './rules.js';
import * as autoQuotation from './autoQuotation.js';
import { queueFailures } from './readerQueue.js';
import { inLanes } from './inLanes.js';
import { gstinList, partnersOf } from './ourParties.js';
import { MAX_PDF_BYTES, SCANNED_BELOW, isPdf, pdfText } from './pdfQuotation.js';
import { MAX_ENQUIRY_ATTACHMENT_TEXT } from './readLimits.js';

/**
 * Replaceable in tests: `chat` stands in for the AI, so no test reaches the
 * network; `readQuotation` reads the quotation PDF we sent (autoQuotation.js).
 */
export const deps = { chat: null, readQuotation: autoQuotation };

const OPEN_ENQUIRY = ['New', 'Contacted', 'Qualified', 'Nurture'];
const SETTING_KEYS = ['auto_enquiries_enabled', 'auto_enquiry_min_confidence', 'auto_enquiry_same_sender_days', 'auto_enquiry_daily_ai_limit',
  'auto_enquiry_backfill_days', 'auto_quotation_min_confidence', 'company_name', 'company_gstin', 'company_gstins', 'partner_companies', 'email_readers_review_only', 'email_readers_auto_clients', 'internal_email_domains', 'auto_po_enabled', 'po_portal_senders', 'email_reader_concurrency',
  'email_read_everything'];

const num = (v, fallback) => { const n = Number(v); return Number.isFinite(n) ? n : fallback; };

export async function enquirySettings(db = { query }) {
  const { rows } = await db.query('SELECT key, value FROM settings WHERE key = ANY($1)', [SETTING_KEYS]);
  const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  // The catalogue's names go into every reader's prompt, so a service is
  // spelt the way the catalogue spells it and links to it (promptRules.js).
  const { rows: services } = await db.query('SELECT name FROM services WHERE active ORDER BY sort_order, name');
  return {
    enabled: String(s.auto_enquiries_enabled ?? 'true').trim().toLowerCase() !== 'false',
    minConfidence: num(s.auto_enquiry_min_confidence, 0.7),
    sameSenderDays: num(s.auto_enquiry_same_sender_days, 30),
    dailyAiLimit: num(s.auto_enquiry_daily_ai_limit, 5000),
    // How many emails each reader reads at once (inLanes.js); 1 is one after another.
    concurrency: Math.min(8, Math.max(1, Math.trunc(num(s.email_reader_concurrency, 4)))),
    backfillDays: num(s.auto_enquiry_backfill_days, 365),
    quotationMinConfidence: num(s.auto_quotation_min_confidence, 0.8),
    ourNames: [s.company_name].filter(Boolean),
    ourGstin: String(s.company_gstin || '').trim() || null,
    // Every registration of ours, and the companies clients also order through (docs/email-po-invoice-prompt-plan.md §1).
    ourGstins: gstinList(s.company_gstin, s.company_gstins),
    partners: partnersOf(s.partner_companies),
    // The rollout of the new PO and invoice prompts (docs/email-po-invoice-prompt-plan.md §7).
    reviewOnly: String(s.email_readers_review_only ?? 'false').trim().toLowerCase() === 'true',
    autoClients: String(s.email_readers_auto_clients || '').split(',').map((n) => n.trim()).filter((n) => n && n.toLowerCase() !== 'none'),
    services: services.map((r) => r.name),
    internalDomains: String(s.internal_email_domains || '').split(',').map((d) => d.trim()).filter(Boolean),
    // The PO reader (autoPurchaseOrder.js) takes PO emails while it is on.
    poReader: String(s.auto_po_enabled ?? 'true').trim().toLowerCase() !== 'false',
    portalSenders: String(s.po_portal_senders || ''),
    // Every email goes to the AI, replies included; the free rules that
    // screen mail out are skipped (073). The duplicate guards stay.
    readAll: String(s.email_read_everything ?? 'true').trim().toLowerCase() !== 'false',
  };
}

/** Model calls made today (business day), against the daily ceiling. */
export async function aiCallsToday(db = { query }) {
  // One ceiling for every email reader: enquiries, quotations, POs and invoices (docs/email-po-plan.md §3.9).
  const { rows: [r] } = await db.query(
    `WITH day AS (SELECT date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata' AS start)
     SELECT (SELECT COALESCE(sum(ai_calls), 0) FROM email_enquiry_decisions, day WHERE decided_at >= day.start)::int
          + (SELECT COALESCE(sum(ai_calls), 0) FROM email_po_decisions, day WHERE decided_at >= day.start)::int
          + (SELECT COALESCE(sum(ai_calls), 0) FROM email_invoice_decisions, day WHERE decided_at >= day.start)::int
          + (SELECT count(*) FROM email_ai_calls, day WHERE made_at >= day.start)::int AS n`);
  return r.n;
}

const chatFn = () => deps.chat || (aiConfig.enabled ? (system, user, opts) => chatJSON(system, user, { title: 'Cetizion Tracker email enquiries', ...opts }) : null);

/** The context one run shares: settings, the AI budget, what it has made. */
export async function runContext({ backfill = false } = {}) {
  const settings = await enquirySettings();
  return { settings, backfill, aiUsed: await aiCallsToday(), created: [], linked: 0, notEnquiry: 0, skipped: 0, errors: 0, stopped: null };
}

/**
 * Judge each candidate a sync or the backfill found. Returns the tally, or
 * null when the feature is switched off. One email failing never stops the
 * rest, and never fails the sync that found it.
 */
export async function processCandidates(account, candidates, { ctx: given = null, notifyEach = true, provider = null, onSettled = null } = {}) {
  const ctx = given || await runContext();
  if (provider) ctx.provider = provider;
  if (!ctx.settings.enabled) return null;
  await inLanes(candidates, {
    concurrency: ctx.settings.concurrency,
    stopped: () => Boolean(ctx.stopped),
    each: async (cand) => {
      // Told for every email reached, so the reader queue (readerQueue.js)
      // can keep the ones that failed. One left unreached stays queued.
      let failure = null;
      try {
        await decide(account, cand, ctx);
      } catch (err) {
        failure = err;
        ctx.errors += 1;
        console.error('[auto-enquiry]', account.email, cand.m?.provider_id, err.message);
      }
      if (onSettled) await onSettled(cand, failure);
    },
  });
  if (notifyEach) {
    for (const e of ctx.created) {
      await notify({
        username: e.owner_email || null, kind: 'enquiry',
        title: `New enquiry ${e.enquiry_no} from ${e.client_name}, created from email`,
        body: e.kind === 'quotation_sent' ? `From the quotation sent by ${account.email}` : `From an email to ${account.email}`,
        entity: 'enquiry', entityId: e.enquiry_no, link: `/enquiries?q=${encodeURIComponent(e.enquiry_no)}`, dedupeKey: `auto-enquiry:${e.enquiry_no}`,
      }).catch(() => {});
    }
  }
  return given ? ctx : { created: ctx.created.length, linked: ctx.linked, not_enquiry: ctx.notEnquiry, errors: ctx.errors };
}

// ------------------------------------------------------------ the decision log

async function logDecision(db, account, cand, d) {
  const { m, c } = cand;
  await db.query(
    `INSERT INTO email_enquiry_decisions (account_id, provider_id, internet_message_id, conversation_id, thread_id, direction, from_email, received_at,
                                          outcome, kind, confidence, method, ai_calls, enquiry_no, quotation_no, quotation_extraction, extraction_reason,
                                          printed_subtotal, printed_tax_total, printed_total)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
     ON CONFLICT (account_id, provider_id) DO NOTHING`,
    [account.id, m.provider_id, m.internet_message_id || null, m.conversation_id || null, d.thread_id ?? cand.threadId ?? null, c.direction,
      m.from?.email || null, m.sent_at || null, d.outcome, d.kind, d.confidence ?? null, d.method, d.ai_calls || 0, d.enquiry_no || null,
      d.quotation_no || null, d.quotation_extraction || null, d.extraction_reason || null,
      d.printed_subtotal ?? null, d.printed_tax_total ?? null, d.printed_total ?? null]);
}

// ------------------------------------------------------------ facts

/** The facts prefilter() needs that only the database knows. */
async function factsFor(account, cand, settings = {}) {
  const { m, c } = cand;
  const { rows: [conv] } = await query(
    `SELECT EXISTS (SELECT 1 FROM email_enquiry_decisions WHERE account_id = $1 AND conversation_id = $2 AND outcome IN ('created','linked')) AS decided,
            EXISTS (SELECT 1 FROM email_threads t JOIN inbox_conversations ic ON ic.thread_id = t.id
                     WHERE t.account_id = $1 AND t.conversation_id = $2 AND ic.enquiry_no IS NOT NULL) AS converted`,
    [account.id, m.conversation_id]);
  // For our own quotation the thread being on that quotation is the point,
  // not a reason to skip it: what matters there is whether it has an
  // enquiry (plan §3.8), which quotationEnquiry() works out.
  const onRecord = c.direction === 'inbound' && await linkedByNumber(cand);
  const facts = { handled: conv.decided || conv.converted || onRecord, firstInConversation: cand.newThread || cand.dropped, readAll: Boolean(settings.readAll) };
  // Only while the PO reader can read: without an AI it reads nothing, and
  // holding PO-looking mail back for it would hide it from everyone.
  if (c.direction === 'inbound' && settings.poReader && (await import('./autoPurchaseOrder.js')).poReaderCanRead()) {
    // A PO email is the PO reader's, until it has decided otherwise.
    const { rows: [po] } = await query(
      `SELECT 1 FROM email_po_decisions WHERE account_id = $1 AND provider_id = $2 AND outcome IN ('not_po','dismissed')`, [account.id, m.provider_id]);
    Object.assign(facts, { poReader: true, notPo: Boolean(po), portalSenders: settings.portalSenders });
  }
  if (c.direction === 'outbound') {
    // A domain we have only ever had bills or sales pitches from is a vendor,
    // and what we send them is not a quotation to a client.
    // Never a free-mail domain: one gmail.com sender's remittance advice
    // made every quotation to any gmail.com client "to a vendor".
    const domains = [...new Set(c.external.map((p) => domainOf(p.email)).filter((d) => d && !PUBLIC_DOMAINS.has(d)))];
    if (domains.length) {
      const { rows: [v] } = await query(
        `SELECT bool_or(kind IN ('billing','vendor_or_sales_pitch')) AND NOT bool_or(kind IN ('new_enquiry','quotation_sent')) AS vendor
           FROM email_enquiry_decisions WHERE direction = 'inbound' AND split_part(lower(from_email), '@', 2) = ANY($1)`, [domains]);
      facts.toVendor = Boolean(v?.vendor);
    }
  }
  return facts;
}

/**
 * Is the stored thread on a quotation, PO or project because the
 * conversation names it? Then it is about a record we already have, even
 * when its first message does not say so: the backfill reaches the first
 * message of a thread whose later replies carried the number.
 *
 * A link the sync made only because the company has an open deal (the weak
 * fallback in linkRecord) does not count: a repeat client's new request
 * must not hide under their old deal (plan §1). Where the mailbox stores no
 * subjects there is no telling the two apart, and the link is trusted —
 * missing an enquiry is the safer mistake than duplicating one.
 */
async function linkedByNumber(cand) {
  if (!cand.threadId) return false;
  const { rows: [t] } = await query('SELECT entity, entity_id, subject FROM email_threads WHERE id = $1', [cand.threadId]);
  if (!t?.entity || t.entity === 'enquiry') return false;
  const { rows: subjects } = await query('SELECT subject FROM email_messages WHERE thread_id = $1', [cand.threadId]);
  const all = [t.subject, ...subjects.map((r) => r.subject)].filter(Boolean);
  if (!all.length) return true;
  const id = String(t.entity_id).toUpperCase();
  return all.some((sub) => { const r = numbersIn(sub); return [...r.quotations, ...r.enquiries, ...r.pos].some((n) => n.toUpperCase() === id); });
}

// ------------------------------------------------------------ classification

async function classifyEmail(account, cand, input, ctx) {
  const chat = chatFn();
  if (chat && ctx.aiUsed < ctx.settings.dailyAiLimit) {
    ctx.aiUsed += 1;
    let companyKnown = false; let openDeals = 0;
    if (cand.threadId) {
      const { rows: [t] } = await query(
        `SELECT t.company_id, (SELECT count(*)::int FROM quotations q WHERE q.company_id = t.company_id
                                 AND q.status IN ('Draft','Submitted','Under Negotiation','On Hold')) AS open
           FROM email_threads t WHERE t.id = $1`, [cand.threadId]);
      companyKnown = Boolean(t?.company_id); openDeals = t?.open || 0;
    }
    const attachmentText = await attachedText(account, cand, ctx);
    const { system, user } = buildPrompt({ ...input, attachmentText }, {
      companyKnown, openDeals, services: ctx.settings.services, ourNames: ctx.settings.ourNames, ourGstin: ctx.settings.ourGstin,
    });
    try {
      const v = parseVerdict(await chat(system, user, { maxTokens: 1000, timeoutMs: 60_000 }), ctx.settings);
      return { ...v, ai_calls: 1 };
    } catch (err) {
      // Not answered (no route, a timeout): the rules decide this one.
      console.warn('[auto-enquiry] AI unavailable, rules decide:', err.message);
      return { ...rulesVerdict(input), ai_calls: 1 };
    }
  }
  // The day's ceiling is reached: the live path carries on with rules; the
  // backfill stops and picks up tomorrow, so a year of mail is judged the
  // same way throughout.
  if (chat && ctx.backfill) return null;
  return { ...rulesVerdict(input), ai_calls: 0 };
}

/**
 * The text of the PDFs a client attached: a request for quotation or a scope
 * of work often says in its PDF what the email only points to. Text PDFs
 * only, no OCR, at most MAX_ENQUIRY_ATTACHMENT_TEXT; anything that fails
 * leaves the email judged on its own, as before.
 */
async function attachedText(account, cand, ctx) {
  const { m, c } = cand;
  if (c.direction !== 'inbound' || !m.has_attachments) return '';
  let files;
  try {
    files = (await (ctx.provider || providerFor(account)).attachments(m.provider_id))
      .filter((a) => isPdf(a) && a.content && a.content.length <= MAX_PDF_BYTES);
  } catch (err) {
    console.warn('[auto-enquiry] attachments not read:', err.message);
    return '';
  }
  let out = '';
  for (const f of files) {
    if (out.length >= MAX_ENQUIRY_ATTACHMENT_TEXT) break;
    const text = (await pdfText(f.content).catch(() => [])).join('\n\n');
    if (text.replace(/\s+/g, '').length < SCANNED_BELOW) continue;
    out += `\n--- ${f.name || 'attachment.pdf'} ---\n${text}`;
  }
  return out.slice(0, MAX_ENQUIRY_ATTACHMENT_TEXT);
}

// ------------------------------------------------------------ owners

async function salesUser(db, ref) {
  if (!ref) return null;
  const { rows: [u] } = await db.query(
    `SELECT id, name, email FROM users WHERE active AND role = 'sales' AND (lower(email) = lower($1) OR lower(name) = lower($1))
      ORDER BY (lower(email) = lower($1)) DESC LIMIT 1`, [String(ref).trim()]);
  return u || null;
}

/**
 * Who an automatically created record belongs to. A personal mailbox: its
 * owner (connected_accounts.user_id, 074), if they are an active
 * salesperson. A shared one: the conversation's assignee, if that is a
 * salesperson. Otherwise nobody — visibly unassigned rather than wrongly
 * given to someone (the rule ownerForNewRecord follows).
 *
 * The owner is a users row, not a name: the string matching on the
 * mailbox's username and address that stood here failed as soon as a
 * mailbox address differed from the login one. Migration 074 turned those
 * strings into user_id once; nothing matches names here any more.
 */
export async function ownerFor(db, account, threadId, fallbackUserId = null) {
  if (!account.is_shared) {
    if (!account.user_id) return null;
    const { rows: [u] } = await db.query(`SELECT id, name, email FROM users WHERE id = $1 AND active AND role = 'sales'`, [account.user_id]);
    return u || null;
  }
  if (threadId) {
    const { rows: [conv] } = await db.query('SELECT assignee FROM inbox_conversations WHERE thread_id = $1', [threadId]);
    const u = await salesUser(db, conv?.assignee);
    if (u) return u;
  }
  if (fallbackUserId) {
    const { rows: [u] } = await db.query(`SELECT id, name, email FROM users WHERE id = $1 AND active AND role = 'sales'`, [fallbackUserId]);
    return u || null;
  }
  return null;
}

// ------------------------------------------------------------ linking

async function sourceId(db, name) {
  const { rows: [s] } = await db.query('SELECT id FROM lead_sources WHERE name = $1', [name]);
  return s?.id ?? null;
}

/** Put a thread (and its inbox conversation) on an enquiry, without taking it off a quotation or a PO. */
async function linkThread(db, threadId, enquiryNo) {
  if (!threadId || !enquiryNo) return;
  await db.query(`UPDATE email_threads SET entity = 'enquiry', entity_id = $2 WHERE id = $1 AND (entity IS NULL OR entity = 'enquiry')`, [threadId, enquiryNo]);
  await db.query('UPDATE inbox_conversations SET enquiry_no = $2 WHERE thread_id = $1 AND enquiry_no IS NULL', [threadId, enquiryNo]);
}

/**
 * The enquiry this email belongs to, from the same sender or company:
 *
 *   an open one dated up to `days` before the email — the client writing
 *   again about the same request; or
 *   one in any status dated within a week either side of it — an enquiry
 *   somebody typed in by hand for this very email. Reading back a year of
 *   mail meets mostly these, long since Converted or Unqualified, and
 *   without this each would be made a second time.
 *
 * `clientName` finds the company by name when no thread or contact does.
 */
async function openEnquiryFor(db, { email, companyId, clientName = null, sentAt, days, withoutQuotation = false }) {
  const { rows: [e] } = await db.query(
    `WITH day AS (SELECT ($4::timestamptz AT TIME ZONE 'Asia/Kolkata')::date AS d),
          co AS (SELECT COALESCE($3::int, (SELECT id FROM companies WHERE name_key = name_key($7))) AS id)
     SELECT e.enquiry_no, e.quotation_no, e.company_id FROM enquiries e LEFT JOIN contacts ct ON ct.id = e.contact_id, day, co
      WHERE ((e.status = ANY($1) AND e.enquiry_date BETWEEN day.d - $5::int AND day.d)
             OR e.enquiry_date BETWEEN day.d - 7 AND day.d + 7)
        AND ($6::boolean IS FALSE OR e.quotation_no IS NULL)
        AND ((ct.email IS NOT NULL AND lower(ct.email) = lower($2))
             OR (co.id IS NOT NULL AND e.company_id = co.id)
             OR EXISTS (SELECT 1 FROM email_enquiry_decisions d WHERE d.enquiry_no = e.enquiry_no AND d.outcome = 'created' AND lower(d.from_email) = lower($2)))
      ORDER BY (e.status = ANY($1)) DESC, abs(e.enquiry_date - day.d), e.id DESC LIMIT 1`,
    [OPEN_ENQUIRY, email || '', companyId ?? null, sentAt, days, withoutQuotation, clientName]);
  return e || null;
}

async function companyName(db, companyId) {
  if (!companyId) return null;
  const { rows: [c] } = await db.query('SELECT name FROM companies WHERE id = $1', [companyId]);
  return c?.name || null;
}

async function threadCompany(db, threadId) {
  if (!threadId) return null;
  const { rows: [t] } = await db.query('SELECT company_id, entity, entity_id FROM email_threads WHERE id = $1', [threadId]);
  return t || null;
}

/**
 * The thread a dropped email gets once it is an enquiry: stored now, under
 * the new company, with the mailbox's visibility applied as for any mail.
 */
export async function keepDropped(db, account, cand, companyId) {
  if (cand.threadId) return cand.threadId;
  const r = await ingestOne(db, account, cand.m, cand.c, { forceCompanyId: companyId });
  if (r.thread) return r.thread.id;
  const { rows: [t] } = await db.query('SELECT id FROM email_threads WHERE account_id = $1 AND conversation_id = $2', [account.id, cand.m.conversation_id]);
  return t?.id ?? null;
}

const istYear = (iso) => new Date(new Date(iso).getTime() + 330 * 60_000).toISOString().slice(0, 4);
const istDate = (iso) => new Date(new Date(iso).getTime() + 330 * 60_000).toISOString().slice(0, 10);

// ------------------------------------------------------------ one email

export async function decide(account, cand, ctx) {
  const { m, c } = cand;
  if (!m.provider_id || !m.conversation_id) return 'incomplete';

  // By id, or as the same email under another id: Outlook gives a message
  // a new id when it is moved to another folder, and every folder is read.
  const { rows: [seen] } = await query(
    `SELECT 1 FROM email_enquiry_decisions WHERE account_id = $1
        AND (provider_id = $2 OR ($3::text IS NOT NULL AND lower(internet_message_id) = lower($3)))`, [account.id, m.provider_id, m.internet_message_id || null]);
  if (seen) return 'seen';

  // The same email, read in another mailbox, already made or joined an
  // enquiry: join this mailbox's copy to it, with no second AI call.
  const elsewhere = await sameEmailElsewhere({ query }, m);
  if (elsewhere) return transaction((db) => joinElsewhere(db, account, cand, elsewhere, ctx));

  const text = mainText(m.body_html || (m.preview ? `<p>${m.preview}</p>` : ''));
  const input = { direction: c.direction, subject: m.subject, text, from: m.from, to: m.to, external: c.external, has_attachments: m.has_attachments, attachments: m.attachments };
  const facts = await factsFor(account, cand, ctx.settings);
  const pf = prefilter(input, facts);
  if (!pf.candidate) { ctx.skipped += 1; return 'skipped'; }

  const verdict = await classifyEmail(account, cand, input, ctx);
  if (!verdict) { ctx.stopped = 'ai_limit'; return 'ai_limit'; }
  // Reading everything lets the AI judge what the free rules would have
  // skipped. When the rules decide instead (no AI, the day's ceiling, an
  // AI error), their own screening is part of the decision — for our own
  // mail it is all of it — so it applies as before: otherwise every email
  // we send would become an enquiry.
  if (facts.readAll && verdict.method === 'rules' && !prefilter(input, { ...facts, readAll: false }).candidate) { ctx.skipped += 1; return 'skipped'; }
  const wanted = pf.candidate === 'quotation' ? 'quotation_sent' : 'new_enquiry';
  const bar = verdict.method === 'ai' ? ctx.settings.minConfidence : RULES_BAR;
  if (verdict.kind !== wanted || verdict.confidence < bar) {
    await logDecision({ query }, account, cand, { outcome: 'not_enquiry', kind: verdict.kind, confidence: verdict.confidence, method: verdict.method, ai_calls: verdict.ai_calls });
    ctx.notEnquiry += 1;
    return 'not_enquiry';
  }

  // The quotation PDF is read before the transaction too: it may call the AI.
  const prepared = wanted === 'quotation_sent' ? await prepareQuotation(account, cand, verdict, ctx) : null;
  if (prepared?.stop) { ctx.stopped = 'ai_limit'; return 'ai_limit'; }
  // Whatever happens next, the PDF's AI call is this decision's too, and
  // counts against the day's ceiling.
  if (prepared?.ai_calls) verdict.ai_calls = (verdict.ai_calls || 0) + prepared.ai_calls;

  const result = await transaction(async (db) => {
    // Live sync and the backfill can meet on one email, and two emails from
    // one client can arrive in one sync: both wait here, then look again.
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`auto-enquiry:${m.internet_message_id || m.provider_id}`]);
    const party = (c.direction === 'outbound' ? c.external[0]?.email : m.from?.email) || '';
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`auto-enquiry-party:${domainOf(party) || party}`]);
    const { rows: [again] } = await db.query('SELECT 1 FROM email_enquiry_decisions WHERE account_id = $1 AND provider_id = $2', [account.id, m.provider_id]);
    if (again) return 'seen';
    // Another mailbox's copy of this email may have been decided while this
    // one was being judged: join it rather than make a second record.
    const meanwhile = await sameEmailElsewhere(db, m);
    if (meanwhile) return joinElsewhere(db, account, cand, meanwhile, ctx, verdict.ai_calls);
    return wanted === 'new_enquiry'
      ? inboundEnquiry(db, account, cand, verdict, ctx)
      : quotationEnquiry(db, account, cand, verdict, prepared, ctx);
  });
  return result;
}

async function sameEmailElsewhere(db, m) {
  if (!m.internet_message_id) return null;
  const { rows: [d] } = await db.query(
    `SELECT d.enquiry_no, d.quotation_no, d.kind, d.confidence, d.method, e.company_id FROM email_enquiry_decisions d
       LEFT JOIN enquiries e ON e.enquiry_no = d.enquiry_no
      WHERE lower(d.internet_message_id) = lower($1) AND d.outcome IN ('created','linked') AND d.enquiry_no IS NOT NULL
      ORDER BY d.id LIMIT 1`, [m.internet_message_id]);
  return d || null;
}

/**
 * This mailbox's copy of an email another mailbox already turned into (or
 * onto) an enquiry. The enquiry belongs to whoever's mailbox was read first;
 * when that left it unowned (a shared mailbox, say) and this copy is in a
 * salesperson's own mailbox, it is theirs (docs/per-user-mailboxes-plan.md
 * §10.4). An owner already set is never changed here.
 */
async function joinElsewhere(db, account, cand, elsewhere, ctx, aiCalls = 0) {
  const threadId = await keepDropped(db, account, cand, elsewhere.company_id);
  await linkThread(db, threadId, elsewhere.enquiry_no);
  if (!account.is_shared) {
    const owner = await ownerFor(db, account, threadId);
    // Only an enquiry nobody is named on: one carrying a sales_person with
    // no owner_user_id is a workbook attribution, not an unowned record.
    if (owner) {
      await db.query(`UPDATE enquiries SET owner_user_id = $2, sales_person = $3 WHERE enquiry_no = $1 AND owner_user_id IS NULL AND sales_person IS NULL`, [elsewhere.enquiry_no, owner.id, owner.name]);
    }
  }
  await logDecision(db, account, cand, {
    outcome: 'linked', kind: elsewhere.kind, confidence: elsewhere.confidence, method: elsewhere.method, ai_calls: aiCalls,
    enquiry_no: elsewhere.enquiry_no, quotation_no: elsewhere.quotation_no, thread_id: threadId,
  });
  ctx.linked += 1;
  return 'linked';
}

const decisionOf = (verdict) => ({ kind: verdict.kind, confidence: verdict.confidence, method: verdict.method, ai_calls: verdict.ai_calls });

/** A client asking for new work. */
async function inboundEnquiry(db, account, cand, verdict, ctx) {
  const { m } = cand;
  const thread = await threadCompany(db, cand.threadId);
  const companyId = thread?.company_id || null;

  const fromName = m.from?.name && !m.from.name.includes('@') ? m.from.name.trim() : null;
  const client = (await companyName(db, companyId)) || verdict.company_name || companyNameFromEmail(m.from?.email) || fromName || m.from?.email;

  const open = await openEnquiryFor(db, { email: m.from?.email, companyId, clientName: client, sentAt: m.sent_at, days: ctx.settings.sameSenderDays });
  if (open) {
    const threadId = await keepDropped(db, account, cand, open.company_id);
    await linkThread(db, threadId, open.enquiry_no);
    await logDecision(db, account, cand, { outcome: 'linked', ...decisionOf(verdict), enquiry_no: open.enquiry_no, thread_id: threadId });
    ctx.linked += 1;
    return 'linked';
  }

  const { rows: [{ id: newCompanyId }] } = await db.query('SELECT company_for($1) AS id', [client]);
  const threadId = await keepDropped(db, account, cand, newCompanyId);
  const owner = await ownerFor(db, account, threadId);
  const { rows: [{ first_reply: firstReply }] } = await db.query(
    `SELECT MIN(sent_at) AS first_reply FROM email_messages WHERE thread_id = $1 AND direction = 'outbound' AND sent_at >= $2`, [threadId, m.sent_at]);
  const summary = verdict.method === 'ai' ? verdict.summary : (account.visibility === 'metadata' ? null : verdict.summary);
  const e = await createEnquiryFromEmail(db, {
    keepRecordLink: true,
    threadId, fromEmail: m.from?.email, fromName,
    enquiry: {
      dated_at: m.sent_at, year: istYear(m.sent_at), client_name: client, status: 'New',
      contact_person: verdict.contact_name || fromName, service: verdict.service, sector: verdict.sector, country: verdict.country,
      source_id: await sourceId(db, 'Inbound email or call'),
      notes: `Created automatically from an email to ${account.email} on ${istDate(m.sent_at)}${summary ? `: ${summary}` : ''}`,
      first_responded_at: firstReply, owner_user_id: owner?.id ?? null, sales_person: owner?.name ?? null,
    },
  });
  await logDecision(db, account, cand, { outcome: 'created', ...decisionOf(verdict), enquiry_no: e.enquiry_no, thread_id: threadId });
  ctx.created.push({ ...e, owner_email: owner?.email || null, kind: 'new_enquiry' });
  return 'created';
}

/**
 * Our quotation, in a conversation with no enquiry: the request reached us
 * some other way, and the enquiry is made from what we sent (plan §3.8).
 */
async function quotationEnquiry(db, account, cand, verdict, prepared, ctx) {
  const { m, c } = cand;
  const recipient = c.external[0] || {};
  const thread = await threadCompany(db, cand.threadId);
  const text = mainText(m.body_html || '');
  const named = numbersIn(m.subject, text).quotations;
  const { rows: [q] } = named.length
    ? await db.query('SELECT * FROM quotations WHERE quotation_no = ANY($1) ORDER BY id LIMIT 1', [named])
    : { rows: [] };

  const linked = async (enquiryNo, threadId, extra = {}) => {
    await linkThread(db, threadId, enquiryNo);
    await logDecision(db, account, cand, { outcome: 'linked', ...decisionOf(verdict), enquiry_no: enquiryNo, quotation_no: q?.quotation_no, thread_id: threadId, ...extra });
    ctx.linked += 1;
    return 'linked';
  };

  if (q) {
    // A tracker quotation already on an enquiry: nothing to make.
    const { rows: [has] } = await db.query('SELECT enquiry_no FROM enquiries WHERE quotation_no = $1', [q.quotation_no]);
    if (has) return linked(has.enquiry_no, await keepDropped(db, account, cand, q.company_id));
  }

  const companyId = q?.company_id || thread?.company_id || null;
  // The thread is already on an enquiry, or the client has a recent open
  // one with no quotation: this quotation answers it.
  const onThread = thread?.entity === 'enquiry' ? { enquiry_no: thread.entity_id, company_id: thread.company_id } : null;
  const open = onThread || await openEnquiryFor(db, { email: recipient.email, companyId, sentAt: m.sent_at, days: ctx.settings.sameSenderDays, withoutQuotation: true });
  const sentOn = istDate(m.sent_at);
  if (open) {
    const threadId = await keepDropped(db, account, cand, companyId || open.company_id);
    if (q) {
      await db.query('UPDATE enquiries SET quotation_no = $2 WHERE enquiry_no = $1 AND quotation_no IS NULL', [open.enquiry_no, q.quotation_no]);
      return linked(open.enquiry_no, threadId);
    }
    // Made outside the tracker, answering an enquiry we already have: the
    // PDF that was read becomes that enquiry's quotation, or, when it could
    // not be read, its owner is asked to add it.
    const { rows: [e] } = await db.query('SELECT enquiry_no, client_name, quotation_no, owner_user_id, sales_person FROM enquiries WHERE enquiry_no = $1', [open.enquiry_no]);
    if (e?.quotation_no) return linked(e.enquiry_no, threadId);
    if (prepared?.ok && deps.readQuotation?.create) {
      const owner = e?.owner_user_id ? { id: e.owner_user_id, name: e.sales_person } : await ownerFor(db, account, threadId);
      const made = await deps.readQuotation.create(db, { account, cand, prepared, client: e.client_name, owner, threadId });
      if (!made.revised && !made.repeated) {
        await db.query('UPDATE enquiries SET quotation_no = $2 WHERE enquiry_no = $1 AND quotation_no IS NULL', [e.enquiry_no, made.quotation_no]);
      }
      return linked(e.enquiry_no, threadId, { quotation_no: made.quotation_no, quotation_extraction: made.repeated ? null : (made.revised ? 'revised' : 'created'), ...made.printed });
    }
    if (prepared) await addQuotationTask(db, { enquiryNo: e.enquiry_no, client: e.client_name, sentOn, account, threadId, assignee: e.sales_person });
    return linked(e.enquiry_no, threadId, prepared ? { quotation_extraction: 'failed', extraction_reason: prepared.reason || 'no_pdf' } : {});
  }

  const otherSource = await sourceId(db, 'Other');
  if (q) {
    const threadId = await keepDropped(db, account, cand, q.company_id);
    const owner = await ownerFor(db, account, threadId, q.owner_user_id);
    const dated = q.quotation_date && String(q.quotation_date).slice(0, 10) < sentOn ? `${String(q.quotation_date).slice(0, 10)}T12:00:00+05:30` : m.sent_at;
    const e = await createEnquiryFromEmail(db, {
    keepRecordLink: true,
      threadId, fromEmail: recipient.email, fromName: recipient.name,
      enquiry: {
        dated_at: dated, year: istYear(dated), client_name: q.client_name, contact_person: q.contact_person, sector: q.sector, country: q.country,
        service: q.service_quoted, estimated_value: q.quotation_value, currency: q.currency, status: 'Converted', quotation_no: q.quotation_no,
        converted_at: m.sent_at, source_id: otherSource, first_responded_at: m.sent_at,
        notes: `Quotation ${q.quotation_no} sent by email on ${sentOn} by ${account.email}; the enquiry itself did not come by email.`,
        owner_user_id: owner?.id ?? q.owner_user_id ?? null, sales_person: owner?.name ?? q.sales_person ?? null,
      },
    });
    await logDecision(db, account, cand, { outcome: 'created', ...decisionOf(verdict), enquiry_no: e.enquiry_no, quotation_no: q.quotation_no, thread_id: threadId });
    ctx.created.push({ ...e, owner_email: owner?.email || null, kind: 'quotation_sent' });
    return 'created';
  }

  // Not in the tracker: made in Word or Excel and emailed.
  const client = (await companyName(db, companyId)) || prepared?.extraction?.client?.company_name || verdict.company_name
    || companyNameFromEmail(recipient.email) || recipient.name || recipient.email;
  // Mail between our own people is read too (073): a "quotation" with no
  // client anywhere, on the PDF or among the recipients, makes nothing.
  if (!client) {
    await logDecision(db, account, cand, { outcome: 'not_enquiry', ...decisionOf(verdict) });
    ctx.notEnquiry += 1;
    return 'not_enquiry';
  }
  const { rows: [{ id: newCompanyId }] } = await db.query('SELECT company_for($1) AS id', [client]);
  const threadId = await keepDropped(db, account, cand, newCompanyId);
  const owner = await ownerFor(db, account, threadId);
  const base = {
    dated_at: m.sent_at, year: istYear(m.sent_at), client_name: client,
    contact_person: prepared?.extraction?.client?.contact_name || verdict.contact_name || recipient.name || null,
    service: verdict.service, sector: verdict.sector, country: verdict.country, source_id: otherSource, first_responded_at: m.sent_at,
    owner_user_id: owner?.id ?? null, sales_person: owner?.name ?? null,
  };

  if (prepared?.ok && deps.readQuotation?.create) {
    const made = await deps.readQuotation.create(db, { account, cand, prepared, client, owner, threadId });
    if (made.revised || made.repeated) {
      // A revision, or the same PDF again: the quotation already has its enquiry.
      const { rows: [has] } = await db.query('SELECT enquiry_no FROM enquiries WHERE quotation_no = $1', [made.quotation_no]);
      return linked(has?.enquiry_no || null, threadId, {
        quotation_no: made.quotation_no, quotation_extraction: made.revised ? 'revised' : null, ...made.printed,
      });
    }
    const e = await createEnquiryFromEmail(db, {
    keepRecordLink: true,
      threadId, fromEmail: recipient.email, fromName: recipient.name,
      enquiry: {
        ...base, status: 'Converted', quotation_no: made.quotation_no, converted_at: m.sent_at,
        estimated_value: made.total ?? null, currency: prepared.extraction.currency || 'INR',
        notes: `Quotation sent by email on ${sentOn} by ${account.email}; the enquiry itself did not come by email. The quotation was read from the PDF.`,
      },
    });
    await logDecision(db, account, cand, {
      outcome: 'created', ...decisionOf(verdict),
      enquiry_no: e.enquiry_no, quotation_no: made.quotation_no, quotation_extraction: 'created', thread_id: threadId, ...made.printed,
    });
    ctx.created.push({ ...e, owner_email: owner?.email || null, kind: 'quotation_sent' });
    return 'created';
  }

  // The PDF could not be trusted, or was not read: the enquiry still goes
  // in, and a person adds the quotation.
  const e = await createEnquiryFromEmail(db, {
    keepRecordLink: true,
    threadId, fromEmail: recipient.email, fromName: recipient.name,
    enquiry: {
      ...base, status: 'Contacted', estimated_value: verdict.quoted_amount ?? null, currency: verdict.currency || 'INR',
      notes: `Quotation sent by email on ${sentOn} by ${account.email}; the enquiry itself did not come by email. The quotation is not in the tracker yet.`,
    },
  });
  await addQuotationTask(db, { enquiryNo: e.enquiry_no, client, sentOn, account, threadId, assignee: owner?.name ?? null });
  await logDecision(db, account, cand, {
    outcome: 'created', ...decisionOf(verdict),
    enquiry_no: e.enquiry_no, quotation_extraction: 'failed', extraction_reason: prepared?.reason || 'no_pdf', thread_id: threadId,
  });
  ctx.created.push({ ...e, owner_email: owner?.email || null, kind: 'quotation_sent' });
  return 'created';
}

/** The owner adds by hand the quotation whose PDF could not be read. */
async function addQuotationTask(db, { enquiryNo, client, sentOn, account, threadId, assignee }) {
  const { rows: hol } = await db.query('SELECT holiday_on FROM holidays');
  await db.query(
    `INSERT INTO tasks (entity, entity_id, title, description, due_at, type, priority, assignee, created_by)
     VALUES ('enquiry', $1, $2, $3, $4, 'document', 'normal', $5, 'system')`,
    [enquiryNo, `Add the quotation sent to ${client} on ${sentOn}: the PDF could not be read`,
      `The quotation went by email from ${account.email}${threadId ? ` (email thread ${threadId})` : ''}. Enter it in the tracker and link it to this enquiry.`,
      addWorkingDays(businessToday(), 1, hol.map((h) => String(h.holiday_on).slice(0, 10))), assignee ?? null]);
}

/**
 * Read the quotation PDF we sent, before any transaction. Only when the
 * email names no tracker quotation; returns { ok, extraction, ... } or
 * { ok: false, reason }.
 */
async function prepareQuotation(account, cand, verdict, ctx) {
  const text = mainText(cand.m.body_html || '');
  const named = numbersIn(cand.m.subject, text).quotations;
  if (named.length) {
    const { rows: [q] } = await query('SELECT 1 FROM quotations WHERE quotation_no = ANY($1)', [named]);
    if (q) return null;
  }
  if (!deps.readQuotation?.prepare) return { ok: false, reason: 'no_pdf' };
  try {
    return await deps.readQuotation.prepare(account, cand, verdict, ctx, chatFn());
  } catch (err) {
    console.warn('[auto-enquiry] quotation PDF not read:', err.message);
    return { ok: false, reason: 'unreadable' };
  }
}

// ------------------------------------------------------------ past mail

/** How long one backfill run may read before it hands over to the next. */
export const BACKFILL_BUDGET_MS = 4 * 60_000;

/**
 * The candidates on one page of past mail. A message we already store uses
 * its stored thread; one we never stored (older than the mailbox's import
 * window, or dropped as not a client) is judged from the raw message.
 */
async function pastCandidates(account, judge, messages) {
  const out = [];
  for (const m of messages) {
    if (!m.provider_id || !m.conversation_id || m.draft) continue;
    const c = forReaders(judge(m), judge.readAll);
    if (!c) continue;
    const { rows: [stored] } = await query(
      `SELECT t.id AS thread_id,
              NOT EXISTS (SELECT 1 FROM email_messages o WHERE o.thread_id = t.id AND o.sent_at < $3 AND o.filtered_as IS NULL) AS first
         FROM email_threads t WHERE t.account_id = $1 AND t.conversation_id = $2`, [account.id, m.conversation_id, m.sent_at]);
    out.push(stored
      ? { m, c, threadId: stored.thread_id, newThread: stored.first, dropped: false }
      : { m, c, threadId: null, newThread: false, dropped: true });
  }
  return out;
}

/**
 * Read one mailbox's past mail, oldest first, for up to `budgetMs`: every
 * folder as one stream while reading everything (folder 'all', 073), else
 * Inbox before Sent Items. Resumable: progress is stored after every page,
 * so a restart or a stop at the day's AI ceiling loses nothing.
 */
export async function backfillAccount(account, ctx, { budgetMs = BACKFILL_BUDGET_MS } = {}) {
  const since = new Date(Date.now() - ctx.settings.backfillDays * 864e5).toISOString();
  const everyFolder = readsAllFolders(account, ctx.settings.readAll);
  await query(`INSERT INTO mailbox_enquiry_backfills (account_id, since, folder) VALUES ($1, $2, $3) ON CONFLICT (account_id) DO NOTHING`,
    [account.id, since, everyFolder ? 'all' : 'inbox']);
  // A read of every folder that is under way when the mailbox is held to
  // Inbox and Sent Items (read_scope, 074) starts again on Inbox: its
  // cursor points into the whole mailbox, and the owner's private folders
  // must not be read on. Nothing is made twice; the decisions stay.
  if (!everyFolder) {
    await query(`UPDATE mailbox_enquiry_backfills SET folder = 'inbox', next_link = NULL, reached = NULL WHERE account_id = $1 AND folder = 'all' AND finished_at IS NULL`, [account.id]);
  }
  let { rows: [row] } = await query('SELECT * FROM mailbox_enquiry_backfills WHERE account_id = $1', [account.id]);
  if (row.finished_at) return { id: account.id, finished: true, created: 0, linked: 0 };
  const started = Date.now();
  const tally = { id: account.id, email: account.email, pages: 0, created: 0, linked: 0 };
  let provider;
  try {
    provider = providerFor(account);
    if (!provider.page) throw new Error(`Reading past mail is not supported for ${account.provider} mailboxes`);
    const judge = await ingestRules(account);
    // At least one page per run, however little time is left.
    for (let first = true; first || (Date.now() - started < budgetMs && !ctx.stopped); first = false) {
      const page = await provider.page(row.folder, { sinceIso: new Date(row.since).toISOString(), cursor: row.next_link });
      const before = { created: ctx.created.length, linked: ctx.linked };
      await processCandidates(account, await pastCandidates(account, judge, page.messages), { ctx, notifyEach: false, provider, onSettled: queueFailures(account, 'enquiry') });
      const created = ctx.created.length - before.created; const linked = ctx.linked - before.linked;
      tally.pages += 1; tally.created += created; tally.linked += linked;
      // Stopped part-way through this page (the day's AI ceiling): read it
      // again next time. What was already decided is not judged twice.
      const last = page.messages.length ? page.messages[page.messages.length - 1].sent_at : row.reached;
      let next = { next_link: page.next, folder: row.folder, scanned: page.messages.length, reached: last, finished_at: null };
      if (ctx.stopped) next = { next_link: row.next_link, folder: row.folder, scanned: 0, reached: row.reached, finished_at: null };
      else if (!page.next && row.folder === 'inbox') next = { next_link: null, folder: 'sentitems', scanned: page.messages.length, reached: null, finished_at: null };
      else if (!page.next) next = { next_link: null, folder: null, scanned: page.messages.length, reached: last, finished_at: new Date().toISOString() };
      ({ rows: [row] } = await query(
        `UPDATE mailbox_enquiry_backfills
            SET next_link = $2, folder = $3, scanned = scanned + $4, created = created + $5, linked = linked + $6,
                reached = $7, finished_at = $8, last_error = NULL, updated_at = now()
          WHERE account_id = $1 RETURNING *`,
        [account.id, next.next_link, next.folder, next.scanned, created, linked, next.reached, next.finished_at]));
      // Re-run or a disconnect removed the row while this ran: stop here;
      // the next run starts afresh.
      if (!row) { tally.restarted = true; break; }
      if (row.finished_at) {
        // Kept on the mailbox, where a re-run does not clear it: the PO
        // reader goes by it (autoPurchaseOrder.js enquiriesReadUpTo).
        await query('UPDATE connected_accounts SET past_enquiries_read_at = $2 WHERE id = $1', [account.id, row.finished_at]);
        break;
      }
    }
    await saveTokens(account, provider);
  } catch (err) {
    await query('UPDATE mailbox_enquiry_backfills SET last_error = $2, updated_at = now() WHERE account_id = $1', [account.id, String(err.message).slice(0, 500)]);
    tally.error = err.message;
  }
  if (row?.finished_at) {
    tally.finished = true;
    await notify({
      kind: 'enquiry', title: `Read ${ctx.settings.backfillDays} days of ${account.email}: ${row.created} ${row.created === 1 ? 'enquiry' : 'enquiries'} created, ${row.linked} linked to existing ones`,
      link: '/enquiries?from_email=1', dedupeKey: `auto-enquiry-backfill:${account.id}:${new Date(row.started_at).toISOString()}`,
    }).catch(() => {});
  }
  return tally;
}

/** The scheduled sweep: every active mailbox whose past mail is not read yet. */
export async function runBackfills({ budgetMs = BACKFILL_BUDGET_MS } = {}) {
  const ctx = await runContext({ backfill: true });
  if (!ctx.settings.enabled) return { skipped: 'switched off', created: 0, errors: 0 };
  const { rows } = await query(
    `SELECT a.* FROM connected_accounts a LEFT JOIN mailbox_enquiry_backfills b ON b.account_id = a.id
      WHERE a.status = 'active' AND b.finished_at IS NULL ORDER BY a.id`);
  const started = Date.now();
  const results = [];
  for (const account of rows) {
    const left = budgetMs - (Date.now() - started);
    if (left <= 0 || ctx.stopped) break;
    results.push(await backfillAccount(account, ctx, { budgetMs: left }));
  }
  return {
    mailboxes: results.length, created: results.reduce((t, r) => t + r.created, 0), linked: results.reduce((t, r) => t + r.linked, 0),
    errors: results.filter((r) => r.error).length + ctx.errors, stopped: ctx.stopped, results,
  };
}
