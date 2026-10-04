/**
 * Purchase orders from email, automatically (docs/email-po-plan.md §3.1–3.7).
 *
 *   processPoCandidates(account, candidates)   read what a sync found
 *   decidePo(account, candidate, ctx)          one email, start to finish
 *   readPo(account, candidate, ctx)            the PDF (or the email), one AI call
 *   matchQuotation(db, ...)                    which quotation the PO is for
 *
 * An email is read once per mailbox, and the decision is logged in
 * email_po_decisions without any of its text. The order for one email:
 *
 *   1. already decided in this mailbox?                       → stop
 *   2. the same email already decided in another mailbox      → log linked, no AI
 *   3. poPrefilter (free rules)                               → stop, not logged
 *   4. read it: the PDF's text (or OCR, or the email), one AI call
 *   5. checkPo                                                → not_po, or review
 *   6. under a lock: the PO number already registered         → linked (PDF attached if missing)
 *   7. match a quotation (number, thread, company and value)  → review when unsure
 *   8. register it with registerPurchaseOrder(), live or history
 *
 * An AI or mailbox error leaves the email undecided, so a later run reads it
 * again. A failed check sends it to review, never to silence. AI calls are
 * made before any transaction opens.
 */
import { query, transaction } from '../../db.js';
import { aiConfig, chatJSON } from '../ai.js';
import { notify } from '../notify.js';
import { businessToday } from '../businessDate.ts';
import { documentStorageReady, uploadDocument } from '../documents.js';
import { claimNextId } from '../sequences.js';
import { registerPurchaseOrder } from '../purchaseOrders.js';
import { ApiError } from '../../middleware/error.js';
import { createEnquiryFromEmail } from './enquiryFromEmail.js';
import { companyNameFromEmail, mainText } from './enquiryDetect.js';
import { aiCallsToday, enquirySettings, keepDropped, ownerFor, processCandidates, runContext } from './autoEnquiry.js';
import { buildPoPrompt, isPortalSender, parsePoVerdict, poPrefilter } from './poDetect.js';
import { checkPo, grossUp, rankPoPdfs, stagesFromTerms } from './pdfPurchaseOrder.js';
import { near } from './pdfQuotation.js';
import { readWithAi } from './readAttachment.js';
import { fitsPattern, loadProfiles, pickProfile, profileNote } from './documentProfiles.js';
import { queueFailures } from './readerQueue.js';
import { ingestRules, matchParticipants, providerFor, readsAllFolders, saveTokens } from './sync.js';
import { forReaders, referencesIn } from './rules.js';
import { inLanes } from './inLanes.js';

/**
 * Replaceable in tests: `chat` stands in for the AI, `upload` for document
 * storage, so no test reaches the network.
 */
export const deps = { chat: null, upload: documentStorageReady ? uploadDocument : null };

const SETTING_KEYS = ['auto_po_enabled', 'auto_po_min_confidence', 'auto_po_value_tolerance_percent', 'auto_po_history_after_days',
  'auto_po_create_quotation_when_missing', 'po_portal_senders', 'company_gstin'];
const num = (v, fallback) => { const n = Number(v); return Number.isFinite(n) ? n : fallback; };
const on = (v) => String(v ?? 'true').trim().toLowerCase() !== 'false';

export async function poSettings(db = { query }) {
  const { rows } = await db.query('SELECT key, value FROM settings WHERE key = ANY($1)', [SETTING_KEYS]);
  const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const shared = await enquirySettings(db);
  return {
    enabled: on(s.auto_po_enabled),
    minConfidence: num(s.auto_po_min_confidence, 0.85),
    tolerancePercent: num(s.auto_po_value_tolerance_percent, 2),
    historyAfterDays: num(s.auto_po_history_after_days, 30),
    createQuotation: on(s.auto_po_create_quotation_when_missing),
    portalSenders: String(s.po_portal_senders || ''),
    ourGstin: String(s.company_gstin || '').trim() || null,
    // The same "us" and the same daily AI ceiling as phase 1.
    ourGstins: shared.ourGstins, partners: shared.partners, reviewOnly: shared.reviewOnly, autoClients: shared.autoClients,
    ourNames: shared.ourNames, internalDomains: shared.internalDomains, dailyAiLimit: shared.dailyAiLimit,
    concurrency: shared.concurrency, services: shared.services, readAll: shared.readAll,
  };
}

const chatFn = () => deps.chat || (aiConfig.enabled ? (system, user, opts) => chatJSON(system, user, { title: 'Cetizion Tracker email purchase orders', ...opts }) : null);

/** Can POs be read at all? Not without an AI: there is no rules-only way. */
export const poReaderCanRead = () => Boolean(chatFn());

export async function poRunContext({ backfill = false } = {}) {
  return { settings: await poSettings(), backfill, aiUsed: await aiCallsToday(), registered: [], review: [], linked: 0, notPo: 0, skipped: 0, errors: 0, stopped: null };
}

/**
 * Read each candidate a sync or the backfill found. Returns the tally, or
 * null when the feature is switched off. One email failing never stops the
 * rest, and never fails the sync that found it.
 */
export async function processPoCandidates(account, candidates, { ctx: given = null, provider = null, onSettled = null } = {}) {
  const ctx = given || await poRunContext();
  if (provider) ctx.provider = provider;
  if (!ctx.settings.enabled) return null;
  await inLanes(candidates, {
    concurrency: ctx.settings.concurrency,
    stopped: () => Boolean(ctx.stopped),
    each: async (cand) => {
      // Told for every email reached, so the reader queue (readerQueue.js)
      // can keep the ones that failed. One left unreached stays queued.
      let failure = null;
      if (cand.c?.direction === 'inbound') {
        try {
          await decidePo(account, cand, ctx);
        } catch (err) {
          failure = err;
          ctx.errors += 1;
          console.error('[auto-po]', account.email, cand.m?.provider_id, err.message);
        }
      }
      if (onSettled) await onSettled(cand, failure);
    },
  });
  await notifyReview(ctx);
  return given ? ctx : { registered: ctx.registered.length, review: ctx.review.length, linked: ctx.linked, not_po: ctx.notPo, errors: ctx.errors };
}

// ------------------------------------------------------------ the decision log

async function logDecision(db, account, cand, d) {
  const { m } = cand;
  // A retry's row is replaced by what the retry decided.
  if (cand.retrySince) await db.query(`DELETE FROM email_po_decisions WHERE account_id = $1 AND provider_id = $2 AND outcome = 'retry'`, [account.id, m.provider_id]);
  await db.query(
    `INSERT INTO email_po_decisions (account_id, provider_id, internet_message_id, conversation_id, thread_id, from_email, received_at,
                                     outcome, document_type, review_reason, mode, confidence, method, ai_calls, po_number, quotation_no,
                                     suggested_quotations, created_quotation, stages_source, retry_since, review_note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
     ON CONFLICT (account_id, provider_id) DO NOTHING`,
    [account.id, m.provider_id, m.internet_message_id || null, m.conversation_id || null, d.thread_id ?? cand.threadId ?? null,
      m.from?.email || null, m.sent_at || null, d.outcome, d.document_type || null, d.review_reason || null, d.mode || null,
      d.confidence ?? null, d.method || 'ai', d.ai_calls || 0, d.po_number || null, d.quotation_no || null,
      d.suggested?.length ? d.suggested : null, Boolean(d.created_quotation), d.stages_source || null, d.retry_since || null, d.review_note || null]);
}

const istDay = (iso) => new Date(new Date(iso).getTime() + 330 * 60_000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);
const istNoon = (d) => `${d}T12:00:00+05:30`;
const round2 = (n) => Math.round(n * 100) / 100;

// ------------------------------------------------------------ one email

export async function decidePo(account, cand, ctx) {
  const { m, c } = cand;
  if (!m.provider_id || c.direction !== 'inbound') return 'incomplete';
  // By id, or as the same email under another id (moved to another folder).
  const { rows: [seen] } = await query(
    `SELECT 1 FROM email_po_decisions WHERE account_id = $1 AND NOT (outcome = 'retry' AND $3)
        AND (provider_id = $2 OR ($4::text IS NOT NULL AND lower(internet_message_id) = lower($4)))`,
    [account.id, m.provider_id, Boolean(cand.retrySince), m.internet_message_id || null]);
  if (seen) return 'seen';

  // The same text the enquiry reader's prefilter reads (mainText's default
  // length), so the two always agree on which emails are PO candidates. The
  // prompt cuts it down for the AI.
  const text = mainText(m.body_html || (m.preview ? `<p>${m.preview}</p>` : ''));
  const input = { direction: 'inbound', subject: m.subject, text, from: m.from, attachments: m.attachments, has_attachments: m.has_attachments };
  // A retry was a candidate when it arrived; its stored copy may hold no text.
  const pf = cand.retrySince ? { candidate: true } : poPrefilter(input, { portalSenders: ctx.settings.portalSenders, readAll: ctx.settings.readAll });
  if (!pf.candidate) { ctx.skipped += 1; return 'skipped'; }

  // The same email, read in another mailbox: no second AI call.
  const elsewhere = await sameEmailElsewhere({ query }, m, account.id);
  if (elsewhere) return transaction((db) => joinElsewhere(db, account, cand, elsewhere, ctx));

  const chat = chatFn();
  // No AI: nothing is read, and the enquiry reader judges the email instead
  // (poReaderCanRead). There is no rules-only way to read a PO.
  if (!chat) { ctx.skipped += 1; return 'no_ai'; }
  if (ctx.aiUsed >= ctx.settings.dailyAiLimit) {
    // The backfill stops and reads the page again tomorrow; live mail is not
    // handed over twice, so it is kept for a retry.
    if (ctx.backfill && !cand.retrySince) { ctx.stopped = 'ai_limit'; return 'ai_limit'; }
    await keepForRetry(account, cand, 0);
    return 'retry';
  }

  ctx.profiles ??= await loadProfiles({ query }, 'po');
  const { rows: [thread] } = cand.threadId ? await query('SELECT company_id FROM email_threads WHERE id = $1', [cand.threadId]) : { rows: [] };
  const read = await readPo(account, cand, ctx, chat, text, { senderEmail: m.from?.email, companyId: thread?.company_id ?? null });
  if (read.error) {
    ctx.errors += 1;
    await keepForRetry(account, cand, 1);
    return 'retry';
  }
  const decision = { confidence: read.verdict?.confidence ?? null, document_type: read.verdict?.document_type ?? null, method: 'ai', ai_calls: read.ai_calls };
  if (read.unreadable) return review(account, cand, ctx, { ...decision, review_reason: 'unreadable' }, null);

  const checked = checkPo(read.verdict, {
    emailDate: m.sent_at, sourceText: read.sourceText, minConfidence: ctx.settings.minConfidence,
    ourNames: ctx.settings.ourNames, ourGstin: ctx.settings.ourGstin, ourGstins: ctx.settings.ourGstins, partners: ctx.settings.partners, internalDomains: ctx.settings.internalDomains,
  });
  if (!checked.ok && checked.reason === 'not_po') {
    await logDecision({ query }, account, cand, { ...decision, outcome: 'not_po' });
    ctx.notPo += 1;
    return 'not_po';
  }
  if (!checked.ok) {
    const suggested = await suggestions({ query }, checked.po, read.allText, cand);
    return review(account, cand, ctx, { ...decision, review_reason: checked.reason, suggested }, checked.po);
  }

  const po = checked.po;
  // A PO number not of the shape this client's numbers have: a misread, or not its PO (§6).
  if (!fitsPattern(cand.profile, po.po_number)) {
    const note = `${cand.profile.company_name}'s PO numbers match ${cand.profile.po_number_pattern}; this one reads ${po.po_number}.`;
    return review(account, cand, ctx, { ...decision, review_reason: 'po_number_pattern', review_note: note, suggested: [] }, po);
  }
  const mode = daysBetween(po.po_date, businessToday()) > ctx.settings.historyAfterDays ? 'history' : 'live';
  Object.assign(decision, { mode });
  // Stored before the transaction, because it is a network call; if the
  // transaction then attaches nothing, the daily purge removes the file.
  const documentId = await storePdf(read.pdf);

  try {
    return await transaction((db) => registerUnderLock(db, account, cand, ctx, { po, decision, documentId, allText: read.allText, flags: checked.flags }));
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    // Registration refused it after all (a PO typed in by hand meanwhile, a
    // quotation that gained a PO): a person decides.
    const reason = err.extra?.fields?.currency ? 'bad_currency' : 'no_match';
    const suggested = await suggestions({ query }, po, read.allText, cand);
    console.warn('[auto-po] registration refused:', err.message);
    return review(account, cand, ctx, { ...decision, review_reason: reason, suggested }, po);
  }
}

async function sameEmailElsewhere(db, m, accountId) {
  if (!m.internet_message_id) return null;
  const { rows: [d] } = await db.query(
    `SELECT outcome, po_number, quotation_no, document_type, confidence FROM email_po_decisions
      WHERE lower(internet_message_id) = lower($1) AND account_id <> $2 ORDER BY id LIMIT 1`, [m.internet_message_id, accountId]);
  return d || null;
}

/** This mailbox's copy of an email another mailbox already read: one PO, one review item. */
async function joinElsewhere(db, account, cand, elsewhere, ctx) {
  const outcome = elsewhere.outcome === 'not_po' ? 'not_po' : 'linked';
  await logDecision(db, account, cand, {
    outcome, method: 'rules', ai_calls: 0, po_number: elsewhere.po_number, quotation_no: elsewhere.quotation_no,
    document_type: elsewhere.document_type, confidence: elsewhere.confidence,
  });
  if (outcome === 'linked') {
    ctx.linked += 1;
    if (elsewhere.po_number) await linkThread(db, cand.threadId, elsewhere.po_number, elsewhere.quotation_no);
  } else ctx.notPo += 1;
  return outcome;
}

async function review(account, cand, ctx, d, po) {
  await logDecision({ query }, account, cand, { ...d, outcome: 'review' });
  ctx.review.push({ account, cand, reason: d.review_reason, po, suggested: d.suggested || [] });
  return 'review';
}

async function storePdf(pdf) {
  if (!pdf || !deps.upload) return null;
  try {
    const doc = await deps.upload({ buffer: pdf.content, fileName: pdf.name || 'purchase-order.pdf', contentType: 'application/pdf', owner: 'purchase-orders' });
    return doc.id;
  } catch (err) {
    console.warn('[auto-po] the PDF could not be stored:', err.message);
    return null;
  }
}

// ------------------------------------------------------------ reading

/**
 * The PO's text and the AI's reading of it. Returns
 *   { verdict, sourceText, allText, pdf, ai_calls }   read
 *   { unreadable: true, ai_calls }                     an encrypted or broken PDF
 *   { error }                                          try again later
 * sourceText is what amounts are checked against: the PDF's text, the
 * email's when the email is the order, or null for a scan.
 */
export async function readPo(account, cand, ctx, chat, emailText, facts = {}) {
  const { m } = cand;
  return readWithAi(account, cand, ctx, chat, {
    // A PO's schedule of rates is often its own PDF: the annexures go too.
    rank: rankPoPdfs, parse: parsePoVerdict, fileName: 'purchase-order.pdf', annexures: true,
    prompt: ({ pdfText }) => {
      // The client's document note, picked before the call: no extra AI call (§6). Kept for the PO-number check.
      cand.profile = pickProfile(ctx.profiles, { ...facts, text: pdfText });
      return buildPoPrompt({
        pdfText, emailSubject: m.subject, emailText, receivedAt: m.sent_at, from: m.from,
        services: ctx.settings.services, ourNames: ctx.settings.ourNames, ourGstin: ctx.settings.ourGstin,
        ourGstins: ctx.settings.ourGstins, partners: ctx.settings.partners, clientNotes: profileNote(cand.profile),
      });
    },
  });
}

// ------------------------------------------------------------ matching

const QUOTATION_COLUMNS = `q.id, q.quotation_no, q.company_id, q.client_name, q.total, q.subtotal, q.quotation_value, q.currency,
  q.owner_user_id, q.sales_person, q.sales_person_email, ps.type AS stage_type,
  EXISTS (SELECT 1 FROM purchase_orders p WHERE p.quotation_no = q.quotation_no) AS has_po,
  (SELECT gstin FROM companies c WHERE c.id = q.company_id) AS company_gstin`;
const OPEN = `ps.type IN ('open','paused')`;
const gstinOf = (v) => String(v || '').toUpperCase().replace(/[^0-9A-Z]/g, '') || null;

async function quotationsWhere(db, where, params) {
  const { rows } = await db.query(`SELECT ${QUOTATION_COLUMNS} FROM quotations q LEFT JOIN pipeline_stages ps ON ps.id = q.stage_id WHERE ${where} ORDER BY q.id`, params);
  return rows;
}

/** The buyer's company: by GSTIN, else the sender's contact or domain (or the thread's), else the name. */
export async function resolveCompany(db, po, cand) {
  const gstin = gstinOf(po.buyer?.gstin);
  if (gstin) {
    const { rows: [c] } = await db.query(`SELECT id, gstin FROM companies WHERE upper(regexp_replace(gstin, '[^0-9A-Za-z]', '', 'g')) = $1 ORDER BY id LIMIT 1`, [gstin]);
    if (c) return c;
  }
  if (cand.threadId) {
    const { rows: [t] } = await db.query('SELECT c.id, c.gstin FROM email_threads t JOIN companies c ON c.id = t.company_id WHERE t.id = $1', [cand.threadId]);
    if (t) return t;
  }
  const who = await matchParticipants(db, cand.c?.external || [], { autoCreate: false });
  if (who.company_id) return (await db.query('SELECT id, gstin FROM companies WHERE id = $1', [who.company_id])).rows[0];
  if (po.buyer?.company_name) {
    const { rows: [c] } = await db.query('SELECT id, gstin FROM companies WHERE name_key = name_key($1)', [po.buyer.company_name]);
    if (c) return c;
  }
  return null;
}

/**
 * Does the PO's value agree with the quotation's, like with like? The PO
 * total against the quotation total, its basic value against the subtotal,
 * or — with "GST extra" and no subtotal — the basic value grossed up.
 */
export function valueAgrees(po, q, tolerancePercent, lines = []) {
  const within = (a, b) => a > 0 && b > 0 && Math.abs(a - b) <= (tolerancePercent / 100) * b + 0.005;
  const qTotal = Number(q.total ?? q.quotation_value) || null;
  const qSub = Number(q.subtotal) || null;
  if (po.total_value && within(po.total_value, qTotal)) return true;
  if (po.basic_value && within(po.basic_value, qSub)) return true;
  if (!po.total_value && po.basic_value && !qSub && within(grossUp(po.basic_value, lines), qTotal)) return true;
  return false;
}

/**
 * Is the PO in the quotation's currency? A PO that prints none takes the
 * quotation's. The values are compared as numbers, so without this a USD
 * 12,000 PO "agreed" with an INR 12,000 quotation.
 */
export const sameCurrency = (po, q) => !po.currency || (q.currency || 'INR') === po.currency;

/**
 * The quotations this email's conversation is about: our quotation email in
 * it, or a thread put on a quotation because a subject in it names that
 * quotation. The sync also links a thread to the client's latest open deal
 * when nothing names one; that guess is not good enough to register money
 * against, so it does not count here.
 */
async function threadQuotations(db, cand) {
  const { m } = cand;
  if (!m.conversation_id) return [];
  const { rows: sent } = await db.query(
    `SELECT DISTINCT quotation_no FROM email_enquiry_decisions WHERE conversation_id = $1 AND quotation_no IS NOT NULL AND direction = 'outbound'`,
    [m.conversation_id]);
  const { rows: linked } = await db.query(
    `SELECT t.entity_id, array_remove(array_agg(DISTINCT msg.subject) || t.subject, NULL) AS subjects
       FROM email_threads t LEFT JOIN email_messages msg ON msg.thread_id = t.id
      WHERE t.conversation_id = $1 AND t.entity = 'quotation' GROUP BY t.id`, [m.conversation_id]);
  const named = linked.filter((t) => [...t.subjects, m.subject].some((sub) => referencesIn(sub).quotations.some((no) => no.toUpperCase() === String(t.entity_id).toUpperCase())));
  return [...new Set([...sent.map((r) => r.quotation_no), ...named.map((t) => t.entity_id)])];
}

/**
 * Which quotation a PO is for (§3.3). The first rule giving exactly one
 * wins: the quotation number on the PO, the thread, then the company and
 * the value. Returns
 *   { quotation, how }                 register against it
 *   { create: true }                   nothing on file: make the quotation
 *   { review, suggested }              a person decides
 */
export async function matchQuotation(db, { po, allText, cand, company, settings }) {
  const tol = settings.tolerancePercent;
  const linesOf = async (q) => (await db.query('SELECT amount, gst_rate FROM quotation_lines WHERE quotation_id = $1', [q.id])).rows;
  const consistent = async (q, how) => {
    if (q.has_po) return { review: 'no_match', suggested: [q.quotation_no] };
    const buyerGstin = gstinOf(po.buyer?.gstin);
    if ((company && q.company_id && q.company_id !== company.id) || (buyerGstin && gstinOf(q.company_gstin) && gstinOf(q.company_gstin) !== buyerGstin)) {
      return { review: 'company_mismatch', suggested: [q.quotation_no] };
    }
    if (!sameCurrency(po, q)) return { review: 'currency_mismatch', suggested: [q.quotation_no] };
    if (!valueAgrees(po, q, tol, await linesOf(q))) return { review: 'value_mismatch', suggested: [q.quotation_no] };
    return { quotation: q, how };
  };

  // 1. Our quotation number, printed on the PO or in the email.
  const refs = [...new Set([po.our_quotation_ref, ...referencesIn(allText).quotations].filter(Boolean).map((r) => String(r).trim().toUpperCase()))];
  if (refs.length) {
    const found = await quotationsWhere(db, 'upper(q.quotation_no) = ANY($1)', [refs]);
    if (found.length === 1) return consistent(found[0], 'number');
    if (found.length > 1) return { review: 'several_matches', suggested: found.map((q) => q.quotation_no) };
  }

  // 2. The thread.
  const inThread = await threadQuotations(db, cand);
  if (inThread.length) {
    const found = await quotationsWhere(db, 'q.quotation_no = ANY($1)', [inThread]);
    if (found.length === 1) return consistent(found[0], 'thread');
    if (found.length > 1) {
      const open = found.filter((q) => !q.has_po);
      if (open.length === 1) return consistent(open[0], 'thread');
    }
  }

  // 3. The company's open quotations without a PO, by value.
  if (company) {
    const open = await quotationsWhere(db, `q.company_id = $1 AND ${OPEN} AND NOT EXISTS (SELECT 1 FROM purchase_orders p WHERE p.quotation_no = q.quotation_no)`, [company.id]);
    if (open.length) {
      const agreeing = [];
      for (const q of open) if (sameCurrency(po, q) && valueAgrees(po, q, tol, await linesOf(q))) agreeing.push(q);
      if (agreeing.length === 1) return { quotation: agreeing[0], how: 'company' };
      return { review: agreeing.length ? 'several_matches' : 'no_match', suggested: (agreeing.length ? agreeing : open).map((q) => q.quotation_no) };
    }
  }
  return settings.createQuotation ? { create: true } : { review: 'no_match', suggested: [] };
}

/** Quotations a reviewer is offered, best effort: the rules above, without registering anything. */
async function suggestions(db, po, allText, cand) {
  try {
    const company = po ? await resolveCompany(db, po, cand) : null;
    const m = po ? await matchQuotation(db, { po, allText, cand, company, settings: { tolerancePercent: 100, createQuotation: false } }) : null;
    return m?.quotation ? [m.quotation.quotation_no] : (m?.suggested || []);
  } catch {
    return [];
  }
}

// ------------------------------------------------------------ registering

async function registerUnderLock(db, account, cand, ctx, { po, decision, documentId, allText, flags }) {
  const { m } = cand;
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`auto-po-msg:${m.internet_message_id || m.provider_id}`]);
  const company = await resolveCompany(db, po, cand);
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`auto-po:${po.po_number_norm}:${company?.id ?? ''}`]);
  const { rows: [again] } = await db.query(
    `SELECT 1 FROM email_po_decisions WHERE account_id = $1 AND provider_id = $2 AND outcome <> 'retry'`, [account.id, m.provider_id]);
  if (again) return 'seen';
  const meanwhile = await sameEmailElsewhere(db, m, account.id);
  if (meanwhile) return joinElsewhere(db, account, cand, meanwhile, ctx);

  // ---- the PO number is already registered: by hand, by import, or from email
  const { rows: same } = await db.query(
    `SELECT po.po_number, po.quotation_no, po.document_id, p.company_id FROM purchase_orders po LEFT JOIN projects p ON p.project_id = po.project_id
      WHERE lower(regexp_replace(po.po_number, '[^a-zA-Z0-9]', '', 'g')) = $1`, [po.po_number_norm]);
  if (same.length) {
    // The same client's PO, provably: the buyer is known and is that PO's
    // client, or this conversation is already on that PO. An unknown buyer
    // (or a PO whose project names no client) used to match any of them,
    // and a new client's PO was linked to — and its PDF attached to —
    // another client's PO with the same number.
    const { rows: [t] } = cand.threadId
      ? await db.query(`SELECT entity_id FROM email_threads WHERE id = $1 AND entity = 'purchase_order'`, [cand.threadId])
      : { rows: [] };
    const ours = same.find((s) => (company && s.company_id === company.id) || (t && t.entity_id === s.po_number));
    if (!ours) {
      // The same number on another client's PO: SAP numbers repeat across companies.
      await logDecision(db, account, cand, { ...decision, outcome: 'review', review_reason: 'company_mismatch', suggested: same.map((s) => s.quotation_no).filter(Boolean) });
      ctx.review.push({ account, cand, reason: 'company_mismatch', po, suggested: [] });
      return 'review';
    }
    // The same number with other values is an amendment, whether or not it
    // says so (Dasami's work order DL26SW060-1132): a person compares them.
    // The same values: the same PO again.
    const changed = await changedFrom(db, ours.po_number, po);
    if (changed) {
      await logDecision(db, account, cand, { ...decision, outcome: 'review', review_reason: 'amendment', po_number: ours.po_number, quotation_no: ours.quotation_no, review_note: changed });
      ctx.review.push({ account, cand, reason: 'amendment', po, suggested: [], note: changed });
      return 'review';
    }
    if (!ours.document_id && documentId) {
      await db.query(`UPDATE purchase_orders SET document_id = $2 WHERE po_number = $1 AND document_id IS NULL AND EXISTS (SELECT 1 FROM documents WHERE id = $2)`, [ours.po_number, documentId]);
    }
    await linkThread(db, cand.threadId, ours.po_number, ours.quotation_no);
    await logDecision(db, account, cand, { ...decision, outcome: 'linked', po_number: ours.po_number, quotation_no: ours.quotation_no });
    ctx.linked += 1;
    return 'linked';
  }

  // ---- which quotation
  const match = await matchQuotation(db, { po, allText, cand, company, settings: ctx.settings });
  if (match.review) {
    await logDecision(db, account, cand, { ...decision, outcome: 'review', review_reason: match.review, suggested: match.suggested });
    ctx.review.push({ account, cand, reason: match.review, po, suggested: match.suggested });
    return 'review';
  }

  // The rollout (§7): read and checked, then held for a person, saying what would have been done; a client turned back on registers.
  if (heldForReview(ctx.settings, match.quotation?.client_name || po.buyer?.company_name)) {
    const note = `Read and checked: it would be registered against ${match.quotation ? match.quotation.quotation_no : 'a quotation made from it'}. The PO reader is review-only while its new prompts are checked.`;
    await logDecision(db, account, cand, { ...decision, outcome: 'review', review_reason: 'review_only', suggested: match.quotation ? [match.quotation.quotation_no] : [], review_note: note });
    ctx.review.push({ account, cand, reason: 'review_only', po, suggested: [], note });
    return 'review';
  }

  if (match.create && !po.currency) {
    // Nothing to take the currency from but the buyer: a GST registration
    // means an Indian client, billed in INR. Otherwise a person says.
    if (!gstinOf(po.buyer?.gstin) && !gstinOf(company?.gstin)) {
      await logDecision(db, account, cand, { ...decision, outcome: 'review', review_reason: 'no_currency', suggested: [] });
      ctx.review.push({ account, cand, reason: 'no_currency', po, suggested: [] });
      return 'review';
    }
    po.currency = 'INR';
  }

  let quotation = match.quotation;
  let threadId = cand.threadId;
  let created = false;
  // A past PO is not news to n8n: quiet before anything is written, the
  // enquiry and quotation made from it included (registerPurchaseOrder
  // sets the same again).
  if (decision.mode === 'history') await db.query(`SELECT set_config('app.suppress_webhooks', 'on', true)`);
  if (match.create) {
    ({ quotation, threadId } = await quotationFromPo(db, account, cand, po, company));
    created = true;
  } else if (!threadId) {
    threadId = await keepDropped(db, account, cand, quotation.company_id);
  }

  // ---- the value, the stages and what the PO itself said
  const { rows: qLines } = await db.query('SELECT amount, gst_rate FROM quotation_lines WHERE quotation_id = $1', [quotation.id]);
  const grossed = !po.total_value;
  const poValue = grossed ? grossUp(po.basic_value, qLines) : po.total_value;
  const terms = stagesFromTerms(po.payment_terms_text);
  const day = istDay(m.sent_at);
  const remarks = [
    `Registered automatically from the purchase order emailed by ${m.from?.email || 'the client'} on ${day}.`,
    grossed ? `Value grossed up for GST; the PO states basic ${po.basic_value}.` : null,
    po.payment_terms_text && terms.source === 'template' ? `Payment stages are the default; the PO says: ${po.payment_terms_text}` : null,
    po.payment_terms_text && terms.source === 'po_terms' ? `Payment terms on the PO: ${po.payment_terms_text}` : null,
    flags.includes('po_date_from_email') ? 'The PO date was not readable; the email date is used.' : null,
    po.partner_name ? `Addressed to our partner ${po.partner_name}${po.addressed_gstin ? ` (GSTIN ${po.addressed_gstin})` : ''}.` : null,
    // Whose reference is whose (docs/email-po-invoice-prompt-plan.md §3): the client's own number, and charges outside the value.
    po.client_reference ? `The client's reference: ${po.client_reference}.` : null,
    po.remarks ? `The PO also says: ${po.remarks}` : null,
  ].filter(Boolean).join(' ');

  const data = await registerPurchaseOrder(db, {
    quotation: quotation.quotation_no, po_number: po.po_number, po_date: po.po_date, po_value: poValue, currency: po.currency || quotation.currency || undefined,
    payment_terms_days: po.credit_days, document_id: documentId ?? undefined,
    addressed_gstin: po.addressed_gstin ?? undefined, partner_name: po.partner_name ?? undefined,
    project_manager: po.project_manager?.name ?? undefined, project_manager_email: po.project_manager?.email ?? undefined,
    planned_delivery_date: po.delivery_date && po.delivery_date >= po.po_date ? po.delivery_date : undefined,
    stages: terms.source === 'po_terms' ? terms.stages : undefined,
    remarks,
  }, { mode: decision.mode });

  await linkThread(db, threadId, data.po_number, quotation.quotation_no);
  await logDecision(db, account, cand, {
    ...decision, outcome: 'registered', po_number: data.po_number, quotation_no: quotation.quotation_no, thread_id: threadId,
    created_quotation: created, stages_source: data.stages.length ? (terms.source === 'po_terms' ? 'po_terms' : 'template') : 'none',
  });
  ctx.registered.push({ ...data, mode: decision.mode, how: match.how || 'created' });
  return 'registered';
}

const nameKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\b(pvt|private|ltd|limited|llp|inc)\b/g, ' ').replace(/\s+/g, ' ').trim();

/** While the readers are review-only (§7): whether this client's document waits for a person, or is one turned back on. */
export function heldForReview(settings, clientName) {
  if (!settings.reviewOnly) return false;
  const k = nameKey(clientName);
  return !(k && (settings.autoClients || []).some((n) => nameKey(n) === k));
}

const inr = (v, currency) => `${currency || 'INR'} ${Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const lineCount = (n) => `${n} line${n === 1 ? '' : 's'}`;
const shares = (values) => { const t = values.reduce((n, v) => n + v, 0); return values.map((v) => (t ? v / t : 0)).sort((a, b) => a - b); };

/**
 * How a PO read again differs from the one registered under its number, as
 * one line of figures for the reviewer, or null when it does not: its value
 * (with GST, or before it for a PO registered without), and the number and
 * split of its lines when the registered lines came from the PO itself.
 */
export async function changedFrom(db, poNumber, po) {
  const { rows: [r] } = await db.query(
    `SELECT po.po_value::float8 AS po_value, po.currency,
            (SELECT array_agg(s.service_value::float8) FROM po_services s WHERE s.po_number = po.po_number) AS values,
            EXISTS (SELECT 1 FROM email_po_decisions d WHERE d.po_number = po.po_number AND d.outcome = 'registered' AND d.created_quotation) AS lines_from_po
       FROM purchase_orders po WHERE po.po_number = $1`, [poNumber]);
  if (!r) return null;
  const value = po.total_value ?? (po.basic_value !== null ? grossUp(po.basic_value) : null);
  const valueDiffers = value !== null && !near(r.po_value, value) && !(po.basic_value !== null && near(r.po_value, po.basic_value));
  const had = (r.values || []).filter((v) => v !== null);
  const lines = po.linesOk && r.lines_from_po ? po.lines.map((l) => Number(l.amount)) : null;
  const linesDiffer = Boolean(lines) && (lines.length !== had.length || shares(lines).some((s, i) => Math.abs(s - shares(had)[i]) > 0.005));
  if (!valueDiffers && !linesDiffer) return null;
  return `Registered: ${inr(r.po_value, r.currency)}${lines ? `, ${lineCount(had.length)}` : ''}. This email: ${inr(value ?? po.basic_value, po.currency || r.currency)}${lines ? `, ${lineCount(lines.length)}` : ''}.`;
}

/**
 * Put the thread on the PO, unless it is on another record because its
 * subject names that record: the automatic path never takes a thread off a
 * record it was put on by number.
 */
export async function linkThread(db, threadId, poNumber, quotationNo) {
  if (!threadId || !poNumber) return;
  const { rows: [t] } = await db.query('SELECT entity, entity_id, subject FROM email_threads WHERE id = $1', [threadId]);
  if (!t) return;
  const elsewhere = t.entity && t.entity_id !== poNumber && t.entity_id !== quotationNo;
  if (elsewhere && t.entity !== 'enquiry') {
    const r = referencesIn(t.subject);
    const named = [...r.quotations, ...r.enquiries, ...r.pos].some((n) => n.toUpperCase() === String(t.entity_id).toUpperCase());
    if (named || t.entity === 'project') return;
  }
  await db.query(`UPDATE email_threads SET entity = 'purchase_order', entity_id = $2 WHERE id = $1`, [threadId, poNumber]);
}

/**
 * No quotation on file (§3.3, decision 1): the quotation is made from the
 * PO, with its lines or one line for its value, and an enquiry converted to
 * it, so the reports count the work. registerPurchaseOrder then wins it.
 */
async function quotationFromPo(db, account, cand, po, company) {
  const { m } = cand;
  // The company already found (by GSTIN, thread or contact) by its own
  // name: the quotation's trigger files it under company_for(client_name),
  // and the PO's spelling ("TATA STEEL LIMITED" for "Tata Steel Ltd")
  // made a second company.
  const client = (company ? (await db.query('SELECT name FROM companies WHERE id = $1', [company.id])).rows[0]?.name : null)
    || po.buyer?.company_name || companyNameFromEmail(m.from?.email) || m.from?.name || m.from?.email;
  const companyId = company?.id ?? (await db.query('SELECT company_for($1) AS id', [client])).rows[0].id;
  if (po.buyer?.gstin && companyId) await db.query(`UPDATE companies SET gstin = $2 WHERE id = $1 AND NULLIF(btrim(gstin), '') IS NULL`, [companyId, po.buyer.gstin]);
  const threadId = await keepDropped(db, account, cand, companyId);
  const owner = await ownerFor(db, account, threadId);
  const day = istDay(m.sent_at);

  // The tax rate the PO implies, else 18%; the lines carry the PO's own split.
  const basic = po.basic_value ?? (po.tax_value !== null && po.total_value ? round2(po.total_value - po.tax_value) : round2(po.total_value / 1.18));
  const tax = po.tax_value ?? (po.gst_extra ? null : (po.total_value ? round2(po.total_value - basic) : null));
  const gstRate = basic > 0 && tax !== null ? Math.round((tax / basic) * 10000) / 100 : 18;
  // The lines carry the basic value. Lines that add up to the total
  // instead (a PO printing no basic value) are scaled down to it, or the
  // tax would be added twice.
  const lineSum = po.linesOk ? po.lines.reduce((n, l) => n + Number(l.amount), 0) : 0;
  const scale = lineSum > 0 ? basic / lineSum : 1;
  const lines = po.linesOk
    ? po.lines.map((l) => ({ description: l.description, rate: round2(Number(l.amount) * scale), service: l.service }))
    : [{ description: 'As per purchase order', rate: basic, service: null }];
  if (po.linesOk && lines.length) {
    // Rounding leaves a paisa or two; it belongs on the last line.
    const residual = round2(basic - lines.reduce((n, l) => n + l.rate, 0));
    lines[lines.length - 1].rate = round2(lines[lines.length - 1].rate + residual);
  }
  const services = [...new Set(po.lines.map((l) => l.service).filter(Boolean))].join(', ') || null;

  const no = await claimNextId('quotation', db, po.po_date.slice(0, 4));
  const { rows: [q] } = await db.query(
    `INSERT INTO quotations (quotation_no, client_name, contact_person, quotation_date, currency, status, service_quoted,
                             owner_user_id, sales_person, remarks)
     VALUES ($1,$2,$3,$4,$5,'Submitted',$6,$7,$8,$9) RETURNING id, quotation_no, company_id`,
    [no, client, po.buyer?.contact_name ?? null, po.po_date, po.currency, services,
      owner?.id ?? null, owner?.name ?? null,
      `Created from the purchase order ${po.po_number} emailed by ${m.from?.email || 'the client'} on ${day}: no quotation for it was on file.`]);
  for (const [i, l] of lines.entries()) {
    await db.query(
      `INSERT INTO quotation_lines (quotation_id, description, qty, rate, discount_percent, gst_rate, sort_order) VALUES ($1,$2,1,$3,0,$4,$5)`,
      [q.id, l.description, l.rate, gstRate, i]);
  }

  // An earlier PO from them makes this repeat business.
  const { rows: [earlier] } = await db.query(
    'SELECT 1 FROM purchase_orders po JOIN projects p ON p.project_id = po.project_id WHERE p.company_id = $1 LIMIT 1', [q.company_id ?? companyId]);
  const { rows: [src] } = await db.query('SELECT id FROM lead_sources WHERE name = $1', [earlier ? 'Existing client' : 'Other']);
  await createEnquiryFromEmail(db, {
    threadId, fromEmail: m.from?.email || null, fromName: m.from?.name || null, keepRecordLink: true,
    enquiry: {
      dated_at: istNoon(po.po_date), year: po.po_date.slice(0, 4), client_name: client, contact_person: po.buyer?.contact_name ?? null,
      service: services, status: 'Converted', quotation_no: q.quotation_no, converted_at: istNoon(po.po_date), source_id: src?.id ?? null,
      estimated_value: po.total_value ?? null, currency: po.currency, first_responded_at: istNoon(po.po_date),
      notes: `Purchase order ${po.po_number} emailed on ${day} to ${account.email}; neither the enquiry nor the quotation was in the tracker.`,
      owner_user_id: owner?.id ?? null, sales_person: owner?.name ?? null,
    },
  });
  const [quotation] = await quotationsWhere(db, 'q.id = $1', [q.id]);
  return { quotation, threadId };
}

// ------------------------------------------------------------ telling people

/**
 * One notification per review item, to the suggested quotation's owner, or
 * to everyone who handles POs when nobody owns it. The backfill sends one
 * summary per mailbox instead (step 4).
 */
async function notifyReview(ctx) {
  if (ctx.backfill) return;
  const WHY = {
    review_only: 'it was read and checked, and waits for a person while the reader is review-only', no_match: 'no quotation matches it', several_matches: 'more than one quotation could be it', not_to_us: 'it is not addressed to us',
    low_confidence: 'it could not be read with confidence', no_po_number: 'it has no PO number', value_mismatch: 'its value differs from the quotation',
    company_mismatch: 'its client differs from the quotation\'s', amendment: 'it amends an earlier PO', cancellation: 'it cancels a PO',
    multiple_pos: 'it holds more than one PO', unreadable: 'its PDF could not be opened', no_value: 'no value could be read',
    amounts_not_in_pdf: 'its amounts could not be confirmed in the PDF', totals_do_not_add_up: 'its totals do not add up', bad_currency: 'its currency is not one the tracker uses',
    currency_mismatch: 'its currency differs from the quotation\'s', no_currency: 'its currency could not be read',
  };
  for (const r of ctx.review) {
    let owner = null;
    if (r.suggested[0]) {
      const { rows: [q] } = await query(
        'SELECT COALESCE(u.email, q.sales_person_email, q.sales_person) AS who FROM quotations q LEFT JOIN users u ON u.id = q.owner_user_id WHERE q.quotation_no = $1', [r.suggested[0]]);
      owner = q?.who || null;
    }
    const what = r.po?.po_number ? `PO ${r.po.po_number}` : 'A purchase order';
    const from = r.po?.buyer?.company_name || r.cand.m.from?.email || 'a client';
    const amended = r.reason === 'amendment' ? ` (amendment${r.po?.amendment_no ? ` ${r.po.amendment_no}` : ''}${r.po?.total_value ? `, now ${r.po.currency || ''} ${r.po.total_value}` : ''})` : '';
    await notify({
      username: owner, kind: 'po_review',
      title: `${what} from ${from} needs a look${amended}`,
      body: `Not registered automatically: ${WHY[r.reason] || r.reason}. Received by ${r.account.email}.`,
      entity: r.suggested[0] ? 'quotation' : null, entityId: r.suggested[0] || null, link: '/purchase-orders?tab=review',
      dedupeKey: `po-review:${r.account.id}:${r.cand.m.provider_id}`,
    }).catch(() => {});
  }
}

/**
 * A PO registered automatically from email: when, from whom, in which mode,
 * and whether a person has checked it since (an event in the activity
 * log). Null for a PO typed in by hand. The PO page's banner reads it.
 */
export async function poFromEmail(poNumber, db = { query }) {
  const { rows: [d] } = await db.query(
    `SELECT d.received_at, d.from_email, d.thread_id, d.mode, d.stages_source, d.created_quotation, a.email AS mailbox,
            EXISTS (SELECT 1 FROM activity_log l WHERE l.action = 'purchase_order.email_read_checked' AND l.entity_type = 'purchase_order'
                     AND l.entity_id = d.po_number AND l.created_at >= d.decided_at) AS checked
       FROM email_po_decisions d JOIN connected_accounts a ON a.id = d.account_id
      WHERE d.po_number = $1 AND d.outcome = 'registered' ORDER BY d.decided_at, d.id LIMIT 1`, [poNumber]);
  return d || null;
}

/** Did the PO reader decide this email is not a PO? The enquiry reader then judges it as any other. */
export async function decidedNotPo(db, accountId, providerId) {
  const { rows: [d] } = await db.query(
    `SELECT 1 FROM email_po_decisions WHERE account_id = $1 AND provider_id = $2 AND outcome IN ('not_po','dismissed')`, [accountId, providerId]);
  return Boolean(d);
}


// ------------------------------------------------------------ retries

/**
 * Live mail the AI could not read — an error, or the day's ceiling — is
 * kept, by its ids only, for pos.backfill to read again. Without this it was
 * lost: live mail is handed over once, and the enquiry reader holds PO mail
 * back for the PO reader.
 */
async function keepForRetry(account, cand, aiCalls) {
  if (cand.retrySince) {
    // Still unreadable: the AI calls are counted; the clock keeps its start.
    if (aiCalls) await query(`UPDATE email_po_decisions SET ai_calls = ai_calls + $3 WHERE account_id = $1 AND provider_id = $2 AND outcome = 'retry'`, [account.id, cand.m.provider_id, aiCalls]);
    return;
  }
  await logDecision({ query }, account, cand, { outcome: 'retry', method: 'ai', ai_calls: aiCalls, retry_since: new Date().toISOString() });
}

/**
 * Read the kept emails again; after a week, a person decides (review,
 * 'unreadable'). The message is rebuilt from what the tracker stores; the
 * PDF comes from the mailbox.
 */
export async function retryPoReads(ctx, { limit = 100 } = {}) {
  await query(
    `UPDATE email_po_decisions SET outcome = 'review', review_reason = 'unreadable'
      WHERE outcome = 'retry' AND retry_since < now() - interval '7 days'`);
  const { rows } = await query(
    `SELECT d.*, m.subject, m.body_html, m.has_attachments, m.from_name FROM email_po_decisions d
       JOIN connected_accounts a ON a.id = d.account_id AND a.status = 'active'
       LEFT JOIN email_messages m ON m.account_id = d.account_id AND m.provider_id = d.provider_id
      WHERE d.outcome = 'retry' ORDER BY d.retry_since LIMIT $1`, [limit]);
  const tally = { retried: 0, registered: 0, review: 0 };
  for (const d of rows) {
    if (ctx.aiUsed >= ctx.settings.dailyAiLimit) break;
    const { rows: [account] } = await query('SELECT * FROM connected_accounts WHERE id = $1', [d.account_id]);
    const cand = {
      m: { provider_id: d.provider_id, internet_message_id: d.internet_message_id, conversation_id: d.conversation_id, sent_at: d.received_at,
        subject: d.subject, body_html: d.body_html, has_attachments: d.has_attachments ?? true, from: { email: d.from_email, name: d.from_name } },
      c: { direction: 'inbound', external: d.from_email ? [{ email: d.from_email, name: d.from_name }] : [] },
      threadId: d.thread_id, retrySince: d.retry_since,
    };
    const before = { registered: ctx.registered.length, review: ctx.review.length };
    tally.retried += 1;
    try {
      await decidePo(account, cand, ctx);
    } catch (err) {
      ctx.errors += 1;
      console.error('[auto-po] retry', d.id, err.message);
    }
    tally.registered += ctx.registered.length - before.registered;
    tally.review += ctx.review.length - before.review;
  }
  return tally;
}

// ------------------------------------------------------------ past mail (§3.9)

/** How long one backfill run may read before it hands over to the next: the same as phase 1's. */
export const PO_BACKFILL_BUDGET_MS = 4 * 60_000;

/**
 * The PO candidates on one page of past Inbox mail: every inbound message,
 * replies included. A message we already store uses its stored thread; one
 * we never stored is read from the raw message. A procurement portal's
 * notification counts even when the blocklist drops it.
 */
async function pastPoCandidates(account, judge, messages, portals) {
  const out = [];
  for (const m of messages) {
    if (!m.provider_id || !m.conversation_id || m.draft) continue;
    const judged = judge(m);
    let c = forReaders(judged, judge.readAll) || judged;
    if (c.skip === 'blocked sender' && isPortalSender(m.from?.email, portals)) c = { ...c, skip: null, direction: 'inbound', external: [m.from] };
    if (c.skip || c.direction !== 'inbound') continue;
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
 * Hand the emails this pass decided are not POs to the enquiry reader. Its
 * backfill ran first and left them alone while the PO reader was on
 * (enquiryDetect.prefilter); now they are judged like any other email.
 */
async function enquiriesFromNotPo(account, cands, enquiryCtx, provider) {
  if (!cands.length) return;
  const { rows } = await query(
    `SELECT provider_id FROM email_po_decisions WHERE account_id = $1 AND provider_id = ANY($2) AND outcome = 'not_po'`,
    [account.id, cands.map((c) => c.m.provider_id)]);
  const notPo = new Set(rows.map((r) => r.provider_id));
  const handBack = cands.filter((c) => notPo.has(c.m.provider_id) && (enquiryCtx.settings.readAll || c.newThread || c.dropped));
  if (handBack.length) await processCandidates(account, handBack, { ctx: enquiryCtx, notifyEach: false, provider });
}

/**
 * How far into this mailbox's past the PO reader may go: the enquiries and
 * quotations a PO looks for must be there first (§3.9). `true` once its
 * past mail has been read through for enquiries — a re-run reading it
 * again does not undo that, since what it made stays. Otherwise the date
 * the enquiry reader has reached in Sent Items, where the quotations we
 * sent are read, after the whole Inbox. Null while it is still on the
 * Inbox: a PO read then could find no quotation and make one. Reading the
 * whole mailbox as one stream (folder 'all'), the date it has reached is
 * how far everything, quotations included, has been read.
 */
export async function enquiriesReadUpTo(accountId) {
  const { rows: [r] } = await query(
    `SELECT a.past_enquiries_read_at, e.finished_at, e.folder, e.reached
       FROM connected_accounts a LEFT JOIN mailbox_enquiry_backfills e ON e.account_id = a.id WHERE a.id = $1`, [accountId]);
  if (r?.past_enquiries_read_at || r?.finished_at) return true;
  return ['sentitems', 'all'].includes(r?.folder) && r.reached ? new Date(r.reached) : null;
}

/**
 * Read one mailbox's past Inbox for POs, oldest first, for up to
 * `budgetMs`. Resumable: progress is stored after every page, so a restart
 * or a stop at the day's AI ceiling loses nothing. It reads only as far as
 * the enquiry reader has got (enquiriesReadUpTo), and waits there for it.
 */
export async function backfillPoAccount(account, ctx, { budgetMs = PO_BACKFILL_BUDGET_MS, enquiryCtx = null } = {}) {
  const upTo = await enquiriesReadUpTo(account.id);
  if (!upTo) return { id: account.id, waiting: 'enquiry backfill', registered: 0, review: 0 };
  const days = (await enquirySettings()).backfillDays;
  const since = new Date(Date.now() - days * 864e5).toISOString();
  await query(`INSERT INTO mailbox_po_backfills (account_id, since) VALUES ($1, $2) ON CONFLICT (account_id) DO NOTHING`, [account.id, since]);
  let { rows: [row] } = await query('SELECT * FROM mailbox_po_backfills WHERE account_id = $1', [account.id]);
  if (row.finished_at) return { id: account.id, finished: true, registered: 0, review: 0 };
  const beyondUpTo = (date) => upTo !== true && date && new Date(date) > upTo;
  // Caught up with the enquiry reader: nothing to fetch until it moves on.
  if (upTo !== true && row.reached && new Date(row.reached) >= upTo) return { id: account.id, waiting: 'enquiry backfill', registered: 0, review: 0 };
  const started = Date.now();
  const tally = { id: account.id, email: account.email, pages: 0, registered: 0, review: 0 };
  let provider;
  try {
    provider = providerFor(account);
    if (!provider.page) throw new Error(`Reading past mail is not supported for ${account.provider} mailboxes`);
    const judge = await ingestRules(account);
    const eCtx = enquiryCtx || await runContext({ backfill: true });
    for (let first = true; first || (Date.now() - started < budgetMs && !ctx.stopped); first = false) {
      // Every folder while reading everything (073); pastPoCandidates keeps the inbound mail.
      const page = await provider.page(readsAllFolders(account, ctx.settings.readAll) ? 'all' : 'inbox', { sinceIso: new Date(row.since).toISOString(), cursor: row.next_link });
      // A page that runs past where the enquiry reader has got is left for
      // a later run: the cursor stays, so it is fetched again then.
      if (page.messages.length && beyondUpTo(page.messages[page.messages.length - 1].sent_at)) {
        tally.waiting = 'enquiry backfill';
        break;
      }
      const cands = await pastPoCandidates(account, judge, page.messages, ctx.settings.portalSenders);
      const before = { registered: ctx.registered.length, review: ctx.review.length };
      await processPoCandidates(account, cands, { ctx, provider, onSettled: queueFailures(account, 'po') });
      // The enquiry reader shares the day's AI ceiling: what this pass used counts.
      eCtx.aiUsed = Math.max(eCtx.aiUsed, ctx.aiUsed);
      await enquiriesFromNotPo(account, cands, eCtx, provider);
      ctx.aiUsed = Math.max(ctx.aiUsed, eCtx.aiUsed);
      const registered = ctx.registered.length - before.registered; const review = ctx.review.length - before.review;
      tally.pages += 1; tally.registered += registered; tally.review += review;
      // Stopped part-way through this page (the day's AI ceiling): read it
      // again next time. What was already decided is not read twice.
      const last = page.messages.length ? page.messages[page.messages.length - 1].sent_at : row.reached;
      const next = ctx.stopped
        ? { next_link: row.next_link, scanned: 0, reached: row.reached, finished_at: null }
        : { next_link: page.next, scanned: page.messages.length, reached: last, finished_at: page.next ? null : new Date().toISOString() };
      ({ rows: [row] } = await query(
        `UPDATE mailbox_po_backfills
            SET next_link = $2, scanned = scanned + $3, registered = registered + $4, review = review + $5,
                reached = $6, finished_at = $7, last_error = NULL, updated_at = now()
          WHERE account_id = $1 RETURNING *`,
        [account.id, next.next_link, next.scanned, registered, review, next.reached, next.finished_at]));
      // Re-run or a disconnect removed the row while this ran: stop here.
      if (!row) { tally.restarted = true; break; }
      if (row.finished_at) {
        // Kept on the mailbox, where a re-run does not clear it: the invoice
        // reader goes by it (autoInvoice.js posReadUpTo).
        await query('UPDATE connected_accounts SET past_pos_read_at = $2 WHERE id = $1', [account.id, row.finished_at]);
        break;
      }
    }
    await saveTokens(account, provider);
  } catch (err) {
    await query('UPDATE mailbox_po_backfills SET last_error = $2, updated_at = now() WHERE account_id = $1', [account.id, String(err.message).slice(0, 500)]);
    tally.error = err.message;
  }
  if (row?.finished_at) {
    tally.finished = true;
    // One summary per mailbox instead of a notification per PO (§3.7, §3.8).
    await notify({
      kind: 'po_review',
      title: `Read ${days} days of ${account.email} for purchase orders: ${row.registered} registered, ${row.review} to review`,
      body: row.registered ? 'POs from past mail have their payment stages; record the invoices and payments that already happened from "Stages from past POs".' : null,
      link: row.registered ? '/payment-stages?from_past_po=1' : '/purchase-orders?tab=review',
      dedupeKey: `auto-po-backfill:${account.id}:${new Date(row.started_at).toISOString()}`,
    }).catch(() => {});
  }
  return tally;
}

/** The scheduled sweep: every active mailbox whose past mail is not read for POs yet. */
export async function runPoBackfills({ budgetMs = PO_BACKFILL_BUDGET_MS } = {}) {
  const ctx = await poRunContext({ backfill: true });
  if (!ctx.settings.enabled) return { skipped: 'switched off', registered: 0, errors: 0 };
  const retried = poReaderCanRead() ? await retryPoReads(ctx) : { retried: 0, registered: 0, review: 0 };
  // The retries were live mail: whoever would have heard of them then hears now.
  await notifyReview({ backfill: false, review: ctx.review.splice(0) });
  const { rows } = await query(
    `SELECT a.* FROM connected_accounts a
       LEFT JOIN mailbox_enquiry_backfills e ON e.account_id = a.id
       LEFT JOIN mailbox_po_backfills b ON b.account_id = a.id
      WHERE a.status = 'active' AND b.finished_at IS NULL
        AND (a.past_enquiries_read_at IS NOT NULL OR e.finished_at IS NOT NULL OR (e.folder IN ('sentitems','all') AND e.reached IS NOT NULL))
      ORDER BY a.id`);
  const started = Date.now();
  const results = [];
  const enquiryCtx = await runContext({ backfill: true });
  for (const account of rows) {
    const left = budgetMs - (Date.now() - started);
    if (left <= 0 || ctx.stopped) break;
    results.push(await backfillPoAccount(account, ctx, { budgetMs: left, enquiryCtx }));
  }
  return {
    retried, mailboxes: results.length, registered: results.reduce((t, r) => t + r.registered, 0) + retried.registered,
    review: results.reduce((t, r) => t + r.review, 0) + retried.review,
    errors: results.filter((r) => r.error).length + ctx.errors, stopped: ctx.stopped, results,
  };
}
