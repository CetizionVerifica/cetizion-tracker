/**
 * Deal stages, read the way people actually write them (#45).
 *
 * The importer used to look for four words — won, lost, hold, and
 * submit/negotiat/pending — and threw away every row that had none. The
 * sales sheet has moved on since: "PO received – 50% advance invoiced",
 * "Proposal sent", "Execution – balance invoiced". On the September 2026
 * sheet that dropped 79 of 168 rows, sixteen of them carrying real PO
 * numbers, because "PO received" does not contain the word "won".
 *
 * How a stage is read:
 *
 *   1. An admin's own reading for that exact wording, if there is one
 *      (the review screen offers it for every distinct value in a sheet).
 *   2. Otherwise the vocabulary below. People write "Status – detail", so
 *      the phrase that appears FIRST decides: "Lost – PO received by a
 *      competitor" is lost, "PO received – 50% advance invoiced" is won,
 *      "Proposal sent – call scheduled" is sent. On a tie, the longer
 *      phrase wins, which is how "won't" beats "won".
 *   3. Nothing matched: unrecognised, shown to the admin to decide, never
 *      guessed.
 *
 * A lead that has not had a proposal yet is recognised as a lead and left
 * out with that reason: it belongs in enquiries, and pretending it is a
 * quotation would put a deal in the pipeline that nobody has priced.
 */

export const QUOTE_STAGES = ['Submitted', 'Under Negotiation', 'Won - PO Received', 'Lost', 'On Hold'];

/** What an admin may choose for a wording, beyond the quotation stages. */
export const STAGE_CHOICES = [...QUOTE_STAGES, 'lead', 'skip'];

const WON = 'Won - PO Received';
const LOST = 'Lost';
const HOLD = 'On Hold';
const NEG = 'Under Negotiation';
const SENT = 'Submitted';
const LEAD = 'lead';

/*
 * Each entry is a phrase and what it means. Phrases are matched as whole
 * words against the normalised text (lower case, dashes and punctuation
 * turned to spaces), so "PO-received" and "PO received" read the same.
 */
const VOCABULARY = [
  // --- lost, including every way of saying "not won" -------------------
  [/\bwon'?t\b/, LOST],
  [/\bwill not\b/, LOST],
  [/\bnot (?:won|selected|awarded|interested|proceeding|going ahead|approved|converted)\b/, LOST],
  [/\bno (?:go|requirement|budget|longer interested)\b/, LOST],
  [/\bclosed ?lost\b/, LOST],
  [/\blost\b/, LOST],
  [/\bdropped\b/, LOST],
  [/\brejected\b/, LOST],
  [/\bdeclined\b/, LOST],
  [/\bcancel+ed\b/, LOST],
  [/\bregret(?:ted)?\b/, LOST],
  [/\bdead\b/, LOST],
  [/\babandoned\b/, LOST],
  [/\bdisqualified\b/, LOST],
  [/\bwent (?:with|to) (?:a |an |another )?competitor\b/, LOST],

  // --- won: the order exists, or the work or the money has started -----
  [/\bclosed ?won\b/, WON],
  [/\bwon\b/, WON],
  [/\bp ?o (?:received|issued|released|confirmed|in hand|signed)\b/, WON],
  [/\bpurchase order (?:received|issued|released|confirmed)\b/, WON],
  [/\bw ?o received\b/, WON],
  [/\bwork ?order (?:received|issued|confirmed|signed)?\b/, WON],
  [/\border (?:received|confirmed|placed|booked)\b/, WON],
  [/\bawarded\b/, WON],
  [/\bconverted\b/, WON],
  [/\b(?:contract|agreement) signed\b/, WON],
  [/\bsigned\b/, WON],
  [/\baccepted\b/, WON],
  [/\bexecution\b/, WON],
  [/\bexecuting\b/, WON],
  [/\bkick ?off\b/, WON],
  [/\b(?:project|work|audit|assessment) (?:started|in progress|ongoing|underway|completed)\b/, WON],
  [/\bdelivered\b/, WON],
  [/\bcompleted\b/, WON],
  [/\breport (?:submitted|issued|shared|delivered)\b/, WON],
  [/\badvance (?:paid|received|invoiced|raised|requested)\b/, WON],
  [/\b(?:tax |proforma |final )?invoice (?:raised|issued|sent|shared|generated|in preparation)\b/, WON],
  [/\binvoiced\b/, WON],
  [/\bpayment\b/, WON],
  [/\bpaid\b/, WON],

  // --- on hold ----------------------------------------------------------
  [/\bon ?hold\b/, HOLD],
  [/\bhold\b/, HOLD],
  [/\bpaused\b/, HOLD],
  [/\bdeferred\b/, HOLD],
  [/\bpostponed\b/, HOLD],
  [/\bdormant\b/, HOLD],
  [/\bparked\b/, HOLD],
  [/\bfrozen\b/, HOLD],
  [/\bnext (?:year|quarter|fy|financial year)\b/, HOLD],

  // --- negotiating: priced, and being worked on ------------------------
  [/\bnegotiat\w*/, NEG],
  [/\brevis(?:ed|ion|ing)\b/, NEG],
  [/\bbeing revised\b/, NEG],
  [/\b(?:final|counter|revised) ?offer\b/, NEG],
  [/\boffer sent\b/, NEG],
  [/\bterms (?:agreed|discussed|under discussion|shared)\b/, NEG],
  [/\bselected\b/, NEG],
  [/\bshortlisted\b/, NEG],
  [/\bl1\b/, NEG],
  [/\bverbal\b/, NEG],
  [/\bletter of intent\b/, NEG],
  [/\bloi\b/, NEG],
  [/\bawaiting (?:approval|confirmation|decision|budget|po|p o|feedback)\b/, NEG],
  [/\bpending\b/, NEG],
  [/\bunder (?:review|discussion|consideration|evaluation)\b/, NEG],
  [/\binternal review\b/, NEG],
  [/\bfollow ?up\b/, NEG],
  [/\bin discussion\b/, NEG],
  [/\bclarification\b/, NEG],
  [/\bvendor (?:onboarding|registration|code)\b/, NEG],

  // --- sent: a proposal is with the client -----------------------------
  [/\b(?:proposal|quotation|quote|offer|techno commercial|commercial) (?:sent|shared|submitted|emailed|mailed|given)\b/, SENT],
  [/\bsubmitted\b/, SENT],
  // Bare words only decide when nothing more specific matched anywhere:
  // "Proposal being revised" is a negotiation, not a proposal sent, even
  // though "proposal" comes first.
  [/\bproposal\b/, SENT, 'fallback'],
  [/\bquot(?:ation|ed)\b/, SENT, 'fallback'],
  [/\bsent\b/, SENT, 'fallback'],

  // --- a lead: no proposal yet -----------------------------------------
  [/\blead\b/, LEAD],
  [/\bnew (?:enquiry|inquiry|lead|opportunity)\b/, LEAD],
  [/\benquiry\b/, LEAD],
  [/\binquiry\b/, LEAD],
  [/\bqualif\w*/, LEAD],
  [/\binterested\b/, LEAD],
  [/\bnda\b/, LEAD],
  [/\bapplication form\b/, LEAD],
  [/\bintro(?:duction|ductory)?\b/, LEAD],
  [/\bdiscovery\b/, LEAD],
  [/\bprospect\w*/, LEAD],
  [/\bcold\b/, LEAD],
  [/\b(?:meeting|call|demo) (?:scheduled|fixed|done|held|planned)\b/, LEAD],
  [/\bmeeting\b/, LEAD, 'fallback'],
  [/\bopportunity\b/, LEAD, 'fallback'],
];

/** The form a wording is compared in: case, dashes, punctuation and spacing ignored. */
export function stageKey(raw) {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/[‐-―−­]/g, '-')     // every kind of dash
    .replace(/[‘’ʼ]/g, "'")               // curly apostrophes
    .replace(/[^a-z0-9%']+/g, ' ')                      // punctuation becomes a gap
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Read one deal stage.
 *
 * Returns { stage, kind, by }:
 *   stage  a quotation status, or null when the row is not a quotation
 *   kind   'quote' | 'lead' | 'skip' | 'unknown' | 'blank'
 *   by     'admin' when the admin's own reading decided, 'rule' otherwise
 */
export function classifyStage(raw, stageMap = null) {
  const key = stageKey(raw);
  if (!key) return { stage: null, kind: 'blank', by: 'rule' };

  const chosen = stageMap ? stageMap[key] : undefined;
  if (chosen) {
    if (QUOTE_STAGES.includes(chosen)) return { stage: chosen, kind: 'quote', by: 'admin' };
    if (chosen === 'lead') return { stage: null, kind: 'lead', by: 'admin' };
    if (chosen === 'skip') return { stage: null, kind: 'skip', by: 'admin' };
  }

  // Specific phrases first; the bare catch-all words only when none matched.
  const pick = (fallback) => {
    let best = null;
    for (const [re, meaning, kind] of VOCABULARY) {
      if ((kind === 'fallback') !== fallback) continue;
      const m = re.exec(key);
      if (!m) continue;
      const better = !best || m.index < best.index || (m.index === best.index && m[0].length > best.length);
      if (better) best = { index: m.index, length: m[0].length, meaning };
    }
    return best;
  };
  const best = pick(false) || pick(true);
  if (!best) return { stage: null, kind: 'unknown', by: 'rule' };
  if (best.meaning === LEAD) return { stage: null, kind: 'lead', by: 'rule' };
  return { stage: best.meaning, kind: 'quote', by: 'rule' };
}

/** Whether a wording says exactly what it was read as, so nobody needs telling. */
export function readsAsItself(raw, stage) {
  const k = stageKey(raw);
  if (!stage) return false;
  const s = stageKey(stage);
  return k === s || (stage === WON && ['won', 'closed won'].includes(k)) || (stage === LOST && ['lost', 'closed lost'].includes(k))
    || (stage === HOLD && ['hold', 'on hold'].includes(k)) || (stage === NEG && ['negotiation'].includes(k));
}
