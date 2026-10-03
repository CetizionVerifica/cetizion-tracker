/**
 * A quotation we sent by email that is not in the tracker becomes one
 * (docs/email-enquiries-plan.md §3.9). Two halves, because one of them
 * calls the AI and the other writes:
 *
 *   prepare(account, candidate, verdict, ctx, chat)   before any transaction:
 *        fetch the attachments, pick the quotation PDF, read its text, ask
 *        the AI, check the answer, store the PDF as a document
 *   create(db, { account, cand, prepared, client, owner, threadId })
 *        inside the enquiry's transaction: the number rule, the quotation,
 *        its lines or its printed totals, a revision, or nothing for a resend
 *
 * The decision row autoEnquiry.js writes carries the PDF's printed totals;
 * quotation_totals() falls back on them while the quotation has no lines.
 */
import { query } from '../../db.js';
import { claimNextId } from '../sequences.js';
import { documentStorageReady, uploadDocument } from '../documents.js';
import { mainText } from './enquiryDetect.js';
import { providerFor } from './sync.js';
import { MAX_PDF_BYTES, SCANNED_BELOW, checkExtraction, extractionPrompt, isPdf, pdfText, rankPdfs } from './pdfQuotation.js';
import { DOCUMENT_MAX_TOKENS, DOCUMENT_TIMEOUT_MS, MAX_EMAIL_TEXT, OCR_TIMEOUT_MS } from './readLimits.js';

const fail = (reason, extra = {}) => ({ ok: false, reason, ...extra });

export async function prepare(account, cand, verdict, ctx, chat) {
  const { m } = cand;
  if (!chat) return fail('no_ai');
  if (ctx.aiUsed >= ctx.settings.dailyAiLimit) return ctx.backfill ? { stop: true } : fail('ai_limit');

  // The quotation PDF, if there is one; otherwise the body is the quotation.
  let chosen = null; let text = null; let reason = null;
  if (m.has_attachments) {
    const provider = ctx.provider || providerFor(account);
    const files = (await provider.attachments(m.provider_id)).filter((a) => isPdf(a) && a.content && a.content.length <= MAX_PDF_BYTES);
    const read = [];
    for (const f of files) {
      try {
        read.push({ ...f, pages: await pdfText(f.content) });
      } catch (err) {
        read.push({ ...f, pages: null, error: err.code || 'unreadable' });
      }
    }
    const ranked = rankPdfs(read.map((f) => ({ ...f, firstPage: f.pages?.[0] || '' })));
    chosen = ranked[0] || null;
    if (chosen && !chosen.pages) reason = chosen.error;
    if (chosen?.pages) text = chosen.pages.join('\n\n');
  }
  if (reason) return fail(reason);
  if (!chosen) text = mainText(m.body_html || '', 30_000);

  const emailText = mainText(m.body_html || '', MAX_EMAIL_TEXT);
  const scanned = chosen && (text || '').replace(/\s+/g, '').length < SCANNED_BELOW;
  const { system, user } = extractionPrompt({
    pdfText: scanned ? null : text, emailSubject: m.subject, emailText, sentAt: m.sent_at, services: ctx.settings.services, ourNames: ctx.settings.ourNames,
  });
  ctx.aiUsed += 1;
  let raw;
  try {
    raw = scanned
      // A scan: the file itself goes, for OCR, with the same zero-retention routing.
      ? await chat(system, [
        { type: 'text', text: user },
        { type: 'file', file: { filename: chosen.name || 'quotation.pdf', file_data: `data:application/pdf;base64,${chosen.content.toString('base64')}` } },
      ], { maxTokens: DOCUMENT_MAX_TOKENS, timeoutMs: OCR_TIMEOUT_MS, plugins: [{ id: 'file-parser', pdf: { engine: 'mistral-ocr' } }] })
      : await chat(system, user, { maxTokens: DOCUMENT_MAX_TOKENS, timeoutMs: DOCUMENT_TIMEOUT_MS });
  } catch (err) {
    return fail('unreadable', { ai_calls: 1, detail: err.message });
  }
  const checked = checkExtraction(raw, {
    emailDate: m.sent_at, sourceText: scanned ? null : text, minConfidence: ctx.settings.quotationMinConfidence,
    ourNames: ctx.settings.ourNames, internalDomains: ctx.settings.internalDomains,
  });
  if (!checked.ok) return { ...checked, ai_calls: 1 };

  // The PDF is kept as the quotation's document. Stored before the
  // transaction, because it is a network call; if the transaction then
  // makes nothing, the daily purge removes the file nobody points at.
  let documentId = null;
  if (chosen && documentStorageReady) {
    try {
      const doc = await uploadDocument({ buffer: chosen.content, fileName: chosen.name || 'quotation.pdf', contentType: 'application/pdf', owner: 'quotations' });
      documentId = doc.id;
    } catch (err) {
      console.warn('[auto-quotation] the PDF could not be stored:', err.message);
    }
  }
  return { ok: true, ai_calls: 1, extraction: checked.extraction, linesOk: checked.linesOk, printed: checked.printed, documentId, fromPdf: Boolean(chosen) };
}

/** A catalogue service, only on an exact match of its name or code. Never guessed. */
async function serviceId(db, name) {
  if (!name) return null;
  const { rows: [s] } = await db.query(
    `SELECT id FROM services WHERE lower(btrim(name)) = lower(btrim($1)) OR (code IS NOT NULL AND lower(btrim(code)) = lower(btrim($1))) ORDER BY id LIMIT 1`, [name]);
  return s?.id ?? null;
}

async function insertLines(db, quotationId, lines) {
  for (const [i, l] of lines.entries()) {
    await db.query(
      `INSERT INTO quotation_lines (quotation_id, service_id, description, qty, unit, rate, discount_percent, gst_rate, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [quotationId, await serviceId(db, l.service), l.description, l.qty, l.unit, l.rate, l.discount_percent, l.gst_rate, i]);
  }
}

/** A printed number in the tracker's own series moves the series past it. */
async function moveCounterPast(db, no) {
  const m = /^CTZ\/QT\/(\d{4})\/(\d+)$/.exec(no);
  if (!m) return;
  await db.query(
    `INSERT INTO sequence_counters (kind, year, last_n) VALUES ('quotation', $1, $2)
     ON CONFLICT (kind, year) DO UPDATE SET last_n = GREATEST(sequence_counters.last_n, EXCLUDED.last_n)`, [m[1], Number(m[2])]);
}

const istDate = (iso) => new Date(new Date(iso).getTime() + 330 * 60_000).toISOString().slice(0, 10);

export async function create(db, { account, cand, prepared, client, owner }) {
  const { m } = cand;
  const x = prepared.extraction;
  const sentOn = istDate(m.sent_at);
  const { rows: [{ id: companyId }] } = await db.query('SELECT company_for($1) AS id', [client]);
  const printedNo = x.quotation_no_printed;

  if (printedNo) {
    const { rows: [existing] } = await db.query('SELECT * FROM quotations WHERE quotation_no = $1 FOR UPDATE', [printedNo]);
    if (existing && existing.company_id === companyId) {
      // The same quotation again: a resend creates nothing; a higher
      // revision goes through the revision path, keeping the old version.
      if (x.revision <= existing.revision) return { repeated: true, quotation_no: existing.quotation_no, printed: {} };
      await revise(db, existing, x, prepared, m, account);
      return { revised: true, quotation_no: existing.quotation_no, total: x.total, printed: prepared.printed };
    }
  }

  const clash = Boolean(printedNo) && (await db.query('SELECT 1 FROM quotations WHERE quotation_no = $1', [printedNo])).rows.length > 0;
  const no = printedNo && !clash ? printedNo : await claimNextId('quotation', db, x.quotation_date.slice(0, 4));
  if (no === printedNo) await moveCounterPast(db, no);
  const services = [...new Set(x.lines.map((l) => l.service).filter(Boolean))].join(', ') || null;
  const remarks = [`Read from the PDF emailed to ${client} on ${sentOn} by ${account.email}.`, printedNo && no !== printedNo ? `Printed number: ${printedNo}.` : null].filter(Boolean).join(' ');
  const noLines = !prepared.linesOk;
  const { rows: [q] } = await db.query(
    `INSERT INTO quotations (quotation_no, client_name, contact_person, country, quotation_date, valid_until, revision, currency, terms, place_of_supply_state,
                             status, sent_at, service_quoted, owner_user_id, sales_person, remarks, document_id,
                             subtotal, tax_total, total, quotation_value)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'Submitted',$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
    [no, client, x.client.contact_name, x.client.country, x.quotation_date, x.valid_until, x.revision, x.currency, x.terms, x.client.state,
      m.sent_at, services, owner?.id ?? null, owner?.name ?? null, remarks, prepared.documentId,
      noLines ? x.subtotal : null, noLines ? x.tax_total : null, noLines ? x.total : null, x.total]);
  if (!noLines) await insertLines(db, q.id, x.lines);
  return { quotation_no: q.quotation_no, total: x.total, printed: prepared.printed };
}

/** A newer revision of a quotation we read before: the tracker's revision path, then the new figures. */
async function revise(db, q, x, prepared, m, account) {
  const { rows: lines } = await db.query('SELECT * FROM quotation_lines WHERE quotation_id = $1 ORDER BY sort_order, id', [q.id]);
  const snapshot = { quotation_no: q.quotation_no, revision: q.revision, quotation_date: q.quotation_date, valid_until: q.valid_until, quotation_value: q.quotation_value, subtotal: q.subtotal, tax_total: q.tax_total, total: q.total, currency: q.currency, terms: q.terms, sent_at: q.sent_at, lines };
  await db.query('INSERT INTO quotation_revisions (quotation_id, revision, snapshot, note, created_by) VALUES ($1,$2,$3,$4,$5)',
    [q.id, q.revision, JSON.stringify(snapshot), `Revised from the PDF emailed on ${istDate(m.sent_at)} by ${account.email}`, 'system']);
  await db.query('DELETE FROM quotation_lines WHERE quotation_id = $1', [q.id]);
  await db.query(
    `UPDATE quotations SET revision = $2, quotation_date = $3, valid_until = $4, sent_at = $5, accepted_at = NULL, accepted_by_name = NULL,
            terms = COALESCE($6, terms), document_id = COALESCE($7, document_id), currency = $8,
            subtotal = $9, tax_total = $10, total = $11, quotation_value = $11
      WHERE id = $1`,
    [q.id, x.revision, x.quotation_date, x.valid_until, m.sent_at, x.terms, prepared.documentId, x.currency,
      prepared.linesOk ? null : x.subtotal, prepared.linesOk ? null : x.tax_total, x.total]);
  if (prepared.linesOk) await insertLines(db, q.id, x.lines);
}

/** Quotations read from email, for the list filter and the quotation page. */
export async function readFromEmail(quotationNo, db = { query }) {
  const { rows: [d] } = await db.query(
    `SELECT d.quotation_extraction, d.received_at, d.thread_id, d.printed_total,
            NOT EXISTS (SELECT 1 FROM quotation_lines l JOIN quotations q ON q.id = l.quotation_id WHERE q.quotation_no = d.quotation_no) AS no_lines,
            -- Somebody checked it against the PDF since it was last read: an event, in the activity log.
            EXISTS (SELECT 1 FROM activity_log a WHERE a.action = 'quotation.email_read_checked' AND a.entity_type = 'quotation'
                     AND a.entity_id = d.quotation_no AND a.created_at >= d.decided_at) AS checked
       FROM email_enquiry_decisions d WHERE d.quotation_no = $1 AND d.quotation_extraction IN ('created','revised')
      ORDER BY d.decided_at DESC, d.id DESC LIMIT 1`, [quotationNo]);
  return d || null;
}
