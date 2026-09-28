/**
 * Which sheet column holds which field (#45).
 *
 * Every sales sheet names its columns its own way: "Client", "Client Name",
 * "Customer Name"; "PO Number", "PO / WO No.", "P.O. No."; "PO Value",
 * "PO Amount", "Contract Amount (excl. GST)". The importer used to need an
 * exact match from a short list and asked the AI for everything else, so a
 * sheet with slightly different headers depended on the model to be read at
 * all.
 *
 * A header now matches a field when, compared in lower case with the
 * punctuation removed:
 *   - it is one of the field's names exactly (strongest), or
 *   - it contains one of them as whole words ("Client Name (as per PO)"
 *     contains "client name"),
 * unless it also says something the field is not: "PO (INR eq.)" is a
 * conversion, not the PO value; "Payment Status" is not the deal stage;
 * "PO Received On" is a date, not money received. Each header is used once
 * and each field takes its best-scoring header, strongest matches first.
 *
 * Columns nobody should import are dropped before anything reads them,
 * including the AI: a sheet with portal user IDs and passwords in it must
 * not carry them any further than the upload.
 */

/**
 * names  — header wordings, most specific first
 * avoid  — a header that also says this is not the field
 * exact  — names that only count as an exact header, never contained in a
 *          longer one ("status" alone is the stage; "payment status" is not)
 */
export const FIELDS = {
  sno: {
    names: ['s.no', 'sno', 's no', 'sr no', 'sr.no', 'sl no', 'sl.no', 'serial no', 'serial number', 'deal id', 'deal no', 'deal ref', 'serial', '#'],
    exact: ['serial', '#'],
    avoid: /invoice|\bpo\b|order|quotation|bill/,
  },
  client: {
    names: ['client name', 'customer name', 'company name', 'account name', 'organisation name', 'organization name', 'party name',
      'entity name', 'client', 'customer', 'company', 'account', 'organisation', 'organization', 'party', 'entity'],
    avoid: /contact|person|\bspoc\b|\bpoc\b|\battn\b|representative|type|code|\bid\b|e ?mail|phone|mobile|gst|address|city|country|state|industry|sector|since/,
  },
  industry: {
    names: ['industry type', 'industry', 'sector', 'segment', 'vertical', 'business type', 'line of business', 'nature of business'],
  },
  contact: {
    names: ['lead name', 'contact person', 'client contact', 'customer contact', 'contact name', 'point of contact', 'concerned person',
      'decision maker', 'client representative', 'kind attn', 'kind attention', 'attention', 'attn', 'spoc', 'poc', 'contact'],
    avoid: /e ?mail|phone|mobile|number|\bno\b|date|type/,
  },
  lead_type: {
    names: ['lead type', 'new/existing', 'new or existing', 'client type', 'customer type', 'new existing'],
  },
  stage: {
    names: ['deal stage', 'sales stage', 'pipeline stage', 'opportunity stage', 'stage of deal', 'deal status', 'lead status',
      'opportunity status', 'proposal status', 'quotation status', 'quote status', 'enquiry status', 'inquiry status',
      'current status', 'order status', 'win / loss', 'win loss', 'deal outcome', 'outcome', 'result', 'stage', 'status'],
    exact: ['status'],
    avoid: /payment|invoice|questionnaire|detail|project|\bpo\b|\btat\b|date|%|reason|remark/,
  },
  stage_detail: {
    names: ['status detail', 'status details', 'stage detail', 'stage details', 'sub status', 'sub-status', 'deal status detail', 'status remarks'],
  },
  service: {
    names: ['proposal name', 'service quoted', 'service / proposal', 'service/proposal', 'scope of work', 'service type', 'service name',
      'type of service', 'service required', 'engagement type', 'type of engagement', 'nature of work', 'assignment',
      'proposal for', 'solution proposed', 'service proposed', 'scope proposed', 'standard / scheme', 'services', 'service', 'proposal', 'scope', 'product', 'solution', 'offering', 'standard', 'scheme'],
    exact: ['proposal', 'product', 'solution', 'offering', 'standard', 'scheme'],
    avoid: /date|dated|value|amount|price|\bno\b|number|\bref\b|\btat\b|sent|revised|status|stage|count|#/,
  },
  proposal_date: {
    names: ['proposal sent date', 'proposal sent on', 'proposal date', 'date of proposal', 'quotation date', 'quote date',
      'quotation sent date', 'proposal submitted on', 'proposal submission date', 'date of submission', 'quotation sent on',
      'quote sent on', 'offer date', 'date quoted', 'date of quotation', 'quotation dated', 'bid submission date', 'submission date',
      'date submitted', 'bid date', 'quote sent', 'proposal sent', 'sent date', 'date sent', 'submitted on'],
    avoid: /revised|\btat\b|follow/,
  },
  quotation_no: {
    names: ['quotation no', 'quotation number', 'quotation ref', 'quote no', 'quote number', 'quote ref', 'proposal no',
      'proposal number', 'proposal ref', 'ctz no', 'quotation #', 'quote #'],
    avoid: /date|value|amount/,
  },
  quoted_price: {
    names: ['quoted price', 'quoted value', 'quotation value', 'quote value', 'proposal value', 'quoted amount',
      'quotation amount', 'proposal amount', 'quoted fee', 'fee quoted', 'fees quoted', 'professional fees quoted', 'proposed fee',
      'proposed fees', 'proposed value', 'offer value', 'offer amount', 'offer price', 'quoted fees', 'quote amount', 'bid value',
      'bid amount', 'price offered', 'offered price', 'fees', 'fee'],
    exact: ['fees', 'fee'],
  },
  currency: {
    names: ['currency', 'currency code', 'curr code', 'ccy code', 'ccy', 'curr', 'cur'],
    exact: ['ccy', 'curr', 'cur'],
    avoid: /rate|conversion|value|amount/,
  },
  po_date: {
    names: ['po received on', 'po date', 'po received', 'po date / received', 'date of po', 'order date', 'date of order', 'order received date',
      'order received on', 'contract date', 'agreement date', 'date of award', 'award date', 'loa date', 'contract signing date', 'wo date',
      'work order date', 'purchase order date', 'po dated', 'po dtd'],
    avoid: /\btat\b|amount|value/,
  },
  po_number: {
    names: ['po number', 'po no', 'po #', 'po / wo no', 'po/wo no', 'po wo no', 'p o no', 'p o number', 'purchase order number',
      'purchase order no', 'work order number', 'work order no', 'wo number', 'wo no', 'po ref', 'po reference', 'order number',
      'order no', 'order ref', 'order reference', 'contract no', 'contract number', 'agreement no', 'agreement number', 'loa no', 'loa number', 'award letter no', 'purchase order'],
    exact: ['purchase order'],
    avoid: /date|dated|amount|value|received on|\btat\b|file/,
  },
  po_amount: {
    names: ['po amount', 'po value', 'po / wo value', 'po/wo value', 'wo value', 'work order value', 'purchase order value',
      'purchase order amount', 'contract amount', 'contract value', 'order value', 'order amount', 'booked value', 'booking value',
      'order booked', 'order booking', 'wo amount', 'work order amount', 'value of po', 'awarded value', 'award value', 'loa value'],
  },
  invoice_number: {
    names: ['invoice number', 'invoice no', 'invoice #', 'invoice ref', 'invoice reference', 'invoice sr no', 'invoice serial no', 'invoice id', 'billing doc no', 'billing document no', 'tax invoice no', 'bill number',
      'bill no', 'pi no', 'pi number'],
    avoid: /date|amount|value|status/,
  },
  invoice_amount: {
    names: ['invoice amount', 'invoice value', 'invoiced amount', 'amount invoiced', 'billed amount', 'billing amount', 'bill amount',
      'amount billed', 'billed value', 'total billed', 'billing done', 'invoice total', 'total invoiced', 'amount billed till date',
      'billed till date', 'invoiced', 'billed'],
    exact: ['billed'],
    avoid: /date|number|\bno\b|status/,
  },
  received: {
    names: ['ammount received', 'amount received', 'payment received', 'received amount', 'amount collected', 'payment collected',
      'amount realised', 'amount realized', 'realised amount', 'realized amount', 'payment realised', 'receipt amount',
      'paid amount', 'amount paid', 'total received', 'payment realized', 'collections', 'collection', 'receipts', 'realised', 'realized',
      'collected', 'received'],
    exact: ['received', 'collected', 'collection', 'collections', 'receipts', 'realised', 'realized'],
    avoid: /date|\bon\b|questionnaire|\bpo\b|order|score|medal|rating|\btat\b/,
  },
  pending: {
    names: ['pending amount', 'amount pending', 'outstanding amount', 'amount outstanding', 'balance due', 'amount due', 'unpaid amount', 'amount unpaid', 'balance payable', 'dues',
      'due amount', 'balance amount', 'pending', 'outstanding', 'balance', 'receivable'],
    avoid: /date|days|age|since|action|task|approval|with|from/,
  },
  follow_up: {
    names: ['follow up comments', 'follow-up comments', 'followup comments', 'follow up remarks', 'follow up notes',
      'next steps', 'next step', 'comments', 'comment'],
    exact: ['comment'],
    avoid: /\bdate\b|\blast\b/,
  },
  // When the client was last followed up, and when the next follow-up is
  // due: the first sets the deal's last contact, the second a reminder.
  last_follow_up: {
    names: ['last follow up', 'last followup', 'last follow up date', 'last follow up on', 'last followed up', 'last followed up on',
      'followed up on', 'date of last follow up', 'last contacted', 'last contacted on', 'last contact', 'last contact date',
      'last call', 'last call date', 'last interaction', 'last meeting', 'last touch'],
    avoid: /comment|remark|note|status|\bby\b/,
  },
  next_follow_up: {
    names: ['next follow up', 'next followup', 'next follow up date', 'next follow up on', 'follow up date', 'followup date',
      'follow up on', 'date of next follow up', 'next contact date', 'next call date', 'next meeting date', 'next action date',
      'reminder date', 'next reminder', 'next reminder date', 'revisit date', 'call back date', 'callback date'],
    avoid: /comment|remark|note|status|\blast\b/,
  },
  remarks: {
    names: ['remarks / source', 'remarks', 'remark', 'notes', 'note', 'latest update', 'observations', 'feedback', 'next action',
      'additional info', 'additional information', 'discussion summary', 'other details', 'description', 'details', 'updates', 'update'],
    exact: ['feedback', 'updates', 'update', 'details', 'description'],
  },
  sales_person: {
    names: ['sales person', 'salesperson', 'sales owner', 'sales executive', 'sales rep', 'account manager', 'key account manager',
      'bd person', 'bd owner', 'bd executive', 'bd manager', 'deal owner', 'business development', 'handled by', 'assigned to',
      'responsible person', 'lead owner', 'opportunity owner', 'account owner', 'relationship manager', 'salesman', 'kam', 'rm', 'owner', 'responsible'],
    exact: ['owner', 'responsible', 'kam', 'rm'],
    avoid: /e ?mail|phone|mobile|project|delivery/,
  },
};

/**
 * Headers that are never a field: conversions into rupees, running
 * balances and working columns the sheet derives from the real ones.
 */
const NEVER = /\binr eq\b|\bequivalent\b|\bin inr\b|yet to invoice|to invoice|%|\btat\b|^rk |helper|formula|days open|\bage\b/;

/** Columns that are dropped at upload and never stored or sent anywhere. */
export const SECRET_HEADER = /pass ?word|passcode|\bpwd\b|\bpin\b|\botp\b|user ?id|user ?name|login|secret|token|credential/i;

/**
 * A header in the form it is compared in: lower case, punctuation gone, and
 * the abbreviations people type spelt out, so "PO Amt (Rs.)", "Inv. No.",
 * "Amt Recd", "Qtn Dt", "O/S Amount" and "P.O. Date" match like the words.
 */
export const normHeader = (s) => String(s ?? '')
  .toLowerCase()
  .replace(/[‐-―−]/g, '-')
  .replace(/\bo\s*\/\s*s\b/g, 'outstanding')
  .replace(/[^a-z0-9#%]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .replace(/\bp o\b/g, 'po')
  .replace(/\bw o\b/g, 'wo')
  .replace(/\bamt\b/g, 'amount')
  .replace(/\bdt\b/g, 'date')
  .replace(/\b(?:recd|rcvd|recvd|reced|recieved)\b/g, 'received')
  .replace(/\binv\b/g, 'invoice')
  .replace(/\b(?:qtn|quot)\b/g, 'quotation')
  .replace(/\bbal\b/g, 'balance')
  .replace(/\b(?:crncy|currncy)\b/g, 'currency')
  .replace(/\bqtd\b/g, 'quoted')
  .replace(/#/g, ' # ')
  // Units say how an amount is counted (see unitOf), not what the column is.
  .replace(/\b(?:rs|inr|in lakhs?|lakhs?|lacs?|lac|in crores?|crores?|cr|mn|in 000|000|excl gst|incl gst|excluding gst|including gst)\b/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .replace(/\s+l$/, '');

/**
 * What a header says its amounts are counted in: "Order Value (INR Lakhs)",
 * "PO Value (₹ L)", "Revenue (Rs. Cr)", "Fee ('000)". A plain number in such a
 * column is multiplied out; one that carries its own unit ("20 lakh") is not.
 */
export function unitOf(header) {
  const h = String(header ?? '').toLowerCase();
  if (/\b(?:crores?|cr)\b/.test(h)) return 1e7;
  if (/\b(?:lakhs?|lacs?|lac|lkh|lks?)\b|[(\s]l\s*\)?\s*$/.test(h)) return 1e5;
  if (/\b(?:mn|million|mio)\b/.test(h)) return 1e6;
  if (/'000|\bthousands?\b|\(\s*k\s*\)/.test(h)) return 1e3;
  return 1;
}

const PREPARED = Object.fromEntries(Object.entries(FIELDS).map(([field, def]) => [field, {
  names: def.names.map(normHeader),
  exact: new Set((def.exact || []).map(normHeader)),
  avoid: def.avoid || null,
}]));

/** How well one header fits one field: 0 for not at all. */
export function headerScore(field, header) {
  const h = normHeader(header);
  if (!h || NEVER.test(h)) return 0;
  const def = PREPARED[field];
  let best = 0;
  // "Status (Won/Lost/Hold)": a header that starts with the word status is the stage.
  if (field === 'stage' && /^status\b/.test(h) && !def.avoid.test(h)) best = 480;
  // "INR/USD": a header made only of currency codes is the currency column.
  // (Read before the unit words are taken out of the header.)
  if (field === 'currency' && /^(?:(?:inr|usd|eur|gbp|aed|sgd|cad)\s*){2,}$/.test(String(header).toLowerCase().replace(/[^a-z]+/g, ' ').trim())) best = 900;
  def.names.forEach((name, i) => {
    if (!name) return;
    // Earlier names are the more specific ones, so they score a little higher.
    if (h === name) { best = Math.max(best, 1000 - i); return; }
    if (def.exact.has(name) || def.avoid?.test(h)) return;
    if (` ${h} `.includes(` ${name} `)) {
      const extra = h.split(' ').length - name.split(' ').length;
      best = Math.max(best, 500 + 10 * name.split(' ').length - 5 * extra - i);
    }
  });
  return best;
}

/**
 * Header → field for a whole row of headers. Strongest matches are assigned
 * first; a header or a field that is taken is not used again.
 */
export function heuristicMapping(headers) {
  const pairs = [];
  for (const field of Object.keys(FIELDS)) {
    for (const header of headers) {
      const score = headerScore(field, header);
      if (score) pairs.push({ field, header, score });
    }
  }
  pairs.sort((a, b) => b.score - a.score);
  const mapping = {};
  const used = new Set();
  for (const { field, header } of pairs) {
    if (mapping[field] || used.has(header)) continue;
    mapping[field] = header;
    used.add(header);
  }
  return mapping;
}

/** How many different fields a row of cells looks like the headers of. */
export function headerRowScore(cells) {
  const texts = cells.filter((v) => typeof v === 'string' && v.trim() && v.trim().length < 60);
  if (texts.length < 2) return 0;
  return Object.keys(heuristicMapping(texts)).length;
}
