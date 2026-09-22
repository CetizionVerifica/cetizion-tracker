import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractRow, buildPlan } from '../src/import/rules.js';
import { reviewRows, aiConfig } from '../src/import/ai.js';

// The rules on their own: no key, no request, whatever the environment holds.
aiConfig.enabled = false;

// Which row is which. S.No labels a row for a person; the sheet position
// identifies it, because S.No can be blank or repeated.

const mapping = { sno: 'S.No', client: 'Client', stage: 'Stage', service: 'Service', po_number: 'PO', po_amount: 'PO Amount', remarks: 'Remarks' };
const sheetRow = (row, sno, extra = {}) => ({ __row: row, 'S.No': sno, Client: `Client ${row}`, Stage: 'Won - PO Received', Service: 'ASI audit', ...extra });

test('a blank S.No falls back to the row position and is marked as not given', () => {
  assert.deepEqual(
    [extractRow(sheetRow(12, ''), mapping), extractRow(sheetRow(4, 12), mapping)].map((r) => [r.sno, r.sno_given, r.row]),
    [[12, false, 12], [12, true, 4]]
  );
});

test('two rows sharing an S.No keep their own hints', async () => {
  const rows = [
    extractRow(sheetRow(4, 12, { Remarks: '30% adv against PO' }), mapping),
    extractRow(sheetRow(12, '', { Remarks: '18% GST extra' }), mapping),
  ];
  const { hints } = await reviewRows(rows);
  assert.equal(hints[4].advance_percent, 30);       // the row that says so
  assert.equal(hints[12].advance_percent, null);    // and not its namesake
});

const live = { quotations: [], purchase_orders: [], projects: [], services: [], stages: [], next_quotation_no: 1, next_project_no: 1, year: 2026 };

test('the plan reads each row its own hint, and labels rows a person can tell apart', () => {
  const rows = [sheetRow(4, 12, { PO: 'PO-1', 'PO Amount': 100000 }), sheetRow(12, '', { PO: 'PO-2', 'PO Amount': 200000 })];
  const hints = { 4: { advance_percent: 30, flags: [] }, 12: { advance_percent: null, flags: [] } };
  const { items } = buildPlan({ rows, mapping, live, hints });
  const stagesFor = (po) => items.filter((it) => it.step === 'stage' && it.payload.po_number === po).map((it) => Math.round(it.payload.stage_percent * 100));
  assert.deepEqual(stagesFor('PO-1'), [30, 70]);    // the hint applied here
  assert.deepEqual(stagesFor('PO-2'), [50, 50]);    // and nowhere else
  const labels = items.filter((it) => it.step === 'purchase_order').map((it) => it.source_label);
  assert.deepEqual(labels, ['S.No 12', 'sheet row 12']);
});

test('an S.No used twice is labelled with its sheet row as well', () => {
  const rows = [sheetRow(4, 7, { PO: 'PO-1', 'PO Amount': 100000 }), sheetRow(9, 7, { PO: 'PO-2', 'PO Amount': 200000 })];
  const { items } = buildPlan({ rows, mapping, live, hints: {} });
  assert.deepEqual(
    items.filter((it) => it.step === 'purchase_order').map((it) => it.source_label),
    ['S.No 7 (sheet row 4)', 'S.No 7 (sheet row 9)']
  );
});
