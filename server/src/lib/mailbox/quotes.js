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
const ATTRIBUTION = [
  // "On Mon, 22 Sep 2026 at 09:12, R. Iyer <r.iyer@x.com> wrote:"
  /\bOn\b[^\n<]{6,120}?\bwrote:/i,
  // "-----Original Message-----"
  /-{2,}\s*Original Message\s*-{2,}/i,
  // Outlook's header block, which starts with From: and a Sent:/Date: line.
  /\bFrom:[^\n<]{0,120}\n?\s*(?:Sent|Date):/i,
  // Clients localise this line, and a client who writes in Spanish or
  // German is not a reason for the preview to give up.
  //
  // No \b after "escribió": \b is defined against [A-Za-z0-9_], and "ó"
  // is not one of those, so a boundary between it and the colon never
  // matches and the whole pattern silently never fires.
  //
  // German puts the writer's name between the verb and the colon —
  // "Am <date> schrieb <name>:" — so unlike the English and Spanish
  // forms the colon cannot sit against the verb.
  /\bEl\b[^\n<]{6,120}?\bescribió[^\n<]{0,60}:/i,
  /\bAm\b[^\n<]{6,120}?\bschrieb\b[^\n<]{0,60}:/i,
];

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
export function splitQuoted(html) {
  const source = String(html || '');
  let at = -1;

  const marker = source.match(MARKER);
  if (marker) at = marker.index;

  for (const pattern of ATTRIBUTION) {
    const found = source.match(pattern);
    if (!found) continue;
    // The earliest boundary wins: a message can carry both, and the
    // attribution line usually sits just above the marked block.
    if (at === -1 || found.index < at) at = found.index;
  }

  if (at <= 0) return { main: source, quoted: '', hasQuoted: false };
  return { main: source.slice(0, at), quoted: source.slice(at), hasQuoted: true };
}
