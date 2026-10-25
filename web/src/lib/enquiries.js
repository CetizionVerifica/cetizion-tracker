/**
 * An enquiry as the list and its page both describe it (#24, and the first
 * step of the sales journey, docs/specs/sales-journey): its statuses, the
 * form that edits it, and what its page says and offers.
 *
 * The form used to live inside the Enquiries list. The enquiry page edits
 * and converts the same record with the same form, and two copies of a
 * field list drift: the day one gains a field, the other saves the record
 * without it. So both read it from here. No React, so
 * test/enquiries.test.js reads it directly.
 *
 * Nothing here works out where the sale is. The rail on the page asks the
 * server (components/journey/JourneyRail.jsx); what this file decides is
 * the page's own sentence and its one button, which are about the enquiry.
 */
import { date, localDate, money, today } from './format.js';

export const CONVERTED = 'Converted';
export const UNQUALIFIED = 'Unqualified';
const QUALIFIED = 'Qualified';
/** The statuses, in the order an enquiry moves through them, for when the lookups have not loaded. */
export const ENQUIRY_STATUSES = ['New', 'Contacted', QUALIFIED, 'Nurture', CONVERTED, UNQUALIFIED];
/** Still being worked: a missed follow-up on one of these is somebody's to make. */
export const OPEN_STATUSES = ['New', 'Contacted', QUALIFIED, 'Nurture'];
const SECTORS = ['Agriculture', 'Metal Industry', 'Pharmaceutical', 'Other'];
const COUNTRIES = ['India', 'United Arab Emirates', 'Singapore', 'United Kingdom', 'United States'];

/** The statuses the server knows, or the fallback above. */
export const enquiryStatuses = (lookups) => lookups?.enums?.enquiry || ENQUIRY_STATUSES;
/** The sectors in use, or a starting list on a new install. */
export const enquirySectors = (lookups) => (lookups?.sectors?.length ? lookups.sectors : SECTORS);

/**
 * The enquiry form, for a new enquiry (`record` null) or an existing one.
 *
 * `record` matters for one field: a linked quotation the lookups no longer
 * offer (a lost one, say) is still shown as the current choice, so opening
 * the form and saving it does not quietly unlink it.
 */
export function enquiryFields(lookups, record) {
  const statuses = enquiryStatuses(lookups);
  const quotations = lookups?.quotations || [];
  return [
    { name: 'enquiry_no', label: 'Enquiry number', auto: 'enquiry' },
    { name: 'enquiry_date', label: 'Enquiry date', type: 'date', default: today() },
    { name: 'client_name', label: 'Client', required: true, type: 'combo', options: lookups?.clients || [], hint: 'One spelling per client; a new name creates a company' },
    { name: 'source', label: 'Enquiry source', hint: 'How the enquiry reached us, such as referral, website, email or event' },
    { name: 'sector', label: 'Sector', type: 'combo', options: enquirySectors(lookups) },
    { name: 'country', label: 'Country', type: 'combo', options: COUNTRIES },

    { name: 'contact_person', label: 'Contact person' },
    // The address lives on the contact, and until now there was nowhere to
    // type it: the contact this name creates held a name and nothing else,
    // so sending the quotation, chasing payment, the portal and mailbox
    // matching all had nobody to reach (docs/client-data-gaps.md, gap 1).
    { name: 'contact_email', label: 'Contact email', type: 'email', hint: 'Saved on the contact. Used to send the quotation and to chase payment' },
    { name: 'contact_phone', label: 'Contact phone' },
    { name: 'source_id', label: 'Source', type: 'select', options: (lookups?.lead_sources || []).map((s) => ({ value: String(s.id), label: s.name })), hint: 'Where this enquiry came from' },
    { name: 'service', label: 'Service asked for', type: 'combo', options: lookups?.services || [] },
    { name: 'services_interested', label: 'Other services of interest' },
    { name: 'estimated_value', label: 'Estimated value', type: 'money', hint: 'Carried onto the quotation when converted' },
    { name: 'currency', label: 'Currency', type: 'select', options: lookups?.enums?.currency || ['INR'], default: 'INR' },
    { name: 'sales_person', label: 'Owner', type: 'combo', options: lookups?.sales_people || [] },
    { name: 'sales_person_email', label: 'Owner email', type: 'email' },
    { name: 'status', label: 'Status', type: 'select', options: statuses, default: 'New', required: true, hint: `Leaving New needs a source and the client; Qualified and "${CONVERTED}" need the services and an estimated value; Unqualified needs a reason. "${CONVERTED}" creates a draft quotation, a line per service, unless one is linked` },
    { name: 'next_follow_up_at', label: 'Next follow-up', type: 'date', hint: 'Blank: set from Settings when the status changes' },
    { name: 'expected_decision_date', label: 'Expected decision', type: 'date' },
    { name: 'unqualified_reason_id', label: 'Reason, if unqualified', type: 'select', options: (lookups?.lost_reasons || []).map((r) => ({ value: String(r.id), label: r.name })) },
    { name: 'unqualified_notes', label: 'Notes on that', span: 2 },
    {
      name: 'quotation_no', label: 'Existing quotation', type: 'select', span: 2,
      hint: 'For an enquiry that was already quoted: link that quotation instead of creating a new one',
      options: [
        ...(record?.quotation_no && !quotations.some((q) => q.quotation_no === record.quotation_no) ? [{ value: record.quotation_no, label: record.quotation_no }] : []),
        ...quotations.map((q) => ({ value: q.quotation_no, label: `${q.quotation_no} — ${q.client_name} (${q.status})` })),
      ],
    },
    { name: 'notes', label: 'Notes', type: 'textarea', span: 'all' },
  ];
}

/** What it asks for: the service picked, else the others typed, as the list's "Interested in" reads. */
export const enquiryService = (e) => e?.service || e?.services_interested || null;

/** "Kestrel Polymers · ISO 9001 certification", or the client alone. */
export function enquiryTitle(e) {
  const client = e?.client_name || e?.enquiry_no || 'Enquiry';
  const service = enquiryService(e);
  return service ? `${client} · ${service}` : client;
}

/**
 * The day it arrived: the enquiry date as typed, else the day it was
 * entered. The first is a date and reads as typed; the second is a time
 * the server stamped, so it is read in the reader's day.
 */
export function enquiryReceived(e) {
  if (e?.enquiry_date) return date(e.enquiry_date);
  return e?.created_at ? localDate(e.created_at) : null;
}

/** Where it came from: the source picked from the list, else the one typed. */
export function enquirySource(e, lookups) {
  const picked = (lookups?.lead_sources || []).find((s) => String(s.id) === String(e?.source_id));
  return picked?.name || e?.source || null;
}

/** Why it was dropped: the reason picked, and the note beside it. */
export function unqualifiedBecause(e, lookups) {
  const reason = (lookups?.lost_reasons || []).find((r) => String(r.id) === String(e?.unqualified_reason_id))?.name;
  return [reason, e?.unqualified_notes].filter(Boolean).join(' — ') || null;
}

/** The status as a chip's tone (web/CLAUDE.md §1): converted is done, unqualified stopped, the rest information. */
export function enquiryTone(status) {
  if (status === CONVERTED) return 'settled';
  if (status === UNQUALIFIED) return 'late';
  return 'info';
}

/**
 * The page's one move, by the enquiry's state (docs/specs/sales-journey §4 E).
 *
 * A quotation, once there is one, is where the sale goes on, so it wins
 * over everything; a qualified enquiry is ready to become one; anything
 * else moves on by talking to the client.
 */
export function enquiryMove(e) {
  if (e?.quotation_no) return 'open_quotation';
  if (e?.status === QUALIFIED) return 'convert';
  return 'log_call';
}

/** The button for each move. */
export const MOVE_LABELS = {
  open_quotation: 'Open the quotation',
  convert: 'Convert to quotation',
  log_call: 'Log a call',
};

/**
 * Whether an open enquiry's follow-up date has gone by: the same test the
 * list's "follow-ups due" banner makes, a day later, since a follow-up due
 * today can still be made today.
 */
export function followUpMissed(e, on = today()) {
  if (!OPEN_STATUSES.includes(e?.status) || !e?.next_follow_up_at) return false;
  return String(e.next_follow_up_at).slice(0, 10) < on;
}

/** " The follow-up due on 12 Oct 2026 was missed." and its kin, for an open enquiry; nothing otherwise. */
function followUp(e, on) {
  if (!OPEN_STATUSES.includes(e.status) || !e.next_follow_up_at) return '';
  const due = String(e.next_follow_up_at).slice(0, 10);
  if (followUpMissed(e, on)) return ` The follow-up due on ${date(due)} was missed.`;
  return due === on ? ' The follow-up is due today.' : ` Next follow-up on ${date(due)}.`;
}

/**
 * The sentence under the rail: what the enquiry waits on, and who.
 *
 * `lookups` names the reason it was dropped; `on` is today, passed in so a
 * test can pin it. Dates typed as dates read as typed; the times the
 * server stamps (first reply, conversion) are read in the reader's day.
 */
export function enquiryVerdict(e, lookups, on = today()) {
  if (!e) return '';
  const owner = e.sales_person;
  if (e.quotation_no) {
    return `Quoted as ${e.quotation_no}${e.converted_at ? ` on ${localDate(e.converted_at)}` : ''}. The quotation carries the sale from here.`;
  }
  if (e.status === UNQUALIFIED) {
    const why = unqualifiedBecause(e, lookups);
    return `Dropped as unqualified${why ? `: ${why}` : ''}. If the client comes back, set the status again with Edit.`;
  }
  if (e.status === CONVERTED) {
    return 'Marked converted, but no quotation is linked to it. Link the quotation with Edit.';
  }
  if (e.status === QUALIFIED) {
    const service = enquiryService(e);
    const worth = e.estimated_value === null || e.estimated_value === undefined || e.estimated_value === ''
      ? 'with no estimate yet'
      : `worth ${money(e.estimated_value, e.currency || 'INR')}`;
    return `Qualified${service ? `: ${service},` : ','} ${worth}. Converting it starts the quotation.${followUp(e, on)}`;
  }
  if (e.status === 'Nurture') {
    return `Parked for later, to come back to when the client is ready.${followUp(e, on)}`;
  }
  const touched = e.last_contacted_at || e.first_responded_at;
  if (e.status === 'New' && !touched) {
    const received = enquiryReceived(e);
    const who = owner ? `: ${owner} to make the first contact` : ', and nobody owns it yet';
    return `Received${received ? ` on ${received}` : ''} and not answered yet${who}.${followUp(e, on)}`;
  }
  const since = touched ? ` since ${localDate(e.first_responded_at || touched)}` : '';
  return `In touch${since}. Qualify it once the services and what it is worth are known.${followUp(e, on)}`;
}

/**
 * What has happened to it so far, oldest first, for the page's rail: the
 * day it arrived and the times the server stamped as it moved (the first
 * reply when it left New, the last call or email logged, the conversion).
 * A moment that has not happened is left out rather than shown blank.
 */
export function enquiryEvents(e, lookups) {
  if (!e) return [];
  const source = enquirySource(e, lookups);
  return [
    { what: 'Received', when: enquiryReceived(e), detail: source ? `Via ${source}` : null },
    { what: 'First reply', when: e.first_responded_at && localDate(e.first_responded_at) },
    { what: 'Last in touch', when: e.last_contacted_at && localDate(e.last_contacted_at) },
    { what: 'Converted', when: e.converted_at && localDate(e.converted_at), detail: e.quotation_no ? `Quoted as ${e.quotation_no}` : null },
  ].filter((event) => event.when);
}

/**
 * One line on the enquiry's questionnaire (#208), by the status of the
 * latest one sent (v_enquiries.questionnaire_status), and the button that
 * opens it. Everything else about it is in the questionnaire's own dialog.
 */
export function questionnaireLine(status) {
  if (!status) {
    return { text: 'None sent yet. It asks the client, step by step, what the quotation needs, and the answers can price it.', button: 'Send the questionnaire' };
  }
  if (status === 'submitted') {
    return { text: 'The client has answered. Open it to read the answers, or to generate the quotation from them.', button: 'Open the questionnaire' };
  }
  if (['not_started', 'in_progress', 'reopened'].includes(status)) {
    return { text: 'Sent, and waiting on the client. Open it to remind them, copy a link, or fill it in with them on a call.', button: 'Open the questionnaire' };
  }
  return { text: 'Open it to see where it stands, or send another.', button: 'Open the questionnaire' };
}

/**
 * The small print: what the button will do, and where the rest went.
 * Read off the same move as the button, so the two never disagree.
 */
export function enquiryNote(move) {
  if (move === 'open_quotation') return 'Its lines, sending it to the client and the PO are on the quotation. Edit, Log a call and the questionnaire are in the ⋯ menu.';
  if (move === 'convert') {
    return `Converting opens the enquiry form with the status set to "${CONVERTED}". Saving creates a draft quotation with a line per service and the estimate carried across, or links the quotation you pick. Edit and the questionnaire are in the ⋯ menu.`;
  }
  return 'Logging a call records what was said and the next step, which becomes a task and sets the next follow-up. Edit and the rest are in the ⋯ menu.';
}
