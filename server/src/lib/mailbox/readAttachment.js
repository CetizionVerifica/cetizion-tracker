/**
 * Read one document from an email with the AI (docs/email-po-plan.md §3.2,
 * §3.10.2): the PDF attachment best ranked, its text (or the file itself
 * for a scan, through OCR), or the email's own text when nothing is
 * attached; then one AI call. The PO reader and the invoice reader share it.
 *
 * With `annexures`, the email's other text PDFs (a schedule of rates, the
 * terms) go after the chosen one, for the model to read the order whole.
 * Amounts are still checked against the chosen PDF alone: a figure the
 * model took from an annexure sends the read to review, never through.
 *
 * A model that reads PDFs (lib/ai.js readsPdf) is sent the file itself,
 * with its text layer alongside (docs/email-auto-entry-plan.md §3.1): our
 * invoices are a letterhead in text and the whole invoice as one image, so
 * their text layer has no number and no amount in it. Whether the text
 * layer holds the document is judged after the read, by whether the
 * document's own number is in it. When it does not, the amounts cannot be
 * checked against it, so a second model reads the file independently and
 * the two readings must agree (§3.7).
 */
import { aiConfig, readsPdf } from '../ai.js';
import { mainText } from './enquiryDetect.js';
import { MAX_PDF_BYTES, SCANNED_BELOW, isPdf, pdfText } from './pdfQuotation.js';
import { providerFor } from './sync.js';
import { DOCUMENT_MAX_TOKENS, DOCUMENT_TIMEOUT_MS, MAX_DOCUMENT_TEXT, OCR_TIMEOUT_MS } from './readLimits.js';

/**
 * options:
 *   rank(files)            best first; files are [{ name, size, firstPage }]
 *   prompt({ pdfText })    { system, user }; pdfText is the text, null for a
 *                          scan (the file goes instead), '' with no PDF
 *   parse(raw)             the AI's answer in its fixed shape
 *   fileName               a name for the file when it has none
 *   requirePdf             true: no PDF attached means no AI call; returns { noPdf: true }
 *   annexures              true: the other text PDFs go too, after the chosen one
 *   schema                 { name, schema }: the answer's JSON Schema (§3.5)
 *   ownNumber(verdict)     the document's own number as read, to tell a
 *                          text PDF from an image one
 *   disagree(a, b)         the fields two readings differ on, [] when they agree
 * Returns
 *   { verdict, sourceText, allText, pdf, ai_calls, disagreed }   read
 *   { unreadable: true, ai_calls: 0 }                 an encrypted or broken PDF
 *   { error }                                         try again later
 * sourceText is what amounts are checked against: the PDF's text, the
 * email's when the email is the document, or null for a scan or an image
 * PDF. disagreed lists the fields a second reading of an image PDF read
 * differently; empty when it agreed or was not needed.
 */
export async function readWithAi(account, cand, ctx, chat, { rank, prompt, parse, fileName = 'document.pdf', requirePdf = false, annexures = false, schema = null, ownNumber = null, disagree = null }) {
  const { m } = cand;
  let chosen = null; let text = null; let others = [];
  if (m.has_attachments) {
    let files;
    try {
      const provider = ctx.provider || providerFor(account);
      files = (await provider.attachments(m.provider_id)).filter((a) => isPdf(a) && a.content && a.content.length <= MAX_PDF_BYTES);
    } catch (err) {
      return { error: err.message };
    }
    const read = [];
    for (const f of files) {
      try {
        read.push({ ...f, pages: await pdfText(f.content) });
      } catch (err) {
        read.push({ ...f, pages: null, error: err.code || 'unreadable' });
      }
    }
    const ranked = rank(read.map((f) => ({ ...f, firstPage: f.pages?.[0] || '' })));
    chosen = ranked[0] || null;
    if (chosen && !chosen.pages) return { unreadable: true, ai_calls: 0 };
    if (chosen) text = chosen.pages.join('\n\n');
    // A scanned annexure is left out: one OCR per read is enough.
    if (chosen && annexures) {
      others = ranked.slice(1).filter((f) => f.pages)
        .map((f) => ({ name: f.name || 'annexure.pdf', text: f.pages.join('\n\n') }))
        .filter((f) => f.text.replace(/\s+/g, '').length >= SCANNED_BELOW);
    }
  }
  // Only the mailbox knows what is attached: a live message says only that
  // something is. An image or a spreadsheet is not worth an AI call.
  if (requirePdf && !chosen) return { noPdf: true, ai_calls: 0 };
  const scanned = chosen && (text || '').replace(/\s+/g, '').length < SCANNED_BELOW;
  const native = Boolean(chosen) && (ctx.readsPdf ?? readsPdf());
  const bodyText = mainText(m.body_html || '', 30_000);
  const asked = prompt({ pdfText: chosen ? (scanned ? null : text) : '' });
  const { system } = asked;
  let user = others.length ? `${asked.user}${annexureText(others, MAX_DOCUMENT_TEXT - (scanned ? 0 : Math.min(text.length, MAX_DOCUMENT_TEXT)))}` : asked.user;
  if (native && !scanned) user += `\n\n${TEXT_LAYER_NOTE}`;
  const file = chosen && { type: 'file', file: { filename: chosen.name || fileName, file_data: `data:application/pdf;base64,${chosen.content.toString('base64')}` } };
  // The file goes whole to a model that reads PDFs (and to the second
  // reader, which does), and through OCR to one that does not when it is a
  // scan; always with the same zero-retention routing.
  const ask = (opts = {}) => (native || scanned || opts.model
    ? chat(system, [{ type: 'text', text: user }, file], {
      maxTokens: DOCUMENT_MAX_TOKENS, timeoutMs: OCR_TIMEOUT_MS, schema,
      plugins: [{ id: 'file-parser', pdf: { engine: native || opts.model ? 'native' : 'mistral-ocr' } }], ...opts,
    })
    : chat(system, user, { maxTokens: DOCUMENT_MAX_TOKENS, timeoutMs: DOCUMENT_TIMEOUT_MS, schema, ...opts }));
  ctx.aiUsed += 1;
  let raw;
  try {
    raw = await ask();
  } catch (err) {
    // Counted against the ceiling, but nothing is logged: the next run tries again.
    return { error: err.message };
  }
  const verdict = parse(raw);
  // A text layer without the document's own number is a letterhead around
  // an image: the amounts cannot be found in it.
  const own = chosen && !scanned && ownNumber ? squash(ownNumber(verdict)) : '';
  const imageOnly = Boolean(chosen) && (scanned || (own !== '' && !squash(text).includes(own)));
  let aiCalls = 1;
  let disagreed = [];
  if (imageOnly && disagree && ctx.secondReader !== false && aiConfig.checkModel) {
    ctx.aiUsed += 1;
    aiCalls += 1;
    try {
      disagreed = disagree(verdict, parse(await ask({ model: aiConfig.checkModel })));
    } catch (err) {
      return { error: err.message };
    }
  }
  const sourceText = chosen ? (imageOnly ? null : text) : `${m.subject || ''}\n${bodyText}`;
  return {
    verdict, sourceText, allText: `${m.subject || ''}\n${bodyText}\n${text || ''}`,
    pdf: chosen ? { content: chosen.content, name: chosen.name } : null, ai_calls: aiCalls, disagreed,
  };
}

const TEXT_LAYER_NOTE = 'The PDF itself is attached. Read the document from its pages: the text above is only its text layer, and anything printed as an image (often the whole table of an invoice) is missing from it.';

/** Letters and digits only, upper case: "CVPL/2026-27/037" and "CVPL 2026 27 037" are one number. */
const squash = (v) => String(v || '').toUpperCase().replace(/[^0-9A-Z]/g, '');

/**
 * The fields two readings of one document differ on. A field is a text
 * (compared as letters and digits) or an amount (compared to the rupee);
 * one both readings left empty agrees.
 */
export function fieldsDiffer(a, b, fields) {
  return fields.filter((k) => {
    const x = a?.[k] ?? null; const y = b?.[k] ?? null;
    if (x === null && y === null) return false;
    if (typeof x === 'number' || typeof y === 'number') return !(Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) < 1);
    return squash(x) !== squash(y);
  });
}

const FIELD_NAMES = {
  invoice_no: 'the invoice number', invoice_date: 'the invoice date', po_reference: 'the PO number', total_value: 'the total',
  po_number: 'the PO number', po_date: 'the PO date', basic_value: 'the value before tax',
};

/** The review note for two readings that differ: which fields, never their text. */
export const disagreeNote = (fields) => `The PDF is an image, so it was read twice; the readings differ on ${fields.map((f) => FIELD_NAMES[f] || f).join(', ')}.`;

/** The other PDFs' text, each under its file name, within what is left of the document budget. */
function annexureText(others, room) {
  let out = '';
  for (const f of others) {
    const head = `\n\nAlso attached to the same email, for reference (${f.name}):\n`;
    if (room - out.length <= head.length) break;
    out += `${head}${f.text}`.slice(0, room - out.length);
  }
  return out;
}
