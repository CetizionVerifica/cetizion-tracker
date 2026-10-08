import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  MAX_TRIPS_PER_INVOICE, TRAVEL_KIND, billableInvoices, billableTrips, mayBillTrip,
  mayRaiseTravelInvoice, selectedCost, travelInvoiceBody, travelInvoiceRow, travelInvoiceTotals,
  tripBlockedReason, validateTravelInvoice,
} from '../src/lib/travelInvoices.js';

/**
 * Raising the invoice that bills a trip to the client (#214 §5.2).
 *
 * The web suite is pure logic — there is no renderer here — so the rules in
 * JSX are checked against the source at the bottom of this file. What the
 * unit tests above it hold is the part that decides money and eligibility:
 * which trips may be ticked, what the amount means, and what goes on the
 * wire.
 */

const SRC = join(new URL('..', import.meta.url).pathname, 'src');
const read = (path) => readFileSync(join(SRC, path), 'utf8');
function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.jsx?$/.test(name) ? [path] : [];
  });
}
/** Source with comments stripped, so a note about a thing is not the thing. */
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const trip = (over = {}) => ({
  travel_id: 'TRV-1', employee_name: 'Asha', chargeable: true, cancelled: false,
  billed_stage_id: null, billed_invoice_no: null, po_number: 'PO-1', project_id: 'PRJ-1',
  destination: 'Hyderabad', travel_start_date: '2026-09-01', total_travel_cost: 12000, ...over,
});
const stage = (over = {}) => ({
  id: 1, kind: 'travel', project_id: 'PRJ-1', po_number: null, invoice_no: 'TI/1',
  invoice_date: '2026-09-30', stage_amount: 37500, amount_received: 0, stage_status: 'Due',
  document_id: null, trip_count: 2, ...over,
});

describe('who may raise a travel invoice', () => {
  test('an administrator and a sales user may; the travel desk may not', () => {
    assert.equal(mayRaiseTravelInvoice({ isAdmin: true }), true);
    assert.equal(mayRaiseTravelInvoice({}), true, 'a sales user raises the invoices they bill');
    assert.equal(mayRaiseTravelInvoice({ isHr: true }), false, 'HR keeps the trips, not the client invoice');
    // An admin who is somehow also flagged HR is still an admin.
    assert.equal(mayRaiseTravelInvoice({ isAdmin: true, isHr: true }), true);
  });
});

describe('which trips an invoice may carry', () => {
  test('a chargeable, uncancelled, unbilled trip on the right PO may be ticked', () => {
    assert.equal(tripBlockedReason(trip(), { projectId: 'PRJ-1', poNumber: 'PO-1' }), null);
    assert.equal(mayBillTrip(trip(), { poNumber: 'PO-1' }), true);
  });

  test('a non-chargeable trip is refused, because there is nothing to bill', () => {
    assert.match(tripBlockedReason(trip({ chargeable: false }), {}), /not a chargeable trip/i);
  });

  test('a cancelled trip is refused', () => {
    assert.match(tripBlockedReason(trip({ cancelled: true }), {}), /cancelled/i);
  });

  test('a trip already billed says which invoice has it', () => {
    const why = tripBlockedReason(trip({ billed_stage_id: 9, billed_invoice_no: 'TI/OLD' }), {});
    assert.match(why, /already billed/i);
    assert.match(why, /TI\/OLD/, 'so the reader can go and look at it');
  });

  test('raised on a PO, only that PO\'s trips are offered', () => {
    assert.match(tripBlockedReason(trip({ po_number: 'PO-2' }), { poNumber: 'PO-1' }), /not PO-1/);
    assert.match(tripBlockedReason(trip({ po_number: null }), { poNumber: 'PO-1' }), /no PO/i);
  });

  test('raised on a project with no PO, a trip\'s own PO does not matter', () => {
    assert.equal(tripBlockedReason(trip({ po_number: 'PO-9' }), { projectId: 'PRJ-1', poNumber: null }), null);
  });

  test('blocked trips are kept and sorted last, so nothing silently vanishes', () => {
    const offered = billableTrips([
      trip({ travel_id: 'A', cancelled: true }),
      trip({ travel_id: 'B' }),
      trip({ travel_id: 'C', chargeable: false }),
      trip({ travel_id: 'D' }),
    ], {});
    assert.equal(offered.length, 4, 'all four are shown');
    assert.deepEqual(offered.slice(0, 2).map((o) => o.trip.travel_id), ['B', 'D'], 'eligible first');
    assert.ok(offered.slice(2).every((o) => o.blocked), 'with the reasons after them');
  });
});

describe('the amount is typed, never derived', () => {
  test('the ticked trips\' cost is reported but is not the invoice amount', () => {
    const trips = [trip({ travel_id: 'A', total_travel_cost: 12000 }), trip({ travel_id: 'B', total_travel_cost: 5500 })];
    assert.equal(selectedCost(trips, ['A', 'B']), 17500);
    // And nothing in the payload takes the amount from it.
    const body = travelInvoiceBody({
      projectId: 'PRJ-1', invoiceNo: 'TI/1', invoiceDate: '2026-09-30', amount: '37500', travelIds: ['A', 'B'],
    });
    assert.equal(body.amount, 37500, 'what was typed');
    assert.equal(body.trip_cost, undefined, 'the trips\' cost is not sent');
  });

  test('nothing records what each trip was re-billed for', () => {
    const body = travelInvoiceBody({ projectId: 'PRJ-1', invoiceNo: 'x', invoiceDate: '2026-01-01', amount: 1, travelIds: ['A'] });
    assert.deepEqual(body.travel_ids, ['A'], 'the trips are named, and only named');
    assert.equal(JSON.stringify(body).includes('amount_per_trip'), false);
  });

  test('a travel invoice row shows its own amount and no percentage', () => {
    const row = travelInvoiceRow(stage({ stage_amount: 37500, amount_received: 10000 }));
    assert.equal(row.amount, 37500);
    assert.equal(row.received, 10000);
    assert.equal(row.tripCount, 2);
    assert.equal(row.stagePercent, undefined, 'there is no percentage to show');
  });

  test('a list of travel invoices totals its own amounts', () => {
    const totals = travelInvoiceTotals([stage({ stage_amount: 37500 }), stage({ id: 2, stage_amount: 25000, amount_received: 25000 })]);
    assert.deepEqual(totals, { count: 2, invoiced: 62500, received: 25000 });
  });
});

describe('what the form refuses', () => {
  const good = { invoiceNo: 'TI/1', invoiceDate: '2026-09-30', amount: '37500', creditDays: '30', today: '2026-10-08' };

  test('a complete form is accepted', () => {
    assert.deepEqual(validateTravelInvoice(good), {});
  });

  test('no invoice number, no date, no amount', () => {
    assert.ok(validateTravelInvoice({ ...good, invoiceNo: '  ' }).invoice_no);
    assert.ok(validateTravelInvoice({ ...good, invoiceDate: '' }).invoice_date);
    assert.ok(validateTravelInvoice({ ...good, amount: '' }).amount);
  });

  test('a zero or negative amount', () => {
    assert.match(validateTravelInvoice({ ...good, amount: '0' }).amount, /more than zero/);
    assert.match(validateTravelInvoice({ ...good, amount: '-5' }).amount, /more than zero/);
  });

  test('a future invoice date, but a past one is ordinary', () => {
    assert.match(validateTravelInvoice({ ...good, invoiceDate: '2026-12-01' }).invoice_date, /future/);
    assert.deepEqual(validateTravelInvoice({ ...good, invoiceDate: '2026-04-01' }), {});
  });

  test('negative credit days', () => {
    assert.ok(validateTravelInvoice({ ...good, creditDays: '-1' }).credit_days);
    assert.deepEqual(validateTravelInvoice({ ...good, creditDays: '' }), {}, 'blank is fine — the PO\'s terms apply');
  });
});

describe('the exact body POST /api/travel-invoices is given', () => {
  test('on a PO', () => {
    assert.deepEqual(travelInvoiceBody({
      projectId: 'PRJ-1', poNumber: 'PO-1', invoiceNo: '  TI/7  ', invoiceDate: '2026-09-30',
      amount: '37500', creditDays: '45', documentId: 12, remarks: ' Sept ', travelIds: ['A', 'B'],
    }), {
      project_id: 'PRJ-1', po_number: 'PO-1', invoice_no: 'TI/7', invoice_date: '2026-09-30',
      amount: 37500, credit_days: 45, document_id: 12, remarks: 'Sept', travel_ids: ['A', 'B'],
    });
  });

  test('on a project with no PO, and with nothing optional given', () => {
    assert.deepEqual(travelInvoiceBody({
      projectId: 'PRJ-ONLY', invoiceNo: 'TI/8', invoiceDate: '2026-09-30', amount: 1000,
    }), {
      project_id: 'PRJ-ONLY', invoice_no: 'TI/8', invoice_date: '2026-09-30', amount: 1000, travel_ids: [],
    });
  });
});

describe('which invoices a trip may be billed on', () => {
  test('only travel invoices, and only of the trip\'s own project', () => {
    const offered = billableInvoices([
      stage({ id: 1, kind: 'po_stage', project_id: 'PRJ-1' }),
      stage({ id: 2, kind: TRAVEL_KIND, project_id: 'PRJ-1' }),
      stage({ id: 3, kind: TRAVEL_KIND, project_id: 'PRJ-OTHER' }),
      stage({ id: 4, kind: TRAVEL_KIND, project_id: 'PRJ-1', po_number: 'PO-1' }),
    ], trip({ project_id: 'PRJ-1' }));
    assert.deepEqual(offered.map((s) => s.id), [2, 4],
      'an ordinary PO stage is never a target, and neither is another project\'s invoice');
  });

  test('a travel invoice on the trip\'s PO and one on its project are both offered', () => {
    const offered = billableInvoices([
      stage({ id: 2, po_number: null }),
      stage({ id: 4, po_number: 'PO-1' }),
    ], trip({ project_id: 'PRJ-1' }));
    assert.equal(offered.length, 2);
  });
});

/* ---------------------------------------------- the rules that live in JSX */

describe('the screens', () => {
  test('there is one Raise travel invoice dialog in the app', () => {
    const declaring = files(SRC).filter((p) => /export function RaiseTravelInvoiceDialog/.test(readFileSync(p, 'utf8')));
    assert.equal(declaring.length, 1, `declared in: ${declaring.join(', ')}`);
    assert.match(declaring[0], /components\/actions\.jsx$/, 'beside every other workflow dialog');
  });

  test('the project and the PO page open that same dialog, not one each', () => {
    for (const page of ['pages/ProjectDetail.jsx', 'pages/PurchaseOrderDetail.jsx']) {
      assert.match(read(page), /RaiseTravelInvoiceDialog/, page);
      assert.match(read(page), /from '\.\.\/components\/actions\.jsx'/, page);
      assert.match(read(page), /<RaiseTravelInvoiceDialog/, page);
    }
  });

  test('both pages ask the role before drawing the action, and HR never gets it', () => {
    for (const page of ['pages/ProjectDetail.jsx', 'pages/PurchaseOrderDetail.jsx']) {
      const text = code(read(page));
      assert.match(text, /mayRaiseTravelInvoice\(\{ isAdmin, isHr \}\)/, page);
      assert.match(text, /useAuth\(\)/, `${page} must read the canonical auth state`);
      assert.match(text, /mayRaiseTravel \?/, `${page} must gate the action on it`);
      assert.doesNotMatch(text, /location\.pathname[^\n]*(admin|hr)/i, `${page} must not infer a role from the route`);
    }
  });

  test('the PO page passes its PO so only that order\'s trips are offered', () => {
    const po = code(read('pages/PurchaseOrderDetail.jsx'));
    assert.match(po, /poNumber: po\.po_number/);
    const project = code(read('pages/ProjectDetail.jsx'));
    assert.match(project, /poNumber: null/, 'the project page offers the project\'s trips');
  });

  test('both pages list travel invoices through the one shared section', () => {
    const declaring = files(SRC).filter((p) => /export function TravelInvoicesSection/.test(readFileSync(p, 'utf8')));
    assert.equal(declaring.length, 1, `declared in: ${declaring.join(', ')}`);
    for (const page of ['pages/ProjectDetail.jsx', 'pages/PurchaseOrderDetail.jsx']) {
      assert.match(read(page), /<TravelInvoicesSection/, page);
    }
  });

  test('a travel invoice is badged as Travel and never shown as a percentage', () => {
    const section = code(read('components/travelInvoices.jsx'));
    assert.match(section, /<Tone>Travel<\/Tone>/, 'the system\'s own badge, so it reads as a state and not as a stage');
    assert.doesNotMatch(section, /stage_percent/, 'a travel invoice has none');
    assert.doesNotMatch(section, /percent\(/, 'and nothing formats one');
  });

  test('the dialog shows the selected trips\' cost without feeding the amount', () => {
    const dialog = code(read('components/actions.jsx'));
    const from = dialog.indexOf('export function RaiseTravelInvoiceDialog');
    const bulk = dialog.slice(from, dialog.indexOf('\nexport function ', from + 1));
    assert.match(bulk, /selectedCost\(/, 'the cost is shown');
    assert.match(bulk, /value=\{amount\}/, 'and the amount is its own field');
    assert.doesNotMatch(bulk, /setAmount\(.*cost/, 'the cost never writes the amount');
    assert.match(bulk, /max=\{todayIso\(\)\}/, 'and an invoice cannot be dated in the future');
  });

  test('the trip page offers travel invoices only, and works without a PO', () => {
    const trip = code(read('pages/TripDetail.jsx'));
    assert.match(trip, /billableInvoices\(/, 'filtered through the shared rule');
    assert.match(trip, /kind: TRAVEL_KIND/, 'and asks the server for travel invoices');
    // The pre-097 control was keyed on the PO and hidden without one, which
    // is why a project-only trip could never be marked billed. The guard now
    // asks for a project *or* a PO, so such a trip reaches the selector.
    assert.match(trip, /!trip\.chargeable \|\| \(!trip\.po_number && !trip\.project_id\)/);
    // The selector was keyed on the PO, so it found nothing for a trip on a
    // project with no PO. It follows the project now, which finds both.
    assert.doesNotMatch(trip, /api\.list\('payment-stages', \{ po_number: trip\.po_number \}\)/,
      'no PO-keyed payment-stage lookup is left');
    assert.match(trip, /project_id: project, kind: TRAVEL_KIND/, 'the selector follows the project');
    // The amount and the PO tell two invoices on one project apart; a travel
    // invoice has no stage name to do it with.
    assert.match(trip, /money\(s\.stage_amount\)/);
    assert.doesNotMatch(trip, /s\.stage_name/, 'a travel invoice is not a named share of a PO');
  });

  test('nothing from a later #214 phase has crept in', () => {
    for (const path of files(SRC)) {
      const text = code(readFileSync(path, 'utf8'));
      assert.doesNotMatch(text, /v_trip_billing/i, path);
      assert.doesNotMatch(text, /insights\/travel|travel-insights/i, path);
    }
  });

  test('the per-invoice trip cap matches what the route accepts', () => {
    assert.equal(MAX_TRIPS_PER_INVOICE, 200);
    const server = readFileSync(join(SRC, '..', '..', 'server', 'src', 'routes', 'workflow.js'), 'utf8');
    assert.match(code(server), /z\.array\(z\.string\(\)\.trim\(\)\.min\(1\)\)\.max\(200\)/);
  });
});
