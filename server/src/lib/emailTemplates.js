/**
 * The emails the tracker sends, as plain functions returning
 * { subject, text, html }. Plain HTML strings rather than a component
 * library: there is no build step, and finance can read the text version
 * in the email log exactly as the client received it.
 */
import { windowNote } from './misWindow.js';

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
 */
export function paymentReminder({ company, contactName, stages, financeEmail, level = 1, finalLevel = 3 }) {
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

Thank you,
Cetizion Verifica`;
  const html = layout(prefix, `
<p>Dear ${esc(contactName || company)},</p>
<p>This is a reminder that the following ${stages.length === 1 ? 'invoice is' : 'invoices are'} past due:</p>
${table(['Invoice', 'PO / stage', 'Outstanding', 'Due date', 'Overdue'], stages.map((s) => [s.invoice_no, `${s.po_number} · ${s.stage_name}`, inr(Number(s.stage_amount) - Number(s.amount_received || 0), s.currency), date(s.invoice_due_date), `${s.days_overdue} days`]))}
<p><strong>Total outstanding: ${esc(inr(total, currency))}</strong></p>
<p>If payment has already been made, please share the transaction reference so we can update our records.${financeEmail ? ` For any query, reply to this email or write to ${esc(financeEmail)}.` : ''}</p>
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
const link = (appUrl, path, text) => (appUrl ? `<a href="${esc(appUrl)}${esc(path)}" style="color:#0F3D5E">${esc(text)}</a>` : esc(text));

/**
 * The Daily Sales Briefing email: the headline figures, the highlights, the
 * overdue items and the top actions, with the PDF attached. `data` is
 * misReports.js dailyBriefing(); links go to tracker pages (a sign-in).
 */
export function dailyBriefing({ data, appUrl = '' }) {
  const g = data.at_a_glance;
  const day = date(data.period.from);
  const overdue = [...data.pending.invoices.rows, ...data.pending.pos.rows, ...data.pending.quotations.rows].filter((r) => r.overdue).sort((a, b) => b.score - a.score).slice(0, 10);
  const subject = `Daily Sales Briefing – ${day}: ${g.new_enquiries} new enquir${g.new_enquiries === 1 ? 'y' : 'ies'}, ${g.pos_received} PO${g.pos_received === 1 ? '' : 's'}, ${g.overdue} overdue`;
  const figures = [
    ['New enquiries', g.new_enquiries], ['Quotations sent', g.quotations_sent],
    ['POs received', `${g.pos_received} · ${lakh(g.pos_received_inr)}`], ['Invoices raised', `${g.invoices_raised} · ${lakh(g.invoices_raised_inr)}`],
    ['Payments received', `${g.payments_received} · ${lakh(g.payments_received_inr)}`],
    ['Pending invoices / POs / quotations', `${g.pending_invoices} / ${g.pending_pos} / ${g.pending_quotations}`],
    [`Overdue (more than ${data.overdue_days} days)`, g.overdue],
  ];
  const actionLine = (a) => `${a.client}: ${a.wording || `${a.next_action} — ${a.reference}`} (${a.days} d${a.amount_inr != null ? `, ${lakh(a.amount_inr)}` : ''}${a.owner ? `, ${a.owner}` : ''})`;
  const text = `Good morning,

Here is the sales briefing for ${day}.

${figures.map(([k, v]) => `${k}: ${v}`).join('\n')}

HIGHLIGHTS
${data.highlights.length ? data.highlights.map((h) => `- ${h.client}: ${h.summary}${h.action ? ` → ${h.action}` : ''}`).join('\n') : '- Nothing was created or changed from email yesterday.'}${data.mail_window ? `\n(${windowNote(data.mail_window)})` : ''}

TOP ACTIONS FOR TODAY
${data.top_actions.length ? data.top_actions.map((a, i) => `${i + 1}. ${actionLine(a)}`).join('\n') : '- Nothing is pending.'}

OVERDUE (${overdue.length}${overdue.length === 10 ? '+' : ''})
${overdue.length ? overdue.map((r) => `- ${r.client} · ${r.reference} · ${r.days} days${r.amount_inr != null ? ` · ${lakh(r.amount_inr)}` : ''}`).join('\n') : '- Nothing overdue.'}

The full briefing is attached as a PDF. ${FX_NOTE}

Regards,
Cetizion Tracker
`;
  const html = layout(`Daily Sales Briefing, ${day}`, `
<p>Good morning,</p>
<p>Here is the sales briefing for <strong>${esc(day)}</strong>.</p>
${table([], figures.map(([k, v]) => [k, String(v)]))}
<h3 style="font-size:14px;margin:16px 0 4px">Highlights</h3>
${data.highlights.length
    ? `<ul>${data.highlights.map((h) => `<li><strong>${esc(h.client)}:</strong> ${esc(h.summary)}${h.action ? ` → ${esc(h.action)}` : ''}${h.link ? ` · ${link(appUrl, h.link, 'open')}` : ''}</li>`).join('')}</ul>`
    : '<p style="color:#64748b">Nothing was created or changed from email yesterday.</p>'}
${data.mail_window ? `<p style="color:#64748b;font-size:12px;margin:4px 0 0">${esc(windowNote(data.mail_window))}</p>` : ''}
<h3 style="font-size:14px;margin:16px 0 4px">Top actions for today</h3>
${data.top_actions.length
    ? `<ol>${data.top_actions.map((a) => `<li>${esc(actionLine(a))} · ${link(appUrl, a.link, 'open')}</li>`).join('')}</ol>`
    : '<p style="color:#64748b">Nothing is pending.</p>'}
<h3 style="font-size:14px;margin:16px 0 4px">Overdue (${overdue.length}${overdue.length === 10 ? '+' : ''})</h3>
${overdue.length
    ? table(['Client', 'Reference', 'Days', 'Amount'], overdue.map((r) => [r.client, r.reference, String(r.days), r.amount_inr == null ? (r.amount == null ? '—' : 'no rate') : lakh(r.amount_inr)]))
    : '<p style="color:#64748b">Nothing overdue.</p>'}
<p>The full briefing is attached as a PDF.</p>
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
