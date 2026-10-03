import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { checkCommentary, checkHighlights, commentaryInput, figuresIn, numbersAllowed, numbersOf } from '../src/lib/misAi.js';
import { weekly } from './misPdfFixture.mjs';

/**
 * The checks that stand between the model and the report
 * (docs/mis-reports-plan.md §3.4, §8): the AI may word, never change a figure.
 */

describe('numbers in text', () => {
  test('numbersOf reads amounts with Indian grouping and decimals', () => {
    assert.deepEqual(numbersOf('₹1,20,000 on 28 Sep, 12.4 L, 21%'), ['120000', '28', '12.4', '21']);
  });
  test('figuresIn offers rounded, lakh and crore forms of an amount', () => {
    const f = figuresIn({ value_inr: 1240000, pct: 21.4, date: '2026-09-28' });
    for (const n of ['1240000', '12.4', '21', '21.4', '2026', '09', '28']) assert.ok(f.has(n), n);
    assert.ok(numbersAllowed('₹12.4 L this week, 21% converted', f));
    assert.equal(numbersAllowed('₹12.9 L this week', f), false);
  });
});

describe('the daily highlights are checked', () => {
  const threads = [
    { thread_id: 11, subject: 'RFQ for 3 sites', company: 'Acme Steel', entity: 'enquiry', entity_id: 'CTZ/ENQ/2026/040', record_status: 'New', text: 'From Ravi: We need an EcoVadis assessment for 3 sites, budget around 4,50,000.', web_link: 'https://outlook/x' },
    { thread_id: 12, subject: 'Invoice query', company: 'Beta Metals', entity: null, entity_id: null, record_status: null, text: 'From AP: Please resend invoice CVPL/26-27/010.', web_link: null },
  ];
  const actions = [{ key: 'stage:5', client: 'Acme Steel', reference: 'PO-1 · Advance', days: 12, amount_inr: 50000, next_action: 'Raise the Advance invoice', owner: 'Priya' }];

  test('an invented thread, and a summary carrying a figure the thread does not, are dropped', () => {
    const raw = {
      highlights: [
        { thread_id: 11, client: 'Acme Steel', summary: 'Asked for an EcoVadis assessment for 3 sites, budget about 4,50,000.', action: 'Send the quotation', owner: 'Priya' },
        { thread_id: 11, client: 'Acme Steel', summary: 'Asked for 5 sites.', action: null },
        { thread_id: 99, client: 'Nobody', summary: 'Made up.', action: null },
        { thread_id: 12, client: 'Beta Metals', summary: 'Wants invoice CVPL/26-27/010 again.', action: 'Resend it' },
      ],
      actions_wording: [
        { row_key: 'stage:5', text: 'Raise the Advance invoice for Acme Steel (PO-1), waiting 12 days.' },
        { row_key: 'stage:5', text: 'Raise it: 15 days now.' },
        { row_key: 'stage:9', text: 'Not a chosen row.' },
      ],
    };
    const { highlights, wording } = checkHighlights(raw, threads, actions);
    assert.deepEqual(highlights.map((h) => h.thread_id), [11, 12]);
    assert.equal(highlights[0].link, '/enquiries?q=CTZ%2FENQ%2F2026%2F040');
    assert.equal(highlights[0].web_link, 'https://outlook/x');
    assert.equal(highlights[0].source, 'ai');
    assert.equal(wording.size, 1);
    assert.match(wording.get('stage:5'), /waiting 12 days/);
  });

  test('at most eight highlights; rubbish is ignored', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ thread_id: i + 1, subject: 's', company: 'C', text: 'hello', entity: null }));
    const raw = { highlights: many.map((t) => ({ thread_id: t.thread_id, summary: 'Said hello.' })) };
    assert.equal(checkHighlights(raw, many, []).highlights.length, 8);
    assert.deepEqual(checkHighlights(null, many, []), { highlights: [], wording: new Map() });
    assert.deepEqual(checkHighlights({ highlights: 'nope' }, many, []).highlights, []);
  });
});

describe('the weekly commentary is checked', () => {
  test('a sentence with a figure not in the input gives way to the narrative; the rest stays', () => {
    const raw = {
      headline: ['14 enquiries, 3 converted (21%).', 'Revenue was ₹13.5 L from 6 POs.', 'Next week looks like 37 enquiries.', 'Receivables over 90 days stand at ₹5 L.', 'A fifth bullet.'],
      sections: {
        enquiries: 'Fourteen enquiries came in, nine of them answered within 26.5 hours on average. That is 40% better than August.',
        revenue: 'Six POs worth ₹13.5 L were received.',
        outcomes: 'Half of them converted.',
        pending: 'Twenty invoices are pending, 17 overdue.',
      },
    };
    const c = checkCommentary(raw, weekly);
    assert.equal(c.headline.length, 3, 'the extrapolated bullet is dropped, and there are at most four');
    assert.ok(!c.headline.some((b) => /37 enquiries/.test(b)));
    assert.equal(c.sections.enquiries, 'Fourteen enquiries came in, nine of them answered within 26.5 hours on average.');
    assert.equal(c.sections.revenue, 'Six POs worth ₹13.5 L were received.');
    assert.equal(c.sections.outcomes, 'Half of them converted.', 'words with no figures pass');
    assert.equal(c.sections.pending, 'Twenty invoices are pending, 17 overdue.');
    assert.equal(c.sections.sectors, undefined, 'a section the model did not word is left to the narrative in the PDF');
  });

  test('the commentary input carries figures only, never email text', () => {
    const input = commentaryInput(weekly);
    assert.ok(!('highlights' in input));
    assert.ok(!JSON.stringify(input).includes('body'));
    assert.equal(input.enquiries.total, 14);
  });
});
