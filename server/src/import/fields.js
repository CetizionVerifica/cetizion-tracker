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
  },
  client: {
    names: ['client name', 'customer name', 'company name', 'account name', 'organisation name', 'organization name', 'party name',
      'client', 'customer', 'company', 'account', 'organisation', 'organization', 'party'],
    avoid: /contact|person|type|code|\bid\b|e ?mail|phone|mobile|gst|address|city|country|state|industry|sector|since|group/,
  },
  industry: {
    names: ['industry type', 'industry', 'sector', 'segment', 'vertical', 'business type', 'line of business'],
  },
  contact: {
    names: ['lead name', 'contact person', 'client contact', 'customer contact', 'contact name', 'point of contact', 'spoc', 'poc', 'contact'],
    avoid: /e ?mail|phone|mobile|number|\bno\b|date|type/,
  },
  lead_type: {
    names: ['lead type', 'new/existing', 'new or existing', 'client type', 'customer type', 'new existing'],
  },
  stage: {
    names: ['deal stage', 'sales stage', 'pipeline stage', 'opportunity stage', 'stage of deal', 'deal status', 'lead status',
      'opportunity status', 'current status', 'stage', 'status'],
    exact: ['status'],
    avoid: /payment|invoice|questionnaire|detail|project|\bpo\b|tat|date|%|reason|remark/,
  },
  stage_detail: {
    names: ['status detail', 'status details', 'stage detail', 'stage details', 'sub status', 'sub-status', 'deal status detail', 'status remarks'],
  },
  service: {
    names: ['proposal name', 'service quoted', 'service / proposal', 'service/proposal', 'scope of work', 'service type', 'service name',
      'services', 'service', 'proposal', 'scope', 'product', 'solution', 'offering'],
    exact: ['proposal', 'product', 'solution', 'offering'],
    avoid: /date|dated|value|amount|price|\bno\b|number|\bref\b|tat|sent|revised|status|stage|count|#/,
  },
  proposal_date: {
    names: ['proposal sent date', 'proposal sent on', 'proposal date', 'date of proposal', 'quotation date', 'quote date',
      'quotation sent date', 'sent date', 'date sent'],
    avoid: /revised|tat|follow/,
  },
  quotation_no: {
    names: ['quotation no', 'quotation number', 'quotation ref', 'quote no', 'quote number', 'quote ref', 'proposal no',
      'proposal number', 'proposal ref', 'ctz no', 'quotation #', 'quote #'],
    avoid: /date|value|amount/,
  },
  quoted_price: {
    names: ['quoted price', 'quoted value', 'quotation value', 'quote value', 'proposal value', 'quoted amount',
      'quotation amount', 'proposal amount', 'quoted fee', 'fee quoted', 'fees', 'fee'],
    exact: ['fees', 'fee'],
  },
  currency: {
    names: ['currency', 'ccy', 'curr', 'cur'],
    exact: ['ccy', 'curr', 'cur'],
    avoid: /rate|conversion|value|amount/,
  },
  po_date: {
    names: ['po received on', 'po date', 'po received', 'po date / received', 'date of po', 'order date', 'wo date',
      'work order date', 'purchase order date', 'po dated', 'po dtd'],
    avoid: /tat|amount|value/,
  },
  po_number: {
    names: ['po number', 'po no', 'po #', 'po / wo no', 'po/wo no', 'po wo no', 'p o no', 'p o number', 'purchase order number',
      'purchase order no', 'work order number', 'work order no', 'wo number', 'wo no', 'po ref', 'po reference', 'order number',
      'order no', 'purchase order'],
    exact: ['purchase order'],
    avoid: /date|dated|amount|value|received on|tat|file/,
  },
  po_amount: {
    names: ['po amount', 'po value', 'po / wo value', 'po/wo value', 'wo value', 'work order value', 'purchase order value',
      'purchase order amount', 'contract amount', 'contract value', 'order value', 'order amount'],
  },
  invoice_number: {
    names: ['invoice number', 'invoice no', 'invoice #', 'invoice ref', 'invoice reference', 'tax invoice no', 'bill number',
      'bill no', 'pi no', 'pi number'],
    avoid: /date|amount|value|status/,
  },
  invoice_amount: {
    names: ['invoice amount', 'invoice value', 'invoiced amount', 'amount invoiced', 'billed amount', 'invoiced', 'billed'],
    exact: ['billed'],
    avoid: /date|number|\bno\b|status/,
  },
  received: {
    names: ['ammount received', 'amount received', 'payment received', 'received amount', 'amount collected', 'payment collected',
      'collected', 'received'],
    exact: ['received', 'collected'],
    avoid: /date|\bon\b|questionnaire|\bpo\b|order|score|medal|rating|tat/,
  },
  pending: {
    names: ['pending amount', 'amount pending', 'outstanding amount', 'amount outstanding', 'balance due', 'amount due',
      'due amount', 'balance amount', 'pending', 'outstanding', 'balance', 'receivable'],
    avoid: /date|days|age|since|action|task|approval|with|from/,
  },
  follow_up: {
    names: ['follow up comments', 'follow-up comments', 'followup comments', 'follow up remarks', 'follow up notes',
      'next steps', 'next step', 'comments', 'comment'],
    exact: ['comment'],
  },
  remarks: {
    names: ['remarks / source', 'remarks', 'remark', 'notes', 'note'],
  },
  sales_person: {
    names: ['sales person', 'salesperson', 'sales owner', 'sales executive', 'sales rep', 'account manager', 'bd person',
      'bd owner', 'business development', 'handled by', 'assigned to', 'owner', 'responsible'],
    exact: ['owner', 'responsible'],
    avoid: /e ?mail|phone|mobile|project|delivery/,
  },
};

/**
 * Headers that are never a field: conversions into rupees, running
 * balances and working columns the sheet derives from the real ones.
 */
const NEVER = /\binr eq\b|\bequivalent\b|\bin inr\b|yet to invoice|to invoice|\bl\b$|\blakh|\blac\b|%|\btat\b|^rk |helper|formula|days open|\bage\b/;

/** Columns that are dropped at upload and never stored or sent anywhere. */
export const SECRET_HEADER = /pass ?word|passcode|\bpwd\b|\bpin\b|\botp\b|user ?id|user ?name|login|secret|token|credential/i;

export const normHeader = (s) => String(s ?? '')
  .toLowerCase()
  .replace(/[‐-―−]/g, '-')
  .replace(/[^a-z0-9#%]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

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
