/**
 * The rules of mailbox sync (#29), kept free of the database and the
 * provider so they can be tested on their own.
 */
import crypto from 'node:crypto';
import sanitizeHtml from 'sanitize-html';
import { QUOTE_CLASSES, splitQuoted } from './quotes.js';

export const addr = (s) => String(s || '').trim().toLowerCase();
export const domainOf = (email) => addr(email).split('@')[1] || '';

/** Free-mail domains never identify a company. */
export const PUBLIC_DOMAINS = new Set(['gmail.com', 'yahoo.com', 'yahoo.co.in', 'outlook.com', 'hotmail.com', 'live.com', 'icloud.com', 'rediffmail.com', 'proton.me', 'protonmail.com', 'aol.com', 'zoho.com']);

export function isBlocked(email, blocklist = []) {
  const e = addr(email); const d = domainOf(e);
  return blocklist.some((p) => {
    const x = addr(p).replace(/^\*?@/, '');
    return x === e || x === d || (x.startsWith('*.') && d.endsWith(x.slice(1)));
  }) || /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|notifications?)@/.test(e);
}

/**
 * Who a message is with, and whether to keep it.
 * message: { from: {email,name}, to: [{email,name}], cc: [...] }
 * Returns { direction, external: [{email,name}], skip: reason|null }.
 */
export function classify(message, { accountEmail, internalDomains = [], blocklist = [], excludeInternal = true } = {}) {
  const internal = new Set(internalDomains.map(addr).filter(Boolean));
  const mine = addr(accountEmail);
  const from = message.from || {};
  const fromInternal = addr(from.email) === mine || internal.has(domainOf(from.email));
  const direction = fromInternal ? 'outbound' : 'inbound';
  const everyone = [from, ...(message.to || []), ...(message.cc || [])].filter((p) => p && p.email);
  const seen = new Set();
  const external = everyone.filter((p) => {
    const e = addr(p.email);
    if (seen.has(e) || e === mine || internal.has(domainOf(e))) return false;
    seen.add(e);
    return true;
  });
  if (!external.length) return { direction, external, skip: excludeInternal ? 'internal only' : null };
  const kept = external.filter((p) => !isBlocked(p.email, blocklist));
  if (!kept.length) return { direction, external: [], skip: 'blocked sender' };
  return { direction, external: kept, skip: null };
}

/** What a mailbox's owner agreed to share. */
export function applyVisibility(msg, visibility) {
  if (visibility === 'share_everything') return msg;
  if (visibility === 'subject') return { ...msg, snippet: null, body_html: null };
  return { ...msg, subject: null, snippet: null, body_html: null };
}

/**
 * Plain text preview of an HTML body.
 *
 * The quoted history comes off first. A reply is mostly the message it is
 * replying to, so taking the first 240 characters of the raw body gave a
 * preview that was two lines of answer and then our own previous email
 * read back to us — the one thing the reader already knows.
 */
export function snippet(html, max = 240) {
  const text = String(splitQuoted(html).main || '')
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Remove what a stored email must never run: scripts, handlers, remote
 * frames, forms.
 *
 * A parser rather than a list of regular expressions. The regexes this
 * replaced let `<img src=x/onerror=...>` through -- they required
 * whitespace before the handler -- and an entity-encoded `javascript:`
 * href with it. Neither was exploitable, because EmailThread.jsx renders
 * this into an <iframe sandbox="">; that one attribute was the entire
 * defence, which is not where a defence should live.
 *
 * The allow-list is what an email legitimately is: text, lists, tables,
 * links, images. Everything else, and every attribute not named here, is
 * dropped rather than escaped, because a stored email is read, not edited.
 */
const SANITIZE = {
  allowedTags: [
    'p', 'div', 'span', 'br', 'hr', 'b', 'strong', 'i', 'em', 'u', 's', 'sub', 'sup', 'small',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'code',
    'ul', 'ol', 'li', 'dl', 'dt', 'dd',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
    'a', 'img', 'figure', 'figcaption',
  ],
  allowedAttributes: {
    a: ['href', 'title', 'name', 'target', 'rel'],
    img: ['src', 'alt', 'title', 'width', 'height'],
    // Where the quote starts, and nothing else.
    //
    // Mail clients mark the quoted history with a class, an id or
    // type="cite", and stripping all three left no way to tell a reply's
    // two new lines from the four screens of history under them — so the
    // preview quoted our own last email back at us, and the reading pane
    // had nothing to collapse. These are inert: no script runs here, the
    // style tag and style attribute are both discarded, and the body is
    // rendered in an iframe with its own document, so a class from an
    // email cannot reach the app's own CSS.
    div: ['id'],
    blockquote: ['type'],
    td: ['colspan', 'rowspan', 'align'],
    th: ['colspan', 'rowspan', 'align', 'scope'],
    col: ['span', 'width'],
    table: ['border', 'cellpadding', 'cellspacing', 'width'],
  },
  // http, https and mailto only: no javascript:, no data: smuggled into a
  // link, no tel: that a click could dial.
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: { img: ['http', 'https', 'cid', 'data'] },
  allowProtocolRelative: false,
  // Only the class names that mark a quoted reply survive; every other
  // class is dropped, so this is a boundary marker and not a way for an
  // email to carry styling hooks into the frame.
  allowedClasses: { '*': QUOTE_CLASSES },
  disallowedTagsMode: 'discard',
  // A link opened from a stored email opens away from the tracker, and
  // cannot reach back through window.opener.
  transformTags: { a: sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer' }) },
};

export function cleanHtml(html) {
  if (!html) return '';
  return sanitizeHtml(String(html), SANITIZE);
}

/** Record numbers mentioned in a subject, most specific first. */
export function referencesIn(subject) {
  const s = String(subject || '');
  return {
    quotations: [...s.matchAll(/\b[A-Z]{2,6}\/QT\/\d{4}\/\d{1,5}\b/g)].map((m) => m[0]),
    enquiries: [...s.matchAll(/\b[A-Z]{2,6}\/ENQ\/\d{4}\/\d{1,5}\b/g)].map((m) => m[0]),
    pos: [...s.matchAll(/\bPO[-\s]?\d{3,}\b/gi)].map((m) => m[0].toUpperCase().replace(/\s/, '-')),
  };
}

// Tokens at rest: AES-256-GCM, key from MAIL_TOKEN_KEY.
const keyFrom = (secret) => crypto.createHash('sha256').update(String(secret)).digest();

export function sealTokens(tokens, secret) {
  if (!secret) throw new Error('MAIL_TOKEN_KEY is not set');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keyFrom(secret), iv);
  const body = Buffer.concat([c.update(JSON.stringify(tokens), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), body.toString('base64')].join('.');
}

export function openTokens(sealed, secret) {
  if (!sealed) return null;
  if (!secret) throw new Error('MAIL_TOKEN_KEY is not set');
  const [v, iv, tag, body] = String(sealed).split('.');
  if (v !== 'v1') throw new Error('Unknown token format');
  const d = crypto.createDecipheriv('aes-256-gcm', keyFrom(secret), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(body, 'base64')), d.final()]).toString('utf8'));
}
