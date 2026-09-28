/**
 * Where the new writing stops and last week's email begins.
 *
 * A reply carries its whole history. Nobody rewrites it — the client
 * presses reply and the previous message is quoted underneath — so a
 * two-line answer arrives as a two-line answer plus four screens of what
 * we already sent. The preview then read "Yes, the 14th works for us. On
 * Mon 22 Sep, R. Iyer wrote: Could you confirm the audit window…", which
 * is the list telling you about your own email.
 *
 * Two ways of finding the boundary, because they fail in different places:
 *
 *  - The markers mail clients leave. Reliable, and language-independent,
 *    but only present if the sanitiser kept them (see rules.js) — so not
 *    on anything synced before that change.
 *  - The attribution line itself, "On <date>, <somebody> wrote:" and its
 *    Outlook equivalent. Works on anything already stored, and is how the
 *    backlog gets a usable preview without a re-sync.
 */

/** Class names mail clients put on the quoted block. */
export const QUOTE_CLASSES = [
  'gmail_quote',
  'gmail_quote_container',
  'gmail_attr',
  'yahoo_quoted',
  'moz-cite-prefix',
  'protonmail_quote',
  'zmail_extra',
];

/** Outlook names the block by id, with a prefix that varies per message. */
export const QUOTE_ID_SUFFIXES = ['divRplyFwdMsg', 'appendonsend'];

const MARKER = new RegExp(
  `<[a-z]+[^>]*(?:class\\s*=\\s*["'][^"']*\\b(?:${QUOTE_CLASSES.join('|')})\\b`
  + `|id\\s*=\\s*["'][^"']*(?:${QUOTE_ID_SUFFIXES.join('|')})`
  + `|type\\s*=\\s*["']cite["'])`,
  'i',
);

/**
 * The attribution line a client writes above the quote.
 *
 * Deliberately narrow. "wrote:" on its own appears in ordinary prose, so
 * it has to be anchored to something that only an attribution line has —
 * a date or an address before it on the same line, or Outlook's own
 * separator and header block.
 */
/**
 * The forms, written once against a placeholder for "any character that
 * may sit inside the line".
 *
 * That placeholder is the whole reason this is built rather than listed.
 * In markup the gap must not cross `<`, or a pattern runs straight
 * through a tag and matches text three elements away. In a stored
 * preview the entities are already decoded, so the sender's address is a
 * literal `<r.iyer@…>` sitting in the middle of the line — and excluding
 * `<` there means the commonest attribution line of all never matches.
 *
 * One rule, two inputs, two compilations.
 */
const FORMS = [
  // "On Mon, 22 Sep 2026 at 09:12, R. Iyer <r.iyer@x.com> wrote:"
  (gap) => `\\bOn\\b${gap}{6,160}?\\bwrote:`,
  // "-----Original Message-----"
  () => '-{2,}\\s*Original Message\\s*-{2,}',
  // Outlook's header block, which starts with From: and a Sent:/Date: line.
  (gap) => `\\bFrom:${gap}{0,140}\\n?\\s*(?:Sent|Date):`,
  // Clients localise this line, and a client who writes in Spanish or
  // German is not a reason for the preview to give up.
  //
  // No \b after "escribió": \b is defined against [A-Za-z0-9_], and "ó"
  // is not one of those, so a boundary between it and the colon never
  // matches and the whole pattern silently never fires.
  (gap) => `\\bEl\\b${gap}{6,160}?\\bescribió${gap}{0,60}:`,
  // German puts the writer's name between the verb and the colon —
  // "Am <date> schrieb <name>:" — so unlike the English and Spanish
  // forms the colon cannot sit against the verb.
  (gap) => `\\bAm\\b${gap}{6,160}?\\bschrieb\\b${gap}{0,60}:`,
];

const compile = (gap) => FORMS.map((form) => new RegExp(form(gap), 'i'));

/** Inside markup: never cross a tag boundary. */
const ATTRIBUTION_HTML = compile('[^\\n<]');
/** Inside an already-flattened preview: `<` is part of an address. */
const ATTRIBUTION_TEXT = compile('[^\\n]');

/**
 * Split stored HTML into what this message says and what it quotes.
 *
 * String-level rather than DOM-level: this runs on the server at ingest,
 * where there is no DOMParser, and the cut only has to be good enough to
 * take a preview from. The browser does the same job properly for display
 * — see web/src/lib/quotedReply.js, which keeps this marker list in step.
 *
 * Cutting mid-tag would leave unbalanced markup, which is fine for the
 * preview (it is flattened to text straight after) and is why the web
 * copy parses instead of slicing.
 */
export function splitQuoted(html, { patterns = ATTRIBUTION_HTML, markers = true } = {}) {
  const source = String(html || '');
  let at = -1;

  const marker = markers ? source.match(MARKER) : null;
  if (marker) at = marker.index;

  for (const pattern of patterns) {
    const found = source.match(pattern);
    if (!found) continue;
    // The earliest boundary wins: a message can carry both, and the
    // attribution line usually sits just above the marked block.
    if (at === -1 || found.index < at) at = found.index;
  }

  if (at <= 0) return { main: source, quoted: '', hasQuoted: false };
  return { main: source.slice(0, at), quoted: source.slice(at), hasQuoted: true };
}

/**
 * The same cut, on a preview that was stored before this existed.
 *
 * snippet() runs at ingest and the result is a column, so fixing the
 * generator only fixes mail that arrives from now on — every message
 * already synced keeps the preview it was given, quoted history and all.
 * Re-syncing to repair it would mean dropping the cursor on every
 * mailbox, and the text is right here.
 *
 * Plain text rather than markup, so only the attribution line can match;
 * the class markers never survived into a snippet in the first place.
 */
export function trimQuotedPreview(text) {
  const value = String(text || '');
  if (!value) return value;
  const { main, hasQuoted } = splitQuoted(value, { patterns: ATTRIBUTION_TEXT, markers: false });
  if (!hasQuoted) return value;
  const cut = main.trim();
  // A preview that is nothing but quoted history — a bare forward — is
  // better shown as it was than blanked.
  return cut || value;
}
