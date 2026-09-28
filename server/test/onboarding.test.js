import test from 'node:test';
import assert from 'node:assert/strict';
import { onboardingProgress, withDerivedSteps } from '../src/lib/onboarding.js';

/**
 * The checklist steps that another record owns (#22 / C15).
 *
 * No database: the point of putting this in its own module is that the
 * rules can be exercised against made-up projects, including the ones a
 * real database rarely produces — a project with no PO at all, a PO with
 * no delivery-triggered stage, a step an admin has renamed.
 */
const STEPS = [
  { id: 1, step_no: 1, step: 'Purchase order(s) received and registered in the PO Register', status: 'Not Started' },
  { id: 2, step_no: 2, step: 'Services on each PO listed against the PO', status: 'Not Started' },
  { id: 3, step_no: 3, step: 'Payment stages for each PO entered in the payment schedule', status: 'Not Started' },
  { id: 4, step_no: 4, step: 'Finance raises the stage-1 (advance) invoice per the PO payment terms', status: 'Done' },
  { id: 5, step_no: 5, step: 'Project manager and delivery team assigned', status: 'Done' },
  { id: 9, step_no: 9, step: 'Final deliverable / report / certificate issued to client', status: 'Not Started' },
  { id: 10, step_no: 10, step: 'Finance raises the on-delivery stage invoice(s)', status: 'Not Started' },
  { id: 11, step_no: 11, step: 'All stage invoices paid on time as per agreed terms - project closed', status: 'Not Started' },
];

const bare = { project: {}, purchase_orders: [], services: [], payment_stages: [], travel: [] };
const byId = (rows) => Object.fromEntries(rows.map((r) => [r.id, r]));

test('a step nobody else owns keeps the status a person set', () => {
  const rows = byId(withDerivedSteps(STEPS, bare));
  assert.equal(rows[5].derived, false);
  assert.equal(rows[5].effective_status, 'Done');
  assert.equal(rows[5].owned_by, null);
});

test('a stored tick never overrides what the records say', () => {
  // Step 4 is stored as Done, and no invoice has been raised.
  const rows = byId(withDerivedSteps(STEPS, {
    ...bare,
    purchase_orders: [{ po_number: 'PO-1', service_count: 1, stage_count: 2 }],
    payment_stages: [
      { po_number: 'PO-1', stage_no: 1, invoice_no: null, terms_days: 45, stage_status: 'To Invoice' },
      { po_number: 'PO-1', stage_no: 2, invoice_no: null, trigger_event: 'On Delivery', stage_status: 'To Invoice' },
    ],
  }));
  assert.equal(rows[4].status, 'Done', 'the stored column is left alone');
  assert.equal(rows[4].effective_status, 'In Progress');
  assert.match(rows[4].detail, /With finance · PO-1 · 45 days terms/);
});

test('a step with nothing to read it from is not started, and says what it is waiting for', () => {
  const rows = byId(withDerivedSteps(STEPS, bare));
  assert.equal(rows[2].effective_status, 'Not Started');
  assert.equal(rows[2].detail, 'Waiting for a purchase order');
  assert.equal(rows[10].detail, 'No stage is triggered by delivery');
  // Not vacuously done: no POs must never satisfy "services on each PO".
  assert.notEqual(rows[2].effective_status, 'Done');
  assert.notEqual(rows[3].effective_status, 'Done');
});

test('delivery closes the deliverable step, and the money steps follow the stages', () => {
  const rows = byId(withDerivedSteps(STEPS, {
    project: { actual_delivery_date: '2026-11-28' },
    services: [{}, {}],
    travel: [],
    purchase_orders: [{ po_number: 'PO-1', po_date: '2026-05-20', service_count: 2, stage_count: 2 }],
    payment_stages: [
      { po_number: 'PO-1', stage_no: 1, invoice_no: 'CTZ/INV/2026/021', stage_status: 'Paid' },
      { po_number: 'PO-1', stage_no: 2, invoice_no: 'CTZ/INV/2026/044', trigger_event: 'On Delivery', stage_status: 'Paid' },
    ],
  }));
  assert.equal(rows[9].effective_status, 'Done');
  assert.equal(rows[9].detail, 'Delivered 28 Nov 2026');
  assert.equal(rows[10].effective_status, 'Done');
  assert.equal(rows[11].effective_status, 'Done');
  assert.equal(rows[11].detail, 'Every stage settled');
  assert.equal(rows[1].detail, 'PO-1 · 20 May 2026');
});

test('an overdue stage is named in the closing step', () => {
  const rows = byId(withDerivedSteps(STEPS, {
    ...bare,
    purchase_orders: [{ po_number: 'PO-1', service_count: 1, stage_count: 2 }],
    payment_stages: [
      { po_number: 'PO-1', stage_no: 1, invoice_no: 'X', stage_status: 'Overdue', days_overdue: 12 },
      { po_number: 'PO-1', stage_no: 2, invoice_no: 'Y', stage_status: 'Paid' },
    ],
  }));
  assert.equal(rows[11].detail, '1 stage open · 1 overdue');
});

test('a renamed step falls back to manual rather than guessing', () => {
  const custom = [{ id: 99, step_no: 1, step: 'Ask the client for the site map', status: 'In Progress', owner: 'A. Deshpande' }];
  const [row] = withDerivedSteps(custom, bare);
  assert.equal(row.derived, false);
  assert.equal(row.effective_status, 'In Progress');
});

test('N/A is left alone and left out of the count', () => {
  const rows = withDerivedSteps([
    { id: 1, step_no: 1, step: 'Purchase order(s) received and registered', status: 'N/A' },
    { id: 2, step_no: 2, step: 'Project manager assigned', status: 'Done' },
  ], bare);
  assert.equal(rows[0].effective_status, 'N/A');
  assert.equal(rows[0].derived, false, 'a step marked N/A is not overridden by the PO register');
  assert.deepEqual(onboardingProgress(rows), { done: 1, total: 1, left: 0, waiting: 0 });
});

test('progress counts what is shown, not what is stored', () => {
  const progress = onboardingProgress(withDerivedSteps(STEPS, bare));
  assert.equal(progress.total, 8);
  // Only step 5 is genuinely done; step 4's stored tick must not count.
  assert.equal(progress.done, 1);
  assert.equal(progress.left, 7);
  assert.equal(progress.waiting, 7, 'every derived step is somebody else\'s to move');
});
