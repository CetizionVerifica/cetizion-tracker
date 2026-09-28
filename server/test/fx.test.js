import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AED_PER_USD, backfillExchangeRates, fetchEcb, inrRatesFor, parseEcbXml, publishingDaysBetween,
  rateAges, readableDate, runExchangeRateSync, staleRates, trackedCurrencies, upsertFeedRates,
} from '../src/lib/fx.ts';
import { staleAmong } from '../src/lib/salesReport.js';

/**
 * Exchange rates from the ECB: reading the file, working out rupees per unit,
 * and storing the result without ever touching a rate somebody typed in.
 *
 * Nothing here reaches the network or a database — the ECB file and the
 * database are both passed in.
 */

// The daily file: apostrophes around attributes, one day, euros as the base.
const DAILY_XML = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
 <Cube><Cube time='2026-09-22'>
  <Cube currency='USD' rate='1.1463'/>
  <Cube currency='GBP' rate='0.85780'/>
  <Cube currency='SGD' rate='1.4612'/>
  <Cube currency='INR' rate='109.5805'/>
  <Cube currency='JPY' rate='180.17'/>
 </Cube></Cube>
</gesmes:Envelope>`;

// The history files: quotation marks, newest day first.
const HISTORY_XML = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope><Cube>
 <Cube time="2026-01-05"><Cube currency="USD" rate="1.1000"/><Cube currency="GBP" rate="0.8500"/><Cube currency="SGD" rate="1.4500"/><Cube currency="INR" rate="105.0000"/></Cube>
 <Cube time="2026-01-02"><Cube currency="USD" rate="1.1200"/><Cube currency="GBP" rate="0.8600"/><Cube currency="SGD" rate="1.4600"/><Cube currency="INR" rate="106.0000"/></Cube>
 <Cube time="2025-12-31"><Cube currency="USD" rate="1.1300"/><Cube currency="INR" rate="107.0000"/></Cube>
</Cube></gesmes:Envelope>`;

/** A database that remembers the rows written, and can hold manual ones. */
const fakeDb = ({ manual = [] } = {}) => {
  const written = [];
  const manualKeys = new Set(manual.map(([c, d]) => `${c}|${d}`));
  return {
    written,
    async query(sql, params = []) {
      if (!/INSERT INTO exchange_rates/.test(sql)) return { rows: [] };
      // The statement takes three arrays and unnests them, so one call can
      // carry a month of days.
      const [currencies, rates, dates, entered_by] = params;
      const stored = [];
      currencies.forEach((currency, i) => {
        const effective_from = dates[i];
        // The real WHERE clause: a row somebody entered by hand refuses the update.
        if (manualKeys.has(`${currency}|${effective_from}`)) return;
        written.push({ currency, rate: Number(rates[i]), effective_from, entered_by });
        stored.push({ from_currency: currency, effective_from });
      });
      return { rows: stored };
    },
  };
};

/** A stand-in for fetch, serving one body or failing. */
const serve = (body, { ok = true, status = 200 } = {}) => async () => ({
  ok, status, text: async () => body,
});

test('the currencies come from STATUS, and the rupee is not one of them', () => {
  const currencies = trackedCurrencies();
  assert.ok(currencies.includes('USD') && currencies.includes('AED') && currencies.includes('EUR'));
  assert.ok(!currencies.includes('INR'));
});

test('both ECB file styles parse: the daily one and the history one', () => {
  const daily = parseEcbXml(DAILY_XML);
  assert.equal(daily.length, 1);
  assert.equal(daily[0].date, '2026-09-22');
  assert.equal(daily[0].rates.USD, 1.1463);
  assert.equal(daily[0].rates.INR, 109.5805);

  const history = parseEcbXml(HISTORY_XML);
  assert.deepEqual(history.map((d) => d.date), ['2026-01-05', '2026-01-02', '2025-12-31']);
  assert.equal(history[1].rates.SGD, 1.46);
});

test('rubbish in the file yields no days rather than a bad rate', () => {
  assert.deepEqual(parseEcbXml(''), []);
  assert.deepEqual(parseEcbXml('<html>maintenance</html>'), []);
  assert.deepEqual(parseEcbXml(`<Cube time="2026-01-05"><Cube currency="USD" rate="nonsense"/></Cube>`), []);
});

test('rupees per unit is the cross rate through the euro', () => {
  const [day] = parseEcbXml(DAILY_XML);
  const rates = Object.fromEntries(inrRatesFor(day).map((r) => [r.currency, r.rate]));
  // One euro buys 109.5805 rupees and 1.1463 dollars, so a dollar buys 95.59 rupees.
  assert.equal(rates.USD, Number((109.5805 / 1.1463).toFixed(6)));
  assert.ok(Math.abs(rates.USD - 95.59) < 0.01, `USD ${rates.USD}`);
  assert.equal(rates.EUR, 109.5805);                       // the file's own base
  assert.ok(Math.abs(rates.GBP - 127.75) < 0.01, `GBP ${rates.GBP}`);
  assert.ok(Math.abs(rates.SGD - 74.99) < 0.01, `SGD ${rates.SGD}`);
});

test('the dirham comes from the dollar at its fixed peg', () => {
  const [day] = parseEcbXml(DAILY_XML);
  const rates = Object.fromEntries(inrRatesFor(day).map((r) => [r.currency, r.rate]));
  assert.equal(AED_PER_USD, 3.6725);
  assert.equal(rates.AED, Number((109.5805 / 1.1463 / 3.6725).toFixed(6)));
  // The same arithmetic behind the tracker's own hand-entered row: 95.54 / 3.6725 = 26.02.
  assert.ok(Math.abs(rates.AED - 26.03) < 0.02, `AED ${rates.AED}`);
});

test('a currency the ECB did not publish that day is left out, never invented', () => {
  const day = { date: '2026-01-05', rates: { USD: 1.1, INR: 105 } };   // no GBP, no SGD
  const got = inrRatesFor(day).map((r) => r.currency).sort();
  assert.deepEqual(got, ['AED', 'EUR', 'USD']);                        // AED still follows the dollar
  // And with no rupee at all, nothing can be converted.
  assert.deepEqual(inrRatesFor({ date: '2026-01-05', rates: { USD: 1.1 } }), []);
});

test('the daily job writes one row per currency for the ECB\'s own date', async () => {
  const db = fakeDb();
  const result = await runExchangeRateSync({ db, fetchImpl: serve(DAILY_XML) });
  assert.equal(result.ecb_date, '2026-09-22');
  assert.equal(result.written, 5);                                     // USD EUR GBP AED SGD
  assert.deepEqual(db.written.map((w) => w.effective_from), Array(5).fill('2026-09-22'));
  assert.deepEqual(result.missing, []);
});

test('running it twice writes the same rows again rather than duplicating them', async () => {
  // The table's unique key is (currency, currency, date), so the second run is
  // an update of that day's row. The fake records both calls; what matters is
  // that every row carries the same key.
  const db = fakeDb();
  await runExchangeRateSync({ db, fetchImpl: serve(DAILY_XML) });
  await runExchangeRateSync({ db, fetchImpl: serve(DAILY_XML) });
  const keys = new Set(db.written.map((w) => `${w.currency}|${w.effective_from}`));
  assert.equal(keys.size, 5, 'five distinct currency-and-date keys, however often it runs');
});

test('a rate entered by hand is never overwritten by the feed', async () => {
  const db = fakeDb({ manual: [['USD', '2026-09-22'], ['AED', '2026-09-22']] });
  const result = await runExchangeRateSync({ db, fetchImpl: serve(DAILY_XML) });
  assert.equal(result.written, 3);
  assert.deepEqual(result.kept_manual.sort(), ['AED 2026-09-22', 'USD 2026-09-22']);
  assert.ok(!db.written.some((w) => w.currency === 'USD'), 'the hand-entered dollar rate stands');
});

test('a failed fetch writes nothing at all', async () => {
  for (const [label, fetchImpl] of [
    ['network down', async () => { throw new Error('getaddrinfo ENOTFOUND'); }],
    ['ECB 503', serve('', { ok: false, status: 503 })],
    ['a maintenance page', serve('<html>down for maintenance</html>')],
  ]) {
    const db = fakeDb();
    await assert.rejects(() => runExchangeRateSync({ db, fetchImpl }), /ECB/, label);
    assert.deepEqual(db.written, [], `${label}: nothing written`);
  }
});

test('the backfill stores every publishing day in range and skips the rest', async () => {
  const db = fakeDb();
  const result = await backfillExchangeRates({ from: '2026-01-01', db, fetchImpl: serve(HISTORY_XML) });
  assert.equal(result.days, 2);                                        // 31 Dec is before the start
  assert.deepEqual([...new Set(db.written.map((w) => w.effective_from))].sort(), ['2026-01-02', '2026-01-05']);
  // Nothing is written for the 3rd and 4th — a weekend the ECB did not publish.
  assert.ok(!db.written.some((w) => ['2026-01-03', '2026-01-04'].includes(w.effective_from)));
});

test('the backfill can be run again, and leaves hand-entered rows alone', async () => {
  const db = fakeDb({ manual: [['USD', '2026-01-02']] });
  const first = await backfillExchangeRates({ from: '2026-01-01', db, fetchImpl: serve(HISTORY_XML) });
  const second = await backfillExchangeRates({ from: '2026-01-01', db, fetchImpl: serve(HISTORY_XML) });
  assert.equal(first.written, second.written, 'the same rows, not more of them');
  assert.deepEqual(first.kept_manual, ['USD 2026-01-02']);
  assert.ok(!db.written.some((w) => w.currency === 'USD' && w.effective_from === '2026-01-02'));
});

test('an end date bounds the backfill', async () => {
  const db = fakeDb();
  const result = await backfillExchangeRates({ from: '2026-01-01', to: '2026-01-03', db, fetchImpl: serve(HISTORY_XML) });
  assert.equal(result.days, 1);
  assert.deepEqual([...new Set(db.written.map((w) => w.effective_from))], ['2026-01-02']);
});

test('publishing days skip weekends', () => {
  assert.equal(publishingDaysBetween('2026-09-21', '2026-09-22'), 1);  // Mon → Tue
  assert.equal(publishingDaysBetween('2026-09-18', '2026-09-21'), 1);  // Fri → Mon, one publishing day
  assert.equal(publishingDaysBetween('2026-09-22', '2026-09-22'), 0);
  // 2 Jan (a Friday) through 22 Sep, weekdays only.
  assert.equal(publishingDaysBetween('2026-01-01', '2026-09-22'), 188);
});

test('a Monday looking back at Friday is not stale; January in September is', () => {
  const ages = rateAges(
    [{ currency: 'USD', effective_from: '2026-09-18' }, { currency: 'EUR', effective_from: '2026-01-01' }],
    { today: '2026-09-21' }                                            // the Monday after
  );
  assert.equal(ages[0].stale, false, 'Friday\'s rate on a Monday is the newest there is');
  assert.equal(ages[1].stale, true);
  assert.equal(ages[1].note, 'EUR converted at the rate of 1 Jan 2026');
});

test('a long weekend with a bank holiday either side still does not cry wolf', () => {
  // Thursday's rate, read on the following Wednesday: four publishing days.
  const [age] = rateAges([{ currency: 'USD', effective_from: '2026-09-17' }], { today: '2026-09-23' });
  assert.equal(age.publishing_days, 4);
  assert.equal(age.stale, false);
  // One more day and it is worth saying.
  assert.equal(rateAges([{ currency: 'USD', effective_from: '2026-09-17' }], { today: '2026-09-24' })[0].stale, true);
});

test('dates read the way the notice says them', () => {
  assert.equal(readableDate('2026-01-01'), '1 Jan 2026');
  assert.equal(readableDate('2026-09-22'), '22 Sep 2026');
});

test('staleness is about the newest rate held, not the rate an old record used', async () => {
  // The table: the dollar is current, the euro has nothing since January.
  const db = {
    async query() {
      return { rows: [
        { currency: 'EUR', effective_from: '2026-01-01', rate: '110.94', source: 'manual' },
        { currency: 'USD', effective_from: '2026-09-21', rate: '95.59', source: 'feed' },
      ] };
    },
  };
  const stale = await staleRates({ db, today: '2026-09-22' });
  assert.deepEqual(stale.map((s) => s.currency), ['EUR']);
  assert.equal(stale[0].note, 'EUR converted at the rate of 1 Jan 2026');
});

test('a rate dated in the future does not pass for the newest one in force', async () => {
  // Somebody enters next month's agreed rate. Reports still convert at the
  // old one, so the warning must still say the old one is old.
  const asked = [];
  const db = {
    async query(sql, params) {
      asked.push({ sql, params });
      return { rows: [{ currency: 'USD', effective_from: '2026-01-01', rate: '95.54', source: 'manual' }] };
    },
  };
  const stale = await staleRates({ db, currencies: ['USD'], today: '2026-09-22' });
  assert.match(asked[0].sql, /effective_from <= \$1::date/);
  assert.equal(asked[0].params[0], '2026-09-22', 'bounded at today, the way rateOn is');
  assert.deepEqual(stale.map((s) => s.note), ['USD converted at the rate of 1 Jan 2026']);
});

// The table answers with whatever newest rate it holds on or before the date
// asked; `asked` records that date, so a test can see which day was judged.
const ratesTable = (newest) => {
  const asked = [];
  return {
    asked,
    db: { async query(_sql, params) { asked.push(params[0]); return { rows: newest.filter((r) => r.effective_from <= params[0]) }; } },
  };
};

test('a past period is judged as of its own last day, not this week', async () => {
  const used = [{ currency: 'USD' }];
  const q3 = { from: '2026-07-01', to: '2026-09-30' };

  // Run on 1 October: September's deals went through at January's rate. Said.
  const stuck = ratesTable([{ currency: 'USD', effective_from: '2026-01-01' }]);
  const late = await staleAmong(used, { today: '2026-10-01', period: q3, db: stuck.db });
  assert.deepEqual(stuck.asked, ['2026-09-30'], 'judged at the period\'s last day');
  assert.deepEqual(late.map((s) => s.note), ['USD converted at the rate of 1 Jan 2026']);

  // The rates were current when the period ended: nothing to say, whatever today is.
  const kept = ratesTable([{ currency: 'USD', effective_from: '2026-09-29' }]);
  assert.deepEqual(await staleAmong(used, { today: '2026-12-15', period: q3, db: kept.db }), []);
  assert.deepEqual(kept.asked, ['2026-09-30']);

  // A period still running is judged as of today.
  const now = ratesTable([{ currency: 'USD', effective_from: '2026-09-21' }]);
  await staleAmong(used, { today: '2026-09-22', period: { from: '2026-01-01', to: '2026-12-31' }, db: now.db });
  assert.deepEqual(now.asked, ['2026-09-22']);
});

test('a report with no foreign currency on it asks the table nothing', async () => {
  const table = ratesTable([{ currency: 'USD', effective_from: '2026-01-01' }]);
  assert.deepEqual(await staleAmong([{ currency: 'INR' }], { today: '2026-09-22', db: table.db }), []);
  assert.deepEqual(table.asked, [], 'no query for a report that converted nothing');
});

test('fetchEcb refuses a body it cannot read rather than returning nothing useful', async () => {
  await assert.rejects(() => fetchEcb('x', { fetchImpl: serve('<html>hello</html>') }), /nothing usable/);
});

test('upsert reports what it wrote and what it left alone', async () => {
  const db = fakeDb({ manual: [['EUR', '2026-01-02']] });
  const result = await upsertFeedRates(
    [{ currency: 'USD', rate: 95.5, effective_from: '2026-01-02' }, { currency: 'EUR', rate: 106, effective_from: '2026-01-02' }],
    { db, enteredBy: 'test' }
  );
  assert.deepEqual(result, { written: 1, kept_manual: ['EUR 2026-01-02'] });
  assert.equal(db.written[0].entered_by, 'test');
});
