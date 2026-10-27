/**
 * From HR's travel workbook to the records it holds (#196 §5.2, §5.3).
 * Pure: the workbook's tabs and what the tracker already has go in, the
 * plan comes out — items in commit order, each with its flags.
 *
 *   traveller     a person, matched to staff or new
 *   trip          legs of one traveller, one PO or project, close in time
 *   segment       one leg: a flight, a train, a bus, a cab, a hotel stay
 *   vendor_invoice  the agency's invoice; rows sharing a number are one
 *   invoice_line  one per leg billed
 *   credit_note   a cancellation or credit note against an invoice
 *
 * Items refer to each other by `seq` (payload.trip_seq, invoice_seq,
 * segment_seq). Flags are { level, code, message }: red blocks the commit,
 * amber asks for a look, blue says what was decided, duplicate is a record
 * already in the tracker (kept unless "update from sheet" is chosen).
 */
import { parseDate, parseMoney } from '../parse.js';
import { mapHeaders, normHeader } from './fields.js';

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const monthIn = (text) => {
  const m = /(?:^|[^a-z])(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*/i.exec(String(text || ''));
  return m ? MONTHS[m[1].toLowerCase()] : null;
};
const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
/** A place or carrier typed all in lower case, capitalised: "hyderabad" → "Hyderabad". Anything else as typed. */
const tidy = (s) => (s && s === s.toLowerCase() ? s.replace(/(^|[\s(/-])([a-z])/g, (m, a, c) => a + c.toUpperCase()) : s);
/** Letters and digits only, upper case: "CV 122" and "cv122" are one service request. */
export const refKey = (s) => String(s ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '');
const days = (a, b) => (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5;
const pad = (n) => String(n).padStart(2, '0');
const r2 = (n) => Math.round(n * 100) / 100;
const flag = (level, code, message) => ({ level, code, message });

const MODE_WORDS = [[/flight|air|plane/, 'flight'], [/train|rail/, 'train'], [/bus/, 'bus'], [/cab|taxi|car/, 'cab'], [/hotel|stay|room/, 'hotel']];
const modeFrom = (text) => { const t = norm(text); for (const [re, m] of MODE_WORDS) if (re.test(t)) return m; return null; };

/** The mode a tab's rows are in, from its headers and its name, when no Mode column says. */
function tabMode(tab, mapping) {
  const fields = new Set(Object.values(mapping));
  const heads = tab.headers.map(normHeader).join(' | ');
  if (fields.has('check_in') || /\bhotel\b/.test(heads)) return { mode: 'hotel', why: 'its Check-in and Hotel columns' };
  if (/\bairline/.test(heads)) return { mode: 'flight', why: 'its Airlines column' };
  if (/\btrain\b|\brailway\b|\bpnr\b/.test(heads)) return { mode: 'train', why: 'its Train or PNR column' };
  if (/\bcab\b|\bvehicle\b/.test(heads)) return { mode: 'cab', why: 'its Cab or Vehicle column' };
  const byName = modeFrom(tab.name);
  if (byName) return { mode: byName, why: `the tab's name, ${tab.name}`, byName: true };
  return { mode: 'flight', why: null };
}

/** The most common year among a tab's real dates: what a typed "20 july" belongs to. */
function tabYear(tab, mapping, fallbackYear) {
  const counts = {};
  for (const row of tab.rows) {
    for (const [h, f] of Object.entries(mapping)) {
      if (!['journey_date', 'booking_date', 'check_in'].includes(f)) continue;
      const v = row.cells[h];
      if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) counts[v.slice(0, 4)] = (counts[v.slice(0, 4)] || 0) + 1;
    }
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best ? Number(best[0]) : fallbackYear;
}

/** A date cell: a real date as it is; typed text read day first, else day and month with the tab's month and year. */
function readDate(v, { month, year }, rec, what) {
  if (v === null || v === undefined || v === '') return null;
  const text = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  // Typed with a month's name ("20 july,22"): the day and month as typed, the year the tab's.
  const named = monthIn(text);
  const parsed = named && year ? null : parseDate(text);
  if (parsed) {
    rec.flags.push(flag('amber', 'text_date', `${what} "${text}" was typed as text, read as ${parsed}`));
    return parsed;
  }
  const day = /(?:^|\D)(\d{1,2})(?!\d)/.exec(text);
  const m = named || month;
  if (day && m && year && Number(day[1]) >= 1 && Number(day[1]) <= 31) {
    const iso = `${year}-${pad(m)}-${pad(day[1])}`;
    if (!Number.isNaN(Date.parse(`${iso}T00:00:00Z`))) {
      rec.flags.push(flag('amber', 'text_date', `${what} "${text}" was typed as text, read as ${iso} with the tab's year`));
      return iso;
    }
  }
  rec.flags.push(flag('red', 'unreadable_date', `${what} "${text}" could not be read as a date`));
  return null;
}

function readMoney(v, rec, what) {
  if (v === null || v === undefined || v === '') return null;
  const { amount } = parseMoney(v);
  if (amount === null || !Number.isFinite(amount)) {
    rec.flags.push(flag('red', 'unreadable_amount', `${what} "${v}" is not an amount`));
    return null;
  }
  return r2(amount);
}

const DEDUCTED = [/(\d[\d,]*(?:\.\d+)?)\s*(?:rs\.?|₹|inr)?\s*deducted/i, /deducted\s*(?:of\s*)?(?:rs\.?|₹|inr)?\s*(\d[\d,]*(?:\.\d+)?)/i];
const CREDIT_NO = /\/CNT?\//i;

/** One row as the fields it holds. Duplicate columns (Aug's two PO No.) give the first filled one. */
function readRow(tab, row, mapping, when, modeHint) {
  const rec = { tab: tab.name, row: row.__row, flags: [], assumptions: [] };
  const get = (field) => {
    for (const [h, f] of Object.entries(mapping)) {
      if (f !== field) continue;
      const v = row.cells[h];
      if (v !== null && v !== undefined && String(v).trim() !== '') return v;
    }
    return null;
  };
  const text = (field) => { const v = get(field); return v === null ? null : String(v).replace(/\s+/g, ' ').trim(); };
  rec.traveller = text('traveller');
  rec.journey_date = readDate(get('journey_date'), when, rec, 'Date of journey');
  rec.booking_date = readDate(get('booking_date'), when, rec, 'Date of booking');
  rec.check_in = readDate(get('check_in'), when, rec, 'Check-in');
  rec.check_out = readDate(get('check_out'), when, rec, 'Check-out');
  rec.from_place = tidy(text('from_place'));
  rec.to_place = tidy(text('to_place'));
  rec.provider = tidy(text('provider'));
  rec.pnr = text('pnr');
  rec.base_fare = readMoney(get('base_fare'), rec, 'Amount');
  rec.service_charge = readMoney(get('service_charge'), rec, 'Admin charges');
  rec.gst_amount = readMoney(get('gst_amount'), rec, 'GST');
  rec.line_total = readMoney(get('line_total'), rec, 'Total');
  rec.trip_type = text('trip_type');
  rec.client_name = text('client_name');
  rec.service_request_no = text('service_request_no');
  rec.invoice_no = text('invoice_no');
  rec.credit_note_no = text('credit_note_no');
  rec.against_invoice = text('against_invoice');
  rec.remarks = text('remarks');
  rec.travel_id = text('travel_id');
  rec.project_id = text('project_id');
  // A PO No. cell that holds a client's name ("Megafine Pharma") is read as one.
  const po = text('po_no');
  if (po && !/\d/.test(po)) {
    rec.flags.push(flag('amber', 'po_holds_client', `PO No. "${po}" is a name, read as the client`));
    rec.client_name ||= po;
  } else rec.po_no = po;

  // A mode read from the tab's headers is said once, on the tab; from its name or from nothing, on the row.
  const typed = modeFrom(text('mode'));
  rec.mode = typed || (rec.check_in ? 'hotel' : modeHint.mode);
  if (!typed && !rec.check_in && modeHint.byName) rec.flags.push(flag('blue', 'mode_inferred', `${rec.mode} from ${modeHint.why}`));
  else if (!typed && !rec.check_in && !modeHint.why) rec.flags.push(flag('blue', 'mode_inferred', 'taken as a flight: nothing says otherwise'));
  if (rec.mode === 'hotel') {
    rec.start_date = rec.check_in || rec.journey_date;
    rec.end_date = rec.check_out;
    rec.to_place ||= rec.from_place;
  } else rec.start_date = rec.journey_date;

  // A cancellation: the remark says so, or the row is a credit or cancellation note.
  rec.credit_no = rec.credit_note_no || (rec.invoice_no && CREDIT_NO.test(rec.invoice_no) ? rec.invoice_no : null);
  rec.against = rec.against_invoice || (rec.invoice_no && rec.invoice_no !== rec.credit_no ? rec.invoice_no : null);
  // A note row is the credit or cancellation note itself; it bills nothing.
  rec.isNote = Boolean(rec.credit_no || rec.against_invoice);
  rec.cancelled = /cancel/i.test(rec.remarks || '') || rec.isNote;
  // A cancellation note cancels the leg, a credit note refunds part of it (as the
  // credit note trigger marks it); "return ticket is cancelled": this leg went ahead.
  rec.noteKind = rec.isNote ? (/\/CNT\//i.test(rec.credit_no || '') || /cancel/i.test(rec.remarks || '') ? 'cancellation_note' : 'credit_note') : null;
  rec.legStatus = rec.noteKind === 'credit_note' || (rec.cancelled && !rec.isNote && /\breturn\b/i.test(rec.remarks || '')) ? 'partly_refunded'
    : rec.cancelled ? 'cancelled' : 'booked';
  if (rec.cancelled) {
    for (const re of DEDUCTED) {
      const m = re.exec(rec.remarks || '');
      if (m) {
        rec.charges = r2(Number(m[1].replace(/,/g, '')));
        rec.flags.push(flag('blue', 'charges_read', `cancellation charges of ${rec.charges} read from the remark`));
        break;
      }
    }
  }
  return rec;
}

/**
 * The plan for one workbook.
 *
 * ctx:
 *   vendor        { id, name, invoice_prefixes }
 *   gapDays       travel_import_trip_gap_days
 *   staff         [{ id, name, email }]
 *   tripTypes     [{ id, name, chargeable, active }]
 *   pos           [{ po_number, project_id }]
 *   projects      [{ project_id, client_name, company_name, service_request_no, open }]
 *   existing      { invoices: [{ id, vendor_invoice_id, vendor_invoice_no }],
 *                   otherVendorInvoices: [vendor_invoice_no],
 *                   legs: [{ segment_id, travel_id, employee_name, start_date, from_place, to_place }],
 *                   credits: [credit_note_no] }
 *   memory        { columns: { normHeader: field }, staff: { spelling: staffId | 'new' },
 *                   tripTypes: { wording: tripTypeId } }  remembered for this vendor
 *   tabs          the tab names to read (all when absent)
 *   today         for the year of a tab with no real date
 */
export function planTravel(workbook, ctx) {
  const memory = { columns: {}, staff: {}, tripTypes: {}, ...(ctx.memory || {}) };
  const fallbackYear = Number(String(ctx.today || new Date().toISOString()).slice(0, 4));
  const tabsOut = [];
  const recs = [];
  for (const tab of workbook.tabs) {
    const mapping = mapHeaders(tab.headers, memory.columns);
    const chosen = !ctx.tabs || ctx.tabs.includes(tab.name);
    tabsOut.push({
      name: tab.name, rows: tab.rows.length, included: chosen, mapping,
      ignored: tab.headers.filter((h) => mapping[h] === 'ignore' || mapping[h] === null || tab.empty.includes(h)),
    });
    if (!chosen) continue;
    const when = { month: monthIn(tab.name), year: tabYear(tab, mapping, fallbackYear) };
    const modeHint = tabMode(tab, mapping);
    tabsOut[tabsOut.length - 1].mode = { mode: modeHint.mode, why: modeHint.why };
    for (const row of tab.rows) {
      const rec = readRow(tab, row, mapping, when, modeHint);
      rec.tabIndex = tabsOut.length - 1;
      // A row with nobody, no date and no money is a note or a subtotal.
      if (!rec.traveller && !rec.start_date && rec.base_fare === null && rec.line_total === null) continue;
      recs.push(rec);
    }
  }

  const items = [];
  let seq = 0;
  const add = (step, payload, extra = {}) => {
    const item = { step, seq: (seq += 1), source_row: extra.source_row ?? null, tab: extra.tab ?? null, parent_seq: extra.parent_seq ?? null,
      action: 'create', included: true, payload, flags: extra.flags || [], assumptions: extra.assumptions || [], existing_ref: null };
    items.push(item);
    return item;
  };

  // ---------------------------------------------------------------- travellers
  const staffByName = new Map(ctx.staff.map((s) => [norm(s.name), s]));
  // Each person once, by their spellings: "Asha Rao" and "asha rao" are one, shown the way most capitalised.
  const spellingsOf = new Map();
  for (const r of recs) if (r.traveller) spellingsOf.set(norm(r.traveller), [...new Set([...(spellingsOf.get(norm(r.traveller)) || []), r.traveller])]);
  const shown = (n) => [...spellingsOf.get(n)].sort((a, b) => (b.match(/[A-Z]/g) || []).length - (a.match(/[A-Z]/g) || []).length)[0];
  const resolved = new Map();
  for (const n of spellingsOf.keys()) {
    const sp = shown(n);
    const remembered = memory.staff[n];
    if (remembered && remembered !== 'new' && ctx.staff.some((s) => s.id === remembered)) { resolved.set(n, { staffId: remembered, how: 'remembered' }); continue; }
    if (staffByName.has(n)) { resolved.set(n, { staffId: staffByName.get(n).id, how: 'name' }); continue; }
    const prefixed = remembered === 'new' ? [] : ctx.staff.filter((s) => norm(s.name).startsWith(`${n} `));
    if (prefixed.length === 1) { resolved.set(n, { staffId: prefixed[0].id, how: 'first name' }); continue; }
    resolved.set(n, { newName: sp });
  }
  // Two spellings of one new person in the file: "Dinesh" and "Dinesh Shudedar".
  for (const [n, r] of resolved) {
    if (!r.newName) continue;
    const longer = [...resolved].filter(([m, o]) => o.newName && m !== n && m.startsWith(`${n} `));
    if (longer.length === 1) resolved.set(n, { newName: longer[0][1].newName, how: 'first name in the file' });
  }
  const travellerItems = new Map();
  for (const [n, r] of resolved) {
    const key = r.staffId ? `staff:${r.staffId}` : `new:${norm(r.newName)}`;
    if (!travellerItems.has(key)) {
      const staff = r.staffId ? ctx.staff.find((s) => s.id === r.staffId) : null;
      travellerItems.set(key, add('traveller', {
        name: staff ? staff.name : r.newName, staff_id: r.staffId || null, create: !r.staffId, email: staff?.email || null, spellings: [],
      }, { flags: r.staffId ? [] : [flag('blue', 'new_staff', 'not in the staff list: a staff row is made for them')] }));
    }
    const item = travellerItems.get(key);
    item.payload.spellings.push(...spellingsOf.get(n));
    if (r.how === 'first name' || r.how === 'first name in the file') item.flags.push(flag('blue', 'matched_first_name', `"${shown(n)}" taken as ${item.payload.name}`));
  }
  const travellerOf = (rec) => {
    if (!rec.traveller) return null;
    const r = resolved.get(norm(rec.traveller));
    return travellerItems.get(r.staffId ? `staff:${r.staffId}` : `new:${norm(r.newName)}`);
  };

  // ---------------------------------------------------------------- legs and trips
  const linkKey = (rec) => refKey(rec.po_no) || refKey(rec.service_request_no) || norm(rec.client_name) || '';
  const dated = (rec) => rec.start_date || '9999-12-31';
  // By person and date; on one day the journey before the hotel or cab it leads to; then as the workbook has them.
  const stays = (rec) => Number(rec.mode === 'hotel' || rec.mode === 'cab');
  const ordered = [...recs].sort((a, b) => {
    const ta = travellerOf(a)?.seq ?? 0; const tb = travellerOf(b)?.seq ?? 0;
    return ta - tb || dated(a).localeCompare(dated(b)) || stays(a) - stays(b) || a.tabIndex - b.tabIndex || a.row - b.row;
  });
  const legKey = (who, rec) => `${who}|${rec.start_date}|${norm(rec.from_place)}|${norm(rec.to_place)}|${rec.mode}`;
  const trips = [];
  const legsByKey = new Map();
  const recLeg = new Map();
  for (const rec of ordered) {
    const who = travellerOf(rec);
    const whoKey = who ? who.seq : `row${rec.row}`;
    // A cancellation row of a leg already in the file cancels that leg.
    if (rec.cancelled) {
      const same = legsByKey.get(legKey(whoKey, rec));
      if (same) { same.recs.push(rec); if (same.status !== 'cancelled') same.status = rec.legStatus; recLeg.set(rec, same); continue; }
    } else if (legsByKey.has(legKey(whoKey, rec))) {
      rec.flags.push(flag('amber', 'same_leg_twice', 'the same leg appears twice in the file'));
    }
    // Same person, nothing saying another client (a return leg often leaves it blank),
    // within the gap of the trip's last day, and chaining on: A→B then B→A or B→C. Hotels and cabs join by date.
    const link = linkKey(rec);
    let trip = trips.find((t) => t.whoKey === whoKey && (!link || !t.link || t.link === link) && rec.start_date && t.last
      && days(t.last, rec.start_date) <= ctx.gapDays
      && (rec.mode === 'hotel' || rec.mode === 'cab' || !rec.from_place || !t.lastTo
        || norm(rec.from_place) === norm(t.lastTo) || norm(rec.to_place) === norm(t.firstFrom)));
    if (!trip) {
      trip = { whoKey, who, link, legs: [], recs: [], last: null, lastTo: null, firstFrom: null };
      trips.push(trip);
    }
    trip.link ||= link;
    const leg = { rec, recs: [rec], status: rec.legStatus, trip };
    trip.legs.push(leg);
    trip.recs.push(rec);
    legsByKey.set(legKey(whoKey, rec), leg);
    recLeg.set(rec, leg);
    const ends = rec.mode === 'hotel' && rec.end_date ? rec.end_date : rec.start_date;
    if (ends && (!trip.last || ends > trip.last)) trip.last = ends;
    if (rec.mode !== 'hotel' && rec.mode !== 'cab') { trip.lastTo = rec.to_place || trip.lastTo; trip.firstFrom ||= rec.from_place; }
  }

  // What the tracker already has, to recognise a workbook uploaded again (§5.2).
  const existingLegs = new Map((ctx.existing?.legs || []).map((l) => [`${norm(l.employee_name)}|${l.start_date}|${norm(l.from_place)}|${norm(l.to_place)}`, l]));
  const byNumber = new Map((ctx.existing?.invoices || []).map((i) => [refKey(i.vendor_invoice_no), i]));
  const otherVendors = new Set((ctx.existing?.otherVendorInvoices || []).map(refKey));
  const credits = new Set((ctx.existing?.credits || []).map(refKey));
  const typesByName = new Map(ctx.tripTypes.filter((t) => t.active !== false).map((t) => [norm(t.name), t]));
  const posByKey = new Map(ctx.pos.map((p) => [refKey(p.po_number), p]));
  const projectsBySr = new Map(ctx.projects.filter((p) => p.service_request_no).map((p) => [refKey(p.service_request_no), p]));
  const projectsByClient = new Map();
  // By client: the project's client or its company's name, open projects only.
  for (const p of ctx.projects.filter((x) => x.open !== false)) {
    for (const k of new Set([norm(p.client_name), norm(p.company_name)].filter(Boolean))) projectsByClient.set(k, [...(projectsByClient.get(k) || []), p]);
  }
  const prefixes = (ctx.vendor.invoice_prefixes || []).map((p) => refKey(p)).filter(Boolean);

  for (const trip of trips) {
    const first = (field) => trip.recs.map((r) => r[field]).find((v) => v !== null && v !== undefined && v !== '');
    const flags = [];
    const assumptions = [];
    const payload = {
      employee_name: trip.who?.payload.name || first('traveller') || null,
      traveller_seq: trip.who?.seq ?? null, vendor_id: ctx.vendor.id,
      po_number: null, project_id: null, client_label: null, trip_type_id: null,
      origin: null, destination: null, travel_start_date: null, travel_end_date: null, booking_date: null,
      cancelled: trip.legs.every((l) => l.status === 'cancelled'),
      remarks: [...new Set(trip.recs.map((r) => r.remarks).filter(Boolean))].join('; ') || null,
      travel_id: first('travel_id') || null,
    };
    const legs = trip.legs.filter((l) => l.rec.mode !== 'hotel' && l.rec.mode !== 'cab');
    payload.origin = legs[0]?.rec.from_place || null;
    payload.destination = legs[0]?.rec.to_place || trip.legs[0]?.rec.to_place || null;
    const dates = trip.legs.flatMap((l) => [l.rec.start_date, l.rec.end_date]).filter(Boolean).sort();
    payload.travel_start_date = dates[0] || null;
    payload.travel_end_date = dates[dates.length - 1] || null;
    payload.booking_date = trip.recs.map((r) => r.booking_date).filter(Boolean).sort()[0] || null;

    // ---- what it is billed to: a PO, else a service request's project, else one project of the client
    const po = first('po_no'); const sr = first('service_request_no'); const client = first('client_name');
    const project = first('project_id');
    if (po && posByKey.has(refKey(po))) {
      payload.po_number = posByKey.get(refKey(po)).po_number;
    } else if (po) {
      flags.push(flag('amber', 'po_not_found', `PO ${po} is not in the tracker`));
    }
    if (!payload.po_number && project && ctx.projects.some((p) => p.project_id === project)) payload.project_id = project;
    if (!payload.po_number && !payload.project_id && sr) {
      const p = projectsBySr.get(refKey(sr));
      if (p) { payload.project_id = p.project_id; flags.push(flag('blue', 'project_by_service_request', `project ${p.project_id} by service request ${sr}`)); }
      else flags.push(flag('amber', 'service_request_not_found', `no project has service request ${sr}`));
    }
    if (!payload.po_number && !payload.project_id && client) {
      const candidates = projectsByClient.get(norm(client)) || [];
      if (candidates.length === 1) {
        payload.project_id = candidates[0].project_id;
        flags.push(flag('amber', 'linked_by_client', `linked to ${candidates[0].project_id} by the client name only`));
      } else payload.client_label = client;
    }
    const linked = Boolean(payload.po_number || payload.project_id);
    if (!linked) flags.push(flag('amber', 'no_po_or_project', 'no PO or project: saved with the client name only'));

    // ---- the trip type: the Types column, a wording remembered, or the importer's rule
    const wording = first('trip_type');
    if (wording) {
      const t = typesByName.get(norm(wording)) || ctx.tripTypes.find((x) => x.id === memory.tripTypes[norm(wording)]);
      if (t) payload.trip_type_id = t.id;
      else {
        payload.trip_type_wording = wording;
        flags.push(flag('red', 'trip_type_unknown', `trip type "${wording}" is not on the list: pick one`));
      }
    } else {
      const t = ctx.tripTypes.filter((x) => x.active !== false && x.chargeable === linked)
        .sort((a, b) => Number(['Chargeable', 'Non-chargeable'].includes(b.name)) - Number(['Chargeable', 'Non-chargeable'].includes(a.name)) || a.sort_order - b.sort_order)[0];
      if (t) { payload.trip_type_id = t.id; assumptions.push(`Trip type ${t.name}: ${linked ? 'it is linked to a PO or project' : 'it is linked to nothing'}, and the sheet gives none`); }
    }
    const type = ctx.tripTypes.find((x) => x.id === payload.trip_type_id);
    if (type?.chargeable && !linked) flags.push(flag('amber', 'chargeable_unlinked', 'a chargeable trip with no PO or project'));
    if (trip.legs.length > 1) flags.push(flag('blue', 'legs_grouped', `${trip.legs.length} rows grouped into one trip`));
    if (payload.booking_date && payload.travel_start_date && payload.travel_start_date < payload.booking_date) {
      flags.push(flag('amber', 'journey_before_booking', `the journey (${payload.travel_start_date}) is before the booking (${payload.booking_date})`));
    }
    if (!payload.employee_name) flags.push(flag('red', 'no_traveller', 'no traveller'));

    trip.item = add('trip', payload, { source_row: trip.recs[0].row, tab: trip.recs[0].tab, parent_seq: trip.who?.seq ?? null, flags, assumptions });
    // A trip already in the tracker (from an earlier upload): its legs say so.
    const known = trip.legs.map((l) => existingLegs.get(`${norm(payload.employee_name)}|${l.rec.start_date}|${norm(l.rec.from_place)}|${norm(l.rec.to_place)}`)).filter(Boolean);
    if (known.length) {
      trip.item.existing_ref = known[0].travel_id;
      trip.item.action = 'skip';
      trip.item.flags.push(flag('duplicate', 'trip_exists', `already in the tracker as ${known[0].travel_id}`));
    }

    trip.legs.forEach((leg, i) => {
      const rec = leg.rec;
      const legFlags = leg.recs.flatMap((r) => r.flags);
      if (!rec.start_date) legFlags.push(flag('red', 'no_date', rec.mode === 'hotel' ? 'no check-in date' : 'no date of journey'));
      if (rec.mode === 'hotel' && !(rec.end_date && rec.start_date && rec.end_date > rec.start_date)) legFlags.push(flag('red', 'hotel_dates', 'a hotel stay needs a check-out after its check-in'));
      if (!rec.traveller) legFlags.push(flag('red', 'no_traveller', 'no traveller'));
      leg.item = add('segment', {
        trip_seq: trip.item.seq, seq: i + 1, mode: rec.mode, from_place: rec.mode === 'hotel' ? null : rec.from_place, to_place: rec.to_place,
        start_date: rec.start_date, end_date: rec.mode === 'hotel' ? rec.end_date : null, provider: rec.provider, pnr_or_ref: rec.pnr,
        status: leg.status, remarks: leg.recs.map((r) => r.remarks).filter(Boolean).join('; ') || null,
      }, { source_row: rec.row, tab: rec.tab, parent_seq: trip.item.seq, flags: legFlags });
      const exists = existingLegs.get(`${norm(payload.employee_name)}|${rec.start_date}|${norm(rec.from_place)}|${norm(rec.to_place)}`);
      if (exists) {
        Object.assign(leg.item, { existing_ref: String(exists.segment_id), action: 'skip' });
        leg.item.flags.push(flag('duplicate', 'leg_exists', `already in the tracker on ${exists.travel_id}`));
      }
    });
  }

  // ---------------------------------------------------------------- the agency's invoices
  // Every row that bills a leg: not a note, and not a later row cancelling a leg already read.
  const bills = (r) => !r.isNote && r.invoice_no && recLeg.get(r)?.rec === r;
  const invoices = new Map();
  for (const rec of recs.filter(bills)) {
    const k = refKey(rec.invoice_no);
    if (!invoices.has(k)) invoices.set(k, { no: rec.invoice_no, recs: [] });
    invoices.get(k).recs.push(rec);
  }
  for (const [k, inv] of invoices) {
    const flags = [];
    const assumptions = [];
    const dated = inv.recs.map((r) => r.booking_date || r.start_date).filter(Boolean).sort()[0] || null;
    if (dated) assumptions.push(`Invoice date ${dated}: the booking date, until the invoice PDF says otherwise`);
    if (prefixes.some((p) => k.startsWith(p))) flags.push(flag('blue', 'vendor_by_prefix', `${ctx.vendor.name}'s, by its number`));
    if (otherVendors.has(k)) flags.push(flag('red', 'other_vendors_invoice', `invoice ${inv.no} is already recorded under another vendor`));
    inv.item = add('vendor_invoice', { vendor_invoice_no: inv.no, invoice_date: dated, vendor_id: ctx.vendor.id }, { source_row: inv.recs[0].row, tab: inv.recs[0].tab, flags, assumptions });
    const known = byNumber.get(k);
    if (known) {
      Object.assign(inv.item, { existing_ref: String(known.id), action: 'skip' });
      inv.item.flags.push(flag('duplicate', 'invoice_exists', `already in the tracker as ${known.vendor_invoice_id}`));
    }
    for (const rec of inv.recs) {
      const leg = recLeg.get(rec);
      const lineFlags = [];
      const lineAssumptions = [];
      const parts = [rec.base_fare, rec.service_charge, rec.gst_amount];
      const sum = r2(parts.reduce((n, v) => n + (v || 0), 0));
      let total = rec.line_total;
      if (rec.base_fare === null && total === null) lineFlags.push(flag('red', 'no_amount', 'no amount'));
      if (total === null && parts.some((v) => v !== null)) {
        total = sum;
        lineFlags.push(flag('amber', 'total_blank', 'the total is blank'));
        lineAssumptions.push(`Total ${sum}: amount + admin charges + GST, as the sheet gives no total`);
      } else if (total !== null && parts.some((v) => v !== null) && Math.abs(total - sum) > 1) {
        lineFlags.push(flag('amber', 'total_mismatch', `total ${total} is not amount + admin + GST (${sum})`));
      }
      if (rec.gst_amount === null && total !== null) lineFlags.push(flag('amber', 'gst_blank', 'GST is blank'));
      const taxable = (rec.base_fare || 0) + (rec.service_charge || 0);
      const line = add('invoice_line', {
        invoice_seq: inv.item.seq, trip_seq: leg?.trip.item.seq ?? null, segment_seq: leg?.item.seq ?? null,
        base_fare: rec.base_fare, service_charge: rec.service_charge, gst_amount: rec.gst_amount,
        gst_rate: rec.gst_amount !== null && taxable > 0 ? r2((rec.gst_amount / taxable) * 100) : null,
        line_total: total, remarks: rec.remarks || null,
      }, { source_row: rec.row, tab: rec.tab, parent_seq: inv.item.seq, flags: lineFlags, assumptions: lineAssumptions });
      if (known && leg?.item.existing_ref) Object.assign(line, { action: 'skip', existing_ref: leg.item.existing_ref });
    }
  }
  for (const rec of recs.filter((r) => !r.cancelled && !r.invoice_no)) {
    const leg = recLeg.get(rec);
    leg?.item.flags.push(flag('amber', 'no_invoice_number', 'no invoice number: the leg is recorded, its cost waits for the invoice'));
  }

  // ---------------------------------------------------------------- credit and cancellation notes
  for (const rec of recs.filter((r) => r.cancelled)) {
    const leg = recLeg.get(rec);
    if (!rec.credit_no) {
      if (!leg?.recs.some((r) => r.credit_no)) leg?.item.flags.push(flag('amber', 'cancelled_no_note', 'cancelled, but no credit note number is given'));
      continue;
    }
    const flags = [];
    const against = rec.against ? invoices.get(refKey(rec.against)) : null;
    if (rec.against && !against && !byNumber.has(refKey(rec.against))) flags.push(flag('amber', 'original_not_found', `the invoice it reverses, ${rec.against}, is in neither the sheet nor the tracker`));
    const note = add('credit_note', {
      credit_note_no: rec.credit_no, vendor_id: ctx.vendor.id,
      kind: rec.noteKind || (/\/CNT\//i.test(rec.credit_no) || /cancel/i.test(rec.remarks || '') ? 'cancellation_note' : 'credit_note'),
      against_invoice_no: rec.against || null, against_invoice_seq: against?.item.seq ?? null,
      segment_seq: leg?.item.seq ?? null,
      // Sheets write a refund as -5000 as often as 5000.
      refund_amount: Math.abs(rec.line_total ?? rec.base_fare ?? 0), cancellation_charges: rec.charges ?? leg?.recs.map((r) => r.charges).find((v) => v != null) ?? null,
      credit_note_date: rec.booking_date || rec.start_date || null, remarks: rec.remarks || null,
    }, { source_row: rec.row, tab: rec.tab, flags,
      assumptions: rec.booking_date || rec.start_date ? [`Dated ${rec.booking_date || rec.start_date}: the row's date, until the note's PDF says otherwise`] : [] });
    if (credits.has(refKey(rec.credit_no))) {
      note.action = 'skip';
      note.flags.push(flag('duplicate', 'credit_note_exists', 'already in the tracker'));
    }
  }

  const count = (step) => items.filter((i) => i.step === step).length;
  const summary = {
    rows: recs.length, travellers: count('traveller'), trips: count('trip'), legs: count('segment'), invoices: count('vendor_invoice'),
    lines: count('invoice_line'), credit_notes: count('credit_note'),
    red: items.filter((i) => i.flags.some((f) => f.level === 'red')).length,
    amber: items.filter((i) => i.flags.some((f) => f.level === 'amber')).length,
    duplicates: items.filter((i) => i.flags.some((f) => f.level === 'duplicate')).length,
  };
  return { items, summary, tabs: tabsOut };
}
