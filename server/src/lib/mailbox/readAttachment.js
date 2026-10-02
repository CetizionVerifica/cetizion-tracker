/**
 * Read one document from an email with the AI (docs/email-po-plan.md §3.2,
 * §3.10.2): the PDF attachment best ranked, its text (or the file itself
 * for a scan, through OCR), or the email's own text when nothing is
 * attached; then one AI call. The PO reader and the invoice reader share it.
 */
import { mainText } from './enquiryDetect.js';
import { MAX_PDF_BYTES, SCANNED_BELOW, isPdf, pdfText } from './pdfQuotation.js';
import { providerFor } from './sync.js';

/**
 * options:
 *   rank(files)            best first; files are [{ name, size, firstPage }]
 *   prompt({ pdfText })    { system, user }; pdfText is the text, null for a
 *                          scan (the file goes instead), '' with no PDF
 *   parse(raw)             the AI's answer in its fixed shape
 *   fileName               a name for the file when it has none
 *   requirePdf             true: no PDF attached means no AI call; returns { noPdf: true }
 * Returns
 *   { verdict, sourceText, allText, pdf, ai_calls }   read
 *   { unreadable: true, ai_calls: 0 }                 an encrypted or broken PDF
 *   { error }                                         try again later
 * sourceText is what amounts are checked against: the PDF's text, the
 * email's when the email is the document, or null for a scan.
 */
export async function readWithAi(account, cand, ctx, chat, { rank, prompt, parse, fileName = 'document.pdf', requirePdf = false }) {
  const { m } = cand;
  let chosen = null; let text = null;
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
    chosen = rank(read.map((f) => ({ ...f, firstPage: f.pages?.[0] || '' })))[0] || null;
    if (chosen && !chosen.pages) return { unreadable: true, ai_calls: 0 };
    if (chosen) text = chosen.pages.join('\n\n');
  }
  // Only the mailbox knows what is attached: a live message says only that
  // something is. An image or a spreadsheet is not worth an AI call.
  if (requirePdf && !chosen) return { noPdf: true, ai_calls: 0 };
  const scanned = chosen && (text || '').replace(/\s+/g, '').length < SCANNED_BELOW;
  const bodyText = mainText(m.body_html || '', 30_000);
  const { system, user } = prompt({ pdfText: chosen ? (scanned ? null : text) : '' });
  ctx.aiUsed += 1;
  let raw;
  try {
    raw = scanned
      // A scan: the file itself goes, for OCR, with the same zero-retention routing.
      ? await chat(system, [
        { type: 'text', text: user },
        { type: 'file', file: { filename: chosen.name || fileName, file_data: `data:application/pdf;base64,${chosen.content.toString('base64')}` } },
      ], { maxTokens: 3000, timeoutMs: 90_000, plugins: [{ id: 'file-parser', pdf: { engine: 'mistral-ocr' } }] })
      : await chat(system, user, { maxTokens: 3000, timeoutMs: 60_000 });
  } catch (err) {
    // Counted against the ceiling, but nothing is logged: the next run tries again.
    return { error: err.message };
  }
  const sourceText = chosen ? (scanned ? null : text) : `${m.subject || ''}\n${bodyText}`;
  return {
    verdict: parse(raw), sourceText, allText: `${m.subject || ''}\n${bodyText}\n${text || ''}`,
    pdf: chosen ? { content: chosen.content, name: chosen.name } : null, ai_calls: 1,
  };
}
