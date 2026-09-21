/**
 * The rules engine: turns mapped sheet rows into draft records with flags
 * and assumptions. Deterministic — the same sheet and the same live data
 * always produce the same plan. The model's hints (rules read from
 * remarks, oddities it noticed) are inputs here, never the final word.
 *
 * These are the rules agreed with the sales lead in September 2026:
 *   - anything mentioning ISO is left out;
 *   - a won deal without a PO number is left out;
 *   - a missing PO date is the proposal date + 7 days;
 *   - a missing invoice date is the PO date + 1 day;
 *   - a missing delivery date is the PO date + 6 months, only once passed;
 *   - invoice numbers go in as CVPL/<financial year>/<number verbatim>;
 *   - a record already on the site is a duplicate: the reviewer chooses
 *     to keep the original (default) or replace it with the sheet.
 *
 * Duplicates are found by fixed identifiers, never by client name alone:
 *   quotation      PO number → the quotation behind that PO; else the
 *                  sheet's quotation number; else client + service + date
 *                  (marked "possibly", because names get shortened)
 *   project        the matched quotation's project, or the matched PO's
 *   purchase order PO number
 *   service line   PO number
 *   payment stage  PO number + stage number
 *   invoice        PO number + stage (an invoice already on that stage)
 *   receipt        PO number + stage (money already recorded on that stage)
 */
import { z } from 'zod';
import { parseMoney } from './parse.js';
import { sameService, similarName } from '../lib/names.js';

export const DEFAULT_RULES = {
  exclude_iso: true,
  won_requires_po: true,
  include_pending: true,
  include_lost: true,
  po_date_offset_days: 7,
  invoice_date_offset_days: 1,
  delivery_offset_months: 6,
  delivery_only_if_past: true,
  default_split: [50, 50],
  default_terms_days: 30,
  default_currency: 'INR',
  invoice_prefix: 'CVPL',
  apply_onboarding_template: true,
  overwrite_existing: false,
};

/**
 * Overrides a request may send. Every key is optional and an unknown key is
 * refused, so a typo fails loudly instead of silently using the default.
 * The prefix is built into a RegExp, so it is letters, digits and hyphens only.
 */
const days = z.number().int().min(0).max(365);
export const rulesSchema = z.object({
  exclude_iso: z.boolean(),
  won_requires_po: z.boolean(),
  include_pending: z.boolean(),
  include_lost: z.boolean(),
  po_date_offset_days: days,
  invoice_date_offset_days: days,
  delivery_offset_months: z.number().int().min(0).max(60),
  delivery_only_if_past: z.boolean(),
  default_split: z.tuple([z.number().int().min(1).max(99), z.number().int().min(1).max(99)])
    .refine(([a, b]) => a + b === 100, 'default_split must add up to 100'),
  default_terms_days: days,
  default_currency: z.string().regex(/^[A-Z]{3}$/, 'default_currency must be a three-letter code such as INR'),
  invoice_prefix: z.string().regex(/^[A-Za-z0-9-]{1,20}$/, 'invoice_prefix may use letters, digits and hyphens only'),
  apply_onboarding_template: z.boolean(),
  overwrite_existing: z.boolean(),
}).partial().strict();

const ISO = /\bISO\b/i;
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

export function mapStage(raw) {
  const s = String(raw || '').toLowerCase();
  if (s.includes('won')) return 'Won - PO Received';
  if (s.includes('lost')) return 'Lost';
  if (s.includes('hold')) return 'On Hold';
  if (s.includes('submit') || s.includes('negotiat') || s.includes('pending')) return 'Under Negotiation';
  return null;
}

function plusDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function plusMonths(iso, n) {
  const d = new Date(iso + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
}
function today() { return new Date().toISOString().slice(0, 10); }

/** Indian financial year for a date: 2026-03-07 -> "2025-26", 2026-07-08 -> "2026-27". */
export function financialYear(iso) {
  const [y, m] = iso.split('-').map(Number);
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

export function invoiceNumber(raw, date, prefix) {
  const s = String(raw).trim();
  if (new RegExp(`^${prefix}/`, 'i').test(s)) return s;          // already in full form
  if (/^\d{4}-\d{2}\//.test(s)) return `${prefix}/${s}`;         // "2026-27/PI-003" carries its own year
  return `${prefix}/${financialYear(date)}/${s}`;
}

/** Pull the mapped fields out of one raw sheet row. */
export function extractRow(raw, mapping) {
  const get = (f) => (mapping[f] ? raw[mapping[f]] : null);
  const po = parseMoney(get('po_amount'));
  const quoted = parseMoney(get('quoted_price'));
  const received = parseMoney(get('received'));
  const pending = parseMoney(get('pending'));
  const invAmt = parseMoney(get('invoice_amount'));
  const snoRaw = get('sno');
  const sno = Number.isFinite(Number(snoRaw)) && snoRaw !== null ? Number(snoRaw) : raw.__row;
  return {
    sno,
    row: raw.__row,
    client: str(get('client')),
    industry: str(get('industry')),
    contact: str(get('contact')),
    lead_type: str(get('lead_type')),
    stage_raw: str(get('stage')),
    stage: mapStage(get('stage')),
    service: str(get('service')),
    proposal_date: dateOrNull(get('proposal_date')),
    quotation_no: str(get('quotation_no')),
    quoted_price: quoted.amount,
    po_date: dateOrNull(get('po_date')),
    po_number: str(get('po_number')),
    po_amount: po.amount,
    po_amount_reinterpreted: po.reinterpreted,
    currency: po.currency || quoted.currency || received.currency || null,
    invoice_number: str(get('invoice_number')),
    invoice_amount: invAmt.amount,
    received: received.amount,
    pending: pending.amount,
    follow_up: str(get('follow_up')),
    remarks: str(get('remarks')),
    sales_person: str(get('sales_person')),
  };
}
const str = (v) => (v === null || v === undefined ? null : String(v).trim() || null);
const dateOrNull = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

/**
 * Build the plan.
 *
 * live: {
 *   quotations:      [{id, quotation_no, client_name, service_quoted, quotation_date, status, project_id, quotation_value, contact_person}],
 *   projects:        [{project_id, client_name, primary_service}],
 *   purchase_orders: [{po_number, project_id, po_date, po_value, currency}],
 *   services:        [{po_number, service, service_value}],
 *   stages:          [{po_number, stage_no, stage_name, stage_percent, invoice_no, invoice_date, amount_received}],
 *   next_quotation_no: 79,        // first free number
 *   next_project_no: 43,
 *   year: 2026,
 * }
 */
export function buildPlan({ rows, mapping, live, hints = {}, rules: overrides = {} }) {
  const rules = { ...DEFAULT_RULES, ...overrides };
  const items = [];
  const skipped = [];
  let seq = 0;
  let qNo = live.next_quotation_no;
  let pNo = live.next_project_no;
  const usedQ = new Set(live.quotations.map((q) => q.quotation_no));
  const usedP = new Set((live.projects || []).map((p) => p.project_id).concat(live.purchase_orders.map((p) => p.project_id)));
  const livePO = new Map(live.purchase_orders.map((p) => [norm(p.po_number), p]));
  const liveQNo = new Map(live.quotations.map((q) => [norm(q.quotation_no), q]));
  const liveServices = new Map();
  for (const s of live.services || []) { const k = norm(s.po_number); if (!liveServices.has(k)) liveServices.set(k, []); liveServices.get(k).push(s); }
  const liveStages = new Map((live.stages || []).map((s) => [`${norm(s.po_number)}#${s.stage_no}`, s]));
  const stageCount = {};
  for (const s of live.stages || []) stageCount[norm(s.po_number)] = (stageCount[norm(s.po_number)] || 0) + 1;
  const liveInvoiceNos = new Map((live.stages || []).filter((s) => s.invoice_no).map((s) => [norm(s.invoice_no), s]));

  // PO numbers that appear on more than one row of the sheet.
  const poCounts = {};
  for (const raw of rows) { const r = extractRow(raw, mapping); if (r.po_number) poCounts[norm(r.po_number)] = (poCounts[norm(r.po_number)] || 0) + 1; }

  const push = (item) => { seq += 1; items.push({ seq, included: true, action: 'create', flags: [], assumptions: [], ...item }); return items[items.length - 1]; };
  const nextQuotationNo = () => { let n; do { n = `CTZ/QT/${live.year}/${String(qNo++).padStart(3, '0')}`; } while (usedQ.has(n)); usedQ.add(n); return n; };
  const nextProjectId = () => { let n; do { n = `PRJ-${live.year}-${String(pNo++).padStart(3, '0')}`; } while (usedP.has(n)); usedP.add(n); return n; };
  /** Mark an item as already on the site. Default choice: keep the original. */
  const duplicate = (item, ref, how, certain = true) => {
    item.action = rules.overwrite_existing ? 'update' : 'skip';
    item.existing_ref = ref;
    item.flags.push({ level: 'warn', code: 'duplicate', message: `${certain ? 'Already' : 'Possibly already'} on the site as ${ref} · matched by ${how}`, by: 'rule', match: how, certain });
  };

  let lastProposalDate = null;   // nearest earlier row's date, for rows with none

  for (const raw of rows) {
    const r = extractRow(raw, mapping);
    const hint = hints[r.sno] || { advance_percent: null, flags: [] };
    const tag = `S.No ${r.sno}`;
    const dateBasis = r.proposal_date || lastProposalDate;
    const dateBasisNote = r.proposal_date ? 'proposal date' : `previous row's proposal date (${lastProposalDate})`;
    if (r.proposal_date) lastProposalDate = r.proposal_date;

    if (!r.client || !r.stage) { skipped.push({ sno: r.sno, client: r.client, reason: r.client ? 'unrecognised deal stage' : 'no client name' }); continue; }
    if (rules.exclude_iso && ISO.test(r.service || '')) { skipped.push({ sno: r.sno, client: r.client, reason: 'ISO proposal' }); continue; }
    const won = r.stage === 'Won - PO Received';
    if (won && rules.won_requires_po && !r.po_number) { skipped.push({ sno: r.sno, client: r.client, reason: 'won but no PO number' }); continue; }
    if (r.stage === 'Lost' && !rules.include_lost) { skipped.push({ sno: r.sno, client: r.client, reason: 'lost deals excluded by rule' }); continue; }
    if (!won && r.stage !== 'Lost' && !rules.include_pending) { skipped.push({ sno: r.sno, client: r.client, reason: 'pending deals excluded by rule' }); continue; }

    // ---- is this row already on the site? ------------------------------
    const poExisting = won && r.po_number ? livePO.get(norm(r.po_number)) : null;
    let existing = null; let qHow = null; let qCertain = true;
    if (poExisting) {
      const behind = live.quotations.filter((q) => q.project_id && q.project_id === poExisting.project_id);
      existing = behind.find((q) => sameService(q.service_quoted, r.service)) || behind[0] || null;
      if (existing) qHow = 'PO number';
    }
    if (!existing && r.quotation_no && liveQNo.has(norm(r.quotation_no))) { existing = liveQNo.get(norm(r.quotation_no)); qHow = 'quotation number'; }
    if (!existing) {
      const cands = live.quotations.filter((q) => similarName(q.client_name, r.client) && sameService(q.service_quoted, r.service)
        && (!r.proposal_date || !q.quotation_date || String(q.quotation_date).slice(0, 10) === r.proposal_date));
      if (cands.length) {
        existing = cands.find((q) => r.proposal_date && String(q.quotation_date).slice(0, 10) === r.proposal_date) || cands[0];
        qHow = r.proposal_date && String(existing.quotation_date || '').slice(0, 10) === r.proposal_date ? 'client, service and date' : 'client and service';
        qCertain = false;
      }
    }

    // ---- quotation -------------------------------------------------
    const remarks = [r.follow_up, r.remarks, `Imported from ${tag}`].filter(Boolean).join(' | ');
    const qItem = push({
      step: 'quotation', source_row: r.sno,
      payload: {
        quotation_no: existing ? existing.quotation_no : nextQuotationNo(),
        quotation_date: r.proposal_date,
        client_name: r.client,
        contact_person: r.contact,
        service_quoted: r.service,
        sector: r.industry,
        sales_person: r.sales_person,
        quotation_value: r.po_amount ?? r.quoted_price,
        currency: r.currency || rules.default_currency,
        status: r.stage,
        po_received: won,
        remarks,
      },
    });
    for (const f of hint.flags) qItem.flags.push(f);
    if (!r.proposal_date) qItem.flags.push({ level: 'info', code: 'no_date', message: 'No proposal date in the sheet', by: 'rule' });
    if (!r.contact) qItem.flags.push({ level: 'info', code: 'no_contact', message: 'No contact person in the sheet', by: 'rule' });
    if (existing) {
      duplicate(qItem, `${existing.quotation_no} (${existing.status})`, qHow, qCertain);
      qItem.existing_ref = existing.quotation_no;
      if (existing.status !== r.stage) qItem.flags.push({ level: 'warn', code: 'status_differs', message: `Site says ${existing.status}, sheet says ${r.stage}`, by: 'rule' });
    }

    if (!won) continue;

    // ---- project + purchase order -----------------------------------
    if (r.po_amount === null) {
      qItem.flags.push({ level: 'warn', code: 'po_without_amount', message: `PO ${r.po_number} has no amount in the sheet; PO not planned`, by: 'rule' });
      continue;
    }
    const existingProject = existing?.project_id || poExisting?.project_id || null;
    const projectId = existingProject || nextProjectId();
    const projItem = push({
      step: 'project', source_row: r.sno, parent_seq: qItem.seq,
      payload: { project_id: projectId, client_name: r.client, primary_service: r.service, apply_onboarding_template: rules.apply_onboarding_template },
    });
    if (existingProject) duplicate(projItem, existingProject, existing?.project_id ? `the quotation's project` : 'PO number');

    let poDate = r.po_date;
    const poAssumptions = [];
    if (!poDate && dateBasis) { poDate = plusDays(dateBasis, rules.po_date_offset_days); poAssumptions.push(`PO date assumed as ${dateBasisNote} + ${rules.po_date_offset_days} days (${poDate})`); }
    let delivery = null;
    if (poDate) {
      const d = plusMonths(poDate, rules.delivery_offset_months);
      if (!rules.delivery_only_if_past || d <= today()) { delivery = d; poAssumptions.push(`Actual delivery assumed as PO date + ${rules.delivery_offset_months} months (${d})`); }
    }
    const fullOnCompletion = hint.flags.some((f) => f.code === 'full_payment_on_completion');
    const poItem = push({
      step: 'purchase_order', source_row: r.sno, parent_seq: projItem.seq,
      assumptions: poAssumptions,
      payload: {
        po_number: r.po_number, project_id: projectId, po_date: poDate, po_value: r.po_amount,
        currency: r.currency || rules.default_currency, payment_terms_days: rules.default_terms_days,
        actual_delivery_date: delivery,
        remarks: [`Imported from ${tag}`, ...poAssumptions, fullOnCompletion ? 'Client terms: 100% after completion' : null].filter(Boolean).join(' | '),
      },
    });
    if (poExisting) {
      duplicate(poItem, `${poExisting.po_number} under ${poExisting.project_id}`, 'PO number');
      poItem.existing_ref = poExisting.po_number;
      if (Number(poExisting.po_value) !== Number(r.po_amount)) poItem.flags.push({ level: 'info', code: 'value_differs', message: `Site has ${poExisting.currency || ''} ${poExisting.po_value}, sheet has ${r.po_amount}`, by: 'rule' });
    }
    if (!poDate) poItem.flags.push({ level: 'warn', code: 'no_po_date', message: 'No PO date and no proposal date to derive one', by: 'rule' });
    if (poCounts[norm(r.po_number)] > 1) poItem.flags.push({ level: 'warn', code: 'duplicate_po_in_sheet', message: 'This PO number appears on more than one row of the sheet', by: 'rule' });
    if (r.received !== null && r.received > r.po_amount + 0.01) poItem.flags.push({ level: 'warn', code: 'received_exceeds_po', message: `Received ${r.received} is more than the PO value ${r.po_amount}: check the PO amount in the sheet`, by: 'rule' });
    if (r.po_amount_reinterpreted) poItem.flags.push({ level: 'warn', code: 'amount_reinterpreted', message: `Sheet says "${r.po_amount_reinterpreted}"; read as ${r.po_amount} assuming a mistyped comma. Confirm with sales`, by: 'rule' });

    const svcItem = push({ step: 'service', source_row: r.sno, parent_seq: poItem.seq, payload: { po_number: r.po_number, service: r.service, service_value: r.po_amount } });
    const existingSvc = poExisting ? (liveServices.get(norm(r.po_number)) || []) : [];
    if (existingSvc.length) duplicate(svcItem, `${r.po_number} / ${existingSvc.map((s) => s.service).join(', ')}`, 'PO number');

    // ---- payment split ---------------------------------------------
    let split;
    if (fullOnCompletion) {
      split = [{ stage_name: 'On delivery (100%)', trigger_event: 'On Delivery', stage_percent: 1 }];
    } else {
      let first = hint.advance_percent;
      let splitNote = null;
      if (!first && r.invoice_number && r.received !== null && r.pending !== null && r.po_amount) {
        const nearWhole = (x) => Math.abs(x * 100 - Math.round(x * 100)) < 0.5;
        const whole = (r.received + r.pending) / r.po_amount;
        const advance = r.received / r.po_amount;
        if (Math.abs(whole - 1) < 0.01 && advance >= 0.05 && advance <= 0.95 && nearWhole(advance)) {
          // "pending" is the rest of the whole PO: the advance is what was received.
          first = Math.round(advance * 100); splitNote = 'advance = received ÷ PO value; pending is the rest of the PO';
        } else if (whole >= 0.05 && whole <= 0.95 && nearWhole(whole)) {
          // "pending" is the shortfall on the invoiced stage: stage = received + pending.
          first = Math.round(whole * 100); splitNote = 'stage = received + pending';
        }
      }
      if (!first) first = rules.default_split[0];
      else if (!splitNote) splitNote = 'advance percentage read from remarks';
      split = [
        { stage_name: `Advance (${first}%)`, trigger_event: 'On PO Registration', stage_percent: first / 100 },
        { stage_name: `On delivery (${100 - first}%)`, trigger_event: 'On Delivery', stage_percent: (100 - first) / 100 },
      ];
      if (splitNote) poItem.assumptions.push(`${first}/${100 - first} split: ${splitNote}`);
      else poItem.assumptions.push(`${first}/${100 - first} split: default, nothing in the sheet says otherwise`);
    }
    const stageItems = split.map((s, i) => {
      const it = push({ step: 'stage', source_row: r.sno, parent_seq: poItem.seq, payload: { po_number: r.po_number, stage_no: i + 1, ...s } });
      const ex = poExisting ? liveStages.get(`${norm(r.po_number)}#${i + 1}`) : null;
      if (ex) duplicate(it, `${r.po_number} stage ${ex.stage_no}: ${ex.stage_name} (${Math.round(ex.stage_percent * 100)}%)`, 'PO number and stage number');
      return it;
    });
    if (poExisting && stageCount[norm(r.po_number)] > split.length) poItem.flags.push({ level: 'info', code: 'more_stages_on_site', message: `Site has ${stageCount[norm(r.po_number)]} stages for this PO; the sheet implies ${split.length}. Extra site stages are left alone`, by: 'rule' });

    // ---- invoice + receipt on the first stage -------------------------
    const liveFirst = poExisting ? liveStages.get(`${norm(r.po_number)}#1`) : null;
    if (r.invoice_number) {
      const invDate = poDate ? plusDays(poDate, rules.invoice_date_offset_days) : null;
      const invoiceNo = invDate ? invoiceNumber(r.invoice_number, invDate, rules.invoice_prefix) : String(r.invoice_number);
      const inv = push({
        step: 'invoice', source_row: r.sno, parent_seq: stageItems[0].seq,
        assumptions: invDate ? [`Invoice date assumed as PO date + ${rules.invoice_date_offset_days} day (${invDate})`] : [],
        payload: { po_number: r.po_number, stage_no: 1, invoice_no: invoiceNo, invoice_date: invDate },
      });
      if (liveFirst?.invoice_no) duplicate(inv, `invoice ${liveFirst.invoice_no} on ${r.po_number} stage 1`, 'PO number and stage');
      else {
        const clash = liveInvoiceNos.get(norm(invoiceNo));
        if (clash) inv.flags.push({ level: 'warn', code: 'invoice_no_in_use', message: `Invoice number ${clash.invoice_no} is already used on ${clash.po_number} stage ${clash.stage_no}`, by: 'rule' });
      }
      if (!invDate) inv.flags.push({ level: 'error', code: 'no_invoice_date', message: 'No date for this invoice and nothing to derive one from', by: 'rule' });
      if (hint.flags.some((f) => f.code === 'proforma_invoice')) inv.flags.push({ level: 'warn', code: 'proforma_invoice', message: 'PI-style number: confirm with finance whether this is a tax invoice', by: 'rule' });
      if (r.received) {
        const rec = push({ step: 'receipt', source_row: r.sno, parent_seq: stageItems[0].seq, payload: { po_number: r.po_number, stage_no: 1, amount_received: r.received, payment_received_date: null } });
        if (liveFirst && Number(liveFirst.amount_received) > 0) duplicate(rec, `${liveFirst.amount_received} received on ${r.po_number} stage 1`, 'PO number and stage');
        const stageAmount = r.po_amount * split[0].stage_percent;
        // Remarks say "X% adv" but the money received is nowhere near X% of
        // the PO (allowing for GST on top and TDS off): the figures disagree.
        if (hint.advance_percent && stageAmount > 0) {
          const ratio = r.received / stageAmount;
          if (ratio < 0.85 || ratio > 1.2) rec.flags.push({ level: 'warn', code: 'received_vs_stated_advance', message: `Remarks say ${hint.advance_percent}% advance (${stageAmount.toFixed(0)}) but ${r.received} was received`, by: 'rule' });
        }
        if (r.received > stageAmount + 0.01) rec.flags.push({ level: 'warn', code: 'received_exceeds_invoice', message: `Received ${r.received} exceeds the advance stage (${stageAmount.toFixed(2)})`, by: 'rule' });
        else if (r.received < stageAmount - 0.01) rec.flags.push({ level: 'info', code: 'short_receipt', message: `Received is ${(stageAmount - r.received).toFixed(2)} short of the advance; stage will show Overdue`, by: 'rule' });
      }
    } else if (r.received) {
      poItem.flags.push({ level: 'warn', code: 'receipt_without_invoice', message: `Sheet shows ${r.received} received but no invoice number; receipt not planned`, by: 'rule' });
    }
  }

  const summary = summarise(items, skipped);
  return { items, skipped, summary, rules };
}

export function summarise(items, skipped = []) {
  const steps = {};
  let duplicates = 0;
  for (const it of items) {
    const s = (steps[it.step] ||= { create: 0, skip: 0, update: 0, excluded: 0, flagged: 0, errors: 0, duplicates: 0 });
    if (!it.included) s.excluded += 1; else s[it.action] += 1;
    if (it.flags.some((f) => f.level === 'warn')) s.flagged += 1;
    if (it.flags.some((f) => f.level === 'error')) s.errors += 1;
    if (it.existing_ref) { s.duplicates += 1; duplicates += 1; }
  }
  const reasons = {};
  for (const sk of skipped) reasons[sk.reason] = (reasons[sk.reason] || 0) + 1;
  return { steps, duplicates, skipped: skipped.length, skipped_reasons: reasons, assumptions: items.reduce((n, it) => n + it.assumptions.length, 0) };
}
