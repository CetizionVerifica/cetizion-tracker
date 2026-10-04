import { pendingRow } from '../src/lib/misReports.js';

/** Fixtures shaped like misReports.js's output: a busy day and a busy week. Shared by misPdf.test.js. */
const row = (i, over = {}) => pendingRow({
  kind: 'to_invoice', key: `k${i}`, client: `Client ${i}`, reference: `PO-${1000 + i} · Advance`, amount_inr: 100000 + i * 1000, currency: 'INR', amount: 100000 + i * 1000,
  since: '2026-09-01', days: 5 + i, owner: 'Priya', next_action: 'Raise the Advance invoice', link: '/x', ...over,
}, 7);
const many = (n) => Array.from({ length: n }, (_, i) => row(i));
const section = (rows) => ({ count: rows.length, overdue: rows.filter((r) => r.overdue).length, value_inr: rows.reduce((n, r) => n + (r.amount_inr || 0), 0), unconverted: 0, rows });

// The day's invoices as the reference splits them: to raise, awaiting payment (with their mail), read from email to check (no amount).
const invoices = [
  ...many(6),
  ...many(12).map((r, i) => ({ ...r, kind: 'invoice_due', key: `due${i}`, reference: `Invoice CVPL/2026-27/0${10 + i} · PO-${1000 + i}`, next_action: 'Chase payment', last_activity: '2026-10-02', email_link: 'https://outlook.office.com/mail/item/x' })),
  ...many(2).map((r, i) => ({ ...r, kind: 'invoice_review', key: `rev${i}`, reference: 'Invoice (unread)', amount: null, amount_inr: null, currency: null, email_link: '/inbox?mb=1&f=sent&t=9' })),
];

export const daily = {
  kind: 'daily_briefing', period: { from: '2026-10-04', to: '2026-10-04' }, today: '2026-10-05', overdue_days: 7,
  at_a_glance: { new_enquiries: 3, quotations_sent: 2, pos_received: 1, pos_received_inr: 180000, pos_registered_late: 1, invoices_raised: 2, invoices_raised_inr: 250000, payments_received: 1, payments_received_inr: 20000, pending_invoices: 20, pending_pos: 20, pending_quotations: 20, overdue: 39 },
  pending: { invoices: section(invoices), pos: section(many(20).map((r) => ({ ...r, kind: 'awaiting_po' }))), quotations: section(many(20).map((r) => ({ ...r, kind: 'quotation_open' }))) },
  invoice_tables: {
    actions: section(invoices.filter((r) => r.kind === 'invoice_review')),
    to_raise: section(invoices.filter((r) => r.kind === 'to_invoice')),
    // Reconciled with Finance's list (§3a): one figure differs, one line is on the list only.
    receivables: section([
      ...invoices.filter((r) => r.kind === 'invoice_due').map((r, i) => ({ ...r, age: r.days + 30, source: i === 0 ? 'both' : 'tracker', note: i === 0 ? 'list: 1,05,000; tracker: 1,00,000' : "not on Finance's list of 3 Oct" })),
      { ...row(30), kind: 'list_receivable', key: 'list:1:4', client: 'Gamma & Sons', reference: "On Finance's list", next_action: 'Finance: record in tracker', overdue: false, source: 'list', age: 40, email_link: 'https://outlook.office.com/mail/item/list' },
    ]),
    list: { id: 1, date: '2026-10-03', file_name: 'Sundry Debtors.xlsx', grand_total: 1500000, matched: 1, list_only: 1, tracker_only: 11 },
  },
  glance_detail: {
    new_enquiries: ['Acme Steel', 'Beta Metals', 'Coreal'], quotations_sent: ['Acme Steel (CTZ/QT/2026/101)', 'Dasami (CTZ/QT/2026/102)'], pos_received: ['Hindalco (PO-77)'],
    invoices_raised: ['Aragen (CVPL/2026-27/037)', 'Alembic (CVPL/2026-27/038)'], payments_received: ['Coreal (CVPL/2026-27/012)'],
  },
  reminders: [
    { kind: 'visit', text: 'Visit: EcoVadis audit, Hindalco, 6 Oct, Pune (confirmed)', link: '/schedule?visit=4' },
    { kind: 'po_not_registered', text: 'PO from Dasami, received 2 Oct, is still not registered', link: '/purchase-orders?tab=review' },
  ],
  mailboxes: { read: [{ email: 'sales@cetizionverifica.com', folders: 'Inbox + Sent Items' }, { email: 'info@cetizionverifica.com', folders: 'Inbox + Sent Items' }], not_read: [] },
  app_url: 'https://tracker.example',
  top_actions: many(5),
  readers: { enquiries_created: 2 },
  events: [{ kind: 'enquiry', thread_id: 0 }],
  highlights: Array.from({ length: 8 }, (_, i) => ({
    thread_id: i, client: `Client ${i}`, summary: `Asked for a revised quotation on lot ${i}, delivery by December.`, action: 'Send the revision', owner: 'Priya', link: '/quotations/x', source: 'ai',
    web_link: `https://outlook.office.com/mail/item/${i}`,
    related: i === 0 ? [{ day: '2026-09-28', from: 'Ravi', subject: 'RFQ: EcoVadis for 3 sites', link: 'https://outlook.office.com/mail/item/r1' }] : [],
  })),
  mail_window: { mailboxes: ['info@cetizionverifica.com', 'sales@cetizionverifica.com'], not_read: [], threads: 14, kept: 8, cut: 0, excluded: [{ reason: 'our own report', count: 1 }, { reason: 'an automatic or bulk sender', count: 5 }] },
  quiet: false,
};

export const weekly = {
  kind: 'weekly_mis', period: { from: '2026-09-28', to: '2026-10-04' }, month_to_date: { from: '2026-10-01', to: '2026-10-04' }, today: '2026-10-05', overdue_days: 7,
  enquiries: {
    total: 14, month_to_date: 6,
    per_day: ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'].map((d, i) => ({ date: d, label: `${28 + i}`.slice(-2), enquiries: 2 })),
    sources: [{ name: 'Website', enquiries: 9 }, { name: 'Referral', enquiries: 5 }],
    rows: Array.from({ length: 14 }, (_, i) => ({ enquiry_no: `E${i}`, date: '2026-09-29', client: `Client ${i}`, country: 'India', sector: 'Pharmaceutical', service: 'EcoVadis assessment', source: 'Website', first_response_hours: i % 3 ? 26.5 : null })),
    tat: { median_hours: 26.5, with_tat: 9, without_tat: 5 },
  },
  outcomes: {
    total: 14,
    slices: [{ key: 'converted', label: 'Converted to PO', count: 3, pct: 21 }, { key: 'pipeline', label: 'In pipeline', count: 8, pct: 57 }, { key: 'quoted_not_won', label: 'Quoted, not won', count: 2, pct: 15 }, { key: 'lost', label: 'Lost', count: 1, pct: 7 }],
    detail: Array.from({ length: 14 }, (_, i) => ({ client: `Client ${i}`, outcome: ['converted', 'pipeline', 'pipeline', 'quoted_not_won', 'lost'][i % 5] })),
  },
  sectors: { rows: [{ sector: 'Pharmaceutical', pos: 3, value_inr: 900000 }, { sector: 'Metal Industry', pos: 2, value_inr: 400000 }, { sector: 'Other', pos: 1, value_inr: 50000, other: true }], total: { pos: 6, value_inr: 1350000 } },
  services: { rows: [{ line: 'EcoVadis', pos: 3, value_inr: 800000 }, { line: 'ISO 14001', pos: 2, value_inr: 450000 }, { line: 'Other', pos: 1, value_inr: 100000, other: true }], total: { pos: 6, value_inr: 1350000 } },
  customers: { tiles: { new_customers: 2, repeat_orders: 4 }, repeat_orders: [] },
  pos: Array.from({ length: 15 }, (_, i) => ({ po_number: `PO-${i}`, po_date: '2026-10-01', customer: `Client ${i}`, country: 'India', service: 'EcoVadis', po_value_inr: 90000, repeat: i % 2 === 0 })),
  revenue: { total: { pos: 6, po_value_inr: 1350000 } },
  quotations_sent: [],
  billing: { week: { invoices: 4, invoiced_inr: 600000, payments: 3, received_inr: 350000 }, month_to_date: { invoices: 2, invoiced_inr: 250000, payments: 1, received_inr: 20000 } },
  receivables: { outstanding_inr: 2400000, overdue_inr: 1200000, overdue_count: 7, over_90: { amount_inr: 500000, count: 2 }, oldest_days: 131, largest: { company: 'Big Client Ltd', overdue: 300000 }, top: [], top_clients: [], unconverted: 0 },
  pending: { invoices: section(many(20)), pos: section(many(10).map((r) => ({ ...r, kind: 'awaiting_po' }))), quotations: section(many(10).map((r) => ({ ...r, kind: 'quotation_open' }))) },
  follow_ups_overdue: { count: 6, value_inr: 700000, top: [] },
  speed: { enquiry_to_po_pct: 21, won: 3, lost: 2, quote_to_contract_pct: 60, quote_to_po_days_median: 9, quote_to_po_sample: 3, average_po_ticket_inr: 225000, pipeline: { count: 11, value_inr: 3100000, weighted_inr: 1400000, average_ticket_inr: 281818, without_rate: 0 }, enquiry_tat_median_hours: 26.5 },
  notes: [{ text: '1 PO has no sector on its quotation or company.' }],
  narrative: { enquiries: '14 enquiries received.', outcomes: '3 of 14 (21%) converted to a PO.', revenue: '₹13.5 L from 6 POs.', customers: '2 new customers.' },
};

