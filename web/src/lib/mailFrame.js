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

const STYLE = 'html,body{margin:0}body{font:13px system-ui,sans-serif;padding:10px 12px;color:#0f172a}img{max-width:100%}';

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
