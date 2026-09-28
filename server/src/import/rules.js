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
import { findDate, looksLikeReference, parseMoney, readCurrency, splitReference } from './parse.js';
import { classifyStage, readsAsItself, stageKey } from './stages.js';
import { unitOf } from './fields.js';
import { resources } from '../lib/resources.js';
import { sameService, similarName } from '../lib/names.ts';
import { financialYear } from '../lib/sequences.js';

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
  // A deal already in the tracker, recognised for certain, takes what
  // changed in the sheet (stage, value, dates...). A won deal is never
  // moved back by a sheet.
  update_from_sheet: true,
};

/** Who writes the sheet's remarks and reminders: how they are found again. */
export const IMPORT_AUTHOR = 'Bulk import';
const NOTE_LABEL = { status: 'Status', remarks: 'Remarks', follow_up: 'Follow-up', next: 'Next follow-up' };
const squash = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * What a sheet cell says that the tracker has not heard yet: nothing when
 * the text was seen before, and only the added part when the team wrote on
 * after it ("Reminder sent" → "Reminder sent | 25-Sep: asked for revision").
 */
export function newText(text, before, heard = []) {
  if (!text) return null;
  const t = squash(text);
  if (heard.some((h) => h.includes(t))) return null;
  const plain = String(text).replace(/\s+/g, ' ').trim();
  const prev = String(before || '').replace(/\s+/g, ' ').trim();
  const at = prev ? plain.toLowerCase().indexOf(prev.toLowerCase()) : -1;
  if (at < 0) return plain;
  const rest = `${plain.slice(0, at)} ${plain.slice(at + prev.length)}`.replace(/^[\s|;,.\-–—]+|[\s|;,\-–—]+$/g, '').replace(/\s+/g, ' ').trim();
  return rest || null;
}

/** The fields a re-upload may change on a quotation, and how they read. */
const CHANGEABLE = [['status', 'stage'], ['quotation_value', 'value'], ['currency', 'currency'], ['quotation_date', 'proposal date'],
  ['contact_person', 'contact'], ['sales_person', 'sales person'], ['service_quoted', 'service']];
function sheetChanges(existing, payload) {
  const out = [];
  for (const [col, label] of CHANGEABLE) {
    const to = payload[col];
    const from = existing[col] ?? null;
    if (to === null || to === undefined || to === '') continue;
    const same = typeof to === 'number' ? from !== null && Math.abs(Number(from) - to) < 0.01 : squash(from) === squash(to);
    if (!same) out.push({ field: col, label, from, to });
  }
  return out;
}

const WON_STATUS = 'Won - PO Received';
// "ISO 14001" and "ISO9001" alike: a digit may follow straight on (#23).
const ISO = /\bISO(?![a-z])/i;
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** The quotation status a sheet's deal stage reads as, or null. See stages.js. */
export function mapStage(raw) {
  return classifyStage(raw).stage;
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

/**
 * Re-exported so callers of this module keep working, but there is only
 * one implementation now.
 *
 * There used to be two, and they disagreed: this one wrote 2026-27 and
 * the series wrote 26-27, so one company's GST invoice series was being
 * numbered in two shapes at once — and the counter, which matches on the
 * prefix, could not see the imported half. It would have handed out a
 * number already in the books.
 */
export { financialYear };

export function invoiceNumber(raw, date, prefix) {
  const s = String(raw).trim();
  if (new RegExp(`^${prefix}/`, 'i').test(s)) return s;          // already in full form
  // A sheet may carry its own year in either shape, and a number that
  // arrives whole is kept whole: these are invoices that already exist.
  if (/^\d{4}-\d{2}\//.test(s) || /^\d{2}-\d{2}\//.test(s)) return `${prefix}/${s}`;
  return `${prefix}/${financialYear(date)}/${s}`;
}

/**
 * Pull the mapped fields out of one raw sheet row.
 *
 * stageMap is the admin's own reading of a stage wording, keyed by
 * stageKey(), as chosen on the review screen.
 */
export function extractRow(raw, mapping, { stageMap = null, aiStageMap = null } = {}) {
  const get = (f) => (mapping[f] ? raw[mapping[f]] : null);
  // An amount in a column headed "(INR Lakhs)" or "(₹ Cr)" is counted in that unit.
  const money = (f) => {
    const v = get(f);
    const m = parseMoney(v);
    const unit = unitOf(mapping[f]);
    const ownUnit = typeof v === 'string' && /\b(?:crores?|cr|lakhs?|lacs?|lac|l|k|mn|million|thousand)\b/i.test(v);
    // Lakhs and crores count rupees: a dollar or euro amount keeps its own figure.
    const foreign = m.currency && m.currency !== 'INR';
    return unit === 1 || m.amount === null || ownUnit || foreign ? m : { ...m, amount: Math.round(m.amount * unit * 100) / 100, unit };
  };
  const po = money('po_amount');
  const quoted = money('quoted_price');
  const received = money('received');
  const pending = money('pending');
  const invAmt = money('invoice_amount');
  const snoRaw = get('sno');
  const sno = Number.isFinite(Number(snoRaw)) && snoRaw !== null ? Number(snoRaw) : raw.__row;

  // The deal stage; a sheet with a separate "status detail" column is read
  // from it when the stage column says nothing this importer understands.
  const stageRaw = str(get('stage'));
  const detailRaw = str(get('stage_detail'));
  let reading = classifyStage(stageRaw, stageMap);
  let stageText = stageRaw;
  if ((reading.kind === 'blank' || reading.kind === 'unknown') && detailRaw) {
    const fromDetail = classifyStage(detailRaw, stageMap);
    if (fromDetail.kind !== 'blank' && fromDetail.kind !== 'unknown') { reading = fromDetail; stageText = detailRaw; }
  }
  // A wording the rules read nothing in, or that points two ways, takes the
  // model's reading when there is one; the admin's own reading stays.
  if (aiStageMap && reading.by === 'rule' && reading.kind !== 'blank') reading = classifyStage(stageText, stageMap, aiStageMap);

  // "4501234567 (dtd 22.09.2026)": the number, and the date from its note.
  const poRef = splitReference(get('po_number'));
  const invRef = splitReference(get('invoice_number'));
  // A quotation number is an identifier; a sentence in that column is a note
  // ("Revised 22-Sep (5% disc.)", "Proposal dtd 09-Sep-2026 – ₹24,80,000").
  // It matters: the number is how a duplicate is recognised.
  const qRaw = str(get('quotation_no'));
  const qIsNumber = Boolean(qRaw) && looksLikeReference(qRaw) && !/%|[₹$€£]|\b(?:revised|proposal|quotation|quote|dtd|dated|disc|discount|offer|annexure|auction|breakup|lumpsum)\b/i.test(qRaw);

  const amountCurrency = po.currency || quoted.currency || received.currency || invAmt.currency || pending.currency || null;
  // With no amount and no currency column, the quotation note may still say
  // it: "Proposal dtd 01-Sep-2026 – USD 7,500 + travel" is a dollar deal.
  const columnCurrency = readCurrency(get('currency')) || (qRaw && !qIsNumber ? readCurrency(qRaw) : null);
  const nextDate = findDate(get('next_follow_up'));
  return {
    sno,
    ref: str(snoRaw),
    row: raw.__row,
    client: str(get('client')),
    industry: str(get('industry')),
    contact: str(get('contact')),
    lead_type: str(get('lead_type')),
    stage_raw: stageText,
    stage_column: stageRaw,
    stage_detail: detailRaw,
    stage: reading.stage,
    stage_kind: reading.kind,
    stage_by: reading.by,
    service: str(get('service')),
    proposal_date: findDate(get('proposal_date')),
    quotation_no: qIsNumber ? qRaw : null,
    quotation_note: qRaw && !qIsNumber ? qRaw : null,
    quoted_price: quoted.amount,
    quoted_reinterpreted: quoted.reinterpreted || null,
    po_date: findDate(get('po_date')),
    po_date_from_note: poRef.date,
    po_number: poRef.number,
    po_note: poRef.note,
    po_amount: po.amount,
    po_amount_reinterpreted: po.reinterpreted,
    amount_unit: po.unit || quoted.unit || received.unit || null,
    currency: amountCurrency || columnCurrency || null,
    currency_conflict: amountCurrency && columnCurrency && amountCurrency !== columnCurrency ? `${columnCurrency} column, ${amountCurrency} amount` : null,
    invoice_number: invRef.number,
    invoice_date: invRef.date,
    invoice_note: invRef.note,
    invoice_amount: invAmt.amount,
    received: received.amount,
    pending: pending.amount,
    follow_up: str(get('follow_up')),
    remarks: str(get('remarks')),
    last_follow_up: findDate(get('last_follow_up')),
    next_follow_up: nextDate,
    // "Next week", "after Diwali": no date to remind on, but worth keeping.
    next_follow_up_note: nextDate ? null : str(get('next_follow_up')),
    sales_person: str(get('sales_person')),
  };
}
const str = (v) => (v === null || v === undefined ? null : String(v).trim() || null);

/** A "Total" or "Grand total" line at the foot of a sheet is not a deal. */
const TOTAL_ROW = /^(?:grand\s*|sub\s*-?\s*)?totals?\b/i;

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

  const readOpts = { stageMap: rules.stage_map || null, aiStageMap: rules.ai_stage_map || null };

  // PO numbers that appear on more than one row of the sheet.
  const poCounts = {};
  for (const raw of rows) { const r = extractRow(raw, mapping, readOpts); if (r.po_number) poCounts[norm(r.po_number)] = (poCounts[norm(r.po_number)] || 0) + 1; }

  // Every distinct stage wording in the sheet and how it was read, so the
  // reviewer can see it and change the reading of any one of them.
  const stageValues = new Map();
  const noteStage = (r) => {
    if (!r.stage_raw) return;
    const key = stageKey(r.stage_raw);
    const seen = stageValues.get(key) || { value: r.stage_raw, key, reading: r.stage || r.stage_kind, by: r.stage_by, rows: 0 };
    seen.rows += 1;
    stageValues.set(key, seen);
  };

  const push = (item) => { seq += 1; items.push({ seq, included: true, action: 'create', flags: [], assumptions: [], ...item }); return items[items.length - 1]; };
  const nextQuotationNo = () => { let n; do { n = `CTZ/QT/${live.year}/${String(qNo++).padStart(3, '0')}`; } while (usedQ.has(n)); usedQ.add(n); return n; };
  const nextProjectId = () => { let n; do { n = `PRJ-${live.year}-${String(pNo++).padStart(3, '0')}`; } while (usedP.has(n)); usedP.add(n); return n; };
  /** Mark an item as already on the site. Default choice: keep the original. */
  const duplicate = (item, ref, how, certain = true) => {
    item.action = rules.overwrite_existing ? 'update' : 'skip';
    item.existing_ref = ref;
    item.flags.push({ level: 'warn', code: 'duplicate', message: `${certain ? 'Already' : 'Possibly already'} on the site as ${ref} · matched by ${how}`, by: 'rule', match: how, certain });
  };

  /**
   * What the row adds to the deal's history: its remarks and follow-up
   * comments as timeline notes (only what is new since the last upload),
   * the last follow-up as the deal's last contact, and the next follow-up
   * as a reminder for the salesperson. Flags say what will happen.
   */
  const asOf = live.today || today();
  const tracking = (r, existing, item) => {
    const ref = existing?.quotation_no;
    const before = (ref && live.trail?.[ref]) || {};
    const heard = [...(ref && live.sheet_notes?.[ref]) || [], before.legacy, existing?.remarks].filter(Boolean).map(squash);
    const t = { notes: [], last_contacted: null, next_step: null, follow_up: null, close_follow_up: false, prior_remarks: before.remarks_field ?? null,
      sheet: { status: r.stage_detail !== r.stage_raw ? r.stage_detail : null, remarks: r.remarks, follow_up: r.follow_up, next: r.next_follow_up_note } };
    for (const kind of ['status', 'remarks', 'follow_up', 'next']) {
      const part = newText(t.sheet[kind], before[kind], heard);
      if (part) t.notes.push(`${NOTE_LABEL[kind]}: ${part}`);
    }
    if (t.notes.length) {
      const one = t.notes.length === 1 ? `: "${t.notes[0].length > 90 ? `${t.notes[0].slice(0, 87)}...` : t.notes[0]}"` : '';
      item.flags.push({ level: 'info', code: 'timeline', message: `${t.notes.length} ${existing ? 'new ' : ''}note${t.notes.length === 1 ? '' : 's'} for the deal's timeline${one}`, by: 'rule' });
    }
    if (r.last_follow_up && r.last_follow_up <= asOf && (!existing?.last_contacted_at || r.last_follow_up > existing.last_contacted_at)) t.last_contacted = r.last_follow_up;
    if (r.follow_up && squash(r.follow_up) !== squash(existing?.next_step)) t.next_step = r.follow_up;

    const open = ref ? live.follow_up_tasks?.[ref] : null;
    const who = r.sales_person || existing?.sales_person || null;
    if (r.stage === 'Lost') {
      if (open) {
        t.close_follow_up = true;
        item.flags.push({ level: 'info', code: 'follow_up_closed', message: `Deal lost: its follow-up reminder for ${open.due_at} will be closed`, by: 'rule' });
      }
    } else if (r.next_follow_up && r.next_follow_up < asOf) {
      if (!open) item.flags.push({ level: 'info', code: 'follow_up_past', message: `Next follow-up ${r.next_follow_up} has already passed; no reminder set`, by: 'rule' });
    } else if (r.next_follow_up && open?.due_at !== r.next_follow_up) {
      t.follow_up = { due: r.next_follow_up, title: `Follow up ${r.client}${r.service ? ` – ${r.service}` : ''}`, description: r.follow_up || null, assignee: who };
      item.flags.push({ level: 'info', code: 'follow_up', message: open ? `Follow-up reminder moves from ${open.due_at} to ${r.next_follow_up}` : `Follow-up reminder on ${r.next_follow_up}${who ? ` for ${who}` : ''}`, by: 'rule' });
    }
    return t;
  };

  let lastProposalDate = null;   // nearest earlier row's date, for rows with none

  for (const raw of rows) {
    const r = extractRow(raw, mapping, readOpts);
    const hint = hints[r.sno] || { advance_percent: null, flags: [] };
    const tag = `S.No ${r.ref || r.sno}`;
    const dateBasis = r.proposal_date || lastProposalDate;
    const dateBasisNote = r.proposal_date ? 'proposal date' : `previous row's proposal date (${lastProposalDate})`;
    if (r.proposal_date) lastProposalDate = r.proposal_date;

    const leaveOut = (reason) => skipped.push({ sno: r.sno, ref: r.ref, client: r.client, stage: r.stage_raw, reason });
    if (TOTAL_ROW.test(r.client || '') || TOTAL_ROW.test(r.ref || '')) { leaveOut('total row'); continue; }
    if (!r.client) { leaveOut('no client name'); continue; }
    noteStage(r);
    if (r.stage_kind === 'blank') { leaveOut('no deal stage'); continue; }
    if (r.stage_kind === 'lead') { leaveOut('early lead, no proposal yet — add it as an enquiry'); continue; }
    if (r.stage_kind === 'skip') { leaveOut('left out by your stage reading'); continue; }
    if (!r.stage) { leaveOut('unrecognised deal stage'); continue; }
    if (rules.exclude_iso && ISO.test(r.service || '')) { leaveOut('ISO proposal'); continue; }
    const won = r.stage === WON_STATUS;
    if (won && rules.won_requires_po && !r.po_number) { leaveOut(r.po_note ? `won but no PO number yet ("${r.po_note}")` : 'won but no PO number'); continue; }
    if (r.stage === 'Lost' && !rules.include_lost) { leaveOut('lost deals excluded by rule'); continue; }
    if (!won && r.stage !== 'Lost' && !rules.include_pending) { leaveOut('pending deals excluded by rule'); continue; }

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
        // A deal an earlier upload wrote, with the same client and service,
        // is the same row come round again: the weekly sheet re-uploaded.
        if (live.trail?.[existing.quotation_no]) { qHow = `${qHow}, from an earlier upload`; qCertain = true; }
      }
    }

    // ---- quotation -------------------------------------------------
    const remarks = [
      r.stage_detail && r.stage_detail !== r.stage_raw ? `Status: ${r.stage_detail}` : null,
      r.follow_up, r.remarks,
      r.quotation_note ? `Quotation ref in sheet: ${r.quotation_note}` : null,
      `Imported from ${tag}`,
    ].filter(Boolean).join(' | ');
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
    if (!readsAsItself(r.stage_raw, r.stage)) {
      qItem.flags.push({ level: 'info', code: 'stage_read_as', message: `Sheet says "${r.stage_raw}"; read as ${r.stage}${r.stage_by === 'admin' ? ' (your reading)' : r.stage_by === 'ai' ? " (the AI's reading: check it)" : ''}`, by: r.stage_by === 'admin' || r.stage_by === 'ai' ? r.stage_by : 'rule' });
    }
    if (r.amount_unit) qItem.flags.push({ level: 'info', code: 'amount_unit', message: `Amounts read in ${r.amount_unit === 1e5 ? 'lakhs' : r.amount_unit === 1e7 ? 'crores' : r.amount_unit === 1e6 ? 'millions' : 'thousands'}, as the column header says`, by: 'rule' });
    if (r.currency_conflict) qItem.flags.push({ level: 'warn', code: 'currency_conflict', message: `The currency column and the amount disagree (${r.currency_conflict}); read as ${r.currency}`, by: 'rule' });
    if (r.quoted_reinterpreted && r.po_amount === null) qItem.flags.push({ level: 'warn', code: 'amount_reinterpreted', message: `Sheet says "${r.quoted_reinterpreted}"; read as ${r.quoted_price}. Confirm with sales`, by: 'rule' });
    if (!r.proposal_date) qItem.flags.push({ level: 'info', code: 'no_date', message: 'No proposal date in the sheet', by: 'rule' });
    if (!r.contact) qItem.flags.push({ level: 'info', code: 'no_contact', message: 'No contact person in the sheet', by: 'rule' });
    if (existing) {
      duplicate(qItem, `${existing.quotation_no} (${existing.status})`, qHow, qCertain);
      qItem.existing_ref = existing.quotation_no;
      const changed = sheetChanges(existing, qItem.payload);
      const says = changed.map((c) => `${c.label} ${c.from ?? '(blank)'} → ${c.to}`).join('; ');
      if (existing.status === WON_STATUS && r.stage !== WON_STATUS) {
        qItem.flags.push({ level: 'warn', code: 'status_differs', message: `The tracker has this deal as won; the sheet says ${r.stage}. Kept as won`, by: 'rule' });
      } else if (changed.length && qCertain && rules.update_from_sheet && !rules.overwrite_existing) {
        qItem.action = 'update';
        qItem.flags.push({ level: 'info', code: 'sheet_changes', message: `Updated from the sheet: ${says}`, by: 'rule', changes: changed });
      } else if (changed.length) {
        qItem.flags.push({ level: 'warn', code: 'status_differs', message: `Changed in the sheet, not applied while kept: ${says}`, by: 'rule', changes: changed });
      }
    }
    qItem.payload.tracking = tracking(r, existing, qItem);

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
    if (!poDate && r.po_date_from_note) { poDate = r.po_date_from_note; poAssumptions.push(`PO date taken from the note on the PO number ("${r.po_note}")`); }
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
        remarks: [`Imported from ${tag}`, r.po_note ? `PO in sheet: ${r.po_note}` : null,
          r.invoice_note && !r.invoice_number ? `Invoice in sheet: ${r.invoice_note}` : null,
          ...poAssumptions, fullOnCompletion ? 'Client terms: 100% after completion' : null].filter(Boolean).join(' | '),
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
      const invDate = r.invoice_date || (poDate ? plusDays(poDate, rules.invoice_date_offset_days) : null);
      const invoiceNo = invDate ? invoiceNumber(r.invoice_number, invDate, rules.invoice_prefix) : String(r.invoice_number);
      const inv = push({
        step: 'invoice', source_row: r.sno, parent_seq: stageItems[0].seq,
        assumptions: r.invoice_date ? [] : invDate ? [`Invoice date assumed as PO date + ${rules.invoice_date_offset_days} day (${invDate})`] : [],
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
    } else if (r.invoice_note) {
      poItem.flags.push({ level: 'info', code: 'invoice_without_number', message: `Sheet says "${r.invoice_note}" but gives no invoice number; no invoice planned, the note is kept in the PO's remarks`, by: 'rule' });
    }
  }

  for (const it of items) it.flags = reviewFlags(it.step, it.payload, it.flags);
  const summary = {
    ...summarise(items, skipped),
    stage_values: [...stageValues.values()].sort((a, b) => b.rows - a.rows || a.value.localeCompare(b.value)),
  };
  return { items, skipped, summary, rules };
}

const AMOUNT_FIELDS = ['quotation_value', 'po_value', 'service_value', 'amount_received'];
const SCHEMAS = { quotation: 'quotations', project: 'projects' };

/**
 * What would stop the commit, shown at review time instead: a negative
 * amount, or a value the record's own form would refuse (too long, wrong
 * type). Checks only the fields present, since ids are filled at commit.
 */
export function reviewFlags(step, payload, flags = []) {
  const kept = flags.filter((f) => f.code !== 'negative_amount' && f.code !== 'invalid_value');
  const bad = AMOUNT_FIELDS.filter((k) => payload?.[k] !== null && payload?.[k] !== undefined && payload[k] !== '' && Number(payload[k]) < 0);
  if (bad.length) kept.push({ level: 'error', code: 'negative_amount', message: `Negative amount in ${bad.map((k) => k.replace(/_/g, ' ')).join(', ')}: correct it or untick the row`, by: 'rule' });
  const resource = resources[SCHEMAS[step]];
  if (resource && payload) {
    const present = Object.fromEntries(Object.entries(payload).filter(([k, v]) => v !== null && v !== undefined && v !== '' && !(AMOUNT_FIELDS.includes(k) && bad.includes(k))));
    const parsed = resource.schema.partial().safeParse(present);
    if (!parsed.success) {
      // In words: "currency CAD is not one the tracker keeps (INR, EUR, …)",
      // not the validator's "Invalid option: expected one of …".
      const issues = parsed.error.issues.map((x) => {
        const field = String(x.path[0]);
        const allowed = x.values || x.options;
        return Array.isArray(allowed) && present[field] !== undefined
          ? `${field.replace(/_/g, ' ')} ${present[field]} is not one the tracker keeps (${allowed.join(', ')})`
          : `${field.replace(/_/g, ' ')}: ${x.message}`;
      }).join('; ');
      kept.push({ level: 'error', code: 'invalid_value', message: `${issues}. Change it with Edit, or untick the row`, by: 'rule' });
    }
  }
  return kept;
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
