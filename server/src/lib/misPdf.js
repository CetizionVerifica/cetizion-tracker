/**
 * The Daily Sales Briefing and Weekly Sales MIS as PDFs
 * (docs/mis-reports-plan.md §3.5), built with pdfmake from
 * the figures misReports.js computed, on the same blocks and type as the
 * sales report PDF (pdfBlocks.js, pdfCharts.js). No browser, no images;
 * Roboto, the font every PDF here is set in, so ₹ prints.
 *
 *   dailyBriefingDoc(data, options)   the document definition
 *   weeklyMisDoc(data, options)
 *   misPdf(data, options)             either, as a Buffer
 *   misFileName(data)                 Daily_Sales_Briefing_YYYY-MM-DD.pdf /
 *                                     Sales_MIS_Report_28Sep-04Oct2026.pdf
 *
 * Where the AI has worded a section (data.commentary, misAi.js) that wording
 * is used; otherwise the one-sentence narrative the Reports page prints.
 * The weekly report's tables are capped with "+N more in the tracker", to
 * keep it to two pages of A4. The daily briefing follows the reference
 * format (docs/mis-briefing-fix-plan.md §3): its four sections, and every
 * pending row, over as many pages as they take.
 */
import pdfmake from './pdf.js';
import { COLORS, horizontalBars } from './pdfCharts.js';
import { INK, MARGIN_X, PDF_STYLES, dateLabel, generatedStamp, periodLabel, reportTable, rule, tile } from './pdfBlocks.js';
import { compactInr, money, number, plural } from './reportFormat.js';
import { windowNote } from './misWindow.js';
import { closingLine, dayParagraph, glanceRows, listNote, sourceLine } from './misBriefing.js';

export const MAX_ROWS = 12;
/** The weekly report's lists are shorter: eight sections share two pages. */
export const MAX_WEEKLY_ROWS = 6;
const MAX_OVERDUE_ROWS = 5;
const NAVY = '#0F3D5E';
const OVERDUE_FILL = '#fdecea';
const W = Math.floor(595.28 - MARGIN_X * 2);

const inr = (v) => (v == null ? 'not converted' : money(v, 'INR'));
const short = (v) => (v == null ? '—' : compactInr(v));
const days = (n) => `${number(n)} d`;
const trim = (s, n = 40) => (String(s ?? '').length > n ? `${String(s).slice(0, n - 1)}…` : String(s ?? ''));

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ddMon = (d) => { const [, m, day] = String(d).split('-'); return `${day}${MON[Number(m) - 1]}`; };

/** The attachment's name, as the routines named theirs. */
export function misFileName(data) {
  if (data.kind === 'daily_briefing') return `Daily_Sales_Briefing_${data.period.from}.pdf`;
  return `Sales_MIS_Report_${ddMon(data.period.from)}-${ddMon(data.period.to)}${data.period.to.slice(0, 4)}.pdf`;
}

export const REPORT_TITLE = { daily_briefing: 'Daily Sales Briefing', weekly_mis: 'Weekly Sales MIS Report' };

const words = (data, key) => data.commentary?.sections?.[key] || data.narrative?.[key] || null;

// ---------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------

function header(title, subtitle, company) {
  return {
    table: {
      widths: ['*'],
      body: [[{
        stack: [
          { text: company.toUpperCase(), style: 'brandTag' },
          { text: title, style: 'title' },
          { text: subtitle, style: 'subtitle' },
        ],
        fillColor: NAVY, margin: [18, 14, 18, 14],
      }]],
    },
    layout: 'noBorders',
  };
}

function tiles(items) {
  const rows = [];
  for (let i = 0; i < items.length; i += 4) rows.push(items.slice(i, i + 4).map(([v, l, m]) => ({ ...tile(v, l, m), margin: [8, 5, 8, 5] })));
  while (rows.at(-1).length < 4) rows.at(-1).push({ text: '' });
  return {
    table: { widths: ['*', '*', '*', '*'], body: rows },
    layout: {
      hLineWidth: () => 0.6, vLineWidth: () => 0.6, hLineColor: () => INK[200], vLineColor: () => INK[200],
      fillColor: () => '#f7f9fc', paddingLeft: () => 0, paddingRight: () => 0, paddingTop: () => 0, paddingBottom: () => 0,
    },
    margin: [0, 8, 0, 8],
  };
}

const h2 = (text) => ({ text, style: 'h2' });
const more = (total, cap = MAX_ROWS) => (total > cap ? { text: `+${number(total - cap)} more in the tracker.`, style: 'lead', margin: [0, 3, 0, 0] } : null);

/** A pending table (§3.1): client, reference, amount, since, days, owner, next action; Overdue rows shaded. */
function pendingTable(section, { empty, cap = MAX_ROWS }) {
  const rows = section.rows.slice(0, cap);
  const shade = (row, content) => ({ text: content ?? '—', ...(row.overdue ? { fillColor: OVERDUE_FILL } : {}) });
  return [
    reportTable({
      compact: true,
      fontSize: 7.5,
      columns: [
        { header: 'Client', value: (r) => shade(r, trim(r.client, 28)), width: 92 },
        { header: 'Reference', value: (r) => shade(r, trim(r.reference, 34)), width: '*' },
        { header: 'Amount (₹)', value: (r) => shade(r, r.amount_inr == null ? (r.amount == null ? '—' : 'no rate') : short(r.amount_inr)), align: 'right', width: 62 },
        { header: 'Since', value: (r) => shade(r, r.since ? dateLabel(r.since).slice(0, 6) : '—'), width: 44 },
        { header: 'Days', value: (r) => shade(r, r.overdue ? `${number(r.days)} ⚠` : number(r.days)), align: 'right', width: 36 },
        { header: 'Owner', value: (r) => shade(r, trim(r.owner || '—', 14)), width: 60 },
        { header: 'Next action', value: (r) => shade(r, trim(r.next_action, 38)), width: 110 },
      ],
      rows,
      empty,
    }),
    more(section.rows.length, cap),
    section.unconverted ? { text: `${plural(section.unconverted, 'amount')} could not be converted to ₹ (no exchange rate for the date).`, style: 'lead', margin: [0, 2, 0, 0] } : null,
  ].filter(Boolean);
}

const fxNote = { text: 'Converted at the exchange rate on each record\'s date (ECB). Earlier reports used fixed rates of USD 88 and EUR 103.', style: 'small', margin: [0, 10, 0, 0] };

function docShell({ title, periodText, company, generatedAt, timeZone, content, info, footnote = null, footerText = null }) {
  return {
    pageSize: 'A4',
    pageOrientation: 'portrait',
    pageMargins: [MARGIN_X, 34, MARGIN_X, 40],
    info: { title: `${company} ${title} — ${periodText}`, author: 'Cetizion Tracker', subject: info, creator: 'Cetizion Tracker' },
    defaultStyle: { font: 'Roboto', fontSize: 8, color: INK[900], lineHeight: 1.15 },
    header: (page) => (page === 1 ? { text: '' } : {
      columns: [
        { text: `${company.toUpperCase()}  ·  ${title.toUpperCase()}`, style: 'runningHead' },
        { text: periodText, style: 'runningHead', alignment: 'right' },
      ],
      margin: [MARGIN_X, 20, MARGIN_X, 0],
    }),
    // The footnote (the exchange-rate note, the data notes) is said once,
    // at the foot of the first page, so it costs the body no room.
    // footerText, when given, replaces the generated stamp on every page.
    footer: (page, pages) => ({
      stack: [
        page === 1 && footnote ? { text: footnote, style: 'footer', margin: [0, 0, 0, 2] } : null,
        {
          columns: [
            { text: footerText || `Generated ${generatedStamp(generatedAt, timeZone)}  ·  ${company}, confidential`, style: 'footer' },
            { text: `Page ${page} of ${pages}`, style: 'footer', alignment: 'right', ...(footerText ? { width: 60 } : {}) },
          ],
        },
      ].filter(Boolean),
      margin: [MARGIN_X, 8, MARGIN_X, 0],
    }),
    content: content.filter(Boolean),
    styles: { ...PDF_STYLES, h1: { ...PDF_STYLES.h1, color: NAVY }, h2: { ...PDF_STYLES.h2, color: NAVY, margin: [0, 10, 0, 3] }, tileValue: { ...PDF_STYLES.tileValue, color: NAVY, fontSize: 15 } },
  };
}

// ---------------------------------------------------------------------
// Daily Sales Briefing: the reference's four sections, and every pending
// row (docs/mis-briefing-fix-plan.md §3)
// ---------------------------------------------------------------------

const RED = '#b42318';
const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const weekday = (d) => WEEKDAY[new Date(`${d}T00:00:00Z`).getUTCDay()];

/** A link the reader can open: Outlook's are whole; a tracker path needs the app's address, and is plain text without it. */
const href = (appUrl, path) => (!path ? null : /^https?:/i.test(path) ? path : appUrl ? `${appUrl}${path}` : null);
const linked = (text, url) => (url ? { text, link: url, color: COLORS.blue, decoration: 'underline' } : { text });

/** In ₹ when converted, in its own currency when there was no rate, "not stated" when there is no amount. */
const amountOf = (r) => (r.amount_inr != null ? short(r.amount_inr) : r.amount != null ? money(r.amount, r.currency || 'INR') : 'not stated');

const heading = (no, title) => [
  { text: [{ text: `${no}.`, color: COLORS.blue }, `  ${title}`], style: 'h1', margin: [0, 14, 0, 0] },
  rule([0, 3, 0, 5]),
];
const subheading = (text) => ({ text, bold: true, fontSize: 8.5, color: INK[700], margin: [0, 7, 0, 3] });
const closing = (text) => ({ text, style: 'lead', italics: true, margin: [0, 3, 0, 0] });

/**
 * A pending table as the reference has it: every row, the overdue ones in
 * red. A row reconciled with Finance's list carries its note beside the
 * reference; a row only on the list links to the list's email.
 */
function briefingTable(section, { empty, appUrl, grandTotal = false, totalLabel = 'Grand total', daysOf = (r) => r.days }) {
  const red = (row, content, extra = {}) => ({ text: content ?? '—', ...(row.overdue ? { color: RED, fillColor: OVERDUE_FILL } : {}), ...extra });
  return [
    reportTable({
      compact: true,
      fontSize: 7,
      columns: [
        { header: 'Client', value: (r) => red(r, r.client), width: 74, totalLabel },
        { header: 'Reference', value: (r) => red(r, r.note ? `${r.reference} (${r.note})` : r.reference), width: '*' },
        { header: 'Amount', value: (r) => red(r, amountOf(r)), align: 'right', width: 54, total: (t) => t },
        { header: 'Last activity', value: (r) => red(r, r.last_activity ? dateLabel(r.last_activity).slice(0, 6) : '—'), width: 40 },
        { header: 'Days', value: (r) => red(r, daysOf(r) == null ? '—' : number(daysOf(r)), r.overdue ? { bold: true } : {}), align: 'right', width: 26 },
        { header: 'Owner', value: (r) => red(r, r.owner || '—'), width: 48 },
        { header: 'Next action', value: (r) => red(r, r.next_action), width: 90 },
        { header: 'Email', value: (r) => { const url = href(appUrl, r.email_link); return url ? { ...linked(r.source === 'list' ? 'list' : 'Open', url), ...(r.overdue ? { fillColor: OVERDUE_FILL } : {}) } : red(r, '—'); }, width: 28 },
      ],
      rows: section.rows,
      total: grandTotal && section.rows.length ? short(section.value_inr) : undefined,
      empty,
    }),
    section.unconverted ? { text: `${plural(section.unconverted, 'amount')} had no exchange rate for its date: shown in its own currency${grandTotal ? ', and left out of the total' : ''}.`, style: 'lead', margin: [0, 2, 0, 0] } : null,
  ].filter(Boolean);
}

/** One highlight: what happened, the action and owner, the source email, earlier emails. */
function highlightItem(h, appUrl) {
  const label = (text) => ({ text, bold: true, color: INK[700] });
  const outlook = /^https?:/i.test(h.web_link || '');
  const source = href(appUrl, h.web_link) ? linked(outlook ? 'open in Outlook' : 'open in the Inbox', href(appUrl, h.web_link))
    : href(appUrl, h.link) ? linked('open the record', href(appUrl, h.link)) : { text: 'not linked', color: INK[500] };
  return {
    stack: [
      { text: [{ text: `${h.client}: `, bold: true }, h.summary] },
      h.action ? { text: [label('Action / owner: '), `${h.action}${h.owner ? ` (${h.owner})` : ''}`], margin: [0, 1, 0, 0] } : null,
      { text: [label('Source email: '), source], margin: [0, 1, 0, 0] },
      h.related?.length ? {
        stack: [label('Related earlier emails:'), { ul: h.related.map((r) => linked(`${dateLabel(r.day).slice(0, 6)} · ${r.from} · ${r.subject}`, href(appUrl, r.link))) }],
        margin: [0, 1, 0, 0],
      } : null,
    ].filter(Boolean),
    margin: [0, 0, 0, 5],
  };
}

export function dailyBriefingDoc(data, { company = 'Cetizion Verifica', generatedAt = new Date(), timeZone = 'Asia/Kolkata' } = {}) {
  const day = dateLabel(data.period.from);
  const appUrl = data.app_url || '';
  const highlights = data.highlights || [];
  const actions = data.top_actions || [];
  const reminders = data.reminders || [];
  const p = data.pending;
  const t = data.invoice_tables;
  const boxes = (data.mailboxes?.read || []).map((b) => b.email);
  const content = [
    header(REPORT_TITLE.daily_briefing, `${weekday(data.period.from)}, ${day}`, company),
    { text: `Generated ${generatedStamp(generatedAt, timeZone)}  ·  Source: ${sourceLine(data.mailboxes, timeZone)}`, style: 'lead', margin: [0, 6, 0, 0] },
    { text: dayParagraph(data), style: 'body', margin: [0, 4, 0, 0] },

    ...heading(1, 'At a glance'),
    reportTable({
      fontSize: 8,
      columns: [
        { header: 'Metric', value: (r) => ({ text: r.metric, bold: true }), width: 120 },
        { header: 'Count', value: (r) => r.count, align: 'right', width: 70 },
        { header: 'Detail', value: (r) => r.detail || '—', width: '*' },
      ],
      rows: glanceRows(data, { money: short }),
    }),

    ...heading(2, 'Key highlights'),
    highlights.length
      ? { ol: highlights.map((h) => highlightItem(h, appUrl)), style: 'body' }
      : { text: `Nothing to highlight from the mail of ${day}.`, style: 'empty' },
    data.mail_window ? { text: windowNote(data.mail_window), style: 'lead' } : null,
    subheading('Reminders carried forward'),
    reminders.length
      ? { ul: reminders.map((r) => linked(r.text, href(appUrl, r.link))), style: 'body' }
      : { text: 'No visit or meeting in the next three days, and no PO waiting to be registered.', style: 'empty' },

    ...heading(3, 'Pending tasks'),
    {
      text: `Days are counted to today: an invoice to raise from its milestone, delivery or PO date; a receivable from its invoice date, as Finance ages it, and red once more than ${data.overdue_days} days past its due date; a PO from the client's yes; a quotation from when it was sent or last followed up; an enquiry from when it came in. Overdue means waiting more than ${data.overdue_days} days; overdue rows are in red. Last activity is the latest email on the record.`,
      style: 'lead',
    },
    h2(`(a) Invoices (${number(p.invoices.count)})`),
    subheading(`Invoice actions: read from email, to check (${number(t.actions.count)})`),
    ...briefingTable(t.actions, { appUrl, empty: 'Nothing to check.' }),
    subheading(`Pending for invoicing (${number(t.to_raise.count)})`),
    ...briefingTable(t.to_raise, { appUrl, empty: 'Nothing to invoice.' }),
    subheading(`Receivables: sundry debtors (${number(t.receivables.count)})`),
    ...briefingTable(t.receivables, { appUrl, grandTotal: true, totalLabel: t.list && !t.list.rejected ? 'Grand total (tracker)' : 'Grand total', daysOf: (r) => r.age ?? r.days, empty: 'Nothing outstanding.' }),
    { text: listNote(t.list, { money: short }), style: 'lead', margin: [0, 3, 0, 0] },
    closing(closingLine('invoices', data)),
    h2(`(b) POs (${number(p.pos.count)})`),
    ...briefingTable(p.pos, { appUrl, empty: 'No quotation is waiting for its PO.' }),
    closing(closingLine('pos', data)),
    h2(`(c) Quotations (${number(p.quotations.count)})`),
    ...briefingTable(p.quotations, { appUrl, empty: 'Every enquiry is quoted and every quotation answered.' }),
    closing(closingLine('quotations', data)),

    ...heading(4, 'Action items for today (top 5)'),
    actions.length
      ? {
        ol: actions.map((a) => ({
          text: [
            { text: `${a.client}: `, bold: true }, a.wording || `${a.next_action} — ${a.reference}`,
            { text: `  (${days(a.days)}${a.amount_inr != null ? `, ${short(a.amount_inr)}` : ''}; owner: ${a.owner || 'not set'})  `, color: INK[500] },
            linked('open', href(appUrl, a.email_link || a.link)),
          ],
        })),
        style: 'body',
      }
      : { text: 'Nothing is pending.', style: 'empty' },
    fxNote,
  ];
  const footerText = `Prepared automatically from the ${boxes.length ? `${boxes.join(', ')} mailbox${boxes.length === 1 ? '' : 'es'}` : 'shared mailboxes'} and the tracker's records  ·  ${REPORT_TITLE.daily_briefing}, ${day}`;
  return docShell({ title: REPORT_TITLE.daily_briefing, periodText: day, company, generatedAt, timeZone, content, info: `For ${day}`, footerText });
}

// ---------------------------------------------------------------------
// Weekly Sales MIS
// ---------------------------------------------------------------------

export function weeklyMisDoc(data, { company = 'Cetizion Verifica', generatedAt = new Date(), timeZone = 'Asia/Kolkata' } = {}) {
  const periodText = periodLabel(data.period);
  const converted = data.outcomes.slices.find((s) => s.key === 'converted');
  const headline = data.commentary?.headline?.length ? data.commentary.headline : [
    data.narrative?.enquiries, data.narrative?.outcomes, data.narrative?.revenue, data.narrative?.customers,
  ].filter(Boolean);
  const serviceChart = horizontalBars({
    items: data.services.rows.filter((r) => r.value_inr > 0).slice(0, 5).map((r, i) => ({
      label: r.line, value: r.value_inr, valueLabel: `${compactInr(r.value_inr)} · ${number(r.pos)} PO${r.pos === 1 ? '' : 's'}`,
      color: r.other ? COLORS.pale : [COLORS.navy, COLORS.blue][i] ?? COLORS.sky,
    })),
    width: W, labelWidth: 150, valueWidth: 120, rowHeight: 13, formatAxis: (v) => compactInr(v),
  });
  const sec = (no, title, key) => [
    { text: [{ text: `${no}.`, color: COLORS.blue }, `  ${title}`], style: 'h1', fontSize: 11.5, margin: [0, 7, 0, 0] },
    rule([0, 2, 0, 3]),
    words(data, key) ? { text: words(data, key), style: 'body', margin: [0, 0, 0, 3] } : null,
  ];
  const enquiryRows = data.enquiries.rows.slice(0, MAX_WEEKLY_ROWS);
  const poRows = data.pos.slice(0, MAX_WEEKLY_ROWS);
  const kv = (pairs) => reportTable({
    compact: true, fontSize: 7,
    columns: [
      { header: 'Measure', value: (r) => r[0], width: 150 }, { header: 'This week', value: (r) => r[1], align: 'right', width: 110 }, { header: '', value: (r) => r[2] || '', width: '*' },
    ],
    rows: pairs,
  });
  const b = data.billing;
  const rec = data.receivables;
  const sp = data.speed;
  const mtd = `${dateLabel(data.month_to_date.from).slice(3)} to date`;
  const hours = (h) => (h == null ? '—' : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} d`);

  const content = [
    header(REPORT_TITLE.weekly_mis, `Week of ${periodText}`, company),
    tiles([
      [number(data.enquiries.total), 'Enquiries', `${number(data.enquiries.month_to_date)} ${mtd.toLowerCase()}`],
      [`${number(data.revenue.total.pos)} · ${short(data.revenue.total.po_value_inr)}`, 'POs received', 'incl. GST, by PO date'],
      [converted?.pct == null ? '—' : `${converted.pct}%`, 'Enquiry → PO', `${number(converted?.count ?? 0)} of ${number(data.outcomes.total)} converted`],
      [`${short(rec.outstanding_inr)} · ${short(rec.over_90.amount_inr)}`, 'Receivables · over 90 days', `${number(rec.over_90.count)} invoice${rec.over_90.count === 1 ? '' : 's'} over 90 days`],
    ]),
    headline.length ? { ul: headline.map((t) => ({ text: t })), style: 'body' } : null,

    ...sec(1, 'Enquiries received', 'enquiries'),
    { text: [
      { text: 'Per day: ', bold: true },
      data.enquiries.per_day.map((d) => `${d.label} ${number(d.enquiries)}`).join('  ·  '),
      { text: `    Week ${number(data.enquiries.total)}  ·  ${mtd} ${number(data.enquiries.month_to_date)}`, bold: true },
    ], style: 'small', margin: [0, 0, 0, 4] },
    reportTable({
      compact: true, fontSize: 7,
      columns: [
        { header: 'Date', value: (r) => dateLabel(r.date).slice(0, 6), width: 40 },
        { header: 'Client', value: (r) => trim(r.client, 26), width: '*' },
        { header: 'Country', value: (r) => trim(r.country || '—', 12), width: 50 },
        { header: 'Sector', value: (r) => trim(r.sector || '—', 16), width: 62 },
        { header: 'Service', value: (r) => trim(r.service || '—', 20), width: 76 },
        { header: 'Source', value: (r) => trim(r.source || '—', 14), width: 56 },
        { header: 'First response', value: (r) => hours(r.first_response_hours), align: 'right', width: 56 },
      ],
      rows: enquiryRows,
      empty: 'No enquiries this week.',
    }),
    more(data.enquiries.rows.length, MAX_WEEKLY_ROWS),
    { text: `First response: from the enquiry (or its first email) to our first reply; median ${hours(data.enquiries.tat.median_hours)}. ${number(data.enquiries.tat.without_tat)} of ${number(data.enquiries.total)} had none recorded, including enquiries made from our own quotation or PO email.`, style: 'lead', margin: [0, 3, 0, 0] },

    ...sec(2, 'Enquiry status', 'outcomes'),
    reportTable({
      compact: true,
      columns: [
        { header: 'Outcome', value: (r) => r.label },
        { header: 'Enquiries', value: (r) => number(r.count), total: (t) => number(t.count), align: 'right', width: 60 },
        { header: 'Share', value: (r) => `${r.pct}%`, total: () => '100%', align: 'right', width: 50 },
        { header: 'Accounts', value: (r) => trim(data.outcomes.detail.filter((d) => d.outcome === r.key).map((d) => d.client).join(', '), 70), width: 250 },
      ],
      rows: data.outcomes.slices,
      total: { count: data.outcomes.total },
      empty: 'No enquiries this week.',
    }),

    ...sec(3, 'Sector-wise POs', 'sectors'),
    reportTable({
      compact: true,
      columns: [
        { header: 'Sector', value: (r) => r.sector },
        { header: 'POs', value: (r) => number(r.pos), total: (t) => number(t.pos), align: 'right', width: 50 },
        { header: 'PO value (₹)', value: (r) => inr(r.value_inr), total: (t) => inr(t.value_inr), align: 'right', width: 100 },
      ],
      rows: data.sectors.rows.filter((r) => r.pos),
      total: data.sectors.total,
      empty: 'No POs this week.',
    }),

    ...sec(4, 'Service-wise sales', 'services'),
    serviceChart ? { svg: serviceChart.svg, width: serviceChart.width, margin: [0, 2, 0, 6] } : { text: 'No PO value this week.', style: 'empty' },

    ...sec(5, 'Customer analysis', 'customers'),
    reportTable({
      compact: true, fontSize: 7,
      columns: [
        { header: 'PO date', value: (r) => dateLabel(r.po_date).slice(0, 6), width: 40 },
        { header: 'Client', value: (r) => trim(r.customer || r.client, 26), width: '*' },
        { header: 'Country', value: (r) => trim(r.country || '—', 12), width: 50 },
        { header: 'Service', value: (r) => trim(r.service || '—', 22), width: 90 },
        { header: 'Value (₹)', value: (r) => inr(r.po_value_inr), align: 'right', width: 80 },
        { header: 'Client type', value: (r) => (r.repeat ? 'Repeat' : 'New'), width: 50 },
      ],
      rows: poRows,
      empty: 'No POs this week.',
    }),
    more(data.pos.length, MAX_WEEKLY_ROWS),

    ...sec(6, 'Revenue: invoiced and received', 'revenue'),
    reportTable({
      compact: true,
      columns: [
        { header: '', value: (r) => r.label },
        { header: 'Invoices', value: (r) => number(r.invoices), align: 'right', width: 60 },
        { header: 'Invoiced (₹)', value: (r) => inr(r.invoiced_inr), align: 'right', width: 100 },
        { header: 'Payments', value: (r) => number(r.payments), align: 'right', width: 60 },
        { header: 'Received (₹)', value: (r) => inr(r.received_inr), align: 'right', width: 100 },
      ],
      rows: [{ label: 'This week', ...b.week }, { label: mtd, ...b.month_to_date }],
    }),

    ...sec(7, 'Pending and overdue follow-ups', 'pending'),
    kv([
      ['Receivables over 90 days', `${short(rec.over_90.amount_inr)} · ${number(rec.over_90.count)} invoices`, `oldest ${rec.oldest_days ?? 0} d${rec.largest ? ` · largest ${trim(rec.largest.company, 24)}` : ''} · ${short(rec.outstanding_inr)} outstanding in all`],
      ['Pending invoices', `${number(data.pending.invoices.count)} · ${short(data.pending.invoices.value_inr)}`, `${number(data.pending.invoices.overdue)} overdue`],
      ['Pending POs', `${number(data.pending.pos.count)} · ${short(data.pending.pos.value_inr)}`, `${number(data.pending.pos.overdue)} overdue`],
      ['Pending quotations', `${number(data.pending.quotations.count)} · ${short(data.pending.quotations.value_inr)}`, `${number(data.pending.quotations.overdue)} overdue · ${number(data.follow_ups_overdue.count)} quotation follow-ups overdue`],
    ]),
    { text: `Overdue items, worst first (pending more than ${data.overdue_days} days)`, style: 'lead', margin: [0, 4, 0, 2] },
    ...pendingTable({ rows: [...data.pending.invoices.rows, ...data.pending.pos.rows, ...data.pending.quotations.rows].filter((r) => r.overdue).sort((x, y) => y.score - x.score), unconverted: 0 }, { empty: `Nothing has waited more than ${data.overdue_days} days.`, cap: MAX_OVERDUE_ROWS }),

    ...sec(8, 'Conversion and speed', 'speed'),
    kv([
      ['Enquiry → PO', sp.enquiry_to_po_pct == null ? '—' : `${sp.enquiry_to_po_pct}%`, 'this week\'s enquiries converted by the week\'s end'],
      ['Quote → contract', sp.quote_to_contract_pct == null ? '—' : `${sp.quote_to_contract_pct}%`, `${number(sp.won)} won, ${number(sp.lost)} lost this week`],
      ['Average PO ticket', short(sp.average_po_ticket_inr), `${short(sp.pipeline.average_ticket_inr)} average open quotation`],
      ['Open pipeline', `${short(sp.pipeline.value_inr)} · ${short(sp.pipeline.weighted_inr)} weighted`, `${number(sp.pipeline.count)} open quotations`],
      ['Speed (medians)', `${hours(sp.enquiry_tat_median_hours)} · ${sp.quote_to_po_days_median == null ? '—' : days(sp.quote_to_po_days_median)}`, `enquiry to our first reply · quotation sent to PO (${number(sp.quote_to_po_sample)} PO${sp.quote_to_po_sample === 1 ? '' : 's'})`],
    ]),
  ];
  const footnote = `${fxNote.text}${data.notes?.length ? ` Data notes: ${data.notes.map((n) => n.text).join(' ')}` : ''}`;
  return docShell({ title: REPORT_TITLE.weekly_mis, periodText, company, generatedAt, timeZone, content, info: `Week of ${periodText}`, footnote });
}

/** Either report, as a Buffer. */
export function misPdf(data, options) {
  const doc = data.kind === 'daily_briefing' ? dailyBriefingDoc(data, options) : weeklyMisDoc(data, options);
  return pdfmake.createPdf(doc).getBuffer();
}

/** How many pages a PDF buffer has (for tests and the run record). */
export const pdfPageCount = (buffer) => (buffer.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
