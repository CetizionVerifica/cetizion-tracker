/**
 * The document a message's HTML is rendered inside.
 *
 * A remote image in a client's email is a read receipt. The sanitiser keeps
 * `<img src="https://…">`, and rightly — an email stripped of its images is
 * often unreadable — and `sandbox` does not stop the frame fetching them.
 * So opening a thread told the sender the minute we read it and the address
 * we read it from. On a live negotiation that is the client watching us sit
 * on their revised terms at 23:40.
 *
 * The content policy is what blocks that; the sandbox never could. It lives
 * here, apart from the component, because it is the security boundary of
 * the whole inbox and it is a string — the one part of this screen worth
 * asserting on directly rather than through a browser.
 */
import DOMPurify from 'dompurify';

/** Did the sender style this, or is it bare structure? */
export const hasOwnStyling = (html) => /<style[\s>]|style\s*=/i.test(String(html || ''));

/** Does this message pull anything from the network? */
export const hasRemoteImage = (html) => /<img\b[^>]*\bsrc\s*=\s*["']?https?:/i.test(String(html || ''));


/**
 * A second sanitiser, in the browser, on HTML the server already cleaned.
 *
 * This is the library Zero uses (apps/mail/lib/email-utils.ts:
 * `DOMPurify.sanitize(html)`), and it is here for the reason a second one
 * is ever worth having: the server's pass happens once, at ingest, in
 * mailbox/sync.js — and that is not the only way a row reaches
 * email_threads. routes/portal.js writes one directly. A client that
 * sanitises whatever it is handed does not care which path the HTML came
 * down.
 *
 * Where this differs from Zero, deliberately: Zero calls sanitize with its
 * defaults and renders the result inline, which keeps every remote image
 * and so keeps every tracking pixel. Blocked images are the point of #105,
 * so the hook below strips a remote src at the DOM level as well, and the
 * frame's content policy still refuses the fetch underneath it. Either one
 * alone would do; a read receipt is worth both.
 */
const REMOTE = /^\s*https?:/i;

// Registered once. DOMPurify hooks are global, so the flag is what makes
// this call-specific — safe because sanitize() is synchronous and cannot
// interleave with another call.
let blockRemote = false;
let hooked = false;

function hook() {
  if (hooked || !DOMPurify.isSupported) return;
  DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
    if (!blockRemote || data.attrName !== 'src') return;
    if (REMOTE.test(data.attrValue)) {
      data.keepAttr = false;
      // Without this the browser resolves a src-less <img> against the
      // frame's own URL and draws a broken-image glyph where the picture
      // was; the placeholder says what happened instead.
      node.setAttribute?.('data-blocked', 'remote image');
    }
  });
  hooked = true;
}

/**
 * Clean a message body for display. Falls back to the input untouched when
 * there is no DOM to parse with — Node, a unit test — which is safe
 * because the server has already sanitised it and the frame's policy is
 * what stops the network either way.
 */
export function cleanMail(html, showImages = false) {
  const raw = String(html ?? '');
  if (!DOMPurify.isSupported) return raw;
  hook();
  blockRemote = !showImages;
  try {
    return DOMPurify.sanitize(raw, {
      // A stored email is read, not edited, so anything interactive goes.
      // <style> stays: it is the message's own design, and the frame's
      // content policy is what stops CSS reaching the network. <link> and
      // <base> do not, because those are how it would.
      FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'base', 'link', 'meta'],
      FORBID_ATTR: ['srcset', 'formaction', 'ping'],
      ALLOW_DATA_ATTR: false,
      // A <style> element belongs in the head, and DOMPurify parsing a
      // fragment has no head to put it in — so it drops it, and ADD_TAGS
      // alone does not change that. Parsing a whole document is what keeps
      // the message's own CSS.
      WHOLE_DOCUMENT: true,
      ADD_TAGS: ['style'],
      // No ALLOWED_URI_REGEXP here, deliberately. Overriding it was a
      // mistake: DOMPurify tests every attribute against that pattern, not
      // only the ones holding a URL, so a stricter one silently deleted
      // width="640", bgcolor, align and cellpadding — the attributes email
      // layout is actually built from. The default already refuses
      // javascript: and already permits cid:, which was the whole of what
      // the override was reaching for.
    });
  } finally {
    blockRemote = false;
  }
}

/**
 * Where a message's own inline images are served from
 * (docs/inbox-outlook-plan.md §3.3): the tracker's own route, which streams
 * the image from the mailbox for the one message it belongs to. A `cid:`
 * reference is a name inside the message; a browser cannot fetch one, so
 * every `src="cid:…"` is pointed here instead, and the frame's policy
 * allows this one path and nothing else of ours.
 */
export const inlineBase = (messageId) => `/api/mail/messages/${encodeURIComponent(messageId)}/inline/`;

/**
 * Point the message's `cid:` images at the inline route. Only the `src` of
 * an <img>: a `cid:` anywhere else (a link, a style) stays as it is and the
 * policy refuses it. The content id is the bare name, without the angle
 * brackets some clients write it with.
 */
export function rewriteCid(html, messageId) {
  if (!messageId) return String(html ?? '');
  const base = inlineBase(messageId);
  return String(html ?? '').replace(/(<img\b[^>]*?\bsrc\s*=\s*)(["']?)cid:(<[^<>"'\s]+>|[^"'\s>]+)\2/gi, (_, before, quote, cid) => {
    const id = decodeURIComponent(cid).replace(/^<|>$/g, '');
    return `${before}"${base}${encodeURIComponent(id)}"`;
  });
}

/**
 * The origin the inline route is read from, as the policy must spell it:
 * a srcdoc frame has its parent's origin, and `'self'` would open every
 * path of ours to the message. In Node (a unit test) there is no origin,
 * and no fetch happens either way.
 */
const inlineOrigin = () => (typeof window !== 'undefined' && window.location?.origin ? window.location.origin : null);

/**
 * `img-src data: cid:` keeps the images that travelled with the message and
 * drops every one that would go to the network. The rest of the list costs
 * nothing and is the second answer if the sanitiser is ever wrong about a
 * tag: no script, no frame, no form to post our session at, no connection
 * out, and `base-uri 'none'` so an email cannot repoint the <base> below
 * against us.
 *
 * `messageId` adds the one path of ours the frame may draw from: that
 * message's inline images (rewriteCid). Only that message's — a frame
 * showing one email cannot read another's attachments through it.
 */
export const framePolicy = (showImages, messageId = null) => [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  `img-src data: cid:${messageId ? ` ${inlineOrigin() || ''}${inlineBase(messageId)}` : ''}${showImages ? ' https:' : ''}`,
  "script-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "connect-src 'none'",
  "font-src 'none'",
  "media-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

/**
 * How a message reads once its own styling is gone.
 *
 * The server strips every `<style>` block and `style` attribute before the
 * message is stored (mailbox/rules.js), so what arrives here is bare
 * structural HTML: paragraphs, lists, tables, blockquotes. The browser's
 * defaults then rendered it as an unstyled 1998 web page — Times-ish
 * headings, `<table border="1">` drawn with the old inset 3D ridges, lists
 * jammed against the margin, and a line of body text running the full
 * width of a 900px pane.
 *
 * That is what this replaces. It is not decoration: an email is somebody's
 * commercial correspondence and most of what is left after sanitising is
 * structure, so the structure has to carry the reading. A measure it is
 * comfortable to read down, tables that look like tables, and a quoted
 * block that is visibly somebody else's words.
 *
 * Off-white rather than #fff: this sits in a dark application, and a pure
 * white slab at full brightness is a glare panel. #fbfbf9 is enough to take
 * the edge off without making the message look tinted or unread.
 */
const STYLE = `
html { -webkit-text-size-adjust: 100%; }
html, body { margin: 0; }
/* A designed email brings its own canvas and expects white under it. */
body { background: #ffffff; color: #23262b; font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; word-break: break-word; }
/* A bare one gets ours: paper, a margin, and a measure to read down.
   Everything below is a default the sender's own CSS overrides — theirs
   comes later in the document, and an inline style beats both. */
body.plain { background: #fbfbf9; padding: 16px 20px 18px; max-width: 680px; }
p { margin: 0 0 0.85em; }
p:last-child, ul:last-child, ol:last-child, table:last-child { margin-bottom: 0; }
h1, h2, h3, h4, h5, h6 { margin: 1.4em 0 0.5em; line-height: 1.3; font-weight: 600; }
h1 { font-size: 1.4em; } h2 { font-size: 1.25em; } h3 { font-size: 1.1em; }
h4, h5, h6 { font-size: 1em; }
ul, ol { margin: 0 0 0.85em; padding-left: 1.4em; }
li { margin: 0.2em 0; }
a { color: #0b5fa5; text-decoration: underline; text-underline-offset: 2px; }
img { max-width: 100%; height: auto; }
hr { height: 0; margin: 1.4em 0; border: 0; border-top: 1px solid #e4e4df; }
/* The default is border: 1px inset ridges, which is where the 1998 look
   came from. Collapsed, hairline, with the header row doing the work. */
table { border-collapse: collapse; margin: 0 0 0.9em; max-width: 100%; font-size: 0.95em; }
th, td { border: 1px solid #e0e0da; padding: 6px 10px; text-align: left; vertical-align: top; }
th { background: #f2f2ee; font-weight: 600; }
caption { padding-bottom: 6px; color: #6b6f76; font-size: 0.9em; text-align: left; }
/* Somebody else's words, and they should look like it. */
blockquote {
  margin: 0 0 0.85em;
  padding: 0.1em 0 0.1em 0.95em;
  border-left: 2px solid #d8d8d1;
  color: #5c6069;
}
pre, code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.92em; }
pre { overflow-x: auto; padding: 10px 12px; border-radius: 6px; background: #f2f2ee; }
code { padding: 0.1em 0.3em; border-radius: 4px; background: #f2f2ee; }
pre code { padding: 0; background: none; }
small { color: #6b6f76; }
`.replace(/\s*\n\s*/g, ' ').trim();

/**
 * `<base target="_blank">` is why the frame needs the popup permissions:
 * without them a link loads the client's website *inside* the message,
 * which looks like the tracker and is not.
 */
export const frameDoc = (html, showImages, { messageId = null } = {}) => {
  const ours = `<meta http-equiv="Content-Security-Policy" content="${framePolicy(showImages, messageId)}">`
    + `<base target="_blank" rel="noopener noreferrer">`
    + `<style>${STYLE}</style>`;
  const plain = hasOwnStyling(html) ? '' : ' class="plain"';
  // The cid: images first, so the sanitiser sees an ordinary same-origin
  // src and the policy's one allowed path matches it.
  const clean = cleanMail(rewriteCid(html, messageId), showImages);

  // Sanitised as a whole document, the message comes back with its own
  // <style> lifted into a head. Ours is put in ahead of it, so that where
  // the two say the same thing about the same element the sender's wins —
  // later rule, equal specificity — and an inline style beats both.
  if (/<head>/i.test(clean)) {
    return `<!doctype html>${clean.replace('<head>', `<head>${ours}`).replace(/<body(?=[\s>])/i, `<body${plain}`)}`;
  }
  // No DOM to sanitise with (Node, a unit test): the server has already
  // cleaned this, and the policy still governs the frame either way.
  return `<!doctype html><html><head>${ours}</head><body${plain}>${clean}</body></html>`;
};
