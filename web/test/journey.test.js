import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  JOURNEY_STEPS, currentRecordPath, daysText, factValue, journeyBoard, journeyOf, railProps, recordPath, samePath, stepBadge,
} from '../src/lib/journey.js';

/**
 * The browser's half of the sales journey (web/src/components/journey/
 * CLAUDE.md §2): the calls, the links to each record, and how one journey
 * becomes the rail on a record page. The server decides every step; these
 * pin that the browser says it faithfully and links to the right page.
 * The clients are made up.
 */

test('the journey is three steps, labelled the same everywhere', () => {
  assert.deepEqual(JOURNEY_STEPS, [
    { key: 'enquiry', label: 'Enquiry' },
    { key: 'quotation', label: 'Quotation' },
    { key: 'po', label: 'PO' },
  ]);
});

test('recordPath encodes the slashes and spaces record numbers carry', () => {
  assert.equal(recordPath('enquiry', 'CTZ/ENQ/2026/004'), '/enquiries/CTZ%2FENQ%2F2026%2F004');
  assert.equal(recordPath('quotation', 'Q-118'), '/quotations/Q-118');
  assert.equal(recordPath('po', 'PO 4500183'), '/purchase-orders/PO%204500183');
  assert.equal(recordPath('project', 'CV108'), '/projects/CV108');
});

test('recordPath has nowhere to go without a number or a known kind', () => {
  for (const no of [null, undefined, '', '   ']) assert.equal(recordPath('quotation', no), null, `number ${JSON.stringify(no)}`);
  assert.equal(recordPath('invoice', 'INV-1'), null);
});

test('currentRecordPath opens the record of the step the sale is on (spec C4)', () => {
  const records = { enquiry_no: 'CTZ/ENQ/2026/004', quotation_no: 'Q-118', po_number: 'PO 4500183', project_id: 'CV108' };
  assert.equal(currentRecordPath({ step: 'enquiry', records }), '/enquiries/CTZ%2FENQ%2F2026%2F004');
  assert.equal(currentRecordPath({ step: 'quotation', records }), '/quotations/Q-118');
  assert.equal(currentRecordPath({ step: 'po', records }), '/purchase-orders/PO%204500183');
  assert.equal(currentRecordPath({ step: 'quotation', records: { ...records, quotation_no: null } }), null, 'no record, no link');
  assert.equal(currentRecordPath({ step: 'invoiced', records }), null);
  assert.equal(currentRecordPath(null), null);
});

/** Stand in for the server: answer every request with `body`, and keep the URLs asked for. */
async function withServer(body, run) {
  const asked = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    asked.push(url);
    return { ok: true, status: 200, json: async () => body };
  };
  try {
    return await run(asked);
  } finally {
    globalThis.fetch = real;
  }
}

test('journeyOf asks for one record, its number encoded, and answers with the journey', async () => {
  const journey = { key: 'e-4', step: 'enquiry', steps: [] };
  await withServer({ data: journey }, async (asked) => {
    assert.deepEqual(await journeyOf({ enquiry: 'CTZ/ENQ/2026/004' }), journey);
    await journeyOf({ po: 'PO 4500183' });
    assert.deepEqual(asked, ['/api/journey/of?enquiry=CTZ%2FENQ%2F2026%2F004', '/api/journey/of?po=PO+4500183']);
  });
});

test('journeyBoard leaves empty filters out of the address', async () => {
  await withServer({ data: { cards: [] } }, async (asked) => {
    assert.deepEqual(await journeyBoard({ sales_person: 'Asha Rao', service: '', stuck: 1, closed: null, cohort: undefined }), { cards: [] });
    await journeyBoard();
    assert.deepEqual(asked, ['/api/journey?sales_person=Asha+Rao&stuck=1', '/api/journey']);
  });
});

test('samePath reads an encoded and a plain address as the same page', () => {
  assert.ok(samePath('/enquiries/CTZ%2FENQ%2F2026%2F004', '/enquiries/CTZ/ENQ/2026/004'));
  assert.ok(samePath('/quotations/Q-118/', '/quotations/Q-118'));
  assert.ok(!samePath('/quotations/Q-118', '/quotations/Q-119'));
  assert.ok(!samePath('/quotations/Q-118', ''));
});

test('a fact reads as the web writes it, and a missing amount is never ₹0', () => {
  assert.equal(factValue({ label: 'Estimate', value: 450000, kind: 'money', currency: 'INR' }), '₹4,50,000');
  assert.equal(factValue({ label: 'Value', value: 12000, kind: 'money', currency: 'EUR' }), '€12,000');
  assert.equal(factValue({ label: 'Received', value: '2026-09-18', kind: 'date' }), '18 Sep 2026');
  assert.equal(factValue({ label: 'Source', value: 'Email', kind: 'text' }), 'Email');
  assert.equal(factValue({ label: 'Estimate', value: null, kind: 'money', currency: 'INR' }), 'No value');
  assert.equal(factValue({ label: 'Sent', value: null, kind: 'date' }), '—');
});

test('days in step reads as a phrase', () => {
  assert.equal(daysText(0), 'Today');
  assert.equal(daysText(1), '1 day');
  assert.equal(daysText(24), '24 days');
  assert.equal(daysText(null), null);
});

test('the current step shows days in step in the tone of its flag', () => {
  assert.deepEqual(stepBadge({ days_in_step: 4, flag: null }), { label: '4 days', tone: 'plain' });
  assert.deepEqual(stepBadge({ days_in_step: 24, flag: { kind: 'slow', label: '24 days', tone: 'waiting' } }), { label: '24 days', tone: 'waiting' });
  assert.deepEqual(stepBadge({ days_in_step: 48, flag: { kind: 'stuck', label: 'Stuck 48 days', tone: 'late' } }), { label: 'Stuck 48 days', tone: 'late' });
  // A flag about something other than time lends its tone; the page's sentence says what it is.
  assert.deepEqual(stepBadge({ days_in_step: 12, flag: { kind: 'overdue', label: '₹3,00,000 overdue', tone: 'late' } }), { label: '12 days', tone: 'late' });
  assert.equal(stepBadge({ days_in_step: null, flag: null }), null);
});

/** A sale at Quotation · Accepted, with its enquiry done and no PO yet, as GET /api/journey/of returns it. */
const atQuotation = {
  key: 'q-118',
  step: 'quotation',
  exit: null,
  small_step: 'Accepted',
  days_in_step: 24,
  flag: { kind: 'slow', label: '24 days', tone: 'waiting' },
  steps: [
    {
      key: 'enquiry', label: 'Enquiry', state: 'done',
      record: { kind: 'enquiry', no: 'CTZ/ENQ/2026/004', date: '2026-09-18' },
      since: '2026-09-18',
      small: [{ label: 'New', state: 'done', date: null }],
      facts: [
        { label: 'Received', value: '2026-09-18', kind: 'date' },
        { label: 'Source', value: 'Email', kind: 'text' },
        { label: 'Owner', value: 'Asha Rao', kind: 'text' },
        { label: 'Estimate', value: 450000, kind: 'money', currency: 'INR' },
      ],
    },
    {
      key: 'quotation', label: 'Quotation', state: 'current',
      record: { kind: 'quotation', no: 'Q-118', date: '2026-10-01' },
      since: '2026-10-01',
      small: [
        { label: 'Priced', state: 'done', date: null },
        { label: 'Sent', state: 'done', date: '2026-10-03' },
        { label: 'Negotiating', state: 'skipped', date: null },
        { label: 'Accepted', state: 'current', date: '2026-10-09' },
        { label: 'Won', state: 'future', date: null },
      ],
      facts: [{ label: 'Quotation no.', value: 'Q-118', kind: 'text' }],
    },
    { key: 'po', label: 'PO', state: 'future', record: null, since: null, small: [], facts: [] },
  ],
};

test('on its own page the rail links every other record, and not the one you are on', () => {
  const { steps, nowLabel, substeps } = railProps(atQuotation, '/quotations/Q-118');
  const [enquiry, quotation, po] = steps;

  assert.equal(enquiry.to, '/enquiries/CTZ%2FENQ%2F2026%2F004');
  assert.equal(enquiry.meta, 'CTZ/ENQ/2026/004 · 18 Sep 2026');
  assert.deepEqual(enquiry.facts.map((f) => f.label), ['Received', 'Source', 'Owner'], 'the first three facts are the preview');
  assert.equal(enquiry.badge, undefined);

  assert.equal(quotation.state, 'current');
  assert.equal(quotation.to, undefined, 'no link to the page you are on');
  assert.deepEqual(quotation.facts, []);
  assert.equal(quotation.meta, 'Q-118 · 01 Oct 2026');
  assert.deepEqual(quotation.badge, { label: '24 days', tone: 'waiting' });

  assert.deepEqual({ to: po.to, meta: po.meta, state: po.state }, { to: undefined, meta: undefined, state: 'future' });

  assert.equal(nowLabel, 'Now · Quotation · Accepted');
  assert.equal(substeps.label, 'Inside Quotation');
  assert.deepEqual(substeps.steps.map((s) => s.state), ['done', 'done', 'skipped', 'current', 'future']);
});

test('from the enquiry the same journey links the quotation, the current step', () => {
  const { steps } = railProps(atQuotation, '/enquiries/CTZ%2FENQ%2F2026%2F004');
  assert.equal(steps[0].to, undefined);
  assert.equal(steps[1].to, '/quotations/Q-118');
  assert.deepEqual(steps[1].facts.map((f) => f.label), ['Quotation no.']);
});

test('a step the sale went past without a record is hollow and goes nowhere', () => {
  const poOnly = {
    step: 'po', exit: null, small_step: 'Registered', days_in_step: 3, flag: null,
    steps: [
      { key: 'enquiry', label: 'Enquiry', state: 'skipped', record: null, small: [], facts: [] },
      { key: 'quotation', label: 'Quotation', state: 'skipped', record: null, small: [], facts: [] },
      {
        key: 'po', label: 'PO', state: 'current',
        record: { kind: 'po', no: 'PO 4500183', date: '2026-08-20', count: 2 },
        small: [{ label: 'Registered', state: 'current', date: '2026-08-20' }],
        facts: [],
      },
    ],
  };
  const { steps, nowLabel } = railProps(poOnly, '/projects/CV108');
  assert.deepEqual(steps.slice(0, 2).map((s) => [s.state, s.to, s.meta]), [['skipped', undefined, undefined], ['skipped', undefined, undefined]]);
  assert.equal(steps[2].to, '/purchase-orders/PO%204500183');
  assert.equal(steps[2].meta, 'PO 4500183 · 20 Aug 2026 · +1 more');
  assert.deepEqual(steps[2].badge, { label: '3 days', tone: 'plain' });
  assert.equal(nowLabel, 'Now · PO · Registered');
});

test('a sale that stopped says where, with no small steps and no days', () => {
  const lost = {
    ...atQuotation, exit: 'lost', flag: null,
    steps: atQuotation.steps.map((s) => (s.key === 'quotation' ? { ...s, state: 'exit' } : s)),
  };
  const rail = railProps(lost, '/quotations/Q-118');
  assert.equal(rail.nowLabel, 'Lost at Quotation');
  assert.equal(rail.substeps, undefined);
  assert.equal(rail.steps[1].badge, undefined);

  const unqualified = {
    step: 'enquiry', exit: 'unqualified', flag: null, days_in_step: 9,
    steps: [
      { ...atQuotation.steps[0], state: 'exit' },
      { key: 'quotation', label: 'Quotation', state: 'future', record: null, small: [], facts: [] },
      { key: 'po', label: 'PO', state: 'future', record: null, small: [], facts: [] },
    ],
  };
  assert.equal(railProps(unqualified, '/enquiries/CTZ%2FENQ%2F2026%2F004').nowLabel, 'Unqualified at Enquiry');
});

test('a paid sale is complete', () => {
  const paid = {
    ...atQuotation, step: 'po', exit: 'paid', flag: null,
    steps: atQuotation.steps.map((s) => ({ ...s, state: 'done', record: s.record || { kind: 'po', no: 'PO 4500183', date: '2026-10-20' } })),
  };
  const rail = railProps(paid, '/purchase-orders/PO%204500183');
  assert.equal(rail.nowLabel, 'Complete · paid');
  assert.equal(rail.substeps, undefined);
  assert.deepEqual(rail.steps.map((s) => s.state), ['done', 'done', 'done']);
  assert.equal(rail.steps[2].to, undefined, 'the PO is the page you are on');
});
