/**
 * The Daily Sales Briefing's lines, said in code (docs/mis-briefing-fix-plan.md
 * §3): the at-a-glance table, the day paragraph, the line under each pending
 * table and the header's source line. Built from the counts misReports.js
 * computed, so every number in them is the report's. No imports, so the
 * email and the PDF can print them without loading the database.
 */

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "3 Oct", as the reference says a day in its sentences. */
export const shortDay = (d) => { const [, m, day] = String(d).slice(0, 10).split('-'); return `${Number(day)} ${MON[Number(m) - 1]}`; };

const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The header's source line: "sales@…, info@… — Inbox + Sent Items, 00:00–23:59 IST". */
export function sourceLine(mailboxes, timeZone) {
  const read = mailboxes?.read || [];
  if (!read.length) return 'no shared mailbox is read';
  const folders = [...new Set(read.map((b) => b.folders))];
  const zone = timeZone === 'Asia/Kolkata' ? 'IST' : timeZone;
  const boxes = folders.length === 1
    ? `${read.map((b) => b.email).join(', ')} — ${folders[0]}`
    : read.map((b) => `${b.email} (${b.folders})`).join(', ');
  return `${boxes}, 00:00–23:59 ${zone}`;
}

/** What the overdue count is made of: "2 invoices, 1 PO". */
export function overdueBreakdown(pending) {
  return [['invoice', pending.invoices.overdue], ['PO', pending.pos.overdue], ['quotation', pending.quotations.overdue]]
    .filter(([, n]) => n).map(([what, n]) => count(n, what)).join(', ');
}

/** Highlights about mail that made no record that day: the "other sales activity". */
export function otherActivity(data) {
  const fromRecords = new Set((data.events || []).map((e) => e.thread_id).filter((id) => id != null));
  return (data.highlights || []).filter((h) => h.source === 'ai' && !fromRecords.has(h.thread_id));
}

/** The line under each pending table ("No PO received or closed on 3 Oct"). */
export function closingLine(section, data) {
  const g = data.at_a_glance;
  const day = shortDay(data.period.from);
  if (section === 'invoices') {
    if (!g.invoices_raised && !g.payments_received) return `No invoice raised and no payment received on ${day}.`;
    return `${count(g.invoices_raised, 'invoice')} raised and ${count(g.payments_received, 'payment')} received on ${day}.`;
  }
  if (section === 'pos') return g.pos_received ? `${count(g.pos_received, 'PO')} received on ${day}.` : `No PO received or closed on ${day}.`;
  return g.quotations_sent ? `${count(g.quotations_sent, 'quotation')} sent on ${day}.` : `No quotation sent on ${day}.`;
}

/**
 * The paragraph under the header: how much mail there was, how much was
 * left out, what moved, what is overdue.
 */
export function dayParagraph(data) {
  const g = data.at_a_glance;
  const day = shortDay(data.period.from);
  const parts = [];
  const w = data.mail_window;
  if (w) {
    const left = w.excluded.reduce((n, e) => n + e.count, 0);
    parts.push(`${count(w.threads, 'email thread')} in the shared mailboxes on ${day}${left ? `; ${left} left out as not sales business or repeated` : ''}.`);
  }
  const moved = [
    [g.new_enquiries, 'new enquiry', 'new enquiries'], [g.quotations_sent, 'quotation sent', 'quotations sent'], [g.pos_received, 'PO received', 'POs received'],
    [g.invoices_raised, 'invoice raised', 'invoices raised'], [g.payments_received, 'payment received', 'payments received'],
  ].filter(([n]) => n).map(([n, one, many]) => count(n, one, many));
  parts.push(moved.length ? `${moved.join(', ')}.` : `No new enquiry, quotation, PO, invoice or payment on ${day}.`);
  if (!g.pos_received && !g.payments_received) parts.push('No pending item was closed.');
  const overdue = overdueBreakdown(data.pending);
  if (overdue) parts.push(`Overdue: ${overdue}.`);
  return parts.join(' ');
}

const listed = (items = [], max) => (items.length > max ? `${items.slice(0, max).join('; ')}; +${items.length - max} more` : items.join('; '));

/** "3 to raise, 2 awaiting payment": a pending count by kind. */
function byKind(rows, labels) {
  return labels.map(([kind, one, many]) => [rows.filter((r) => r.kind === kind).length, one, many])
    .filter(([n]) => n).map(([n, one, many]) => count(n, one, many)).join(', ');
}

/**
 * "1. At a glance" as Metric / Count / Detail rows. `money` formats an INR
 * value; `max` is how many names a Detail lists before "+N more".
 */
export function glanceRows(data, { money = (v) => String(v), max = 4 } = {}) {
  const g = data.at_a_glance;
  const d = data.glance_detail || {};
  const p = data.pending;
  const other = otherActivity(data);
  const valued = (n, inr) => (n ? `${n} · ${money(inr)}` : '0');
  return [
    { metric: 'New enquiries', count: String(g.new_enquiries), detail: listed(d.new_enquiries, max) },
    { metric: 'Quotations sent', count: String(g.quotations_sent), detail: listed(d.quotations_sent, max) },
    {
      metric: 'POs received', count: valued(g.pos_received, g.pos_received_inr),
      detail: [listed(d.pos_received, max), g.pos_registered_late ? `${count(g.pos_registered_late, 'older PO')} registered` : ''].filter(Boolean).join('; '),
    },
    { metric: 'Invoices raised', count: valued(g.invoices_raised, g.invoices_raised_inr), detail: listed(d.invoices_raised, max) },
    { metric: 'Payments received', count: valued(g.payments_received, g.payments_received_inr), detail: listed(d.payments_received, max) },
    { metric: 'Other sales activity', count: String(other.length), detail: listed([...new Set(other.map((h) => h.client))], max) },
    {
      metric: 'Pending invoices', count: String(g.pending_invoices),
      detail: byKind(p.invoices.rows, [['to_invoice', 'to raise', 'to raise'], ['invoice_due', 'awaiting payment', 'awaiting payment'], ['invoice_review', 'read from email, to check', 'read from email, to check']]),
    },
    {
      metric: 'Pending POs', count: String(g.pending_pos),
      detail: byKind(p.pos.rows, [['awaiting_po', 'verbal yes awaiting its PO', 'verbal yeses awaiting their POs'], ['won_without_po', 'won with no PO registered', 'won with no PO registered'], ['po_review', 'PO received by email, not registered', 'POs received by email, not registered']]),
    },
    {
      metric: 'Pending quotations', count: String(g.pending_quotations),
      detail: byKind(p.quotations.rows, [['enquiry_unquoted', 'enquiry not quoted', 'enquiries not quoted'], ['quotation_open', 'quotation not answered', 'quotations not answered']]),
    },
    { metric: `Overdue (over ${data.overdue_days} days)`, count: String(g.overdue), detail: overdueBreakdown(p) || 'none' },
  ];
}
