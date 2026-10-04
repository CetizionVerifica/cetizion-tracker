import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { dailyBriefingDoc, misFileName, misPdf, pdfPageCount, weeklyMisDoc } from '../src/lib/misPdf.js';
import { dailyBriefing as dailyEmail, weeklyMis as weeklyEmail } from '../src/lib/emailTemplates.js';
import { daily, weekly } from './misPdfFixture.mjs';

/**
 * The two report PDFs and their emails (docs/mis-reports-plan.md §3.5, §3.6,
 * §8): the weekly MIS on two A4 pages, the daily briefing in the reference
 * format (docs/mis-briefing-fix-plan.md §3), the right file names, and
 * figures that reach the page. Built from a fixture shaped like
 * misReports.js's output, so no database is needed.
 */

describe('the report PDFs', () => {
  test('file names follow the routines\' own', () => {
    assert.equal(misFileName(daily), 'Daily_Sales_Briefing_2026-10-04.pdf');
    assert.equal(misFileName(weekly), 'Sales_MIS_Report_28Sep-04Oct2026.pdf');
  });

  test('the daily briefing follows the reference: four sections and every pending row, over as many pages as it takes', async () => {
    const pdf = await misPdf(daily);
    assert.ok(pdf.length < 150 * 1024, `under 150 KB: ${pdf.length}`);
    assert.ok(pdfPageCount(pdf) > 2, `no two-page cap: ${pdfPageCount(pdf)} pages`);
    const doc = dailyBriefingDoc(daily);
    const text = JSON.stringify(doc.content);
    for (const heading of ['At a glance', 'Key highlights', 'Reminders carried forward', 'Pending tasks', 'Action items for today (top 5)']) assert.match(text, new RegExp(heading.replace(/[()]/g, '\\$&')));
    assert.match(text, /Sunday, 04 Oct 2026/, 'the date with its weekday');
    assert.match(text, /Source: sales@cetizionverifica\.com, info@cetizionverifica\.com — Inbox \+ Sent Items, 00:00–23:59 IST/);
    assert.doesNotMatch(text, /more in the tracker/, 'nothing is cut');
    assert.equal((text.match(/Client 19/g) || []).length, 2, 'the last PO and quotation rows are both there');
    for (const sub of ['Invoice actions: read from email, to check \\(2\\)', 'Pending for invoicing \\(6\\)', 'Receivables: sundry debtors \\(13\\)', 'Grand total']) assert.match(text, new RegExp(sub));
    assert.match(text, /not stated/, 'an invoice read from email with no amount');
    assert.match(text, /No PO received or closed|1 PO received on 4 Oct\./);
    assert.match(text, /"link":"https:\/\/tracker\.example\/inbox\?mb=1&f=sent&t=9"/, 'a tracker link is made whole');
    assert.match(text, /"link":"https:\/\/outlook\.office\.com\/mail\/item\/0"/, 'the source email opens in Outlook');
    assert.match(text, /28 Sep · Ravi · RFQ: EcoVadis for 3 sites/, 'related earlier emails');
    assert.match(text, /Other sales activity/);
    assert.match(text, /"color":"#b42318"/, 'overdue rows are red');
    assert.match(text, /Grand total \(tracker\)/);
    assert.match(text, /Reconciled with Finance's list of 3 Oct \(grand total ₹15 L\): 1 matched, 1 line on the list only/);
    assert.match(text, /list: 1,05,000; tracker: 1,00,000/, 'both figures where the list and the tracker differ');
    assert.match(text, /"text":"list","link":"https:\/\/outlook\.office\.com\/mail\/item\/list"/, "a line on the list only links to Finance's email");
    assert.match(JSON.stringify(doc.footer(3, 4)), /Prepared automatically from the sales@cetizionverifica\.com, info@cetizionverifica\.com mailboxes/, 'the footer on every page');
    assert.match(JSON.stringify(doc.footer(3, 4)), /Page 3 of 4/);
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

  test('a quiet day says so and keeps the pending tables and the reminders', () => {
    const quiet = { ...daily, quiet: true, highlights: [], mail_window: null, at_a_glance: { ...daily.at_a_glance, new_enquiries: 0, quotations_sent: 0, pos_received: 0, invoices_raised: 0, payments_received: 0 } };
    const text = JSON.stringify(dailyBriefingDoc(quiet).content);
    assert.match(text, /No new enquiry, quotation, PO, invoice or payment on 4 Oct\. No pending item was closed\./);
    assert.match(text, /\(a\) Invoices \(20\)/);
    assert.match(text, /Nothing to highlight from the mail of 04 Oct 2026/);
    assert.match(text, /No PO received or closed on 4 Oct\./);
    assert.match(text, /Visit: EcoVadis audit, Hindalco, 6 Oct, Pune \(confirmed\)/);
  });
});

describe('the report emails', () => {
  test('the daily briefing follows the PDF in short: at a glance, highlights with their source email, reminders, top 5', () => {
    const e = dailyEmail({ data: daily, appUrl: 'https://tracker.example' });
    assert.match(e.subject, /Daily Sales Briefing – 04 Oct 2026: 3 new enquiries, 1 PO, 39 overdue/);
    assert.match(e.text, /1\. AT A GLANCE\nNew enquiries: 3 \(Acme Steel; Beta Metals; Coreal\)/);
    assert.match(e.text, /Overdue \(over 7 days\): 39 \(12 invoices, 17 POs, 17 quotations\)/);
    assert.match(e.text, /2\. KEY HIGHLIGHTS\n1\. Client 0: .*\n {3}Action \/ owner: Send the revision \(Priya\)\n {3}Source email: https:\/\/outlook\.office\.com\/mail\/item\/0/);
    assert.match(e.text, /Reminders carried forward:\n- Visit: EcoVadis audit/);
    assert.match(e.text, /3\. ACTION ITEMS FOR TODAY \(TOP 5\)\n1\. Client 0: Raise the Advance invoice — PO-1000 · Advance \(5 d, ₹1 L; owner: Priya\)/);
    assert.match(e.text, /attached as a PDF/);
    assert.match(e.text, /USD 88 and EUR 103/);
    assert.match(e.html, /href="https:\/\/outlook\.office\.com\/mail\/item\/0"[^>]*>open in Outlook/);
    assert.match(e.html, /href="https:\/\/tracker\.example\/schedule\?visit=4"/);
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
