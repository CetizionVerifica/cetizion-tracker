import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BOARD_KEYS, DEFAULT_PERIOD, PERIODS, boardColumns, boardRequest, cardStatus, cardValue, cohortChipText,
  conversion, conversionText, drawerView, exitChip, funnelFigures, isFiltered, journeyLookup, medianText,
  openingStep, periodPhrase, periodRange, readBoardQuery, stepAfter, timelineOf, withFilters,
  withoutRateText, writeBoardQuery,
} from '../src/components/journey/boardModel.js';

/**
 * The Journey board's pure half (web/src/components/journey/CLAUDE.md §3,
 * §5): the funnel's percentages, the filters in the address bar, and the
 * words round what the server sends. The server decides where every sale
 * is; these pin that the board divides, files and words it faithfully.
 * The clients are made up.
 */

const TODAY = '2026-10-25';
const read = (search) => readBoardQuery(new URLSearchParams(search), TODAY);

const DEFAULTS = {
  sales_person: '', service: '', stuck: false, closed: false, period: DEFAULT_PERIOD, from: '', to: '', cohort: '',
};

// ---------------------------------------------------------------- the funnel

test('a conversion is the figure as a whole share of the one before it', () => {
  assert.equal(conversion(31, 42), 74);
  assert.equal(conversion(12, 31), 39);
  assert.equal(conversion(9, 12), 75);
  assert.equal(conversion(0, 5), 0, 'none of five is 0%, not nothing');
  assert.equal(conversion(5, 5), 100);
  assert.equal(conversion('3', '4'), 75, 'counts that arrive as strings still divide');
});

test('nothing to divide by gives no percentage rather than 0% or Infinity', () => {
  assert.equal(conversion(0, 0), null);
  assert.equal(conversion(3, 0), null, 'PO-only sales can be won with none quoted');
  assert.equal(conversion(3, null), null);
  assert.equal(conversion(null, 4), null);
  assert.equal(conversion(3, 'x'), null);
  assert.equal(conversionText(0, 0, 'quoted'), null);
});

test('the chip between two figures reads as the share that went on', () => {
  assert.equal(conversionText(31, 42, 'quoted'), '74% quoted');
  assert.equal(conversionText(9, 12, 'with a PO'), '75% with a PO');
});

test('the funnel is Started, Quoted, Won, With PO, each after the first with its chip', () => {
  const figures = funnelFigures({ started: 42, quoted: 31, won: 12, with_po: 9 });
  assert.deepEqual(figures.map((f) => [f.label, f.count, f.conversion]), [
    ['Started', 42, null],
    ['Quoted', 31, '74% quoted'],
    ['Won', 12, '39% won'],
    ['With PO', 9, '75% with a PO'],
  ]);
});

test('an empty period has four noughts and no percentages', () => {
  assert.deepEqual(funnelFigures({ started: 0, quoted: 0, won: 0, with_po: 0 }).map((f) => [f.count, f.conversion]),
    [[0, null], [0, null], [0, null], [0, null]]);
  assert.deepEqual(funnelFigures(undefined).map((f) => f.count), [0, 0, 0, 0], 'before the board arrives');
  // Nothing quoted but something won (a PO with no quotation): the next chip still works.
  assert.deepEqual(funnelFigures({ started: 2, quoted: 0, won: 1, with_po: 1 }).map((f) => f.conversion),
    [null, '0% quoted', null, '100% with a PO']);
});

// ---------------------------------------------------------------- the period

test('the periods are the last 30, 90 and 365 days, and the financial year', () => {
  assert.deepEqual(PERIODS.map((p) => p.label), ['Last 30 days', 'Last 90 days', 'Last 365 days', 'This financial year']);
  assert.deepEqual(periodRange('last-90', TODAY), { from: '2026-07-27', to: TODAY }, 'the server\'s own default');
  assert.deepEqual(periodRange('last-30', TODAY), { from: '2026-09-25', to: TODAY });
  assert.deepEqual(periodRange('last-365', TODAY), { from: '2025-10-25', to: TODAY });
  assert.deepEqual(periodRange('this-fy', TODAY), { from: '2026-04-01', to: '2027-03-31' });
  assert.deepEqual(periodRange('this-fy', '2027-02-10'), { from: '2026-04-01', to: '2027-03-31' }, 'February is still the year that began in April');
  assert.equal(periodRange('last-week', TODAY), null);
});

test('the period in words follows the verb', () => {
  assert.equal(periodPhrase({ period: 'last-90' }), 'in the last 90 days');
  assert.equal(periodPhrase({ period: 'last-365' }), 'in the last 365 days');
  assert.equal(periodPhrase({ period: 'this-fy' }), 'in this financial year');
  assert.equal(periodPhrase({ period: 'custom', from: '2026-08-01', to: '2026-08-31' }), 'between 01 Aug 2026 and 31 Aug 2026');
});

// ------------------------------------------------------- filters ⇄ address bar

test('an empty address is the default board', () => {
  assert.deepEqual(read(''), DEFAULTS);
  assert.equal(writeBoardQuery(DEFAULTS).toString(), '', 'and the default board writes nothing');
});

test('every filter goes into the address and comes back the same', () => {
  const cases = [
    { ...DEFAULTS, sales_person: 'Asha Rao', service: 'ISO 9001 certification' },
    { ...DEFAULTS, stuck: true, closed: true },
    { ...DEFAULTS, cohort: 'with_po' },
    { ...DEFAULTS, period: 'last-30', ...periodRange('last-30', TODAY) },
    { ...DEFAULTS, period: 'this-fy', ...periodRange('this-fy', TODAY), cohort: 'quoted', stuck: true },
    { ...DEFAULTS, period: 'custom', from: '2026-08-01', to: '2026-08-31', sales_person: 'Dev Patel & Co' },
  ];
  for (const filters of cases) {
    const address = writeBoardQuery(filters).toString();
    assert.deepEqual(read(address), filters, address);
  }
});

test('the address carries plain, readable keys and leaves out what is default', () => {
  const filters = { ...DEFAULTS, sales_person: 'Asha Rao', stuck: true, period: 'last-30', ...periodRange('last-30', TODAY), cohort: 'won' };
  assert.equal(writeBoardQuery(filters).toString(), 'sales_person=Asha+Rao&stuck=1&from=2026-09-25&to=2026-10-25&cohort=won');
  assert.deepEqual(BOARD_KEYS, ['sales_person', 'service', 'stuck', 'closed', 'from', 'to', 'cohort']);
});

test('keys that are not the board\'s stay in the address', () => {
  const next = writeBoardQuery({ ...DEFAULTS, closed: true }, new URLSearchParams('log=1&cohort=won&stuck=1'));
  assert.equal(next.toString(), 'log=1&closed=1', 'its own keys are rewritten, the others kept');
});

test('anything unreadable in the address falls back to its default', () => {
  assert.deepEqual(read('cohort=lost&stuck=yes&closed=2'), DEFAULTS);
  assert.deepEqual(read('from=2026-10-01&to=2026-09-01'), DEFAULTS, 'a period that ends before it starts');
  assert.deepEqual(read('from=2026-02-30&to=2026-03-10'), DEFAULTS, 'a day that does not exist');
  assert.deepEqual(read('from=2026-09-01'), DEFAULTS, 'half a period');
  assert.deepEqual(read('stuck=true&closed=1').stuck, true);
});

test('the default period in the address reads as the default, so it is not written twice', () => {
  const { from, to } = periodRange('last-90', TODAY);
  assert.deepEqual(read(`from=${from}&to=${to}`), DEFAULTS);
});

test('choosing a period on the toolbar brings its dates; the default clears them', () => {
  const thirty = withFilters(new URLSearchParams('stuck=1'), { period: 'last-30' }, TODAY);
  assert.equal(thirty.toString(), 'stuck=1&from=2026-09-25&to=2026-10-25');
  const back = withFilters(thirty, { period: 'last-90' }, TODAY);
  assert.equal(back.toString(), 'stuck=1');
  const cohort = withFilters(back, { cohort: 'quoted' }, TODAY);
  assert.equal(cohort.toString(), 'stuck=1&cohort=quoted', 'any other change is taken as given');
  assert.equal(withFilters(cohort, { cohort: '' }, TODAY).toString(), 'stuck=1', 'and a blank takes it away');
});

test('the server is asked for what the address says, toggles as 1', () => {
  assert.deepEqual(boardRequest(read('sales_person=Asha+Rao&stuck=1&cohort=won')),
    { sales_person: 'Asha Rao', service: '', stuck: '1', closed: '', from: '', to: '', cohort: 'won' });
  assert.deepEqual(boardRequest(read('closed=1&from=2026-09-25&to=2026-10-25')),
    { sales_person: '', service: '', stuck: '', closed: '1', from: '2026-09-25', to: '2026-10-25', cohort: '' });
});

test('a board is filtered by an owner, a service, a toggle or a cohort, but not by its period', () => {
  assert.equal(isFiltered(DEFAULTS), false);
  assert.equal(isFiltered({ ...DEFAULTS, period: 'last-30', from: '2026-09-25', to: TODAY }), false);
  for (const change of [{ sales_person: 'Asha Rao' }, { service: 'ISO 14001' }, { stuck: true }, { closed: true }, { cohort: 'won' }]) {
    assert.equal(isFiltered({ ...DEFAULTS, ...change }), true, JSON.stringify(change));
  }
});

// ------------------------------------------------------------ the cohort chip

test('an active cohort says which sales the board is showing, and when they started', () => {
  assert.equal(cohortChipText({ ...DEFAULTS, cohort: 'quoted' }), 'Showing: quoted in the last 90 days');
  assert.equal(cohortChipText({ ...DEFAULTS, cohort: 'started', period: 'last-30' }), 'Showing: started in the last 30 days');
  assert.equal(cohortChipText({ ...DEFAULTS, cohort: 'won', period: 'this-fy' }), 'Showing: won in this financial year');
  assert.equal(cohortChipText({ ...DEFAULTS, cohort: 'with_po', period: 'custom', from: '2026-08-01', to: '2026-08-31' }),
    'Showing: with a PO between 01 Aug 2026 and 31 Aug 2026');
  assert.equal(cohortChipText(DEFAULTS), null, 'no cohort, no chip');
});

// ------------------------------------------------------------- columns, cards

const card = (over = {}) => ({
  key: 'q-118', step: 'quotation', exit: null, small_step: 'Accepted', progress: ['done', 'current', 'future'],
  days_in_step: 24, flag: null, next: { verb: 'register_po', label: 'Register the PO' },
  client_name: 'Harbourline Textiles', service: 'ISO 9001 certification', sales_person: 'Asha Rao',
  value: 590000, currency: 'INR', value_inr: 590000,
  records: { enquiry_no: 'CTZ/ENQ/2026/004', quotation_no: 'Q-118', po_number: null, project_id: null },
  ...over,
});

test('the columns are the three steps, each with its summary and its own cards in order', () => {
  const data = {
    steps: [
      { key: 'enquiry', label: 'Enquiry', count: 1, value_inr: 450000, without_rate: 0, median_days: 4 },
      { key: 'quotation', label: 'Quotation', count: 2, value_inr: 1180000, without_rate: 1, median_days: 11 },
      { key: 'po', label: 'PO', count: 0, value_inr: 0, without_rate: 0, median_days: null },
    ],
    cards: [card({ key: 'e-3', step: 'enquiry' }), card({ key: 'q-9' }), card({ key: 'q-118' })],
  };
  const columns = boardColumns(data);
  assert.deepEqual(columns.map((c) => [c.label, c.count, c.cards.map((x) => x.key)]),
    [['Enquiry', 1, ['e-3']], ['Quotation', 2, ['q-9', 'q-118']], ['PO', 0, []]]);
  assert.equal(columns[1].without_rate, 1);
  assert.deepEqual(boardColumns(null).map((c) => [c.key, c.count, c.cards.length]), [['enquiry', 0, 0], ['quotation', 0, 0], ['po', 0, 0]]);
});

test('a column says its median days here, and who it left out of its value', () => {
  assert.equal(medianText(11), 'median 11 days here');
  assert.equal(medianText(1), 'median 1 day here');
  assert.equal(medianText(0), 'median 0 days here');
  assert.equal(medianText(10.5), 'median 11 days here', 'a median of an even count is whole days on the board');
  assert.equal(medianText(null), null);
  assert.equal(withoutRateText(0), null);
  assert.match(withoutRateText(1), /^1 sale is left out .* its currency on its date\. Add it under Settings, Exchange rates\.$/);
  assert.match(withoutRateText(3), /^3 sales are left out .* their currency/);
});

test('a card shows its value in its own currency, and says when it has none', () => {
  assert.equal(cardValue(card()), '₹5,90,000');
  assert.equal(cardValue(card({ value: 12000, currency: 'EUR' })), '€12,000');
  assert.equal(cardValue(card({ step: 'enquiry', value: null })), 'No estimate');
  assert.equal(cardValue(card({ value: null })), 'No value', 'never ₹0');
  // POs in several currencies, as the server sends them: no value of their own, rupees when every PO has a rate.
  assert.equal(cardValue(card({ step: 'po', value: null, currency: null, value_inr: 190000 })), '₹1,90,000 across currencies');
  assert.equal(cardValue(card({ step: 'po', value: null, currency: null, value_inr: null })), 'Several currencies');
  assert.equal(cardValue(card({ value: null, currency: null, value_inr: null, value_hidden: true })), 'Owner only', 'someone else\'s record, not a missing value');
  assert.equal(cardValue(card({ step: 'po', value: null, currency: null, value_inr: null, value_hidden: true })), 'Owner only');
});

test('a card says one thing about time: where it stopped, else its flag, else its days', () => {
  assert.deepEqual(cardStatus(card({ exit: 'lost', flag: null })), { chip: { label: 'Lost', tone: 'late' } });
  assert.deepEqual(cardStatus(card({ flag: { kind: 'stuck', label: 'Stuck 48 days', tone: 'late' } })), { chip: { label: 'Stuck 48 days', tone: 'late' } });
  assert.deepEqual(cardStatus(card()), { days: '24 days' });
  assert.deepEqual(cardStatus(card({ days_in_step: null })), {});
  assert.deepEqual(exitChip('unqualified'), { label: 'Unqualified', tone: 'late' });
  assert.deepEqual(exitChip('paid'), { label: 'Paid', tone: 'settled' });
  assert.equal(exitChip(null), null);
});

// -------------------------------------------------------------------- drawer

test('the drawer asks for the sale by its quotation first, then its enquiry, then its PO', () => {
  assert.deepEqual(journeyLookup(card()), { quotation: 'Q-118' });
  assert.deepEqual(journeyLookup(card({ records: { enquiry_no: 'CTZ/ENQ/2026/007', quotation_no: null, po_number: null } })), { enquiry: 'CTZ/ENQ/2026/007' });
  assert.deepEqual(journeyLookup(card({ records: { enquiry_no: null, quotation_no: null, po_number: 'PO 4500183' } })), { po: 'PO 4500183' });
  assert.equal(journeyLookup(card({ records: {} })), null);
});

test('the drawer opens on the step the sale is on, or the one it stopped at', () => {
  assert.equal(openingStep(card()), 'quotation');
  assert.equal(openingStep(card({ progress: ['skipped', 'exit', 'future'] })), 'quotation');
  assert.equal(openingStep(card({ step: 'po', exit: 'paid', progress: ['done', 'done', 'done'] })), 'po', 'a paid sale opens on its PO');
  assert.equal(openingStep(null), 'enquiry');
});

test('↑ and ↓ walk the steps and stop at either end', () => {
  assert.equal(stepAfter('enquiry', 1), 'quotation');
  assert.equal(stepAfter('quotation', 1), 'po');
  assert.equal(stepAfter('po', 1), 'po');
  assert.equal(stepAfter('enquiry', -1), 'enquiry');
  assert.equal(stepAfter('po', -3), 'enquiry', 'Home');
  assert.equal(stepAfter('enquiry', 3), 'po', 'End');
});

test('before the journey arrives the drawer draws the card\'s three steps', () => {
  const view = drawerView(card(), null);
  assert.deepEqual(view.steps.map((s) => [s.label, s.state, s.record, s.lines]),
    [['Enquiry', 'done', null, []], ['Quotation', 'current', null, []], ['PO', 'future', null, []]]);
  assert.equal(view.nowLabel, 'Now · Quotation · Accepted');
  assert.deepEqual(view.badge, { label: '24 days', tone: 'plain' });
  assert.equal(drawerView(card({ exit: 'lost', progress: ['skipped', 'exit', 'future'] }), null).nowLabel, 'Lost at Quotation');
});

test('once it arrives each step carries its record line, small steps and facts', () => {
  const detail = {
    ...card(),
    steps: [
      { key: 'enquiry', label: 'Enquiry', state: 'done', record: { kind: 'enquiry', no: 'CTZ/ENQ/2026/004', date: '2026-09-18' }, since: '2026-09-18', small: [], facts: [{ label: 'Source', value: 'Email', kind: 'text' }] },
      { key: 'quotation', label: 'Quotation', state: 'current', record: { kind: 'quotation', no: 'Q-118', date: '2026-10-01' }, since: '2026-10-01', small: [{ label: 'Priced', state: 'done', date: null }], facts: [] },
      { key: 'po', label: 'PO', state: 'skipped', record: null, since: null, small: [], facts: [] },
    ],
  };
  const { steps } = drawerView(card(), detail);
  assert.deepEqual(steps.map((s) => s.lines), [['CTZ/ENQ/2026/004', '18 Sep 2026'], ['Q-118', '01 Oct 2026'], ['Not recorded']]);
  assert.deepEqual(steps.map((s) => s.reachable), [true, true, true], 'open unless the server says otherwise');
  assert.equal(steps[0].facts[0].value, 'Email');
  assert.equal(steps[1].small[0].label, 'Priced');
  assert.equal(steps[1].since, '2026-10-01');
  const several = drawerView(card(), { ...detail, steps: [detail.steps[0], detail.steps[1], { ...detail.steps[2], state: 'current', record: { kind: 'po', no: 'PO 4500183', date: '2026-10-20', count: 3 } }] });
  assert.deepEqual(several.steps[2].lines, ['PO 4500183', '20 Oct 2026 · +2 more']);
  const theirs = drawerView(card(), { ...detail, steps: [{ ...detail.steps[0], reachable: false, facts: [] }, detail.steps[1], detail.steps[2]] });
  assert.equal(theirs.steps[0].reachable, false, 'someone else\'s enquiry: no Open full page, no timeline');
});

test('each step\'s timeline is its record\'s, by the number its page uses', () => {
  assert.deepEqual(timelineOf({ kind: 'enquiry', no: 'CTZ/ENQ/2026/004' }), { entity: 'enquiry', id: 'CTZ/ENQ/2026/004' });
  assert.deepEqual(timelineOf({ kind: 'quotation', no: 'Q-118' }), { entity: 'quotation', id: 'Q-118' });
  assert.deepEqual(timelineOf({ kind: 'po', no: 'PO 4500183', count: 2 }), { entity: 'purchase_order', id: 'PO 4500183' });
  assert.equal(timelineOf(null), null);
  assert.equal(timelineOf({ kind: 'po', no: null }), null);
});
