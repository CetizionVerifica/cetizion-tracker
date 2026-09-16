/**
 * The emails the tracker sends, as plain functions returning
 * { subject, text, html }. Plain HTML strings rather than a component
 * library: there is no build step, and finance can read the text version
 * in the email log exactly as the client received it.
 */

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
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
