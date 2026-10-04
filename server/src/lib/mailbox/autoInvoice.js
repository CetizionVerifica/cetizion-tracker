/**
 * Invoices we email to clients, recorded on the right payment stage
 * (docs/email-po-plan.md §3.10).
 *
 *   processInvoiceCandidates(account, candidates)   read what a sync found
 *   decideInvoice(account, candidate, ctx)          one email, start to finish
 *   matchPo(db, invoice, candidate)                 which PO the invoice is for
 *   backfillInvoiceAccount / runInvoiceBackfills    a year of Sent Items, and
 *                                                   the invoices still waiting
 *
 * An email is read once per mailbox, and the decision is logged in
 * email_invoice_decisions without any of its text. The order for one email:
 *
 *   1. already decided in this mailbox?                       → stop
 *   2. invoicePrefilter; a proforma is not_invoice by rule    → stop
 *   3. the same email already decided in another mailbox      → log linked, no AI
 *   4. read it: the PDF's text (or OCR), one AI call; checkInvoice
 *   5. which PO: its number, the project, the thread, then the client and amount
 *        none yet → waiting, tried again until auto_invoice_wait_days, then review
 *   6. under a lock: the number already recorded → linked (same stage), or review
 *   7. the open stage whose amount is the invoice total → recordInvoice()
 *
 * Recording an invoice never emails the client. A past invoice (history
 * mode) raises no notification and no webhook, and its stage is not chased
 * until a person has touched it (lib/invoices.js UNTOUCHED_HISTORY_INVOICE).
 */
import { query, transaction } from '../../db.js';
import { aiConfig, chatJSON } from '../ai.js';
import { notify } from '../notify.js';
import { businessToday } from '../businessDate.ts';
import { documentStorageReady, uploadDocument } from '../documents.js';
import { NORMALISED_INVOICE_NO, recordInvoice } from '../invoices.js';
import { ApiError } from '../../middleware/error.js';
import { near } from './pdfQuotation.js';
import { mainText } from './enquiryDetect.js';
import { aiCallsToday, enquirySettings } from './autoEnquiry.js';
import { linkThread, resolveCompany } from './autoPurchaseOrder.js';
import { buildInvoicePrompt, checkInvoice, invoicePrefilter, parseInvoiceVerdict, pickStage, rankInvoicePdfs, splitFor, wrongGstin } from './invoiceDetect.js';
import { advanceShare } from '../../import/ai.js';
import { readWithAi } from './readAttachment.js';
import { queueFailures } from './readerQueue.js';
import { forReaders } from './rules.js';
import { ingestRules, providerFor, readsAllFolders, saveTokens } from './sync.js';
import { isPdf } from './pdfQuotation.js';
import { MAX_EMAIL_TEXT } from './readLimits.js';
import { inLanes } from './inLanes.js';

/** Replaceable in tests: the AI and document storage. */
export const deps = { chat: null, upload: documentStorageReady ? uploadDocument : null };

const SETTING_KEYS = ['auto_invoice_enabled', 'auto_invoice_min_confidence', 'auto_invoice_wait_days', 'auto_po_history_after_days', 'company_gstin'];
const num = (v, fallback) => { const n = Number(v); return Number.isFinite(n) ? n : fallback; };

export async function invoiceSettings(db = { query }) {
  const { rows } = await db.query('SELECT key, value FROM settings WHERE key = ANY($1)', [SETTING_KEYS]);
  const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const shared = await enquirySettings(db);
  return {
    enabled: String(s.auto_invoice_enabled ?? 'true').trim().toLowerCase() !== 'false',
    minConfidence: num(s.auto_invoice_min_confidence, 0.85),
    waitDays: num(s.auto_invoice_wait_days, 7),
    historyAfterDays: num(s.auto_po_history_after_days, 30),
    ourGstin: String(s.company_gstin || '').trim() || null,
    ourGstins: shared.ourGstins, partners: shared.partners,
    ourNames: shared.ourNames, internalDomains: shared.internalDomains, dailyAiLimit: shared.dailyAiLimit, backfillDays: shared.backfillDays,
    concurrency: shared.concurrency, readAll: shared.readAll,
  };
}

const chatFn = () => deps.chat || (aiConfig.enabled ? (system, user, opts) => chatJSON(system, user, { title: 'Cetizion Tracker email invoices', ...opts }) : null);

export async function invoiceRunContext({ backfill = false } = {}) {
  return { settings: await invoiceSettings(), backfill, aiUsed: await aiCallsToday(), recorded: [], review: [], linked: 0, waiting: 0, notInvoice: 0, skipped: 0, errors: 0, stopped: null };
}

/**
 * Read each outbound candidate a sync or the backfill found. Returns the
 * tally, or null when the feature is switched off. One email failing never
 * stops the rest, and never fails the sync that found it.
 */
export async function processInvoiceCandidates(account, candidates, { ctx: given = null, provider = null, onSettled = null } = {}) {
  const ctx = given || await invoiceRunContext();
  if (provider) ctx.provider = provider;
  if (!ctx.settings.enabled) return null;
  await inLanes(candidates, {
    concurrency: ctx.settings.concurrency,
    stopped: () => Boolean(ctx.stopped),
    each: async (cand) => {
      // Told for every email reached, so the reader queue (readerQueue.js)
      // can keep the ones that failed. One left unreached stays queued.
      let failure = null;
      if (cand.c?.direction === 'outbound') {
        try {
          await decideInvoice(account, cand, ctx);
        } catch (err) {
          failure = err;
          ctx.errors += 1;
          console.error('[auto-invoice]', account.email, cand.m?.provider_id, err.message);
        }
      }
      if (onSettled) await onSettled(cand, failure);
    },
  });
  if (!given) await notifyOutcomes(ctx);
  return given ? ctx : { recorded: ctx.recorded.length, review: ctx.review.length, linked: ctx.linked, waiting: ctx.waiting, not_invoice: ctx.notInvoice, errors: ctx.errors };
}

// ------------------------------------------------------------ the decision log

/** Write a decision, or — for one that was waiting — settle it. */
async function saveDecision(db, account, cand, d) {
  const { m, c } = cand;
  const values = [d.outcome, d.document_type || null, d.review_reason || null, d.mode || null, d.confidence ?? null, d.method || 'ai',
    d.stage_id ?? null, d.po_number || null, d.invoice_no || null, Boolean(d.document_kept_existing), d.outcome === 'waiting' && d.reading ? JSON.stringify(d.reading) : null,
    d.thread_id ?? cand.threadId ?? null, d.review_note || null, d.split_suggestion ? JSON.stringify(d.split_suggestion) : null];
  if (cand.decisionId) {
    await db.query(
      `UPDATE email_invoice_decisions SET outcome = $2, document_type = $3, review_reason = $4, mode = $5, confidence = $6, method = $7,
              stage_id = $8, po_number = $9, invoice_no = $10, document_kept_existing = $11, reading = $12, thread_id = COALESCE($13, thread_id),
              review_note = $14, split_suggestion = $15, ai_calls = ai_calls + $16
        WHERE id = $1 AND outcome = 'waiting'`, [cand.decisionId, ...values, cand.retry ? d.ai_calls || 0 : 0]);
    return;
  }
  await db.query(
    `INSERT INTO email_invoice_decisions (account_id, provider_id, internet_message_id, conversation_id, to_emails, sent_at,
                                          outcome, document_type, review_reason, mode, confidence, method, stage_id, po_number, invoice_no,
                                          document_kept_existing, reading, thread_id, review_note, split_suggestion, ai_calls)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
     ON CONFLICT (account_id, provider_id) DO NOTHING`,
    [account.id, m.provider_id, m.internet_message_id || null, m.conversation_id || null, (c.external || []).map((p) => p.email), m.sent_at || null,
      ...values, d.ai_calls || 0]);
}

const istDay = (iso) => new Date(new Date(iso).getTime() + 330 * 60_000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);

// ------------------------------------------------------------ one email

export async function decideInvoice(account, cand, ctx) {
  const { m, c } = cand;
  if (!m.provider_id || c.direction !== 'outbound') return 'incomplete';
  // By id, or as the same email under another id (moved to another folder).
  const { rows: [seen] } = await query(
    `SELECT 1 FROM email_invoice_decisions WHERE account_id = $1 AND NOT (outcome = 'waiting' AND $3)
        AND (provider_id = $2 OR ($4::text IS NOT NULL AND lower(internet_message_id) = lower($4)))`,
    [account.id, m.provider_id, Boolean(cand.retry), m.internet_message_id || null]);
  if (seen) return 'seen';

  const text = mainText(m.body_html || (m.preview ? `<p>${m.preview}</p>` : ''), MAX_EMAIL_TEXT);
  // A retry was a candidate when it was sent; its stored copy may hold no text.
  const pf = cand.retry ? { candidate: true } : invoicePrefilter({ direction: 'outbound', subject: m.subject, text, external: c.external, attachments: m.attachments, has_attachments: m.has_attachments }, { readAll: ctx.settings.readAll });
  if (!pf.candidate) {
    if (pf.reason === 'proforma') {
      // Decided by the rules: a proforma is never recorded, and never uses up a number.
      await saveDecision({ query }, account, cand, { outcome: 'not_invoice', document_type: 'proforma', method: 'rules' });
      ctx.notInvoice += 1;
      return 'not_invoice';
    }
    ctx.skipped += 1;
    return 'skipped';
  }

  // The same email, read in another mailbox (sales@ and accounts@ both on
  // the thread): no second AI call, and never a second record.
  if (m.internet_message_id && !cand.retry) {
    const { rows: [other] } = await query(
      `SELECT outcome, stage_id, po_number, invoice_no FROM email_invoice_decisions
        WHERE lower(internet_message_id) = lower($1) AND account_id <> $2 ORDER BY id LIMIT 1`, [m.internet_message_id, account.id]);
    if (other) {
      const outcome = other.outcome === 'not_invoice' ? 'not_invoice' : 'linked';
      await saveDecision({ query }, account, cand, { outcome, method: 'rules', stage_id: other.stage_id, po_number: other.po_number, invoice_no: other.invoice_no });
      if (outcome === 'linked') ctx.linked += 1; else ctx.notInvoice += 1;
      return outcome;
    }
  }

  const chat = chatFn();
  // No AI, or the day's ceiling reached: left undecided, so the backfill reads it once it can.
  if (!chat) { ctx.skipped += 1; return 'no_ai'; }
  if (ctx.aiUsed >= ctx.settings.dailyAiLimit) {
    // The backfill reads the page again tomorrow; live mail is handed over
    // once, so it waits, unread, for invoices.backfill to read it.
    if (ctx.backfill && !cand.retry) { ctx.stopped = 'ai_limit'; return 'ai_limit'; }
    if (!cand.retry) await saveDecision({ query }, account, cand, { outcome: 'waiting', reading: null, ai_calls: 0 });
    ctx.waiting += 1;
    return 'waiting';
  }

  const read = await readWithAi(account, cand, ctx, chat, {
    rank: rankInvoicePdfs, parse: parseInvoiceVerdict, fileName: 'invoice.pdf', requirePdf: true,
    prompt: ({ pdfText }) => buildInvoicePrompt({
      pdfText, emailSubject: m.subject, emailText: text, sentAt: m.sent_at, to: c.external, ourNames: ctx.settings.ourNames, ourGstin: ctx.settings.ourGstin,
      ourGstins: ctx.settings.ourGstins, partners: ctx.settings.partners,
    }),
  });
  if (read.error) {
    ctx.errors += 1;
    // Read again later, as for the day's ceiling; the call is counted.
    if (cand.retry) await query('UPDATE email_invoice_decisions SET ai_calls = ai_calls + 1 WHERE id = $1', [cand.decisionId]);
    else await saveDecision({ query }, account, cand, { outcome: 'waiting', reading: null, ai_calls: read.ai_calls ?? 1 });
    return 'waiting';
  }
  if (read.noPdf) {
    // Decided by the rules, with no AI call: an invoice is a PDF.
    await saveDecision({ query }, account, cand, { outcome: 'not_invoice', method: 'rules' });
    ctx.notInvoice += 1;
    return 'not_invoice';
  }
  const base = { method: 'ai', ai_calls: read.ai_calls, confidence: read.verdict?.confidence ?? null, document_type: read.verdict?.document_type ?? null };
  if (read.unreadable) return toReview({ query }, account, cand, ctx, { ...base, review_reason: 'unreadable' });

  const checked = checkInvoice(read.verdict, {
    emailDate: m.sent_at, sourceText: read.sourceText, minConfidence: ctx.settings.minConfidence,
    ourNames: ctx.settings.ourNames, ourGstin: ctx.settings.ourGstin, ourGstins: ctx.settings.ourGstins, partners: ctx.settings.partners, internalDomains: ctx.settings.internalDomains,
  });
  if (!checked.ok && checked.reason === 'not_invoice') {
    await saveDecision({ query }, account, cand, { ...base, outcome: 'not_invoice' });
    ctx.notInvoice += 1;
    return 'not_invoice';
  }
  if (!checked.ok) return toReview({ query }, account, cand, ctx, { ...base, review_reason: checked.reason, invoice_no: read.verdict.invoice_no });
  return settle(account, cand, ctx, checked.invoice, base, read.pdf);
}

async function toReview(db, account, cand, ctx, d) {
  await saveDecision(db, account, cand, { ...d, outcome: 'review' });
  ctx.review.push({ account, cand, reason: d.review_reason, po_number: d.po_number || null, invoice_no: d.invoice_no || null });
  return 'review';
}

/**
 * Match, then record — for an invoice just read, or one that was waiting
 * for its PO (pdf null: the attachment is fetched again, with no AI call).
 */
async function settle(account, cand, ctx, inv, base, pdf) {
  const mode = daysBetween(inv.invoice_date, businessToday()) > ctx.settings.historyAfterDays ? 'history' : 'live';
  const decision = { ...base, mode, invoice_no: inv.invoice_no };

  const match = await matchPo({ query }, inv, cand);
  if (match.review) return toReview({ query }, account, cand, ctx, { ...decision, review_reason: match.review, po_number: match.po_number });
  if (!match.po) {
    // Its PO is not in the tracker yet: the PO may still be on its way in.
    const firstRead = cand.firstReadAt || new Date().toISOString();
    if (daysBetween(istDay(firstRead), businessToday()) >= ctx.settings.waitDays) {
      return toReview({ query }, account, cand, ctx, { ...decision, review_reason: 'po_not_found' });
    }
    // Read just now (first time, or a retry of an unread one): keep what was read.
    if (!cand.decisionId || cand.retry) await saveDecision({ query }, account, cand, { ...decision, outcome: 'waiting', reading: inv });
    ctx.waiting += 1;
    return 'waiting';
  }

  // Raised from a registration other than the one the PO was addressed to: the client would reject it (§1).
  if (wrongGstin(inv, match.po)) return toReview({ query }, account, cand, ctx, { ...decision, review_reason: 'wrong_gstin', po_number: match.po.po_number });
  // The PO date printed beside its number must be the PO's (§4): another date is another order, or a slip.
  const poDate = match.po.po_date ? String(match.po.po_date).slice(0, 10) : null;
  if (inv.po_date && poDate && inv.po_date !== poDate) {
    return toReview({ query }, account, cand, ctx, { ...decision, review_reason: 'po_date_mismatch', po_number: match.po.po_number, review_note: `The invoice gives PO ${match.po.po_number} dated ${inv.po_date}; the tracker's PO is dated ${poDate}.` });
  }

  const file = pdf || await refetchPdf(account, cand, ctx);
  const documentId = await storePdf(file);
  try {
    return await transaction((db) => recordUnderLock(db, account, cand, ctx, { inv, decision, po: match.po, documentId }));
  } catch (err) {
    // Recorded meanwhile under the same number (the unique index), or the
    // stage went: a person decides.
    if (!(err instanceof ApiError) && err.code !== '23505') throw err;
    return toReview({ query }, account, cand, ctx, { ...decision, review_reason: 'invoice_no_in_use', po_number: match.po.po_number });
  }
}

async function refetchPdf(account, cand, ctx) {
  try {
    const provider = ctx.provider || providerFor(account);
    const files = (await provider.attachments(cand.m.provider_id)).filter((a) => isPdf(a) && a.content);
    return rankInvoicePdfs(files.map((f) => ({ ...f, firstPage: '' })))[0] || null;
  } catch {
    return null;
  }
}

async function storePdf(pdf) {
  if (!pdf?.content || !deps.upload) return null;
  try {
    return (await deps.upload({ buffer: pdf.content, fileName: pdf.name || 'invoice.pdf', contentType: 'application/pdf', owner: 'payment-stages' })).id;
  } catch (err) {
    console.warn('[auto-invoice] the PDF could not be stored:', err.message);
    return null;
  }
}

async function recordUnderLock(db, account, cand, ctx, { inv, decision, po, documentId }) {
  const { m } = cand;
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`auto-invoice:${inv.invoice_no_norm}`]);
  const { rows: [again] } = await db.query(
    `SELECT 1 FROM email_invoice_decisions WHERE account_id = $1 AND provider_id = $2 AND outcome <> 'waiting'`, [account.id, m.provider_id]);
  if (again) return 'seen';

  // The number is already on a stage: this one (a re-send, or the copy of
  // an invoice sent from the tracker), a changed one, or somebody else's.
  const { rows: [existing] } = await db.query(
    `SELECT id, po_number, stage_amount FROM v_payment_stages WHERE ${NORMALISED_INVOICE_NO()} = $1 LIMIT 1`, [inv.invoice_no_norm]);
  if (existing) {
    if (existing.po_number !== po.po_number) return toReview(db, account, cand, ctx, { ...decision, review_reason: 'invoice_no_in_use', po_number: po.po_number });
    if (!near(Number(existing.stage_amount), inv.total_value)) return toReview(db, account, cand, ctx, { ...decision, review_reason: 'revised', po_number: po.po_number, stage_id: existing.id });
    await saveDecision(db, account, cand, { ...decision, outcome: 'linked', stage_id: existing.id, po_number: po.po_number });
    ctx.linked += 1;
    return 'linked';
  }

  const { rows: stages } = await db.query(
    `SELECT id, stage_no, stage_name, trigger_event, milestone_name, stage_percent, stage_amount, invoice_no, on_hold, currency FROM v_payment_stages WHERE po_number = $1 ORDER BY stage_no`,
    [po.po_number]);
  const pick = pickStage(stages, inv.total_value, inv.stage_hint);
  if (pick.reason === 'amount_not_a_stage') {
    // A share of a PO with one 100% stage: offer the split (§5). The quotation's terms give the share when the invoice does not.
    const { rows: [q] } = await db.query('SELECT terms FROM quotations WHERE quotation_no = $1', [po.quotation_no]);
    const split = splitFor(stages, inv, { quotationAdvance: advanceShare(String(q?.terms || '')).percent });
    const note = split
      ? `Its PO has one 100% stage of ${stages[0].currency || 'INR'} ${Number(stages[0].stage_amount).toLocaleString('en-IN')}; this invoice is ${split.percent}% of it. Accept the split to record it as "${split.stage_name}" and leave ${100 - split.percent}% open.`
      : null;
    return toReview(db, account, cand, ctx, { ...decision, review_reason: pick.reason, po_number: po.po_number, review_note: note, split_suggestion: split ? { ...split, invoice_no: inv.invoice_no, invoice_date: inv.invoice_date } : null });
  }
  if (pick.reason) return toReview(db, account, cand, ctx, { ...decision, review_reason: pick.reason, po_number: po.po_number });

  const recorded = await recordInvoice(db, {
    stageId: pick.stage.id, invoiceNo: inv.invoice_no, invoiceDate: inv.invoice_date, documentId, keepExistingDocument: true, mode: decision.mode,
  });
  await linkThread(db, cand.threadId, po.po_number, po.quotation_no);
  await saveDecision(db, account, cand, {
    ...decision, outcome: 'recorded', stage_id: recorded.id, po_number: po.po_number, document_kept_existing: recorded.document_kept_existing,
  });
  ctx.recorded.push({ account, invoice_no: recorded.invoice_no, po_number: po.po_number, stage_name: pick.stage.stage_name, mode: decision.mode });
  return 'recorded';
}

// ------------------------------------------------------------ matching (§3.10.3)

const LIVE_PO = `NOT po.cancelled AND NOT EXISTS (SELECT 1 FROM purchase_orders r WHERE r.replaces_po_number = po.po_number)`;
const PO_COLUMNS = 'po.po_number, po.quotation_no, po.project_id, p.company_id, po.addressed_gstin, po.po_date';

/** Of these POs, the ones with an open stage of the invoice's amount. */
async function withStageOf(db, poNumbers, total) {
  if (!poNumbers.length) return [];
  const { rows } = await db.query(
    `SELECT DISTINCT po_number FROM v_payment_stages WHERE po_number = ANY($1) AND invoice_no IS NULL AND NOT on_hold
        AND abs(stage_amount - $2) <= GREATEST(1, 0.005 * GREATEST(abs(stage_amount), abs($2)))`, [poNumbers, total]);
  return rows.map((r) => r.po_number);
}

/**
 * Which PO an invoice is for. The first rule giving exactly one PO wins:
 * the PO number printed on it, the project it names, the thread, then the
 * client's live POs with an open stage of that amount. Returns
 *   { po }                 found
 *   { review, po_number }  several_pos: a person decides
 *   {}                     nothing yet
 */
export async function matchPo(db, inv, cand) {
  const company = await resolveCompany(db, { buyer: inv.buyer }, cand);
  const sameClient = (rows) => rows.filter((r) => !company || !r.company_id || r.company_id === company.id);
  const all = async (where, params) => (await db.query(
    `SELECT ${PO_COLUMNS} FROM purchase_orders po LEFT JOIN projects p ON p.project_id = po.project_id WHERE ${LIVE_PO} AND ${where}`, params)).rows;
  const one = async (where, params) => sameClient(await all(where, params));
  const narrow = async (rows) => {
    if (rows.length <= 1) return rows;
    const fit = await withStageOf(db, rows.map((r) => r.po_number), inv.total_value);
    return rows.filter((r) => fit.includes(r.po_number));
  };
  const answer = (rows) => (rows.length === 1 ? { po: rows[0] } : rows.length > 1 ? { review: 'several_pos', po_number: null } : null);

  // The POs this conversation is on: the thread, or the client's PO email in it.
  const threadPos = async () => {
    if (!cand.m.conversation_id) return { numbers: [], project: null };
    const { rows: [t] } = await db.query(`SELECT entity, entity_id FROM email_threads WHERE conversation_id = $1 AND entity IN ('purchase_order','project') LIMIT 1`, [cand.m.conversation_id]);
    const { rows: fromPo } = await db.query(
      `SELECT DISTINCT po_number FROM email_po_decisions WHERE conversation_id = $1 AND po_number IS NOT NULL AND outcome IN ('registered','linked','registered_by_hand')`, [cand.m.conversation_id]);
    return { numbers: [...new Set([...(t?.entity === 'purchase_order' ? [t.entity_id] : []), ...fromPo.map((r) => r.po_number)])], project: t?.entity === 'project' ? t.entity_id : null };
  };
  // With the buyer unknown, a PO number alone is not proof: client PO
  // numbers are short and repeat ("1001"). Only the conversation can say.
  const confirmed = async (rows) => {
    if (company || !rows.length) return rows;
    const { numbers, project } = await threadPos();
    const sure = rows.filter((r) => numbers.includes(r.po_number) || (project && r.project_id === project));
    return sure.length ? sure : null;
  };

  // 1. The PO number printed on the invoice.
  if (inv.po_reference) {
    const rows = await confirmed(await narrow(await one(`lower(regexp_replace(po.po_number, '[^a-zA-Z0-9]', '', 'g')) = $1`, [String(inv.po_reference).toLowerCase().replace(/[^a-z0-9]/g, '')])));
    if (rows === null) return { review: 'client_unknown', po_number: null };
    const found = answer(rows);
    if (found) return found;
  }
  // 2. The project it names.
  if (inv.project_reference) {
    const rows = await confirmed(await narrow(await one('upper(po.project_id) = upper($1)', [inv.project_reference])));
    if (rows === null) return { review: 'client_unknown', po_number: null };
    const found = answer(rows);
    if (found) return found;
  }
  // The invoice names a PO or project the tracker does not have (for this
  // client): it waits for that PO. Guessing another PO of the same client
  // by amount recorded it on the wrong PO, and left the right one open.
  if (inv.po_reference || inv.project_reference) return {};

  // 3. The thread: on a PO or a project, or holding the client's PO email.
  if (cand.m.conversation_id) {
    const { numbers, project } = await threadPos();
    let rows = numbers.length ? await one('po.po_number = ANY($1)', [numbers]) : [];
    if (!rows.length && project) rows = await one('po.project_id = $1', [project]);
    const found = answer(await narrow(rows));
    if (found) return found;
  }
  // 4. The client's live POs with an open stage of that amount, only for an
  // invoice that cites nothing.
  if (company) {
    const rows = await one('p.company_id = $1', [company.id]);
    const fit = await withStageOf(db, rows.map((r) => r.po_number), inv.total_value);
    const found = answer(rows.filter((r) => fit.includes(r.po_number)));
    if (found) return found;
  }
  return {};
}

// ------------------------------------------------------------ telling people

/**
 * Live only: the PO's owner hears of each invoice recorded, and of each one
 * that needs a look. Past mail raises one summary per mailbox instead.
 */
async function notifyOutcomes(ctx) {
  if (ctx.backfill) return;
  const ownerOf = async (poNumber) => {
    if (!poNumber) return null;
    const { rows: [o] } = await query(
      `SELECT COALESCE(u.email, q.sales_person_email, q.sales_person) AS who FROM purchase_orders po
         LEFT JOIN quotations q ON q.quotation_no = po.quotation_no LEFT JOIN users u ON u.id = q.owner_user_id WHERE po.po_number = $1`, [poNumber]);
    return o?.who || null;
  };
  for (const r of ctx.recorded) {
    if (r.mode !== 'live') continue;
    await notify({
      username: await ownerOf(r.po_number), kind: 'invoice_recorded',
      title: `Invoice ${r.invoice_no} recorded from email on PO ${r.po_number}`,
      body: `${r.stage_name}, from the invoice sent by ${r.account.email}.`,
      entity: 'purchase_order', entityId: r.po_number, link: `/purchase-orders/${encodeURIComponent(r.po_number)}`,
      dedupeKey: `invoice-recorded:${r.po_number}:${r.invoice_no}`,
    }).catch(() => {});
  }
  const WHY = {
    po_not_found: 'its PO is not in the tracker', several_pos: 'more than one PO could be it', amount_not_a_stage: 'its amount is not one of the PO\'s stages',
    po_without_stages: 'its PO has no payment stages', invoice_no_in_use: 'its number is already on another stage', not_from_us: 'it is not our invoice', wrong_gstin: 'it is raised from a GSTIN other than the one its PO is addressed to', po_date_mismatch: 'the PO date it gives is not the PO\'s',
    low_confidence: 'it could not be read with confidence', client_unknown: 'its client could not be confirmed for the PO it names', credit_note: 'it is a credit or debit note', revised: 'it revises or cancels an invoice', unreadable: 'its PDF could not be opened',
    no_invoice_no: 'it has no invoice number', amounts_not_in_pdf: 'its amounts could not be confirmed in the PDF', totals_do_not_add_up: 'its totals do not add up',
    bad_currency: 'its currency is not one the tracker uses', bad_date: 'its date is missing or after the email',
  };
  for (const r of ctx.review) {
    await notify({
      username: await ownerOf(r.po_number), kind: 'invoice_review',
      title: `${r.invoice_no ? `Invoice ${r.invoice_no}` : 'An invoice'} emailed by ${r.account.email} needs a look`,
      body: `Not recorded automatically: ${WHY[r.reason] || r.reason}.`,
      entity: r.po_number ? 'purchase_order' : null, entityId: r.po_number, link: '/payment-stages?tab=invoice-review',
      dedupeKey: `invoice-review:${r.account.id}:${r.cand.m.provider_id}`,
    }).catch(() => {});
  }
}

// ------------------------------------------------------------ waiting, and past mail (§3.10.6)

/**
 * The invoices whose PO was not in the tracker when they were read: matched
 * again from the facts kept while they wait (no AI call), recorded once
 * their PO is in, and sent to review after auto_invoice_wait_days.
 */
export async function retryWaiting(ctx, { limit = 200 } = {}) {
  const { rows } = await query(
    `SELECT d.*, a.email AS account_email FROM email_invoice_decisions d JOIN connected_accounts a ON a.id = d.account_id
      WHERE d.outcome = 'waiting' AND a.status = 'active' ORDER BY d.decided_at LIMIT $1`, [limit]);
  const tally = { retried: rows.length, recorded: 0, review: 0 };
  const from = { recorded: ctx.recorded.length, review: ctx.review.length };
  for (const d of rows) {
    const { rows: [account] } = await query('SELECT * FROM connected_accounts WHERE id = $1', [d.account_id]);
    const cand = {
      m: { provider_id: d.provider_id, internet_message_id: d.internet_message_id, conversation_id: d.conversation_id, sent_at: d.sent_at, has_attachments: true },
      c: { direction: 'outbound', external: (d.to_emails || []).map((email) => ({ email })) },
      threadId: d.thread_id, decisionId: d.id, firstReadAt: d.decided_at,
    };
    const before = { recorded: ctx.recorded.length, review: ctx.review.length };
    try {
      if (d.reading) {
        await settle(account, cand, ctx, d.reading, { method: 'ai', confidence: d.confidence, document_type: d.document_type }, null);
      } else if (daysBetween(istDay(d.decided_at), businessToday()) >= ctx.settings.waitDays) {
        // Never read in a week: a person looks.
        await toReview({ query }, account, cand, ctx, { method: 'ai', review_reason: 'unreadable' });
      } else if (ctx.aiUsed < ctx.settings.dailyAiLimit) {
        // Never read (an AI error, or the day's ceiling): read it now.
        const { rows: [msg] } = await query('SELECT subject, body_html FROM email_messages WHERE account_id = $1 AND provider_id = $2', [d.account_id, d.provider_id]);
        await decideInvoice(account, { ...cand, retry: true, m: { ...cand.m, subject: msg?.subject ?? null, body_html: msg?.body_html ?? null } }, ctx);
      }
    } catch (err) {
      ctx.errors += 1;
      console.error('[auto-invoice] retry', d.id, err.message);
    }
    tally.recorded += ctx.recorded.length - before.recorded;
    tally.review += ctx.review.length - before.review;
  }
  // These were live email once: their owners hear of them as they would have then.
  await notifyOutcomes({ backfill: false, recorded: ctx.recorded.slice(from.recorded), review: ctx.review.slice(from.review) });
  return tally;
}

/** The outbound candidates on one page of past Sent Items. */
async function pastInvoiceCandidates(account, judge, messages) {
  const out = [];
  for (const m of messages) {
    if (!m.provider_id || !m.conversation_id || m.draft) continue;
    const c = forReaders(judge(m), judge.readAll);
    if (!c || c.direction !== 'outbound') continue;
    const { rows: [t] } = await query('SELECT id FROM email_threads WHERE account_id = $1 AND conversation_id = $2', [account.id, m.conversation_id]);
    out.push({ m, c, threadId: t?.id ?? null, newThread: false, dropped: !t });
  }
  return out;
}

/**
 * How far into this mailbox's past the invoice reader may go: the POs its
 * invoices are for should be registered first (§3.10.6). A PO may arrive in
 * sales@ and its invoice go out from accounts@, so every active mailbox's
 * PO reader counts, until 24 hours after this one's own has read through.
 *
 * Each PO reader has got either all the way (`past_pos_read_at`, which a
 * re-run does not clear, or a finished row) or to the date it has reached.
 * `true` means no limit, a date means up to then, and null means wait.
 * Undecided invoices wait for their PO anyway.
 */
export async function posReadUpTo(accountId) {
  const { rows } = await query(
    `SELECT a.id, COALESCE(b.finished_at, a.past_pos_read_at) AS read_at, b.reached
       FROM connected_accounts a LEFT JOIN mailbox_po_backfills b ON b.account_id = a.id
      WHERE a.status = 'active' OR a.id = $1`, [accountId]);
  const own = rows.find((r) => r.id === accountId);
  if (!own || (!own.read_at && !own.reached)) return null;
  if (own.read_at && new Date(own.read_at) < new Date(Date.now() - 864e5)) return true;
  let upTo = true;
  for (const r of rows) {
    if (r.read_at) continue;
    if (!r.reached) return null;
    if (upTo === true || new Date(r.reached) < upTo) upTo = new Date(r.reached);
  }
  return upTo;
}

/**
 * Read one mailbox's past Sent Items for invoices, oldest first, for up to
 * `budgetMs`. Resumable, as the other backfills are.
 */
export async function backfillInvoiceAccount(account, ctx, { budgetMs = 4 * 60_000 } = {}) {
  const upTo = await posReadUpTo(account.id);
  if (!upTo) return { id: account.id, waiting: 'PO backfill', recorded: 0, review: 0 };
  const since = new Date(Date.now() - ctx.settings.backfillDays * 864e5).toISOString();
  await query(`INSERT INTO mailbox_invoice_backfills (account_id, since) VALUES ($1, $2) ON CONFLICT (account_id) DO NOTHING`, [account.id, since]);
  let { rows: [row] } = await query('SELECT * FROM mailbox_invoice_backfills WHERE account_id = $1', [account.id]);
  if (row.finished_at) return { id: account.id, finished: true, recorded: 0, review: 0 };
  const beyondUpTo = (date) => upTo !== true && date && new Date(date) > upTo;
  // Caught up with the PO readers: nothing to fetch until they move on.
  if (upTo !== true && row.reached && new Date(row.reached) >= upTo) return { id: account.id, waiting: 'PO backfill', recorded: 0, review: 0 };
  const started = Date.now();
  const tally = { id: account.id, email: account.email, pages: 0, recorded: 0, review: 0 };
  let provider;
  try {
    provider = providerFor(account);
    if (!provider.page) throw new Error(`Reading past mail is not supported for ${account.provider} mailboxes`);
    const judge = await ingestRules(account);
    for (let first = true; first || (Date.now() - started < budgetMs && !ctx.stopped); first = false) {
      // Every folder while reading everything (073): our invoices are often
      // filed away from Sent Items. pastInvoiceCandidates keeps what we sent.
      const page = await provider.page(readsAllFolders(account, ctx.settings.readAll) ? 'all' : 'sentitems', { sinceIso: new Date(row.since).toISOString(), cursor: row.next_link });
      // A page that runs past where the PO readers have got is left for a
      // later run: the cursor stays, so it is fetched again then.
      if (page.messages.length && beyondUpTo(page.messages[page.messages.length - 1].sent_at)) {
        tally.waiting = 'PO backfill';
        break;
      }
      const before = { recorded: ctx.recorded.length, review: ctx.review.length };
      await processInvoiceCandidates(account, await pastInvoiceCandidates(account, judge, page.messages), { ctx, provider, onSettled: queueFailures(account, 'invoice') });
      const recorded = ctx.recorded.length - before.recorded; const review = ctx.review.length - before.review;
      tally.pages += 1; tally.recorded += recorded; tally.review += review;
      const last = page.messages.length ? page.messages[page.messages.length - 1].sent_at : row.reached;
      const next = ctx.stopped
        ? { next_link: row.next_link, scanned: 0, reached: row.reached, finished_at: null }
        : { next_link: page.next, scanned: page.messages.length, reached: last, finished_at: page.next ? null : new Date().toISOString() };
      ({ rows: [row] } = await query(
        `UPDATE mailbox_invoice_backfills
            SET next_link = $2, scanned = scanned + $3, recorded = recorded + $4, review = review + $5,
                reached = $6, finished_at = $7, last_error = NULL, updated_at = now()
          WHERE account_id = $1 RETURNING *`,
        [account.id, next.next_link, next.scanned, recorded, review, next.reached, next.finished_at]));
      if (!row) { tally.restarted = true; break; }
      if (row.finished_at) break;
    }
    await saveTokens(account, provider);
  } catch (err) {
    await query('UPDATE mailbox_invoice_backfills SET last_error = $2, updated_at = now() WHERE account_id = $1', [account.id, String(err.message).slice(0, 500)]);
    tally.error = err.message;
  }
  if (row?.finished_at) {
    tally.finished = true;
    await notify({
      kind: 'invoice_review',
      title: `Read ${ctx.settings.backfillDays} days of ${account.email} for invoices: ${row.recorded} recorded, ${row.review} to review`,
      body: row.recorded ? 'Invoices from past mail are on their stages; record the payments that already happened from "Past POs and invoices to settle".' : null,
      link: row.recorded ? '/payment-stages?from_past_po=1' : '/payment-stages?tab=invoice-review',
      dedupeKey: `auto-invoice-backfill:${account.id}:${new Date(row.started_at).toISOString()}`,
    }).catch(() => {});
  }
  return tally;
}

/** The scheduled sweep: the invoices waiting for their PO, then every mailbox whose Sent Items are not read yet. */
export async function runInvoiceBackfills({ budgetMs = 4 * 60_000 } = {}) {
  const ctx = await invoiceRunContext({ backfill: true });
  if (!ctx.settings.enabled) return { skipped: 'switched off', recorded: 0, errors: 0 };
  const retried = await retryWaiting(ctx);
  const { rows } = await query(
    `SELECT a.* FROM connected_accounts a LEFT JOIN mailbox_po_backfills p ON p.account_id = a.id
       LEFT JOIN mailbox_invoice_backfills b ON b.account_id = a.id
      WHERE a.status = 'active' AND b.finished_at IS NULL
        AND (a.past_pos_read_at IS NOT NULL OR p.finished_at IS NOT NULL OR p.reached IS NOT NULL)
      ORDER BY a.id`);
  const started = Date.now();
  const results = [];
  for (const account of rows) {
    const left = budgetMs - (Date.now() - started);
    if (left <= 0 || ctx.stopped) break;
    results.push(await backfillInvoiceAccount(account, ctx, { budgetMs: left }));
  }
  return {
    retried, mailboxes: results.length, recorded: results.reduce((t, r) => t + r.recorded, 0) + retried.recorded,
    review: results.reduce((t, r) => t + r.review, 0) + retried.review,
    errors: results.filter((r) => r.error).length + ctx.errors, stopped: ctx.stopped, results,
  };
}
