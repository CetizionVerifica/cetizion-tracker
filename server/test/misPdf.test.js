import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { MAX_ROWS, dailyBriefingDoc, misFileName, misPdf, pdfPageCount, weeklyMisDoc } from '../src/lib/misPdf.js';
import { dailyBriefing as dailyEmail, weeklyMis as weeklyEmail } from '../src/lib/emailTemplates.js';
import { daily, weekly } from './misPdfFixture.mjs';

/**
 * The two report PDFs and their emails (docs/mis-reports-plan.md §3.5, §3.6,
 * §8): each at most two A4 pages for a busy week, the right file names, and
 * figures that reach the page. Built from a fixture shaped like
 * misReports.js's output, so no database is needed.
 */

describe('the report PDFs', () => {
  test('file names follow the routines\' own', () => {
    assert.equal(misFileName(daily), 'Daily_Sales_Briefing_2026-10-04.pdf');
    assert.equal(misFileName(weekly), 'Sales_MIS_Report_28Sep-04Oct2026.pdf');
  });

  test('the daily briefing is at most two pages even with every table full, and the tables are capped', async () => {
    const pdf = await misPdf(daily);
    assert.ok(pdf.length < 150 * 1024, `under 150 KB: ${pdf.length}`);
    assert.ok(pdfPageCount(pdf) <= 2, `${pdfPageCount(pdf)} pages`);
    const text = JSON.stringify(dailyBriefingDoc(daily).content);
    assert.match(text, /\+8 more in the tracker/);
    assert.match(text, /Highlights of yesterday/);
    assert.match(text, /Top 5 actions for today/);
    assert.equal(MAX_ROWS, 12);
  });

  test('the weekly MIS is two pages, with the eight sections and one chart', async () => {
    const pdf = await misPdf(weekly);
    assert.equal(pdfPageCount(pdf), 2, 'two pages');
    assert.ok(pdf.length < 150 * 1024, `under 150 KB: ${pdf.length}`);
    const doc = weeklyMisDoc(weekly);
    const text = JSON.stringify(doc.content);
    for (const heading of ['Enquiries received', 'Enquiry status', 'Sector-wise POs', 'Service-wise sales', 'Customer analysis', 'Revenue: invoiced and received', 'Pending and overdue follow-ups', 'Conversion and speed']) {
      assert.match(text, new RegExp(heading));
    }
    assert.equal(doc.content.filter((n) => n?.svg).length, 1, 'one bar chart, PO value by service');
    assert.match(text, /₹5 L/, 'receivables over 90 days reach the page');
    assert.match(JSON.stringify(doc.footer(1, 2)), /USD 88 and EUR 103/, 'the exchange-rate note is at the foot of page 1');
    assert.doesNotMatch(JSON.stringify(doc.footer(2, 2)), /USD 88/, 'and said once');
  });

  test('the AI\'s wording replaces the narrative when present, section by section', () => {
    const worded = { ...weekly, commentary: { headline: ['A strong week.'], sections: { enquiries: 'Fourteen enquiries, nine of them answered within a day.' } } };
    const text = JSON.stringify(weeklyMisDoc(worded).content);
    assert.match(text, /Fourteen enquiries, nine of them answered within a day/);
    assert.match(text, /A strong week/);
    assert.match(text, /3 of 14 \(21%\) converted/, 'a section the AI did not word keeps the narrative');
  });

  test('a quiet day says so and keeps the pending tables', () => {
    const quiet = { ...daily, quiet: true, highlights: [], at_a_glance: { ...daily.at_a_glance, new_enquiries: 0, quotations_sent: 0, pos_received: 0, invoices_raised: 0, payments_received: 0 } };
    const text = JSON.stringify(dailyBriefingDoc(quiet).content);
    assert.match(text, /A quiet day/);
    assert.match(text, /Pending invoices \(20\)/);
    assert.match(text, /Nothing was created or changed from email yesterday/);
  });
});

describe('the report emails', () => {
  test('the daily briefing names the day, the figures and the overdue items, and says the PDF is attached', () => {
    const e = dailyEmail({ data: daily, appUrl: 'https://tracker.example' });
    assert.match(e.subject, /Daily Sales Briefing – 04 Oct 2026: 3 new enquiries, 1 PO, 39 overdue/);
    assert.match(e.text, /New enquiries: 3/);
    assert.match(e.text, /TOP ACTIONS FOR TODAY\n1\. Client 0: Raise the Advance invoice/);
    assert.match(e.text, /attached as a PDF/);
    assert.match(e.text, /USD 88 and EUR 103/);
    assert.match(e.html, /href="https:\/\/tracker\.example\/quotations\/x"/);
    assert.doesNotMatch(e.html, /<script/);
  });

  test('the weekly MIS carries the headline bullets and the week\'s figures', () => {
    const e = weeklyEmail({ data: weekly });
    assert.match(e.subject, /Weekly Sales MIS – 28 Sep 2026 – 04 Oct 2026: 14 enquiries, 6 POs \(₹13\.5 L\)/);
    assert.match(e.text, /- 14 enquiries received\./);
    assert.match(e.text, /Receivables over 90 days: ₹5 L \(2 invoices\)/);
    assert.match(e.html, /Weekly Sales MIS, 28 Sep 2026 – 04 Oct 2026/);
  });
});
