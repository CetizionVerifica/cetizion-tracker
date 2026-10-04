import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { closingLine, dayParagraph, glanceRows, otherActivity, overdueBreakdown, shortDay, sourceLine } from '../src/lib/misBriefing.js';
import { threadLink } from '../src/lib/misReports.js';

/**
 * The daily briefing's lines said in code (docs/mis-briefing-fix-plan.md §3):
 * every number in them is one the report computed.
 */

const section = (rows) => ({ count: rows.length, overdue: rows.filter((r) => r.overdue).length, rows });
const day = (over = {}) => ({
  period: { from: '2026-10-03', to: '2026-10-03' },
  overdue_days: 7,
  at_a_glance: { new_enquiries: 0, quotations_sent: 0, pos_received: 0, pos_received_inr: 0, pos_registered_late: 0, invoices_raised: 0, invoices_raised_inr: 0, payments_received: 0, payments_received_inr: 0, pending_invoices: 3, pending_pos: 1, pending_quotations: 2, overdue: 3 },
  pending: {
    invoices: section([{ kind: 'to_invoice', overdue: true }, { kind: 'invoice_due', overdue: true }, { kind: 'invoice_due', overdue: false }]),
    pos: section([{ kind: 'po_review', overdue: true }]),
    quotations: section([{ kind: 'enquiry_unquoted', overdue: false }, { kind: 'quotation_open', overdue: false }]),
  },
  highlights: [],
  events: [],
  ...over,
});

describe('the daily briefing in words', () => {
  test('a day is said as the reference says it', () => {
    assert.equal(shortDay('2026-10-03'), '3 Oct');
    assert.equal(shortDay('2026-12-25T00:00:00Z'), '25 Dec');
  });

  test('the closing line under each table comes from the at-a-glance counts', () => {
    const quiet = day();
    assert.equal(closingLine('pos', quiet), 'No PO received or closed on 3 Oct.');
    assert.equal(closingLine('invoices', quiet), 'No invoice raised and no payment received on 3 Oct.');
    assert.equal(closingLine('quotations', quiet), 'No quotation sent on 3 Oct.');
    const busy = day({ at_a_glance: { ...quiet.at_a_glance, pos_received: 2, invoices_raised: 1, payments_received: 0, quotations_sent: 1 } });
    assert.equal(closingLine('pos', busy), '2 POs received on 3 Oct.');
    assert.equal(closingLine('invoices', busy), '1 invoice raised and 0 payments received on 3 Oct.');
    assert.equal(closingLine('quotations', busy), '1 quotation sent on 3 Oct.');
  });

  test('the day paragraph says how much mail, what moved, and what is overdue', () => {
    assert.equal(dayParagraph(day()), 'No new enquiry, quotation, PO, invoice or payment on 3 Oct. No pending item was closed. Overdue: 2 invoices, 1 PO.');
    const busy = day({
      at_a_glance: { ...day().at_a_glance, new_enquiries: 1, pos_received: 1 },
      mail_window: { threads: 12, excluded: [{ reason: 'our own report', count: 1 }, { reason: 'internal only', count: 2 }] },
    });
    assert.equal(dayParagraph(busy), '12 email threads in the shared mailboxes on 3 Oct; 3 left out as not sales business or repeated. 1 new enquiry, 1 PO received. Overdue: 2 invoices, 1 PO.');
  });

  test('the overdue count is broken down by type', () => {
    assert.equal(overdueBreakdown(day().pending), '2 invoices, 1 PO');
    assert.equal(overdueBreakdown({ invoices: { overdue: 0 }, pos: { overdue: 0 }, quotations: { overdue: 1 } }), '1 quotation');
    assert.equal(overdueBreakdown({ invoices: { overdue: 0 }, pos: { overdue: 0 }, quotations: { overdue: 0 } }), '');
  });

  test('other sales activity is the AI highlights about mail that made no record', () => {
    const data = day({
      events: [{ kind: 'enquiry', thread_id: 1 }],
      highlights: [{ thread_id: 1, client: 'Acme', source: 'ai' }, { thread_id: 2, client: 'Beta', source: 'ai' }, { thread_id: 3, client: 'Coreal', source: 'records' }],
    });
    assert.deepEqual(otherActivity(data).map((h) => h.client), ['Beta']);
  });

  test('the at-a-glance table: Metric, Count, Detail, with names capped and pending counts by kind', () => {
    const data = day({
      at_a_glance: { ...day().at_a_glance, new_enquiries: 5, pos_received: 1, pos_received_inr: 180000, pos_registered_late: 1 },
      glance_detail: { new_enquiries: ['A', 'B', 'C', 'D', 'E'], quotations_sent: [], pos_received: ['Hindalco (PO-77)'], invoices_raised: [], payments_received: [] },
    });
    const rows = Object.fromEntries(glanceRows(data, { money: (v) => `₹${v}`, max: 3 }).map((r) => [r.metric, r]));
    assert.deepEqual(rows['New enquiries'], { metric: 'New enquiries', count: '5', detail: 'A; B; C; +2 more' });
    assert.equal(rows['POs received'].count, '1 · ₹180000');
    assert.equal(rows['POs received'].detail, 'Hindalco (PO-77); 1 older PO registered');
    assert.equal(rows['Quotations sent'].detail, '');
    assert.equal(rows['Pending invoices'].detail, '1 to raise, 2 awaiting payment');
    assert.equal(rows['Pending POs'].detail, '1 PO received by email, not registered');
    assert.equal(rows['Pending quotations'].detail, '1 enquiry not quoted, 1 quotation not answered');
    assert.deepEqual(rows['Overdue (over 7 days)'], { metric: 'Overdue (over 7 days)', count: '3', detail: '2 invoices, 1 PO' });
    assert.equal(rows['Other sales activity'].count, '0');
  });

  test('the source line names every mailbox read, its folders and the window', () => {
    const one = { read: [{ email: 'sales@x.com', folders: 'Inbox + Sent Items' }, { email: 'info@x.com', folders: 'Inbox + Sent Items' }] };
    assert.equal(sourceLine(one, 'Asia/Kolkata'), 'sales@x.com, info@x.com — Inbox + Sent Items, 00:00–23:59 IST');
    const mixed = { read: [{ email: 'sales@x.com', folders: 'Inbox + Sent Items' }, { email: 'info@x.com', folders: 'all folders' }] };
    assert.equal(sourceLine(mixed, 'Europe/London'), 'sales@x.com (Inbox + Sent Items), info@x.com (all folders), 00:00–23:59 Europe/London');
    assert.equal(sourceLine({ read: [] }, 'Asia/Kolkata'), 'no shared mailbox is read');
  });

  test('a thread opens in the Inbox by its mailbox, folder and id', () => {
    assert.equal(threadLink({ account_id: 3, folder_id: 'AQMk/x=', thread_id: 41 }), '/inbox?mb=3&f=AQMk%2Fx%3D&t=41');
    assert.equal(threadLink({ account_id: 3, folder_id: null, thread_id: 41 }), '/inbox?mb=3');
    assert.equal(threadLink({}), '/inbox');
  });
});
