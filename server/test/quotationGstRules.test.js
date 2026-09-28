import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { gstBreakdown } from '../src/lib/accounting/gst.js';
import { quotationDocument } from '../src/lib/quotationPdf.js';

/**
 * The GST split itself (#23, acceptance line 1), and what the document
 * prints. "CGST + SGST within the state, IGST outside it" was never built:
 * the quotation carried one `tax_total` and the PDF printed one row called
 * GST, which is not a document a compliance business can put its name to.
 *
 * The rule already existed for draft invoices (`splitTax`), so this reuses
 * it rather than writing a second copy.
 *
 * No database here, and that is deliberate: importing these pulls in the
 * shared pool, and a suite that builds its own database has to do that
 * before anything else has looked at it.
 */

const LINES = [{ amount: 100000, gst_rate: 18 }, { amount: 10000, gst_rate: 5 }];

describe('working out the split', () => {
  test('within our own state it is CGST and SGST, half the rate each', () => {
    const g = gstBreakdown(LINES, { ourState: '27', theirState: '27' });
    assert.equal(g.intra, true);
    assert.equal(g.cgst, 9250);
    assert.equal(g.sgst, 9250);
    assert.equal(g.igst, 0);
    assert.equal(g.tax_total, 18500, 'and the two halves are the whole tax');
    assert.equal(g.total, 128500);
  });

  test('outside it, the whole thing is IGST', () => {
    const g = gstBreakdown(LINES, { ourState: '27', theirState: '29' });
    assert.equal(g.intra, false);
    assert.equal(g.igst, 18500);
    assert.equal(g.cgst + g.sgst, 0);
    assert.equal(g.tax_total, 18500, 'the tax owed is the same either way; only the split changes');
  });

  test('each rate keeps its own band, because the average of two rates is not a rate', () => {
    const g = gstBreakdown(LINES, { ourState: '27', theirState: '27' });
    assert.deepEqual(g.bands.map((b) => b.rate), [18, 5], 'highest first');
    assert.equal(g.bands[0].taxable, 100000);
    assert.equal(g.bands[0].cgst, 9000);
    assert.equal(g.bands[1].taxable, 10000);
    assert.equal(g.bands[1].cgst, 250);
    // 18,500 on 110,000 is 16.82% — the weighted average, and a rate no GST
    // tool accepts. It must appear nowhere.
    assert.ok(!g.bands.some((b) => b.rate === 16.82));
  });

  test('a quotation in another currency is zero-rated, and says why', () => {
    const g = gstBreakdown(LINES, { ourState: '27', theirState: '27', currency: 'USD' });
    assert.equal(g.zero_rated, true);
    assert.equal(g.tax_total, 0);
    assert.equal(g.total, 110000, 'the value stands; only the tax goes');
    assert.match(g.problems.join(' '), /USD/);
  });

  test('when the split cannot be decided it says so, and does not answer zero', () => {
    const noState = gstBreakdown(LINES, { ourState: null, theirState: '27' });
    assert.match(noState.problems.join(' '), /company state code/i);
    assert.equal(noState.tax_total, 18500, 'the tax is still owed; it is the split that is unknown');
    assert.equal(noState.igst, 18500, 'and IGST is the safer of the two to show');

    const noPlace = gstBreakdown(LINES, { ourState: '27', theirState: null });
    assert.match(noPlace.problems.join(' '), /place of supply/i);
  });

  test('a quotation with no lines is not a tax bill', () => {
    const g = gstBreakdown([], { ourState: '27', theirState: '27' });
    assert.deepEqual(g.bands, []);
    assert.equal(g.tax_total, 0);
    assert.equal(g.total, 0);
  });

  test('a state code written with a leading zero still matches', () => {
    assert.equal(gstBreakdown(LINES, { ourState: '7', theirState: '07' }).intra, true);
  });
});

describe('what the PDF prints', () => {
  const doc = (gst) => JSON.stringify(quotationDocument({
    quotation_no: 'CTZ/QT/2026/001', client_name: 'A Client', currency: 'INR',
    subtotal: 110000, tax_total: 18500, total: 128500, settings: {},
    lines: LINES.map((l, i) => ({ ...l, description: `Line ${i + 1}`, qty: 1, rate: l.amount })),
    gst,
  }));

  test('CGST and SGST rows, one pair per rate, within the state', () => {
    const out = doc(gstBreakdown(LINES, { ourState: '27', theirState: '27' }));
    for (const label of ['CGST @ 9%', 'SGST @ 9%', 'CGST @ 2.5%', 'SGST @ 2.5%']) {
      assert.ok(out.includes(label), `${label} is missing from the document`);
    }
    assert.ok(!out.includes('IGST'), 'and no IGST beside them');
  });

  test('IGST rows outside it', () => {
    const out = doc(gstBreakdown(LINES, { ourState: '27', theirState: '29' }));
    assert.ok(out.includes('IGST @ 18%') && out.includes('IGST @ 5%'));
    assert.ok(!out.includes('CGST'), 'CGST has no place on an inter-state document');
  });

  test('a quotation loaded without the split still prints its stored total', () => {
    // An old revision snapshot has no `gst`, and a document that prints
    // nothing would be worse than one printing the single figure it has.
    const out = doc(null);
    assert.ok(out.includes('GST'));
    assert.ok(out.includes('18,500') || out.includes('18500'));
  });
});
