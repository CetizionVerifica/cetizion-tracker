import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BILLING_STATUSES, clientBillingChip, clientHasPaid, isBilled, overdueBy, unbilledReason,
} from '../src/lib/tripBilling.js';

/**
 * What the client was billed for a trip, on the trip page (#214 §5.3, §4).
 *
 * The figures and the status word are the server's; what is tested here is
 * the mapping onto something a person reads, and — against the source,
 * because the web suite has no renderer — that the travel desk's section is
 * read-only and that nothing recomputes money in the browser.
 */

const SRC = join(new URL('..', import.meta.url).pathname, 'src');
const read = (path) => readFileSync(join(SRC, path), 'utf8');
/** Source with comments stripped, so a note about a thing is not the thing. */
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const billed = (over = {}) => ({
  chargeable: true, cancelled: false, billing_status: 'due', stage_id: 7,
  invoice_no: 'CVPL/TI/1', invoice_date: '2026-10-01', invoice_amount: 37500,
  amount_received: 0, payment_received_date: null, stage_status: 'Due',
  days_overdue: 0, invoice_document_id: 42, billed_on_po_stage: false, ...over,
});

describe('the client chip', () => {
  test('every status the view can hold has a chip, prefixed so it cannot be read as the agency\'s', () => {
    for (const status of BILLING_STATUSES) {
      const chip = clientBillingChip(status);
      assert.ok(chip, status);
      assert.match(chip.label, /^Client: /, `${status} must say whose status it is`);
      assert.ok(['plain', 'wait', 'ok', 'late', 'info'].includes(chip.tone), chip.tone);
    }
  });

  test('paid is settled, overdue is late, not billed is waiting', () => {
    assert.equal(clientBillingChip('paid').tone, 'ok');
    assert.equal(clientBillingChip('overdue').tone, 'late');
    assert.equal(clientBillingChip('not_billed').tone, 'wait');
    assert.equal(clientBillingChip('not_chargeable').tone, 'plain');
  });

  test('no billing block means no chip at all, not a wrong one', () => {
    assert.equal(clientBillingChip(undefined), null);
    assert.equal(clientBillingChip(null), null);
  });

  test('a status nobody has seen before still renders, rather than vanishing', () => {
    assert.equal(clientBillingChip('written_off').label, 'Client: written_off');
  });
});

describe('what the section decides', () => {
  test('paid comes from the server\'s word, never from the figures', () => {
    assert.equal(clientHasPaid(billed({ billing_status: 'paid' })), true);
    // Received equals invoiced, and the server still says partly paid —
    // the server wins, because it has the credit notes and the rounding.
    assert.equal(clientHasPaid(billed({ billing_status: 'partly_paid', amount_received: 37500 })), false);
    assert.equal(clientHasPaid(null), false);
  });

  test('there are figures to show only when a travel invoice bills the trip', () => {
    assert.equal(isBilled(billed()), true);
    assert.equal(isBilled(billed({ stage_id: null })), false);
    assert.equal(isBilled(null), false);
  });

  test('a non-chargeable trip is never described as unbilled', () => {
    const why = unbilledReason(billed({ chargeable: false, billing_status: 'not_chargeable', stage_id: null }));
    assert.match(why, /not charged to a client/);
    assert.doesNotMatch(why, /not billed|yet/i, 'nothing is outstanding on it');
  });

  test('a chargeable trip with no invoice says what is missing', () => {
    assert.match(unbilledReason(billed({ billing_status: 'not_billed', stage_id: null })), /not on a travel invoice yet/);
  });

  test('a trip pointing at an ordinary PO stage says so plainly', () => {
    const why = unbilledReason(billed({ billing_status: 'not_billed', stage_id: null, billed_on_po_stage: true }));
    assert.match(why, /ordinary PO payment stage/);
    assert.match(why, /not billed on a travel invoice/, 'so it is not mistaken for billed');
    assert.match(why, /administrator/, 'and says who can put it right');
  });

  test('how late it is, and only when it is', () => {
    assert.equal(overdueBy(billed({ billing_status: 'overdue', days_overdue: 15 })), '15 days overdue');
    assert.equal(overdueBy(billed({ billing_status: 'overdue', days_overdue: 1 })), '1 day overdue');
    assert.equal(overdueBy(billed({ billing_status: 'due', days_overdue: 0 })), null);
    assert.equal(overdueBy(billed({ billing_status: 'paid', days_overdue: 0 })), null);
  });
});

describe('the trip page', () => {
  const trip = () => code(read('pages/TripDetail.jsx'));

  test('the billing block comes from the server, and the second request is gone', () => {
    const text = trip();
    assert.match(text, /const billing = data\?\.data\?\.billing \?\? null;/);
    // It used to fetch the project's whole payment schedule to find one
    // stage, and skipped that for HR — which is why the travel desk could
    // never see whether the client had paid.
    assert.doesNotMatch(text, /api\.list\('payment-stages', \{ project_id: trip\.project_id \}\)/,
      'the schedule-wide lookup is gone');
    // One payment-stage request is left on this page and it is the PO
    // side's invoice selector, not a second opinion on what the client has
    // paid. The travel desk makes none at all.
    assert.equal((text.match(/api\.list\('payment-stages'/g) || []).length, 1);
    assert.match(text, /project_id: project, kind: TRAVEL_KIND/, 'and that one is the selector');
  });

  test('the travel desk gets a read-only section and no selector', () => {
    const text = trip();
    // One tab, two readings of it: the travel desk reads the invoice, the
    // PO side decides it. Both land in the same place on the record, which
    // is what makes the tab mean the same thing to everybody.
    assert.match(text, /tab === 'billing' && \(isHr\s*\?\s*<ClientBilling billing=\{billing\} \/>/);
    assert.match(text, /const tabKeys = \['legs', 'costs', 'docs', 'billing'\]/,
      'and the tab is offered to the travel desk at all');
    const from = text.indexOf('function ClientBilling');
    const section = text.slice(from, text.indexOf('\nfunction ', from + 1));
    assert.ok(from > 0, 'the section exists');
    assert.match(section, /read-only/i, 'and says so (sentence case, as every Mocha hint is)');
    for (const control of ['<select', 'onChange', 'api.action', 'api.update', 'Button']) {
      assert.equal(section.includes(control), false, `the travel desk's section must not contain ${control}`);
    }
  });

  test('admin and sales keep the editable control, unchanged', () => {
    const text = trip();
    assert.match(text, /:\s*<BilledStage trip=\{trip\} onChanged=\{refetch\} \/>\)\}/,
      'the editable control is what everyone but the travel desk gets');
    assert.match(text, /function BilledStage\(/, 'and the control itself is still here');
    // #233's own guard inside the control, untouched by this phase: a
    // chargeable trip with a project or a PO reaches the selector.
    assert.match(text, /!trip\.chargeable \|\| \(!trip\.po_number && !trip\.project_id\)/);
    assert.match(text, /billed-stage/, 'still writing through its own route');
  });

  test('the section shows every figure the slice allows, and the invoice itself', () => {
    const text = trip();
    const from = text.indexOf('function ClientBilling');
    const section = text.slice(from, text.indexOf('\nfunction ', from + 1));
    for (const field of ['invoice_no', 'invoice_date', 'invoice_amount', 'amount_received',
      'payment_received_date', 'stage_status', 'invoice_document_id']) {
      assert.ok(section.includes(field), `missing ${field}`);
    }
    assert.match(section, /api\.documentUrl\(billing\.invoice_document_id\)/, 'reusing the one document viewer');
    assert.match(section, /PDF not on file/, 'and saying so when there is none');
  });

  test('nothing of the sales side beyond the slice is referenced', () => {
    const text = trip();
    const forbidden = ['stage_percent', 'tds_amount', 'reminder_level', 'promise_to_pay_date',
      'hold_reason', 'po_value', 'margin'];
    for (const field of forbidden) {
      assert.equal(text.includes(field), false, `${field} has no business on the trip page`);
    }
  });

  test('the client chip is the server\'s word and sits apart from the agency\'s', () => {
    const text = trip();
    assert.match(text, /clientBillingChip\(billing\?\.billing_status\)/);
    // No second opinion worked out in the browser.
    assert.doesNotMatch(text, /amount_received >= |received >= invoice/, 'no re-derived paid test');
  });

  test('nothing from the Insights phase has crept in', () => {
    const text = trip();
    for (const later of ['insights', 'v_trip_billing', 'export.xlsx', 'reverse']) {
      assert.equal(text.toLowerCase().includes(later), false, later);
    }
  });
});
