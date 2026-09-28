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

/** Does this message pull anything from the network? */
export const hasRemoteImage = (html) => /<img\b[^>]*\bsrc\s*=\s*["']?https?:/i.test(String(html || ''));

/**
 * `img-src data: cid:` keeps the images that travelled with the message and
 * drops every one that would go to the network. The rest of the list costs
 * nothing and is the second answer if the sanitiser is ever wrong about a
 * tag: no script, no frame, no form to post our session at, no connection
 * out, and `base-uri 'none'` so an email cannot repoint the <base> below
 * against us.
 */
export const framePolicy = (showImages) => [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  `img-src data: cid:${showImages ? ' https:' : ''}`,
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
html, body { margin: 0; background: #fbfbf9; }
body {
  padding: 16px 20px 18px;
  color: #23262b;
  font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  /* Emails arrive as one long column. A measure keeps it readable; a table
     wider than this still gets its full width from the rule below. */
  max-width: 680px;
  word-break: break-word;
}
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
export const frameDoc = (html, showImages) =>
  `<!doctype html><html><head>`
  + `<meta http-equiv="Content-Security-Policy" content="${framePolicy(showImages)}">`
  + `<base target="_blank" rel="noopener noreferrer">`
  + `<style>${STYLE}</style>`
  + `</head><body>${String(html ?? '')}</body></html>`;
