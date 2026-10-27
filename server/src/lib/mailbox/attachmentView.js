/**
 * What an email attachment looks like in the tracker's viewer
 * (docs/inbox-attachments-plan.md §3, step 1). Attachments are viewed in
 * the Inbox, never downloaded: a PDF or a picture goes to the browser as
 * bytes it draws itself (pdf.js, an <img>), and a spreadsheet or a text
 * file is turned into plain data here, so nothing in the file ever runs.
 *
 *   pdf     application/pdf                      bytes, drawn by pdf.js
 *   image   png, jpeg, gif, webp, bmp, svg       bytes, drawn by an <img>
 *   sheet   xlsx, xls, xlsm, ods, csv            { sheets: [{ name, rows, truncated }] }
 *   text    txt, log, json, xml, md              { text, truncated }
 *   word    docx                                 { html } (step 2), cleaned like a mail body
 *   email   an email forwarded as an attachment  { from, to, cc, subject, sent_at, html } (step 2)
 *   office  pptx, ppt, pps(x), doc, rtf, odt, odp a PDF, converted by LibreOffice (step 3, officeConvert.js)
 *
 * Anything else (archives, programs, a OneDrive link) is not viewable and
 * says so; so is an `office` file while no converter is configured.
 */
import mammoth from 'mammoth';
import XLSX from 'xlsx';
import { converterConfigured } from './officeConvert.js';
import { cleanHtml } from './rules.js';

/** The most rows and columns a sheet shows; a note says when there was more. */
export const SHEET_MAX_ROWS = 2000;
export const SHEET_MAX_COLS = 60;
/** The most characters a text file shows. */
export const TEXT_MAX_CHARS = 1024 * 1024;

const ext = (name) => (/\.([a-z0-9]{1,8})$/i.exec(String(name || ''))?.[1] || '').toLowerCase();

const IMAGE_TYPES = /^image\/(png|jpe?g|gif|webp|bmp|svg\+xml)$/i;
const IMAGE_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml' };
const SHEET_TYPES = /^(application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet|application\/vnd\.ms-excel(\.sheet\.macroenabled\.12)?|application\/vnd\.oasis\.opendocument\.spreadsheet|text\/csv)$/i;
const SHEET_EXT = new Set(['xlsx', 'xls', 'xlsm', 'ods', 'csv']);
const TEXT_TYPES = /^(text\/plain|application\/json|application\/xml|text\/xml|text\/markdown)$/i;
const TEXT_EXT = new Set(['txt', 'log', 'json', 'xml', 'md']);
const WORD_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
/** The formats LibreOffice turns into a PDF, by type, with the extension it reads them by. */
const OFFICE_TYPES = {
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.openxmlformats-officedocument.presentationml.slideshow': 'ppsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.ms-powerpoint.presentation.macroenabled.12': 'pptm',
  'application/msword': 'doc',
  'application/rtf': 'rtf',
  'text/rtf': 'rtf',
  'application/vnd.oasis.opendocument.text': 'odt',
  'application/vnd.oasis.opendocument.presentation': 'odp',
};
const OFFICE_EXT = new Set(['pptx', 'ppsx', 'ppt', 'pps', 'pptm', 'doc', 'rtf', 'odt', 'odp']);

/**
 * How an attachment is shown, from its declared type and, when a mail
 * client sent the vague `application/octet-stream`, its name. null when
 * the viewer cannot show it.
 */
export function viewKind({ name, content_type: type, kind = 'file' } = {}) {
  if (kind === 'item') return 'email';
  if (kind === 'reference') return null;
  const t = String(type || '').toLowerCase().split(';')[0].trim();
  const e = ext(name);
  const vague = !t || t === 'application/octet-stream';
  if (t === WORD_TYPE || e === 'docx') return 'word';
  if (OFFICE_EXT.has(e) || OFFICE_TYPES[t]) return 'office';
  if (t === 'application/pdf' || (vague && e === 'pdf')) return 'pdf';
  if (IMAGE_TYPES.test(t) || (vague && IMAGE_EXT[e])) return 'image';
  if (SHEET_TYPES.test(t) || SHEET_EXT.has(e)) return 'sheet';
  if (TEXT_TYPES.test(t) || ((vague || t.startsWith('text/')) && TEXT_EXT.has(e))) return 'text';
  return null;
}

/** The extension LibreOffice reads an `office` file by: its own, or the one its type gives. */
export function officeExt(att) {
  const e = ext(att.name);
  if (OFFICE_EXT.has(e)) return e;
  return OFFICE_TYPES[String(att.content_type || '').toLowerCase().split(';')[0].trim()] || null;
}

/** The type the bytes are served under: the declared one, or the one the name gives a vague type. */
export function viewType(att) {
  const t = String(att.content_type || '').toLowerCase().split(';')[0].trim();
  if (viewKind(att) === 'pdf') return 'application/pdf';
  if (IMAGE_TYPES.test(t)) return t;
  return IMAGE_EXT[ext(att.name)] || 'application/octet-stream';
}

/**
 * One attachment as the reading pane lists it: what it is, how the viewer
 * shows it (`view`: pdf, image, sheet, text, word, email, office, or null
 * for not viewable — an office file too while no converter is set up), and
 * where the viewer reads it — null for a caller who may not open it.
 * Shared by the message route (routes/mail.js) and the thread route
 * (routes/mailboxes.js).
 */
export const publicAttachment = (messageId, a, canView) => {
  const view = viewKind(a);
  return {
    id: a.id, name: a.name, content_type: a.content_type, size_bytes: a.size_bytes, is_inline: a.is_inline, content_id: a.content_id,
    kind: a.kind || 'file',
    view: view === 'office' && !converterConfigured() ? null : view,
    view_url: canView ? `/api/mail/messages/${messageId}/attachments/${a.id}/view` : null,
  };
};

const cellText = (v) => (v === null || v === undefined ? '' : String(v));

/**
 * A spreadsheet as rows of text, sheet by sheet: values as the sheet shows
 * them (formatted, never formulas), capped in rows and columns. A CSV is
 * read as text, so a number keeps the digits it was written with.
 */
export function toSheets(buffer, { name } = {}) {
  const csv = ext(name) === 'csv' && !(buffer[0] === 0x50 && buffer[1] === 0x4b);
  const opts = { sheetRows: SHEET_MAX_ROWS + 1, cellFormula: false, cellHTML: false, cellStyles: false, bookVBA: false };
  const wb = csv
    ? XLSX.read(buffer.toString('utf8').replace(/^﻿/, ''), { ...opts, type: 'string', raw: true })
    : XLSX.read(buffer, { ...opts, type: 'buffer' });
  return wb.SheetNames.map((sheetName) => {
    const ws = wb.Sheets[sheetName];
    const all = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '', blankrows: true });
    const wide = all.some((r) => r.length > SHEET_MAX_COLS);
    const rows = all.slice(0, SHEET_MAX_ROWS).map((r) => r.slice(0, SHEET_MAX_COLS).map(cellText));
    // Trailing empty rows say nothing.
    while (rows.length && rows[rows.length - 1].every((c) => c === '')) rows.pop();
    return { name: sheetName, rows, truncated: all.length > SHEET_MAX_ROWS || wide };
  });
}

/** A text file as text, cut at TEXT_MAX_CHARS. */
export function toText(buffer) {
  const text = buffer.toString('utf8').replace(/^﻿/, '');
  return { text: text.slice(0, TEXT_MAX_CHARS), truncated: text.length > TEXT_MAX_CHARS };
}

/**
 * A Word document as HTML (mammoth): headings, paragraphs, lists, tables
 * and pictures, without the page layout (headers, footers, columns).
 * Cleaned with the same rules as a mail body, so it is shown the same way:
 * in the sandboxed, script-free frame.
 */
export async function toHtml(buffer) {
  const { value } = await mammoth.convertToHtml({ buffer });
  return { html: cleanHtml(value) };
}

/** A forwarded email, as the viewer shows it: who, when, and the cleaned body. */
export const forwardedEmail = (m) => ({
  subject: m.subject || null,
  from: m.from || null,
  to: m.to || [],
  cc: m.cc || [],
  sent_at: m.sent_at || null,
  html: cleanHtml(m.body_html || ''),
});
