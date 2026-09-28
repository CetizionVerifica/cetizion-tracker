/**
 * Where a reply stops being new writing and starts being last week's email.
 *
 * The server draws the same line to take a preview from, on a string,
 * because it has no DOM at ingest — see server/src/lib/mailbox/quotes.js,
 * and keep the two marker lists in step. Here the document is already
 * parsed, so the cut can be made on the tree and give back markup that
 * still balances, which is what the reading pane needs.
 */

/** What mail clients mark the quoted block with. Mirrors quotes.js. */
const QUOTE_SELECTOR = [
  '.gmail_quote',
  '.gmail_quote_container',
  '.gmail_attr',
  '.yahoo_quoted',
  '.moz-cite-prefix',
  '.protonmail_quote',
  '.zmail_extra',
  '[id$="divRplyFwdMsg"]',
  '[id$="appendonsend"]',
  'blockquote[type="cite"]',
].join(', ');

/**
 * The attribution line, for everything synced before the sanitiser started
 * keeping the markers — which is all of the existing mail.
 *
 * Narrow on purpose: "wrote:" alone turns up in ordinary prose, so it only
 * counts when a date or an address sits in front of it.
 */
const ATTRIBUTION = [
  /\bOn\b[^\n]{6,120}?\bwrote:\s*$/i,
  /-{2,}\s*Original Message\s*-{2,}/i,
  // German puts the writer's name between the verb and the colon —
  // "Am <date> schrieb <name>:" — so the colon cannot be anchored to the
  // verb the way the English and Spanish forms allow.
  /\bEl\b[^\n]{6,120}?\bescribió[^\n]{0,60}:\s*$/i,
  /\bAm\b[^\n]{6,120}?\bschrieb\b[^\n]{0,60}:\s*$/i,
];

const isAttribution = (text) => {
  const line = String(text || '').trim();
  if (line.length < 12 || line.length > 200) return false;
  return ATTRIBUTION.some((p) => p.test(line));
};

/**
 * The first node that begins the quoted history, or null.
 *
 * Only top-level children are considered for the text form: an
 * attribution line nested deep inside the message body is far more likely
 * to be somebody quoting a sentence in passing than the real boundary.
 */
function findBoundary(body) {
  const marked = body.querySelector(QUOTE_SELECTOR);
  if (marked) {
    // The boundary is the outermost ancestor that still starts the quote,
    // so the "On … wrote:" line above the blockquote goes with it rather
    // than being left behind as the last line of the message.
    let node = marked;
    while (node.parentElement && node.parentElement !== body && node.parentElement.firstElementChild === node) {
      node = node.parentElement;
    }
    return node;
  }
  return Array.from(body.children).find((el) => isAttribution(el.textContent)) || null;
}

/**
 * Split a message into what it says and what it quotes.
 *
 * Returns the original html unchanged when there is no quote to find, so a
 * first message in a thread costs nothing.
 */
export function splitQuotedReply(html) {
  const source = String(html || '');
  if (!source.trim() || typeof DOMParser === 'undefined') {
    return { main: source, quoted: '', hasQuoted: false };
  }

  const doc = new DOMParser().parseFromString(source, 'text/html');
  const boundary = findBoundary(doc.body);
  if (!boundary) return { main: source, quoted: '', hasQuoted: false };

  const quoted = [];
  let node = boundary;
  while (node) {
    const next = node.nextSibling;
    quoted.push(node);
    node = next;
  }
  const quotedHtml = quoted.map((n) => (n.nodeType === 1 ? n.outerHTML : n.textContent)).join('');
  for (const n of quoted) n.remove();

  const main = doc.body.innerHTML;
  // A reply whose new part is empty — somebody forwarded without comment —
  // is better shown whole than as a blank pane with a button under it.
  if (!doc.body.textContent.trim()) return { main: source, quoted: '', hasQuoted: false };

  return { main, quoted: quotedHtml, hasQuoted: Boolean(quotedHtml.trim()) };
}
