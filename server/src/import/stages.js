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
 * Phrases that decide before anything else, whatever comes first in the
 * text, because they turn the meaning of everything around them:
 *   - someone else got the order: "Won by competitor", "Order placed on
 *     lower bidder" are lost, though they say "won" and "order placed";
 *   - no proposal has gone yet: "Proposal to be sent", "RFQ received –
 *     preparing quotation" are leads, though they say "proposal";
 *   - the order is not in yet: "Won – confirmed by email (PO awaited)",
 *     "Execution – PO awaited" are negotiations. That is how the company's
 *     own register files them ("3. Negotiation / PO Awaited");
 *   - the work has visibly started: "LOI received, kick-off done" is won;
 *   - a CRM probability: "100%" is won and "0%" lost.
 * The first group that matches decides, in this order.
 */
const OVERRIDES = [
  // A CRM's probability, after the stage name, says it outright: "Closed Won
  // (100%)" is won and "(0%)" lost. Only at the end: "0% advance" is terms.
  [/(?:^|\s)100 ?%$/, WON, 'percent'],
  [/(?:^|\s)0 ?%$/, LOST, 'percent'],
  // Someone else got it, or it died after all.
  [/\b(?:won|awarded|received|placed|given|got|bagged|taken|finali[sz]ed|went) (?:by|to|with|on) (?:a |an |the )?(?:competitor|another|other|lower|l ?1\b)|\bcompetitor (?:got|won|was awarded|awarded|selected|bagged|finali[sz]ed)|\blower bidder\b|\bnot (?:l ?1|shortlisted|short listed)\b|\bl ?[2-9]\b|\bopted (?:for|to go with) (?:another|other|a different|competitor)|\bclient (?:chose|has chosen|selected|went ahead with|went with|is going with|going with|appointed|finali[sz]ed|awarded(?: it)? to|decided to do it in ?house)\b(?! us\b| cetizion\b| cv\b)|\bin ?house\b|\blost to\b|\bunsuccessful\b|\bloss\b|\blose\b|\bdrop(?:ped)?\b|(?<!not )\bcancel+(?:ed|ation)?\b|\bwithdr(?:awn|ew)\b|\bterminated\b|\bno bid\b|\bnot (?:bidding|pursuing|participating)\b|\bdid not (?:participate|bid|quote)\b|\bprice too high\b|\bwon by (?!us\b|cetizion\b|cv\b)\w+|\bwent with\b|\bshifted to (?:another|other|a different)\b|\bdeal failed\b|\bfailed\b|\bnot (?:won|accepted|selected|awarded|successful|converted)\b(?! yet)/, LOST],
  // A reply to an RFP, RFQ or tender that has gone is a submission, not a lead.
  [/\b(?:response|reply|bid|proposal|quote|quotation|offer)s? (?:to|for|against) (?:the |an? )?(?:rfp|rfq|rfi|eoi|tender|enquiry)\b.*\b(?:submitted|sent|shared|uploaded)\b|\b(?:rfp|rfq|rfi|eoi|tender) (?:response|reply|bid)s? (?:submitted|sent|shared|uploaded)\b|\b(?:tech(?:nical)?|price|commercial) bid (?:qualified|submitted|opened|opening)\b|\bprice bid opening\b/, SENT],
  // No proposal has gone yet.
  [/(?<!revised |re |updated )\b(?:proposal|quotation|quote|offer|techno commercial offer|bid|pricing)s? (?:to be (?:sent|shared|submitted|prepared)|yet to be (?:sent|shared|submitted)|not (?:yet )?(?:sent|shared|submitted)|under preparation|being prepared|in preparation|in progress|being drafted|wip|work in progress|draft)\b|\bnot (?:yet )?sent (?:to (?:the )?client)?\b|\bprepar\w* (?:the |a )?(?:proposal|quotation|quote|offer|bid)\b|\bto prepare (?:the |a )?(?:proposal|quotation|quote|offer)\b|\byet to (?:send|share|submit|quote)\b|\bbefore (?:we can )?(?:quote|quoting|sending)\b|\b(?:rfq|rfp|eoi|rfi)\b|\brequest for (?:quotation|quote|proposal|information)\b|\brequirement (?:gathering|discussion|understanding)\b|\bneeds? analysis\b|\b(?:initial|scope|scoping|first|exploratory|intro) (?:discussion|call|meeting)\b|\bawaiting (?:data|details|information|inputs?)\b|\btender (?:document|documents|doc) (?:purchased|downloaded|received)\b|\binternal approval\b|\b(?:appointmentscheduled|qualifiedtobuy)\b/, LEAD],
  // The order is not in yet, though everything else may be agreed.
  [/\b(?:p ?o|w ?o|work order|purchase order|order|contract)s? (?:is |are )?(?:awaited|pending|expected|to follow|to be (?:released|issued|placed|signed|received|raised)|not (?:yet )?(?:received|released|issued|placed|signed)|yet to (?:be )?(?:received|released|issued)|in process|under process|being processed|under preparation)\b|\bawaiting (?:the )?(?:p ?o|w ?o|order|purchase order|work order|contract)\b|\b(?:verbal|verbally|in principle|in-principle) (?:confirmed|confirmation|approval|approved|go ahead|nod|ok|yes)\b|\bapproved by (?:the )?client\b|\bcommitment received\b|\bdecision in (?:our|cv|cetizion)'?s? favou?r\b|\bpr raised\b|\b(?:decisionmakerboughtin|contractsent)\b|\bnot yet (?:won|closed|finali[sz]ed|confirmed)\b|\bstill negotiating\b|\b(?:internal )?po approval\b|\bapproval at client\b|^(?!.*\b(?:accepted|won|po (?:received|recd|issued|released)|released (?:the )?po|order (?:received|placed|confirmed))\b).*\b(?:final (?:offer|quote|quotation|commercials?)|bafo|best and final offer)\b|\bawaiting (?:the )?(?:loa|letter of award|award letter|award)\b|\bvendor (?:registration|onboarding|code)\b.*\bfor (?:the )?(?:p ?o|order)\b/, NEG],
  // The order is in, or the work has visibly started.
  [/\b(?:p ?o|w ?o|work order|purchase order|award letter|loa)s? (?:received|issued|in hand|signed)\b|\b(?:issued|released|placed|sent) (?:the |a |us )?(?:p ?o|w ?o|order|purchase order|work order)\b|\bkick ?off (?:done|held|completed|meeting (?:done|held))\b|\bwork (?:started|commenced|in progress)\b|\bwip\b|\bdata collection\b|\b(?:project|work|audit|assessment|assignment) (?:done|completed|conducted|delivered)\b|\b(?:report|certificate|statement) (?:issued|submitted|delivered)\b|\bretention\b|\b(?:letter of award|award letter|loa)\b(?! (?:awaited|pending|expected|to be))|\b(?:agreement|contract) executed\b|\b(?:team )?mobili[sz]ed\b|\border in hand\b|(?:^|\s)(?<!\bnot )won$/, WON],
];

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
  [/(?<!not )\bcancel+ed\b/, LOST],
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
  [/\bmandate (?:received|signed|given|confirmed)\b/, WON],
  [/^(?:deal )?confirmed$/, WON],
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
  [/\bbill(?:ed|ing (?:done|completed|raised))\b/, WON],
  [/\bpayment (?:received|done|made|credited|realised|realized|collected|follow ?up|due|pending)\b/, WON],
  [/\bpaid\b/, WON],

  // --- on hold ----------------------------------------------------------
  [/\bon ?hold\b/, HOLD],
  [/\bhold\b/, HOLD],
  [/\bpaused\b/, HOLD],
  [/\bsuspended\b/, HOLD],
  [/\bdeferred\b/, HOLD],
  [/\bpostponed\b/, HOLD],
  [/\bonly postponed\b/, HOLD],
  [/\bdormant\b/, HOLD],
  [/\bparked\b/, HOLD],
  [/\bfrozen\b/, HOLD],
  [/\bnext (?:year|quarter|fy|financial year|month)\b/, HOLD],
  [/\b(?:reconnect|revisit|re ?connect|touch base|get back|connect) (?:after|later|next|in)\b/, HOLD],
  [/\bafter (?:diwali|the holidays|holidays|budget|festive season|monsoon)\b/, HOLD],
  [/\b(?:back ?burner|abeyance|on the shelf|shelved|put off)\b/, HOLD],

  // --- negotiating: priced, and being worked on ------------------------
  [/negotiat\w*/, NEG],
  [/\bbest (?:price|rate|offer)\b/, NEG],
  [/\bmatch (?:the )?competitor\b/, NEG],
  [/\bscope (?:being )?(?:trimmed|reduced|cut|changed|reworked)\b/, NEG],
  [/\b(?:final )?commercial round\b/, NEG],
  [/\brevis(?:ed|ion|ing)\b/, NEG],
  [/\bbeing revised\b/, NEG],
  [/\brework\w*/, NEG],
  [/\bre ?quot\w*/, NEG],
  [/\bbafo\b/, NEG],
  [/\bredlines?\b/, NEG],
  [/\b(?:final|counter|revised) ?offer\b/, NEG],
  [/\bterms (?:agreed|discussed|under discussion|shared|being (?:discussed|finali[sz]ed|negotiated))\b/, NEG],
  [/\bfinali[sz](?:ing|e|ation)\b/, NEG],
  [/\b(?:price|pricing|commercial|fee) (?:discussion|negotiation|query|queries)s?\b/, NEG],
  [/\b(?:discount|lower (?:fee|price|rate|quote))\b/, NEG],
  [/\bcontracting\b/, NEG],
  [/\blegal (?:review|vetting)\b/, NEG],
  [/\bselected\b/, NEG],
  [/\bshortlisted\b/, NEG],
  [/\bl1\b/, NEG],
  [/\bverbal\b/, NEG],
  [/\bletter of intent\b/, NEG],
  [/\bloi\b/, NEG],
  [/\bawaiting (?:approval|confirmation|budget)\b/, NEG],
  [/\bpending\b/, NEG],
  [/\bunder (?:review|discussion|consideration)\b/, NEG],
  [/\bin discussion\b/, NEG],
  [/\bclarification\b/, NEG],

  // --- sent: a proposal is with the client -----------------------------
  [/\b(?:proposal|quotation|quote|offer|techno commercial|commercial) (?:sent|shared|submitted|emailed|mailed|given|presented)\b/, SENT],
  [/\boffer sent\b/, SENT],
  [/\bsubmitted\b/, SENT],
  [/\bpresented\b/, SENT],
  [/\bawaiting (?:feedback|response|reply|decision|revert|results?)\b/, SENT],
  [/\bresults? awaited\b/, SENT],
  [/\bbid (?:sent|submitted|uploaded)\b/, SENT],
  [/\bwith (?:the )?client\b/, SENT],
  [/\bclient review\b/, SENT],
  [/\bclient (?:evaluating|reviewing|comparing)\b/, SENT],
  [/\b(?:presentationscheduled)\b/, SENT],
  [/\b(?:pending|waiting) (?:with|from) (?:the )?client\b/, SENT],
  [/\bdecision pending\b/, SENT],
  [/\bfollow(?:ed)? ?up\b/, SENT],
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
  // How the company's own register files it: before any proposal.
  [/\bvendor (?:onboarding|registration|code|form)\b/, LEAD],
  [/\b(?:meeting|call|demo) (?:scheduled|fixed|done|held|planned)\b/, LEAD],
  [/\brequirement\w*/, LEAD],
  [/\bmeeting\b/, LEAD, 'fallback'],
  [/\bopportunity\b/, LEAD, 'fallback'],
];

/**
 * The spellings people actually type, brought to one form before reading:
 * "PO recd", "recieved", "rcvd" are received; "nego", "negotation" are a
 * negotiation; "qtn" is a quotation.
 */
function canonical(key) {
  return key
    .replace(/\b(?:recieved|recived|receieved|recevied|recvd|rcvd|recd|rec'd|rcd)\b/g, 'received')
    .replace(/\b(?:negotation|negociation|negotiaton|negotition|negotn|nego)\b/g, 'negotiation')
    .replace(/\bqtn\b/g, 'quotation')
    .replace(/\bonhold\b/g, 'on hold')
    .replace(/\bemd (?:paid|submitted|deposited)\b/g, 'emd deposit')
    .replace(/\bqtd\b/g, 'quoted')
    .replace(/\bprop sub\b/g, 'proposal submitted')
    .replace(/\benquiery\b/g, 'enquiry')
    .replace(/\bpostpon(?:ded|ned)\b/g, 'postponed');
}

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
 *   by     'admin' when the admin's own reading decided, 'ai' when only the
 *          model's reading did (the rules found nothing), 'rule' otherwise
 *
 * aiMap is the model's reading of wordings the rules did not understand,
 * keyed like stageMap. It never overrides a rule or the admin.
 */
export function classifyStage(raw, stageMap = null, aiMap = null) {
  const key = stageKey(raw);
  if (!key) return { stage: null, kind: 'blank', by: 'rule' };

  const chosen = stageMap ? stageMap[key] : undefined;
  if (chosen) {
    if (QUOTE_STAGES.includes(chosen)) return { stage: chosen, kind: 'quote', by: 'admin' };
    if (chosen === 'lead') return { stage: null, kind: 'lead', by: 'admin' };
    if (chosen === 'skip') return { stage: null, kind: 'skip', by: 'admin' };
  }

  const text = canonical(key);
  for (const [re, meaning] of OVERRIDES) {
    if (re.test(text)) return meaning === LEAD ? { stage: null, kind: 'lead', by: 'rule' } : { stage: meaning, kind: 'quote', by: 'rule' };
  }

  // Specific phrases first; the bare catch-all words only when none matched.
  const pick = (fallback) => {
    let best = null;
    for (const [re, meaning, kind] of VOCABULARY) {
      if ((kind === 'fallback') !== fallback) continue;
      const m = re.exec(text);
      if (!m) continue;
      const better = !best || m.index < best.index || (m.index === best.index && m[0].length > best.length);
      if (better) best = { index: m.index, length: m[0].length, meaning };
    }
    return best;
  };
  const best = pick(false) || pick(true);
  const guess = aiMap ? aiMap[key] : undefined;
  const fromAi = QUOTE_STAGES.includes(guess) ? { stage: guess, kind: 'quote', by: 'ai' } : guess === 'lead' ? { stage: null, kind: 'lead', by: 'ai' } : null;
  if (!best) return fromAi || { stage: null, kind: 'unknown', by: 'rule' };
  // A wording that points two ways, or says "not", is better read whole.
  if (fromAi && contested(text)) return fromAi;
  if (best.meaning === LEAD) return { stage: null, kind: 'lead', by: 'rule' };
  return { stage: best.meaning, kind: 'quote', by: 'rule' };
}

const NEGATED = /\b(?:not|no|never|nothing|without)\b/;

/** The vocabulary finds two meanings in it, or it is negated: not a sure reading. */
function contested(text) {
  const meanings = new Set(VOCABULARY.filter(([re, , kind]) => kind !== 'fallback' && re.test(text)).map(([, meaning]) => meaning));
  return meanings.size > 1 || NEGATED.test(text);
}

/**
 * Whether the rules are unsure of a wording: they read nothing, or it is
 * contested. Those are the ones worth the model's reading. A company
 * convention (an override) is sure by definition.
 */
export function needsReading(raw) {
  const key = stageKey(raw);
  if (!key) return false;
  const text = canonical(key);
  if (OVERRIDES.some(([re]) => re.test(text))) return false;
  return classifyStage(raw).kind === 'unknown' || contested(text);
}

/** Whether a wording says exactly what it was read as, so nobody needs telling. */
export function readsAsItself(raw, stage) {
  const k = stageKey(raw);
  if (!stage) return false;
  const s = stageKey(stage);
  return k === s || (stage === WON && ['won', 'closed won'].includes(k)) || (stage === LOST && ['lost', 'closed lost'].includes(k))
    || (stage === HOLD && ['hold', 'on hold'].includes(k)) || (stage === NEG && ['negotiation'].includes(k));
}
