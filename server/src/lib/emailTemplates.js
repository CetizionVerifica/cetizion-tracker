/**
 * The emails the tracker sends, as plain functions returning
 * { subject, text, html }. Plain HTML strings rather than a component
 * library: there is no build step, and finance can read the text version
 * in the email log exactly as the client received it.
 */
import { windowNote } from './misWindow.js';
import { dayParagraph, glanceRows } from './misBriefing.js';

const esc =(s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const inr = (n, currency = 'INR') => {
  const v = Number(n || 0);
  const sym = { INR: '₹', USD: '$', EUR: '€', GBP: '£', AED: 'AED ', SGD: 'S$' }[currency] || `${currency} `;
  return sym + new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', { maximumFractionDigits: 0 }).format(v);
};
const date = (d) => {
  if (!d) return '';
  const [y, m, day] = String(d).slice(0, 10).split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${day} ${months[Number(m) - 1]} ${y}`;
};

function layout(title, bodyHtml) {
  return `<!doctype html><html><body style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#0f172a;line-height:1.5;margin:0;padding:24px;background:#f8fafc">
<div style="max-width:640px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:24px">
<h2 style="margin:0 0 12px;font-size:18px;color:#0f766e">${esc(title)}</h2>
${bodyHtml}
<p style="margin-top:24px;font-size:12px;color:#64748b">Cetizion Verifica · This message was sent from the Cetizion Tracker.</p>
</div></body></html>`;
}

function table(headers, rows) {
  const th = headers.map((h) => `<th style="text-align:left;padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:12px;color:#64748b">${esc(h)}</th>`).join('');
  const tr = rows.map((r) => `<tr>${r.map((c) => `<td style="padding:6px 8px;border-bottom:1px solid #f1f5f9">${esc(c)}</td>`).join('')}</tr>`).join('');
  return `<table style="border-collapse:collapse;width:100%;margin:12px 0">${th ? `<tr>${th}</tr>` : ''}${tr}</table>`;
}

/**
 * A payment reminder to one client for its overdue stages.
 * stages: [{ po_number, stage_name, invoice_no, invoice_date, invoice_due_date, currency, stage_amount, amount_received, days_overdue }]
 * portalUrl: the client portal's address, when the recipient can sign in to it (#198 phase 3).
 */
export function paymentReminder({ company, contactName, stages, financeEmail, level = 1, finalLevel = 3, portalUrl = null }) {
  const total = stages.reduce((n, s) => n + (Number(s.stage_amount) - Number(s.amount_received || 0)), 0);
  const currency = stages[0]?.currency || 'INR';
  const prefix = level >= finalLevel ? 'Final reminder' : level === 2 ? 'Second reminder' : 'Payment reminder';
  const subject = `${prefix}: ${stages.length === 1 ? `invoice ${stages[0].invoice_no}` : `${stages.length} invoices`} due from ${company}`;
  const lines = stages.map((s) => `- Invoice ${s.invoice_no} (${s.po_number}, ${s.stage_name}): ${inr(Number(s.stage_amount) - Number(s.amount_received || 0), s.currency)} outstanding, due ${date(s.invoice_due_date)}, ${s.days_overdue} days overdue`);
  const text = `Dear ${contactName || company},

This is a reminder that the following ${stages.length === 1 ? 'invoice is' : 'invoices are'} past due:

${lines.join('\n')}

Total outstanding: ${inr(total, currency)}

If payment has already been made, please share the transaction reference so we can update our records. For any query, reply to this email${financeEmail ? ` or write to ${financeEmail}` : ''}.
${portalUrl ? `\n${PORTAL_NOTE.text(portalUrl)}\n` : ''}
Thank you,
Cetizion Verifica`;
  const html = layout(prefix, `
<p>Dear ${esc(contactName || company)},</p>
<p>This is a reminder that the following ${stages.length === 1 ? 'invoice is' : 'invoices are'} past due:</p>
${table(['Invoice', 'PO / stage', 'Outstanding', 'Due date', 'Overdue'], stages.map((s) => [s.invoice_no, `${s.po_number} · ${s.stage_name}`, inr(Number(s.stage_amount) - Number(s.amount_received || 0), s.currency), date(s.invoice_due_date), `${s.days_overdue} days`]))}
<p><strong>Total outstanding: ${esc(inr(total, currency))}</strong></p>
<p>If payment has already been made, please share the transaction reference so we can update our records.${financeEmail ? ` For any query, reply to this email or write to ${esc(financeEmail)}.` : ''}</p>
${portalUrl ? PORTAL_NOTE.html(portalUrl) : ''}
<p>Thank you,<br>Cetizion Verifica</p>`);
  return { subject, text, html };
}

/** How to reach the client portal, as a reminder and a new-invoice email both say it. */
const PORTAL_NOTE = {
  text: (url) => `In the Cetizion Verifica client portal you can download your invoices, raise a query, or tell us you have paid: ${url}
Enter this email address there and we will send you a link that signs you in.`,
  html: (url) => `<p>In the <a href="${esc(url)}">Cetizion Verifica client portal</a> you can download your invoices, raise a query, or tell us you have paid. Enter this email address there and we will send you a link that signs you in.</p>`,
};

/**
 * A new invoice is in the client portal (#198 phase 3, G6), to one portal
 * contact. invoice: { invoice_no, invoice_date, invoice_due_date, po_number,
 * stage_name, stage_amount, currency, taxable, gst, document_id }.
 */
export function portalNewInvoice({ contactName, company, invoice: s, url }) {
  const subject = `Invoice ${s.invoice_no} for PO ${s.po_number} is in your client portal`;
  const amount = Number(s.gst) > 0
    ? `${inr(s.stage_amount, s.currency)} including GST ${inr(s.gst, s.currency)} (taxable ${inr(s.taxable, s.currency)})`
    : inr(s.stage_amount, s.currency);
  const what = `Invoice ${s.invoice_no} dated ${date(s.invoice_date)}, for ${s.stage_name} on PO ${s.po_number}, is now in the client portal${s.document_id ? ' with its PDF' : ''}.`;
  const text = `Dear ${contactName || company},

${what}

Amount: ${amount}${s.invoice_due_date ? `\nDue: ${date(s.invoice_due_date)}` : ''}

${PORTAL_NOTE.text(url)}

Thank you,
Cetizion Verifica`;
  const html = layout(`Invoice ${s.invoice_no} is in your client portal`, `
<p>Dear ${esc(contactName || company)},</p>
<p>${esc(what)}</p>
${table([], [['Amount', amount], ...(s.invoice_due_date ? [['Due', date(s.invoice_due_date)]] : [])])}
${PORTAL_NOTE.html(url)}
<p style="margin:16px 0"><a href="${esc(url)}" style="display:inline-block;padding:10px 16px;border-radius:8px;background:#0f766e;color:#fff;text-decoration:none">Open the client portal</a></p>
<p>Thank you,<br>Cetizion Verifica</p>`);
  return { subject, text, html };
}

/** The morning digest to finance: what to invoice, what is overdue, what was chased. */
export function financeDigest({ today, toInvoice, overdue, remindersSent }) {
  const subject = `Finance digest ${date(today)}: ${toInvoice.length} to invoice, ${overdue.length} overdue`;
  const text = `Finance digest for ${date(today)}

TO INVOICE (${toInvoice.length})
${toInvoice.map((s) => `- ${s.client_name} · ${s.po_number} · ${s.stage_name} · ${inr(s.stage_amount, s.currency)}`).join('\n') || '- none'}

OVERDUE (${overdue.length})
${overdue.map((s) => `- ${s.client_name} · invoice ${s.invoice_no} · ${inr(Number(s.stage_amount) - Number(s.amount_received || 0), s.currency)} · ${s.days_overdue} days`).join('\n') || '- none'}

Reminders sent to clients today: ${remindersSent}
`;
  const html = layout(`Finance digest, ${date(today)}`, `
<h3 style="font-size:14px;margin:16px 0 4px">To invoice (${toInvoice.length})</h3>
${toInvoice.length ? table(['Client', 'PO', 'Stage', 'Amount'], toInvoice.map((s) => [s.client_name, s.po_number, s.stage_name, inr(s.stage_amount, s.currency)])) : '<p style="color:#64748b">Nothing waiting for an invoice.</p>'}
<h3 style="font-size:14px;margin:16px 0 4px">Overdue (${overdue.length})</h3>
${overdue.length ? table(['Client', 'Invoice', 'Outstanding', 'Overdue'], overdue.map((s) => [s.client_name, s.invoice_no, inr(Number(s.stage_amount) - Number(s.amount_received || 0), s.currency), `${s.days_overdue} days`])) : '<p style="color:#64748b">Nothing overdue.</p>'}
<p>Reminders sent to clients today: <strong>${remindersSent}</strong></p>`);
  return { subject, text, html };
}

/** The daily digest (#44): everything unread in the notification centre. */
export function dailyDigest({ today, items }) {
  const subject = `Tracker digest ${date(today)}: ${items.length} thing${items.length === 1 ? '' : 's'} need attention`;
  const text = `Tracker digest for ${date(today)}

${items.map((n) => `- ${n.title}${n.body ? ` (${n.body})` : ''}`).join('\n')}
`;
  const html = layout(`Tracker digest, ${date(today)}`, table(['What', 'Details'], items.map((n) => [n.title, n.body || ''])));
  return { subject, text, html };
}

/** One notification, for someone who asked to get that kind by email (#44). */
export function notificationEmail({ item, appUrl = '' }) {
  const link = item.link ? `${appUrl}${item.link}` : null;
  const subject = item.title;
  const text = `${item.title}${item.body ? `\n\n${item.body}` : ''}${link ? `\n\n${link}` : ''}\n\nChange what you are emailed about under Account, Notifications.`;
  const html = layout(item.title, `${item.body ? `<p>${esc(item.body)}</p>` : ''}${link ? `<p><a href="${esc(link)}">Open it in the tracker</a></p>` : ''}<p style="color:#6b7280;font-size:12px">Change what you are emailed about under Account, Notifications.</p>`);
  return { subject, text, html };
}

/** The Monday digest for admins (#44): the week in counts, and what is still open. */
export function weeklyDigest({ today, raised, open, items }) {
  const total = raised.reduce((n, r) => n + r.n, 0);
  const subject = `Tracker week to ${date(today)}: ${total} notification${total === 1 ? '' : 's'}, ${open.reduce((n, r) => n + r.n, 0)} still open`;
  const text = `The week to ${date(today)}

Raised this week:
${raised.map((r) => `- ${r.kind}: ${r.n}`).join('\n') || '- nothing'}

Still open:
${open.map((r) => `- ${r.kind}: ${r.n}`).join('\n') || '- nothing'}

${items.map((n) => `- ${n.title}${n.body ? ` (${n.body})` : ''}`).join('\n')}
`;
  const html = layout(`The week to ${date(today)}`,
    table(['Kind', 'Raised this week', 'Still open'], [...new Set([...raised, ...open].map((r) => r.kind))].map((k) => [
      k, String(raised.find((r) => r.kind === k)?.n || 0), String(open.find((r) => r.kind === k)?.n || 0),
    ])) + (items.length ? table(['Oldest still open', 'Details'], items.map((n) => [n.title, n.body || ''])) : ''));
  return { subject, text, html };
}

export function testEmail({ to, mode }) {
  const subject = 'Cetizion Tracker: test email';
  const text = `This is a test email from the Cetizion Tracker to ${to}. Delivery mode: ${mode}. If you are reading this, sending works.`;
  return { subject, text, html: layout('Test email', `<p>${esc(text)}</p>`) };
}

/** To the approver: a quotation needs a yes. */
export function approvalRequest({ quotation: q, reason, requestedBy }) {
  const subject = `Approval needed: quotation ${q.quotation_no} for ${q.client_name}`;
  const text = `${requestedBy || 'Sales'} asks for approval on quotation ${q.quotation_no} (${q.client_name}, ${q.service_quoted || 'services'}).

Value: ${inr(q.total ?? q.quotation_value, q.currency)}${q.discount_percent ? `\nOverall discount: ${Number(q.discount_percent)}%` : ''}
Reason: ${reason}

Open the quotation in the tracker to approve or reject it.`;
  return { subject, text, html: layout('Approval needed', `<p>${esc(text).replace(/\n/g, '<br>')}</p>`) };
}

/** To the sales person: the decision. */
export function approvalDecision({ quotation: q, decision, note, decidedBy }) {
  const subject = `Quotation ${q.quotation_no} ${decision}`;
  const text = `Quotation ${q.quotation_no} for ${q.client_name} was ${decision}${decidedBy ? ` by ${decidedBy}` : ''}.${note ? `\n\nNote: ${note}` : ''}${decision === 'approved' ? '\n\nIt can now be sent to the client.' : '\n\nRevise the discount or terms and ask again.'}`;
  return { subject, text, html: layout(`Quotation ${decision}`, `<p>${esc(text).replace(/\n/g, '<br>')}</p>`) };
}

// ------------------------------------------------- follow-ups and escalation

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const KIND_NAMES = { enquiry: ['enquiry', 'enquiries'], quotation: ['quotation', 'quotations'], payment_stage: ['invoice', 'invoices'] };
const KIND_ORDER = ['enquiry', 'quotation', 'payment_stage'];
const SECTION = { enquiry: 'Enquiries', quotation: 'Quotations', payment_stage: 'Invoices' };

/** Where a follow-up email link lands: the record, with its "Log a touch" dialog open. */
const recordLink = (appUrl, item) => {
  if (!item.link) return '';
  const base = String(appUrl || '').replace(/\/+$/, '');
  return `${base}${item.link}${item.link.includes('?') ? '&' : '?'}log=1`;
};

/** Why an item needs a follow-up, in a few words. */
function whyDue(i) {
  if (i.why === 'task') {
    const task = `task${i.task_title ? ` "${i.task_title}"` : ''} due ${date(i.due_on)}`;
    return i.entity === 'payment_stage' ? `${inr(i.amount, i.currency || 'INR')} overdue ${plural(Number(i.days_overdue || 0), 'day', 'days')}; ${task}` : task;
  }
  if (i.entity === 'enquiry') {
    return i.why === 'follow_up_date' ? `follow-up date ${date(i.due_on)}` : `no contact for ${plural(i.idle_days ?? 0, 'working day', 'working days')}`;
  }
  if (i.entity === 'quotation') return `${{ dated: 'dated', entered: 'entered' }[i.sent_basis] || 'sent'} ${date(i.sent_on)}, no contact for ${plural(i.idle_days ?? 0, 'working day', 'working days')}`;
  return `${inr(i.amount, i.currency || 'INR')} overdue ${plural(Number(i.days_overdue || 0), 'day', 'days')}`;
}

const label = (i) => i.number || i.entity_id;

/** A table whose first cell is a link; every value escaped. */
function linkTable(headers, rows) {
  const th = headers.map((h) => `<th style="text-align:left;padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:12px;color:#64748b">${esc(h)}</th>`).join('');
  const tr = rows.map(([first, href, ...rest]) => `<tr><td style="padding:6px 8px;border-bottom:1px solid #f1f5f9">${href ? `<a href="${esc(href)}">${esc(first)}</a>` : esc(first)}</td>${rest.map((c) => `<td style="padding:6px 8px;border-bottom:1px solid #f1f5f9">${esc(c)}</td>`).join('')}</tr>`).join('');
  return `<table style="border-collapse:collapse;width:100%;margin:12px 0"><tr>${th}</tr>${tr}</table>`;
}

/**
 * One owner's follow-ups for the day: new items by kind, then the ones
 * already reminded and still inside their grace period.
 * items/waiting: plan items from lib/followUps.js planFollowUps().
 */
export function followUpReminder({ ownerName, today, items, more: notListed = 0, waiting = [], respondBy, appUrl = '', cap = 50 }) {
  // The subject and the respond-by date cover only the listed items; the
  // rest come in the next reminder, with their own date.
  const shown = items.slice(0, cap);
  const more = notListed + items.length - shown.length;
  const counts = KIND_ORDER.map((k) => [k, shown.filter((i) => i.entity === k).length]).filter(([, n]) => n);
  const subject = `Follow up today: ${counts.map(([k, n]) => plural(n, ...KIND_NAMES[k])).join(', ')}`;
  const footer = `Log a call, email, meeting or note on the record by ${date(respondBy)} or this goes to management.`;
  const bell = 'This email is separate from the follow-up notifications in the tracker\'s bell, and goes whatever your notification settings say.';

  const textSections = KIND_ORDER.map((k) => {
    const rows = shown.filter((i) => i.entity === k);
    if (!rows.length) return '';
    return `${SECTION[k].toUpperCase()} (${rows.length})\n${rows.map((i) => `- ${label(i)} · ${i.client || ''} · ${whyDue(i)} · respond by ${date(respondBy)}\n  ${recordLink(appUrl, i)}`).join('\n')}\n`;
  }).filter(Boolean).join('\n');
  const textWaiting = waiting.length
    ? `\nSTILL WAITING (${waiting.length})\n${waiting.map((i) => `- ${label(i)} · ${i.client || ''} · respond by ${date(i.respond_by)}\n  ${recordLink(appUrl, i)}`).join('\n')}\n`
    : '';
  const text = `Hello ${ownerName || ''},

These need a follow-up from you today.

${textSections}${more > 0 ? `\n${more} more ${more === 1 ? 'is' : 'are'} due as well. ${more === 1 ? 'It comes' : 'They come'} in your next reminder, with ${more === 1 ? 'its' : 'their'} own respond-by date.\n` : ''}${textWaiting}
${footer}

${bell}
`;

  const htmlSections = KIND_ORDER.map((k) => {
    const rows = shown.filter((i) => i.entity === k);
    if (!rows.length) return '';
    return `<h3 style="font-size:14px;margin:16px 0 4px">${esc(SECTION[k])} (${rows.length})</h3>
${linkTable(['Record', 'Client', 'Why', 'Respond by'], rows.map((i) => [label(i), recordLink(appUrl, i), i.client || '', whyDue(i), date(respondBy)]))}`;
  }).join('');
  const htmlWaiting = waiting.length
    ? `<h3 style="font-size:14px;margin:16px 0 4px">Still waiting (${waiting.length})</h3>
${linkTable(['Record', 'Client', 'Respond by'], waiting.map((i) => [label(i), recordLink(appUrl, i), i.client || '', date(i.respond_by)]))}`
    : '';
  const html = layout(`Follow up today, ${date(today)}`, `
<p>Hello ${esc(ownerName || '')},</p>
<p>These need a follow-up from you today.</p>
${htmlSections}${more > 0 ? `<p>${more} more ${more === 1 ? 'is' : 'are'} due as well. ${more === 1 ? 'It comes' : 'They come'} in your next reminder, with ${more === 1 ? 'its' : 'their'} own respond-by date.</p>` : ''}${htmlWaiting}
<p><strong>${esc(footer)}</strong></p>
<p style="color:#64748b;font-size:12px">${esc(bell)}</p>`);
  return { subject, text, html };
}

/** Rows grouped under each owner's name, in the order given. */
function groupByOwner(items) {
  const groups = new Map();
  for (const i of items) {
    const name = i.owner_name || 'Unknown';
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(i);
  }
  return [...groups.entries()];
}

const escalationRow = (appUrl, i) => [
  label(i), recordLink(appUrl, i), i.client || '', i.amount === null || i.amount === undefined ? '' : inr(i.amount, i.currency || 'INR'),
  i.reminded_on ? date(i.reminded_on) : '—', i.respond_by ? date(i.respond_by) : '—', i.idle_days === null || i.idle_days === undefined ? '' : String(i.idle_days),
];
const ESCALATION_HEADERS = ['Record', 'Client', 'Value', 'Reminded', 'Respond by', 'Working days quiet'];
const UNOWNED_HEADERS = ['Record', 'Client', 'Value', 'Previous owner', 'Working days quiet'];
const unownedRow = (appUrl, i) => [
  label(i), recordLink(appUrl, i), i.client || '', i.amount === null || i.amount === undefined ? '' : inr(i.amount, i.currency || 'INR'),
  i.owner_name || '—', i.idle_days === null || i.idle_days === undefined ? '' : String(i.idle_days),
];

/**
 * The daily escalation to management: follow-ups nobody acted on after a
 * reminder, ones still open since an earlier escalation, and ones with no
 * owner to remind.
 */
export function followUpEscalation({ today, escalated = [], stillOpen = [], unowned = [], appUrl = '' }) {
  const parts = [];
  if (escalated.length) parts.push(`${escalated.length} new`);
  if (stillOpen.length) parts.push(`${stillOpen.length} still open`);
  if (unowned.length) parts.push(`${unowned.length} with no owner`);
  const subject = `Follow-ups missed: ${parts.join(', ')}`;
  // Say what actually happened: nobody was reminded about an unowned record.
  const reminded = escalated.length + stillOpen.length;
  const intro = reminded && unowned.length
    ? 'The owner was reminded about the first of these and nothing has been logged since. The rest have no owner to remind.'
    : reminded ? 'The owner was reminded and nothing has been logged on these since.'
    : 'These are due a follow-up and have no owner to remind.';

  const textRow = (i) => `  - ${label(i)} · ${i.client || ''}${i.amount === null || i.amount === undefined ? '' : ` · ${inr(i.amount, i.currency || 'INR')}`}${i.reminded_on ? ` · reminded ${date(i.reminded_on)} · respond by ${date(i.respond_by)}` : ''} · ${i.idle_days ?? '?'} working days quiet\n    ${recordLink(appUrl, i)}`;
  const textGrouped = (title, items) => (items.length
    ? `${title} (${items.length})\n${groupByOwner(items).map(([owner, rows]) => `${owner}\n${rows.map(textRow).join('\n')}`).join('\n')}\n\n`
    : '');
  const text = `Follow-ups missed, ${date(today)}

${intro}

${textGrouped('MISSED', escalated)}${textGrouped('STILL OPEN AFTER AN EARLIER ESCALATION', stillOpen)}${unowned.length ? `NO OWNER (${unowned.length})\nNobody could be reminded. Assign an owner in the tracker.\n${unowned.map((i) => `${textRow(i)}${i.owner_name ? ` (was ${i.owner_name})` : ''}`).join('\n')}\n` : ''}`;

  const htmlGrouped = (title, items) => (items.length
    ? `<h3 style="font-size:14px;margin:16px 0 4px">${esc(title)} (${items.length})</h3>${groupByOwner(items).map(([owner, rows]) => `<p style="margin:8px 0 0"><strong>${esc(owner)}</strong></p>${linkTable(ESCALATION_HEADERS, rows.map((i) => escalationRow(appUrl, i)))}`).join('')}`
    : '');
  const html = layout(`Follow-ups missed, ${date(today)}`, `
<p>${esc(intro)}</p>
${htmlGrouped('Missed', escalated)}${htmlGrouped('Still open after an earlier escalation', stillOpen)}${unowned.length ? `<h3 style="font-size:14px;margin:16px 0 4px">No owner (${unowned.length})</h3><p>Nobody could be reminded. Assign an owner in the tracker.</p>${linkTable(UNOWNED_HEADERS, unowned.map((i) => unownedRow(appUrl, i)))}` : ''}`);
  return { subject, text, html };
}

/** A short note to an owner whose follow-ups were escalated. */
export function followUpEscalatedNotice({ ownerName, items, appUrl = '' }) {
  const subject = `Sent to management: ${plural(items.length, 'follow-up', 'follow-ups')} with nothing logged`;
  const text = `Hello ${ownerName || ''},

Nothing was logged on ${items.length === 1 ? 'this record' : 'these records'} by the respond-by date, so ${items.length === 1 ? 'it has' : 'they have'} been listed for management today:

${items.map((i) => `- ${label(i)} · ${i.client || ''} · respond by ${date(i.respond_by)}\n  ${recordLink(appUrl, i)}`).join('\n')}

Logging a call, email, meeting or note on the record closes it.
`;
  const html = layout('Sent to management', `
<p>Hello ${esc(ownerName || '')},</p>
<p>Nothing was logged on ${items.length === 1 ? 'this record' : 'these records'} by the respond-by date, so ${items.length === 1 ? 'it has' : 'they have'} been listed for management today:</p>
${linkTable(['Record', 'Client', 'Respond by'], items.map((i) => [label(i), recordLink(appUrl, i), i.client || '', date(i.respond_by)]))}
<p>Logging a call, email, meeting or note on the record closes it.</p>`);
  return { subject, text, html };
}

// ---------------------------------------------------------------------
// The scheduled sales reports (docs/mis-reports-plan.md §3.6)
// ---------------------------------------------------------------------

const lakh = (v) => {
  if (v === null || v === undefined) return '—';
  const n = Number(v); const abs = Math.abs(n);
  if (abs >= 1e7) return `₹${(abs / 1e7).toFixed(2).replace(/\.?0+$/, '')} Cr`;
  if (abs >= 1e5) return `₹${(abs / 1e5).toFixed(1).replace(/\.?0+$/, '')} L`;
  return inr(n);
};
const FX_NOTE = 'Converted at the exchange rate on each record\'s date (ECB). Earlier reports used fixed rates of USD 88 and EUR 103.';
/** The briefing's Team reports line (mis-report-sender-plan.md §B2): misPersonal.js teamReports() in words. */
export function teamReportsLine(t) {
  if (!t) return null;
  return `Team reports: Sent: ${t.sent}${t.not_sent.length ? ` · Not sent: ${t.not_sent.map((n) => `${n.name} (${n.why})`).join(', ')}` : ''}`;
}
const link = (appUrl, path, text) => (appUrl ? `<a href="${esc(appUrl)}${esc(path)}" style="color:#0F3D5E">${esc(text)}</a>` : esc(text));

/**
 * The Daily Sales Briefing email: the reference's sections in short
 * (docs/mis-briefing-fix-plan.md §3) — at a glance, the highlights with
 * their source emails and the reminders, and the top 5 — with the PDF,
 * which has every pending row, attached. `data` is misReports.js
 * dailyBriefing(); tracker links need a sign-in, Outlook's open the message.
 */
export function dailyBriefing({ data, appUrl = '' }) {
  const g = data.at_a_glance;
  const day = date(data.period.from);
  const subject = `Daily Sales Briefing – ${day}: ${g.new_enquiries} new enquir${g.new_enquiries === 1 ? 'y' : 'ies'}, ${g.pos_received} PO${g.pos_received === 1 ? '' : 's'}, ${g.overdue} overdue`;
  const glance = glanceRows(data, { money: lakh, max: 3 });
  const highlights = data.highlights || [];
  const reminders = data.reminders || [];
  const url = (path) => (!path ? '' : /^https?:/i.test(path) ? path : appUrl ? `${appUrl}${path}` : '');
  const a = (href, text) => (href ? `<a href="${esc(href)}" style="color:#0F3D5E">${esc(text)}</a>` : esc(text));
  const source = (h) => (/^https?:/i.test(h.web_link || '') ? 'open in Outlook' : h.web_link ? 'open in the Inbox' : 'open the record');
  const sourceUrl = (h) => url(h.web_link) || url(h.link);
  const noReminders = 'No visit or meeting in the next three days, and no PO waiting to be registered.';
  const actionLine = (x) => `${x.client}: ${x.wording || `${x.next_action} — ${x.reference}`} (${x.days} d${x.amount_inr != null ? `, ${lakh(x.amount_inr)}` : ''}; owner: ${x.owner || 'not set'})`;
  const h3 = (text) => `<h3 style="font-size:14px;margin:16px 0 4px">${esc(text)}</h3>`;
  const muted = (text) => `<p style="color:#64748b">${esc(text)}</p>`;
  const text = `Good morning,

Here is the sales briefing for ${day}.

${dayParagraph(data)}

1. AT A GLANCE
${glance.map((r) => `${r.metric}: ${r.count}${r.detail ? ` (${r.detail})` : ''}`).join('\n')}

2. KEY HIGHLIGHTS
${highlights.length
    ? highlights.map((h, i) => `${i + 1}. ${h.client}: ${h.summary}${h.action ? `\n   Action / owner: ${h.action}${h.owner ? ` (${h.owner})` : ''}` : ''}${sourceUrl(h) ? `\n   Source email: ${sourceUrl(h)}` : ''}`).join('\n')
    : `- Nothing to highlight from the mail of ${day}.`}${data.mail_window ? `\n(${windowNote(data.mail_window)})` : ''}

Reminders carried forward:
${reminders.length ? reminders.map((r) => `- ${r.text}`).join('\n') : `- ${noReminders}`}

3. ACTION ITEMS FOR TODAY (TOP 5)
${data.top_actions.length ? data.top_actions.map((x, i) => `${i + 1}. ${actionLine(x)}`).join('\n') : '- Nothing is pending.'}
${data.team_reports ? `\n${teamReportsLine(data.team_reports)}\n` : ''}
The full briefing, with every pending item, is attached as a PDF. ${FX_NOTE}

Regards,
Cetizion Tracker
`;
  const html = layout(`Daily Sales Briefing, ${day}`, `
<p>Good morning,</p>
<p>Here is the sales briefing for <strong>${esc(day)}</strong>.</p>
<p>${esc(dayParagraph(data))}</p>
${h3('1. At a glance')}
${table(['Metric', 'Count', 'Detail'], glance.map((r) => [r.metric, r.count, r.detail || '—']))}
${h3('2. Key highlights')}
${highlights.length
    ? `<ol>${highlights.map((h) => `<li><strong>${esc(h.client)}:</strong> ${esc(h.summary)}${h.action ? `<br>Action / owner: ${esc(h.action)}${h.owner ? ` (${esc(h.owner)})` : ''}` : ''}${sourceUrl(h) ? `<br>Source email: ${a(sourceUrl(h), source(h))}` : ''}</li>`).join('')}</ol>`
    : muted(`Nothing to highlight from the mail of ${day}.`)}
${data.mail_window ? `<p style="color:#64748b;font-size:12px;margin:4px 0 0">${esc(windowNote(data.mail_window))}</p>` : ''}
<p style="margin:12px 0 4px"><strong>Reminders carried forward</strong></p>
${reminders.length ? `<ul>${reminders.map((r) => `<li>${a(url(r.link), r.text)}</li>`).join('')}</ul>` : muted(noReminders)}
${h3('3. Action items for today (top 5)')}
${data.top_actions.length
    ? `<ol>${data.top_actions.map((x) => `<li>${esc(actionLine(x))} · ${a(url(x.email_link || x.link), 'open')}</li>`).join('')}</ol>`
    : muted('Nothing is pending.')}
${data.team_reports ? `<p>${esc(teamReportsLine(data.team_reports))}</p>` : ''}
<p>The full briefing, with every pending item, is attached as a PDF.</p>
<p style="font-size:12px;color:#64748b">${esc(FX_NOTE)}</p>
<p>Regards,<br>Cetizion Tracker</p>`);
  return { subject, text, html };
}

/** The Weekly Sales MIS email: the headline figures and bullets, with the PDF attached. `data` is misReports.js weeklyMis(). */
export function weeklyMis({ data, appUrl = '' }) {
  const period = `${date(data.period.from)} – ${date(data.period.to)}`;
  const converted = data.outcomes.slices.find((s) => s.key === 'converted');
  const headline = data.commentary?.headline?.length ? data.commentary.headline : [data.narrative?.enquiries, data.narrative?.outcomes, data.narrative?.revenue, data.narrative?.customers].filter(Boolean);
  const subject = `Weekly Sales MIS – ${period}: ${data.enquiries.total} enquiries, ${data.revenue.total.pos} POs (${lakh(data.revenue.total.po_value_inr)})`;
  const figures = [
    ['Enquiries', `${data.enquiries.total} (month to date ${data.enquiries.month_to_date})`],
    ['Converted to PO', converted ? `${converted.count} of ${data.outcomes.total} (${converted.pct}%)` : '—'],
    ['POs received', `${data.revenue.total.pos} · ${lakh(data.revenue.total.po_value_inr)}`],
    ['Invoiced / received this week', `${lakh(data.billing.week.invoiced_inr)} / ${lakh(data.billing.week.received_inr)}`],
    ['Receivables over 90 days', `${lakh(data.receivables.over_90.amount_inr)} (${data.receivables.over_90.count} invoices)`],
    ['Overdue items', `${data.pending.invoices.overdue + data.pending.pos.overdue + data.pending.quotations.overdue} pending more than ${data.overdue_days} days`],
    ['Open pipeline', `${lakh(data.speed.pipeline.value_inr)} (weighted ${lakh(data.speed.pipeline.weighted_inr)})`],
  ];
  const text = `Good morning,

Here is the sales MIS for the week of ${period}.

${headline.map((t) => `- ${t}`).join('\n')}

${figures.map(([k, v]) => `${k}: ${v}`).join('\n')}

The full report is attached as a PDF, with the enquiry table, sector-wise and service-wise sales, customer analysis, pending items and conversion figures. ${FX_NOTE}

Regards,
Cetizion Tracker
`;
  const html = layout(`Weekly Sales MIS, ${period}`, `
<p>Good morning,</p>
<p>Here is the sales MIS for the week of <strong>${esc(period)}</strong>.</p>
${headline.length ? `<ul>${headline.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
${table([], figures.map(([k, v]) => [k, String(v)]))}
<p>The full report is attached as a PDF, with the enquiry table, sector-wise and service-wise sales, customer analysis, pending items and conversion figures.${appUrl ? ` ${link(appUrl, '/reports', 'Open the Reports page')}.` : ''}</p>
<p style="font-size:12px;color:#64748b">${esc(FX_NOTE)}</p>
<p>Regards,<br>Cetizion Tracker</p>`);
  return { subject, text, html };
}

// ---------------------------------------------------------------------
// The personal daily MIS (mis-report-sender-plan.md §B1)
// ---------------------------------------------------------------------

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** "Tue 6 Oct 2026", as the subject has it. */
export function dayTitle(d) {
  const [y, m, day] = String(d).slice(0, 10).split('-').map(Number);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${WEEKDAY_SHORT[new Date(Date.UTC(y, m - 1, day)).getUTCDay()]} ${day} ${months[m - 1]} ${y}`;
}

/** The headings of the seven sections; every line under them is the AI's (misAi.js writePersonal). */
export const PERSONAL_SECTIONS = [
  ['actions', 'Actions taken'],
  ['mailbox', 'From the mailbox'],
  ['not_in_tracker', 'In email, not in the tracker'],
  ['waiting', 'Waiting on them'],
  ['today', 'Today'],
  ['for_management', 'For management'],
];
export const MAILBOX_PARTS = [['highlights', 'What mattered'], ['commitments', 'Commitments'], ['owed_replies', 'Replies owed'], ['awaiting', 'Awaiting a reply']];
const COUNT_WORDS = [['emails_sent', 'Emails sent'], ['emails_received', 'Emails received'], ['calls', 'Calls and meetings'], ['records_created', 'Records created'], ['tasks_done', 'Tasks done'], ['overdue', 'Overdue']];

/**
 * The personal daily MIS email (§B1): the AI's report in short, the PDF
 * attached. `data` is { person, period, report } with `report` as
 * writePersonal checked it. Code adds the headings and the counts' labels,
 * never a sentence of its own.
 */
export function personalMis({ data, appUrl = '' }) {
  const r = data.report;
  const day = dayTitle(data.period.from);
  const subject = `Daily MIS · ${data.person.name} · ${day}`;
  const url = (path) => (!path ? '' : /^https?:/i.test(path) ? path : appUrl ? `${appUrl}${path}` : '');
  const a = (href, text) => (href ? `<a href="${esc(href)}" style="color:#0F3D5E">${esc(text)}</a>` : esc(text));
  const h3 = (text) => `<h3 style="font-size:14px;margin:16px 0 4px">${esc(text)}</h3>`;
  const none = '<p style="color:#64748b">—</p>';
  const itemsOf = (key) => (key === 'for_management' ? r.for_management.map((text) => ({ text })) : key === 'actions' ? r.actions.map((x) => ({ ...x, text: `${x.at} ${x.text}` })) : r[key]);
  const flag = (x) => (x.no_action_yesterday ? ' [no action yesterday]' : '');
  const due = (x) => (x.due ? ` (by ${date(x.due)})` : '');

  const textSections = PERSONAL_SECTIONS.map(([key, title], i) => {
    if (key === 'mailbox') {
      const parts = MAILBOX_PARTS.map(([k, t]) => `${t}:\n${r.mailbox[k].length ? r.mailbox[k].map((x) => `- ${x.text}${due(x)}`).join('\n') : '- —'}`).join('\n');
      return `${i + 2}. ${title.toUpperCase()}\n${parts}`;
    }
    const items = itemsOf(key);
    return `${i + 2}. ${title.toUpperCase()}\n${items.length ? items.map((x) => `- ${x.text}${flag(x)}`).join('\n') : '- —'}`;
  }).join('\n\n');
  const text = `${subject}

1. SUMMARY OF THE DAY
${r.summary.text}
${COUNT_WORDS.map(([k, label]) => `${label}: ${r.summary.counts[k]}`).join(' · ')}

${textSections}

PDF attached.
`;

  const htmlSections = PERSONAL_SECTIONS.map(([key, title], i) => {
    if (key === 'mailbox') {
      return h3(`${i + 2}. ${title}`) + MAILBOX_PARTS.map(([k, t]) => `<p style="margin:8px 0 2px"><strong>${esc(t)}</strong></p>${r.mailbox[k].length ? `<ul>${r.mailbox[k].map((x) => `<li>${a(url(x.link), `${x.text}${due(x)}`)}</li>`).join('')}</ul>` : none}`).join('');
    }
    const items = itemsOf(key);
    return h3(`${i + 2}. ${title}`) + (items.length
      ? `<ul>${items.map((x) => `<li>${a(url(x.link), x.text)}${x.no_action_yesterday ? ' <strong style="color:#b42318">no action yesterday</strong>' : ''}</li>`).join('')}</ul>`
      : none);
  }).join('\n');
  const html = layout(`Daily MIS · ${data.person.name}`, `
<p style="color:#64748b;margin:0 0 8px">${esc(day)}</p>
${h3('1. Summary of the day')}
<p>${esc(r.summary.text)}</p>
${table(COUNT_WORDS.map(([, label]) => label), [COUNT_WORDS.map(([k]) => String(r.summary.counts[k]))])}
${htmlSections}
<p style="font-size:12px;color:#64748b">PDF attached.</p>`);
  return { subject, text, html };
}

// ------------------------------------------------------------ service questionnaires (#208)

const button = (url, label) => `<p style="margin:16px 0"><a href="${esc(url)}" style="display:inline-block;padding:10px 16px;border-radius:8px;background:#0f766e;color:#fff;text-decoration:none">${esc(label)}</a></p>`;

/**
 * The client's questionnaire link, or a reminder of it. `message` is the
 * salesperson's own note, printed as text.
 */
export function questionnaireInvite({ contactName, company, questionnaire, url, expiresAt, from, message = '', reminder = false }) {
  const subject = reminder
    ? `Reminder: ${questionnaire} for ${company}`
    : `${questionnaire} for ${company}: a few questions before we quote`;
  const opening = reminder
    ? `A reminder about the ${questionnaire}: we need your answers before we can prepare your quotation.`
    : `To prepare an accurate quotation, please answer a few questions about ${company} in our ${questionnaire}.`;
  const how = `It takes a few minutes and works on a phone. Your answers are saved as you go, so you can stop and come back with the same link. The link works until ${date(expiresAt)}.`;
  const text = `Dear ${contactName || company},

${opening}
${message ? `\n${message}\n` : ''}
Open the questionnaire: ${url}

${how}

Thank you,
${from || 'Cetizion Verifica'}`;
  const html = layout(reminder ? 'A reminder about your questionnaire' : questionnaire, `
<p>Dear ${esc(contactName || company)},</p>
<p>${esc(opening)}</p>
${message ? `<p style="white-space:pre-wrap;border-left:3px solid #e2e8f0;padding-left:12px;color:#334155">${esc(message)}</p>` : ''}
${button(url, 'Open the questionnaire')}
<p style="color:#475569">${esc(how)}</p>
<p>Thank you,<br>${esc(from || 'Cetizion Verifica')}</p>`);
  return { subject, text, html };
}

/** To the enquiry's owner: the client has submitted, the answers are on the enquiry. */
export function questionnaireSubmitted({ ownerName, company, questionnaire, enquiryNo, submittedBy, link }) {
  const subject = `${company} submitted the ${questionnaire}`;
  const text = `Hello ${ownerName || ''},

${submittedBy || 'The client'} submitted the ${questionnaire} for ${company} (enquiry ${enquiryNo || '—'}). The answers are on the enquiry${link ? `: ${link}` : ''}.

Cetizion Tracker`;
  const html = layout(subject, `
<p>Hello ${esc(ownerName || '')},</p>
<p>${esc(submittedBy || 'The client')} submitted the ${esc(questionnaire)} for ${esc(company)} (enquiry ${esc(enquiryNo || '—')}). The answers are on the enquiry.</p>
${link ? button(link, 'See the answers') : ''}
<p>Cetizion Tracker</p>`);
  return { subject, text, html };
}
