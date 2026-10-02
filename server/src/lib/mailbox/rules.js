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
 * links, images, and the styling that makes it look like the message the
 * sender actually wrote. Everything else, and every attribute not named
 * here, is dropped rather than escaped, because a stored email is read,
 * not edited.
 *
 * Styling used to be dropped with everything else, and the result was that
 * a designed email — every marketing mail, every invoice, most things a
 * client's system sends — arrived as bare paragraphs and a borderless
 * table. It read as a broken page rather than as their message.
 *
 * What makes it safe to keep is not this list: it is where the body is
 * rendered. web/src/lib/mailFrame.js puts it in an iframe under a content
 * policy of `default-src 'none'`, and that is what answers every way CSS
 * can be turned into a weapon:
 *
 *   @import url(https://…)        style-src names no host, so it is refused
 *   background: url(https://…)    img-src is data: and cid: until somebody
 *                                 asks for images, so the CSS tracking
 *                                 pixel is blocked exactly as the <img>
 *                                 one is
 *   @font-face src: url(…)        font-src 'none'
 *   url(javascript:…)             script-src 'none'
 *   position: fixed, z-index      cannot leave the frame it is drawn in
 *
 * The iframe was always the isolation; it is only now being relied on for
 * what it was built to do. Scripts, handlers, frames and forms are still
 * dropped here, because those are not a rendering question.
 */
const SANITIZE = {
  allowedTags: [
    'p', 'div', 'span', 'br', 'hr', 'b', 'strong', 'i', 'em', 'u', 's', 'sub', 'sup', 'small',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'code',
    'ul', 'ol', 'li', 'dl', 'dt', 'dd',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
    'a', 'img', 'figure', 'figcaption',
    // Email is written in 1999 HTML because that is what mail clients
    // render: layout tables, <center>, <font>, and a <style> block that
    // Gmail keeps and most senders still ship.
    'style', 'center', 'font',
  ],
  // sanitize-html calls <style> vulnerable, and in a page it is. This body
  // is never in the page — see the note above the list.
  allowVulnerableTags: true,
  allowedAttributes: {
    // The styling itself. Kept unfiltered rather than whitelisted by
    // property: a whitelist long enough to render real mail correctly is
    // no smaller a surface, and it fails silently on whatever it forgot.
    '*': ['style', 'class', 'id', 'align', 'valign', 'dir', 'lang', 'title', 'bgcolor', 'width', 'height'],
    a: ['href', 'title', 'name', 'target', 'rel'],
    img: ['src', 'alt', 'title', 'width', 'height'],
    font: ['color', 'face', 'size'],
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
    td: ['colspan', 'rowspan', 'align', 'background'],
    th: ['colspan', 'rowspan', 'align', 'scope', 'background'],
    col: ['span', 'width'],
    table: ['border', 'cellpadding', 'cellspacing', 'width', 'background'],
  },
  // http, https and mailto only: no javascript:, no data: smuggled into a
  // link, no tel: that a click could dial.
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: { img: ['http', 'https', 'cid', 'data'] },
  allowProtocolRelative: false,
  // Every class survives now. It used to be only the ones marking a quoted
  // reply, on the reasoning that anything else was a styling hook — which
  // it is, and which is the point: a <style> block with no classes to
  // reach styles nothing. The quote markers still matter and are still
  // here, they are simply no longer the only ones (QUOTE_CLASSES).
  allowedClasses: false,
  disallowedTagsMode: 'discard',
  // A link opened from a stored email opens away from the tracker, and
  // cannot reach back through window.opener.
  transformTags: { a: sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer' }) },
};

export function cleanHtml(html) {
  if (!html) return '';
  return sanitizeHtml(String(html), SANITIZE);
}

/** Newsletters and automated mail, by their text and by their sender. */
export const BULK = /\bunsubscribe\b|view (it |this (email|message) )?in (your |a )?browser|this is an automated (message|email)|do not reply to this (email|message)/i;
export const BULK_SENDER = /^(newsletters?|marketing|news|mailer|bounces?|campaigns?|updates|digest)[@.+-]/i;

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
