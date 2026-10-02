import pdfmake from './pdf.js';
import { MONTH_NAMES, amounts, compactInr, decimal, money, number, percent, plural } from './reportFormat.js';
import { share } from './reportMath.ts';
import { ENQUIRY_STATUS, QUOTATION_STATUS } from './statuses.js';
import { COLORS, donut, horizontalBars, stackedColumns } from './pdfCharts.js';
import {
  clientAnalysis, daysBetween, enquiryAnalysis, headline, managementFixes, quotationStatusAnalysis, revenueAnalysis,
  sectorAnalysis, serviceAnalysis,
} from './salesReviewAnalysis.js';

// CLIENT_TYPES.repeat in salesReport.js, which this file does not import: it pulls in the database.
const REPEAT_CLIENT = 'Repeat client';

/**
 * The Sales & Enquiry Performance Review: an A4 portrait management report
 * with charts and a written analysis, built on the server from the same data
 * as the Sales reports page. Nothing is stored and no outside service is used.
 */

export { money };

const { navy: NAVY, blue: BLUE, sky: SKY, green: GREEN, gold: GOLD, red: RED } = COLORS;
export const INK = { 900: '#0f172a', 700: '#334155', 500: '#64748b', 200: '#e2e8f0', 50: '#f8fafc' };
const INK_900 = '#0f172a';
const INK_700 = '#334155';
const INK_500 = '#64748b';
const INK_200 = '#e2e8f0';
const INK_50 = '#f8fafc';
const NAVY_50 = '#eef2f8';
const WARN_FG = '#b45309';
const TONES = {
  good: { bar: GREEN, fg: GREEN, bg: '#eef6f1' },
  watch: { bar: GOLD, fg: '#8a6414', bg: '#fbf6e9' },
  risk: { bar: RED, fg: RED, bg: '#fbefec' },
  action: { bar: BLUE, fg: BLUE, bg: '#edf3f9' },
  note: { bar: INK_500, fg: INK_700, bg: INK_50 },
};

export const MARGIN_X = 42;
const W = Math.floor(595.28 - MARGIN_X * 2); // A4 portrait less the side margins
const WON = QUOTATION_STATUS.won;
const MONTHS = MONTH_NAMES;

// ---------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------

export function dateLabel(value) {
  if (!value) return '—';
  const [y, m, d] = String(value).slice(0, 10).split('-');
  return `${d} ${MONTHS[Number(m) - 1]} ${y}`;
}

export function periodLabel({ from, to } = {}) {
  if (from && to) return `${dateLabel(from)} – ${dateLabel(to)}`;
  if (from) return `From ${dateLabel(from)}`;
  if (to) return `Up to ${dateLabel(to)}`;
  return 'All time';
}

/** A time zone the viewer's browser sent, if Intl knows it; UTC otherwise. */
export function reportTimeZone(value) {
  const tz = String(value ?? '').trim();
  if (!tz || tz.length > 64) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

export function generatedStamp(date, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone, day: '2-digit', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(date).map((part) => [part.type, part.value])
  );
  return `${parts.day} ${MONTHS[Number(parts.month) - 1]} ${parts.year}, ${parts.hour}:${parts.minute} (${timeZone})`;
}

const dateIn = (date, timeZone) =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);

/** "Sep" when every month is in one year, "Sep ’26" otherwise. */
function shortMonths(months) {
  const years = new Set(months.filter((m) => m.month).map((m) => m.month.slice(0, 4)));
  return months.map((m) => {
    if (!m.month) return 'No date';
    const name = MONTHS[Number(m.month.slice(5, 7)) - 1];
    return years.size <= 1 ? name : `${name} ’${m.month.slice(2, 4)}`;
  });
}

// ---------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------

const TABLE_LAYOUT = {
  hLineWidth: (i, node) => (i === 0 || i === node.table.body.length ? 0 : i === node.table.headerRows ? 0.8 : 0.4),
  vLineWidth: () => 0,
  hLineColor: (i, node) => (i === node.table.headerRows ? NAVY : INK_200),
  fillColor: (row, node) => (row < node.table.headerRows ? NAVY : row % 2 === 0 ? INK_50 : null),
  paddingLeft: () => 5,
  paddingRight: () => 5,
  paddingTop: () => 3.5,
  paddingBottom: () => 3.5,
};

const note = (text, style = 'cellNote') => ({ text, style });

/** A cell with a main line and optional small lines under it. */
const lines = (main, ...notes) => {
  const extra = notes.filter(Boolean);
  return extra.length ? { stack: [{ text: main }, ...extra] } : main;
};

/**
 * A report table: navy header, zebra rows, right-aligned figures and an
 * optional bold Total row. column.value(row) and column.total(total) return
 * a string or a pdfmake node.
 */
export function reportTable({ columns, rows, total, empty = '', fontSize = 8, compact = false }) {
  if (!rows.length) return { text: empty, style: 'empty' };
  const cell = (content, col) =>
    content !== null && typeof content === 'object'
      ? { alignment: col.align || 'left', ...content }
      : { text: content ?? '—', alignment: col.align || 'left' };

  const body = [
    columns.map((col) => ({ text: col.header, style: 'th', alignment: col.align || 'left', ...(compact ? { fontSize: 7 } : {}) })),
    ...rows.map((row) => columns.map((col) => cell(col.value(row), col))),
  ];
  if (total) {
    body.push(columns.map((col, i) => ({
      ...cell(i === 0 ? (col.totalLabel ?? 'Total') : col.total ? col.total(total) : '', col),
      bold: true,
      fillColor: NAVY_50,
    })));
  }
  return {
    table: { headerRows: 1, dontBreakRows: true, widths: columns.map((col) => col.width ?? '*'), body },
    layout: compact ? { ...TABLE_LAYOUT, paddingLeft: () => 3, paddingRight: () => 3 } : TABLE_LAYOUT,
    fontSize,
  };
}

export const rule = (margin = [0, 3, 0, 7]) => ({
  canvas: [{ type: 'line', x1: 0, y1: 0, x2: W, y2: 0, lineWidth: 0.8, lineColor: INK_200 }],
  margin,
});

/** A numbered section. Its heading, lead and first block stay on one page. */
export function section(no, title, lead, first = []) {
  return {
    stack: [
      { text: [{ text: `${no}.`, color: BLUE }, `  ${title}`], style: 'h1' },
      rule(),
      lead ? { text: lead, style: 'body' } : null,
      ...first,
    ].filter(Boolean),
    unbreakable: true,
    margin: [0, 16, 0, 0],
  };
}

/** Keep a sub-heading on the same page as a short table under it. */
function subsection(title, lead, content, rowCount) {
  const block = [{ text: title, style: 'h2' }, lead ? { text: lead, style: 'lead' } : null, content].filter(Boolean);
  return rowCount <= 14 ? { stack: block, unbreakable: true } : { stack: block };
}

export function figure(no, caption, chart, emptyText) {
  if (!chart) return { text: emptyText, style: 'empty' };
  return {
    stack: [{ svg: chart.svg, width: chart.width }, { text: `Figure ${no} — ${caption}`, style: 'caption' }],
    unbreakable: true,
    margin: [0, 4, 0, 8],
  };
}

/** A coloured analysis box: TAG and the finding, as in a management review. */
export function callout({ tag, tone, text }) {
  const c = TONES[tone] ?? TONES.note;
  return {
    table: {
      widths: ['*'],
      body: [[{
        text: [{ text: `${tag}   `, bold: true, color: c.fg, fontSize: 7.5, characterSpacing: 0.5 }, { text, color: INK_900 }],
        fillColor: c.bg,
        margin: [10, 6, 10, 6],
        fontSize: 8.5,
        lineHeight: 1.3,
      }]],
    },
    layout: {
      hLineWidth: () => 0,
      vLineWidth: (i) => (i === 0 ? 3 : 0),
      vLineColor: () => c.bar,
      paddingLeft: () => 0,
      paddingRight: () => 0,
      paddingTop: () => 0,
      paddingBottom: () => 0,
    },
    unbreakable: true,
    margin: [0, 0, 0, 6],
  };
}

const insightsBlock = (insights) => (insights.length ? { stack: insights.map(callout), margin: [0, 2, 0, 0] } : null);

/** A two-column "Measure | Value" table. */
const measureTable = (rows) =>
  reportTable({
    columns: [
      { header: 'Measure', value: (r) => r[0] },
      { header: 'Value', value: (r) => r[1], align: 'right', width: 90 },
    ],
    rows,
  });

export function tile(value, label, meta) {
  return {
    stack: [
      { text: value, style: 'tileValue' },
      { text: label, style: 'tileLabel' },
      meta ? { text: meta, style: 'tileMeta' } : null,
    ].filter(Boolean),
    margin: [10, 8, 10, 8],
  };
}

/** The review's type styles, shared with the Reports section's PDF (reportPdf.js). */
export const PDF_STYLES = {
    brandTag: { fontSize: 7.5, bold: true, color: '#c9dbf0', characterSpacing: 1.2 },
    title: { fontSize: 21, bold: true, color: '#ffffff', margin: [0, 4, 0, 4] },
    subtitle: { fontSize: 8.5, color: '#dbe5f2' },
    kicker: { fontSize: 8, bold: true, color: BLUE, characterSpacing: 1.2, margin: [0, 12, 0, 5] },
    h1: { fontSize: 13.5, bold: true, color: NAVY },
    h2: { fontSize: 9.5, bold: true, color: NAVY, margin: [0, 12, 0, 3] },
    chartTitle: { fontSize: 8.5, bold: true, color: NAVY, margin: [96, 0, 0, 4] },
    body: { fontSize: 9, color: INK_700, lineHeight: 1.35, margin: [0, 0, 0, 6] },
    lead: { fontSize: 7.5, color: INK_500, margin: [0, 0, 0, 5] },
    caption: { fontSize: 7.5, italics: true, color: INK_500, margin: [0, 3, 0, 0] },
    small: { fontSize: 7.5, color: INK_500, lineHeight: 1.3 },
    th: { bold: true, color: '#ffffff', fontSize: 7.5 },
    cellNote: { fontSize: 6.5, color: INK_500 },
    warnNote: { fontSize: 6.5, color: WARN_FG },
    tileValue: { fontSize: 17, bold: true, color: NAVY },
    tileLabel: { fontSize: 7.5, bold: true, color: INK_700, margin: [0, 2, 0, 0] },
    tileMeta: { fontSize: 7, color: INK_500, margin: [0, 1, 0, 0] },
    runningHead: { fontSize: 7, color: INK_500, characterSpacing: 0.4 },
    footer: { fontSize: 7, color: INK_500 },
    empty: { fontSize: 8, italics: true, color: INK_500, margin: [0, 2, 0, 8] },
};

// ---------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------

export function salesReportDocDefinition(data) {
  const {
    period = {}, sectors, customers, fx, revenue, enquiries, quotationStatus, services, contracts, gaps,
    rates = {}, generatedAt = new Date(), timeZone = 'UTC',
  } = data;

  const stamp = generatedStamp(generatedAt, timeZone);
  const today = dateIn(generatedAt, timeZone);
  const periodText = periodLabel(period);
  // Every section, revenue included, covers the same period now — there is
  // no separate year/month picker for revenue any more, and no second phrase
  // for it either, so the report never reads "All time" in one place and
  // "all dates" in another for the same thing.
  const revenueLabel = periodText;

  // Sector won value in INR. Converted in SQL at the rate in force on each
  // quotation's own date, the same lookup every other figure here uses.
  // Quotations, one each: phase POs on one quotation are one deal won, and a
  // quotation marked won with no PO registered still counts.
  const quotationCount = (s) => s.won_deals + s.lost + s.pipeline + s.won_without_po;
  const sectorRows = sectors.rows.map((row) => ({ ...row, quotations: quotationCount(row) }));
  const sectorTotal = { ...sectors.summary, quotations: quotationCount(sectors.summary) };

  // Exchange rates the figures used, and any currency left unconverted.
  const quotationUnconverted = quotationStatus.total.unconverted ?? [];
  const used = new Set([
    ...sectors.summary.amounts.map((a) => a.currency),
    ...quotationUnconverted.map((a) => a.currency),
    ...(revenue.rates ?? []).map((r) => r.currency),
  ]);
  used.delete('INR');
  const missingRates = [...new Set([
    ...fx.summary.missing_rates,
    ...sectorTotal.unconverted.map((a) => a.currency),
    ...customers.summary.total.unconverted.map((a) => a.currency),
    ...quotationUnconverted.map((a) => a.currency),
    ...revenue.orders.total.order_unconverted.map((a) => a.currency),
    ...revenue.invoicing.total.missing_rates,
  ])].sort();
  // Currencies whose newest rate is itself days old (lib/fx.ts), from both
  // halves of the report, each named once: the web page's banner, in print.
  const staleRates = [...new Map(
    [...(fx.summary.stale_rates ?? []), ...(revenue.stale_rates ?? [])].map((r) => [r.currency, r])
  ).values()].sort((a, b) => a.currency.localeCompare(b.currency));
  const staleCurrencies = new Set(staleRates.map((r) => r.currency));

  // Each figure is converted at the rate in force on its own date; this line
  // names the latest rate on record, so a stale one is visible at a glance.
  const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 4 });
  const rateDay = (iso) => {
    const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
    return `${d} ${MONTH_NAMES[m - 1]} ${y}`;
  };
  const ratesText = used.size
    ? [...used].sort().map((currency) => {
        const r = rates[currency];
        if (!r) return `${currency}: not set`;
        return `1 ${currency} = ₹${inr.format(r.rate)} (rate of ${rateDay(r.effective_from)}` +
          `${staleCurrencies.has(currency) ? ', not updated since' : ''})`;
      }).join('   ·   ')
    : 'Not needed — every amount in this report is in INR';

  // ------------------------------------------------------------ analysis
  const eA = enquiryAnalysis(enquiries, today);
  const qA = quotationStatusAnalysis(quotationStatus);
  const sA = sectorAnalysis(sectors, sectorRows);
  const vA = serviceAnalysis(services);
  const kA = clientAnalysis(customers);
  const rA = revenueAnalysis(revenue, revenueLabel);
  const head = headline({ enquiries, sectors, customers, revenue, revenueLabel, priority: rA.priority });
  const fixes = managementFixes({ gaps, sectors, services, revenue, missingRates, staleRates });

  const et = enquiries.total;
  const ct = customers.summary.total;
  const p = revenue.invoicing.total;
  const overdue = revenue.payment_status.rows.find((row) => row.status === 'Overdue')?.pos ?? 0;

  // ------------------------------------------------------------- page 1
  const findings = [eA, qA, sA, vA, kA, rA].map((a) => a.insights.find((i) => i.tone !== 'note')).filter(Boolean);
  if (fixes.length) {
    findings.push({
      tag: 'DATA GAPS',
      tone: 'watch',
      text: `${plural(fixes.length, 'gap')} in the source data limit${fixes.length === 1 ? 's' : ''} this report; section 7 lists what to fix.`,
    });
  }

  const cover = [
    {
      table: {
        widths: ['*'],
        body: [[{
          stack: [
            { text: 'CETIZION VERIFICA PRIVATE LIMITED', style: 'brandTag' },
            { text: 'Sales & Enquiry Performance Review', style: 'title' },
            { text: `Period: ${periodText}`, style: 'subtitle' },
          ],
          fillColor: NAVY,
          margin: [18, 16, 18, 16],
        }]],
      },
      layout: 'noBorders',
    },
    {
      text: `Prepared ${stamp}  ·  Source: Enquiries page (${plural(et.enquiries, 'enquiry', 'enquiries')}), quotation register ` +
        `(${plural(sectorTotal.quotations, 'quotation')}) and purchase-order register (${plural(p.pos, 'PO')} dated in ${revenueLabel})`,
      style: 'small',
      margin: [0, 6, 0, 0],
    },
    // Won business moved from quotation status and date to the PO register,
    // so earlier printouts do not reconcile with this one. Said on the cover,
    // where anyone comparing two reports looks first.
    {
      text: 'How won business is counted: from the purchase orders registered, by PO date. Reports produced before ' +
        'September 2026 counted quotations marked won, by quotation date, so their monthly and quarterly figures ' +
        'will not match this one — a deal quoted in March with its PO in April now falls in April.',
      style: 'small',
      italics: true,
      margin: [0, 3, 0, 0],
    },
    { text: 'AT A GLANCE', style: 'kicker' },
    {
      table: {
        widths: ['*', '*', '*'],
        body: [
          [
            tile(number(et.enquiries), 'Enquiries received', `${number(et.quoted)} quoted · ${number(et.declined)} unqualified`),
            tile(number(sectors.summary.pos), 'POs won', `Win rate ${percent(sectors.summary.win_rate)} on decided quotations`),
            tile(compactInr(ct.won_value_inr), 'Won value (INR)', ct.unconverted.length ? `+ ${amounts(ct.unconverted)} without a rate` : `${plural(ct.clients, 'client')}`),
          ],
          [
            tile(compactInr(p.invoiced_inr), `Invoiced · ${revenueLabel}`, `${percent(p.invoiced_rate)} of ${compactInr(p.po_value_inr)} PO value`),
            tile(compactInr(p.received_inr), `Cash received · ${revenueLabel}`, `${percent(p.collection_rate)} of invoiced`),
            tile(compactInr(p.due_now_inr), `Due now · ${revenueLabel}`, `${plural(overdue, 'PO')} overdue`),
          ],
        ],
      },
      layout: {
        hLineWidth: () => 0.6,
        vLineWidth: () => 0.6,
        hLineColor: () => INK_200,
        vLineColor: () => INK_200,
        fillColor: () => '#f7f9fc',
        paddingLeft: () => 0,
        paddingRight: () => 0,
        paddingTop: () => 0,
        paddingBottom: () => 0,
      },
      margin: [0, 0, 0, 10],
    },
    callout(head),
    { text: 'KEY FINDINGS', style: 'kicker' },
    findings.length
      ? {
          table: {
            widths: [96, '*'],
            body: findings.map((f) => [
              { text: f.tag, bold: true, fontSize: 7.5, color: (TONES[f.tone] ?? TONES.note).fg, characterSpacing: 0.4, margin: [0, 1, 0, 0] },
              { text: f.text, fontSize: 8.5, lineHeight: 1.3, color: INK_900 },
            ]),
          },
          layout: {
            hLineWidth: (i, node) => (i === 0 || i === node.table.body.length ? 0 : 0.4),
            vLineWidth: () => 0,
            hLineColor: () => INK_200,
            paddingLeft: () => 0,
            paddingRight: () => 6,
            paddingTop: () => 5,
            paddingBottom: () => 5,
          },
        }
      : { text: 'There is not enough activity in this period for findings.', style: 'empty' },
    { text: 'IN THIS REPORT', style: 'kicker' },
    {
      columns: [
        { ol: ['Enquiry volume', 'Quotation status, and contracts received', 'Sector-wise performance', 'Service-wise sales'], style: 'small' },
        {
          stack: [
            { ol: ['Client analysis', 'Revenue and collections', 'What management needs to fix'], start: 5, style: 'small' },
            { text: 'Appendix: FX deals, client lists, notes and definitions', style: 'small', margin: [12, 0, 0, 0] },
          ],
        },
      ],
      columnGap: 14,
    },
  ].filter(Boolean);

  // ------------------------------------------------ 1. enquiry volume
  const months = enquiries.months;
  const volumeChart = et.enquiries
    ? stackedColumns({
        categories: shortMonths(months),
        series: [
          { name: 'Quotation sent', color: GREEN, values: months.map((m) => m.quoted) },
          { name: 'In progress', color: GOLD, values: months.map((m) => m.in_progress) },
          { name: 'Unqualified', color: RED, values: months.map((m) => m.declined) },
        ],
        width: W,
        height: 190,
        yTitle: 'Enquiries',
        integer: true,
      })
    : null;
  const pipeline = enquiries.pipeline;
  const volumeMeasures = [
    ['Enquiries received', number(et.enquiries)],
    ['Average per month', decimal(enquiries.average_per_month)],
    ['Busiest month', enquiries.busiest ? `${enquiries.busiest.label} — ${number(enquiries.busiest.enquiries)}` : '—'],
    ['Quotation sent', number(et.quoted)],
    ['Reached a contract (PO)', number(pipeline.contracted)],
    ['Quoted, no contract yet', number(Math.max(et.quoted - pipeline.contracted, 0))],
    ['In progress (not yet quoted)', number(et.in_progress)],
    ['Unqualified', number(et.declined)],
    ['TAT — enquiry to contract (average)', pipeline.tat_count ? `${decimal(pipeline.average_tat_days)} days` : '— (none reached a contract yet)'],

    ...(gaps.undated_enquiries ? [['Enquiries with no date (not counted)', number(gaps.undated_enquiries)]] : []),
  ];
  const mixColumn = (title, rows) => ({
    width: '*',
    stack: [
      { text: title, bold: true, fontSize: 8.5, color: NAVY, margin: [0, 0, 0, 3] },
      reportTable({
        columns: [
          { header: title, value: (r) => r.label },
          { header: 'Enquiries', value: (r) => number(r.count), align: 'right', width: 40 },
        ],
        rows,
        empty: 'Not recorded yet.',
        compact: true,
        fontSize: 7.5,
      }),
    ],
  });
  const mixSection = et.enquiries
    ? subsection(
        'Enquiry mix — source, sector and country',
        'How this period’s enquiries break down, whatever became of them.',
        { columns: [mixColumn('Source', pipeline.by_source), mixColumn('Sector', pipeline.by_sector), mixColumn('Country', pipeline.by_country)], columnGap: 12 },
        Math.max(pipeline.by_source.length, pipeline.by_sector.length, pipeline.by_country.length) + 1
      )
    : null;
  // A stage name plus how long it has taken: a final TAT once there is a
  // contract, a running count ("so far") while the enquiry is still moving.
  const enquiryStage = (row) => {
    if (row.tat_days != null) return `Contract awarded — ${plural(row.tat_days, 'day')}`;
    if (row.status === ENQUIRY_STATUS.declined) return 'Declined';
    const label = row.status === ENQUIRY_STATUS.quoted ? 'Quotation sent' : 'In progress';
    const soFar = row.enquiry_date ? daysBetween(row.enquiry_date, today) : null;
    return soFar != null ? `${label} — ${plural(soFar, 'day')} so far` : label;
  };
  const detailSection = et.enquiries
    ? subsection(
        'Enquiry detail',
        'Every enquiry in the period: source, service, sector, country and its stage, with the TAT (turnaround time) to a signed contract — running while it is still open, final once a contract is awarded.',
        reportTable({
          columns: [
            { header: 'Enquiry', value: (r) => lines(r.enquiry_no, note(dateLabel(r.enquiry_date))), width: 68 },
            { header: 'Client', value: (r) => r.client },
            { header: 'Source', value: (r) => r.source || '—', width: 58 },
            { header: 'Service', value: (r) => r.service || '—' },
            { header: 'Sector', value: (r) => r.sector || '—', width: 58 },
            { header: 'Country', value: (r) => r.country || '—', width: 58 },
            { header: 'Stage (TAT)', value: enquiryStage, width: 96 },
          ],
          rows: pipeline.detail,
          empty: 'No enquiries in this period.',
          compact: true,
          fontSize: 7,
        }),
        pipeline.detail.length + 1
      )
    : null;
  const volumeSection = [
    section(1, 'Enquiry volume', eA.lead, [figure(1, 'Enquiries by month and status', volumeChart, '')]),
    et.enquiries
      ? { columns: [{ width: 210, stack: [measureTable(volumeMeasures)] }, { width: '*', stack: eA.insights.map(callout) }], columnGap: 14, unbreakable: true }
      : insightsBlock(eA.insights),
    mixSection,
    detailSection,
  ];

  // ------------------------------------------------ 2. quotation status
  const wonValueCell = (value, unconverted, withoutValue) =>
    lines(
      money(value),
      unconverted?.length ? note(`+ ${amounts(unconverted)} (no rate)`, 'warnNote') : null,
      withoutValue ? note(`${withoutValue} with no value`) : null
    );
  const STATUS_STYLE = {
    [QUOTATION_STATUS.draft]: { label: 'Draft (not yet sent)', color: '#cbd5e1', field: 'draft' },
    [QUOTATION_STATUS.submitted]: { label: 'Submitted', color: SKY, field: 'submitted' },
    [QUOTATION_STATUS.negotiating]: { label: 'Under negotiation', color: GOLD, field: 'negotiating' },
    [QUOTATION_STATUS.onHold]: { label: 'On hold', color: '#9ca3af', field: 'on_hold' },
    [WON]: { label: 'Won - PO received', color: GREEN, field: 'won' },
    [QUOTATION_STATUS.lost]: { label: 'Lost', color: RED, field: 'lost' },
  };
  const qt = quotationStatus.total;
  const statusRows = quotationStatus.rows.map((row) => ({ ...row, ...(STATUS_STYLE[row.status] ?? { label: row.status, color: BLUE }) }));
  const statusSection = [
    section(2, 'Quotation status', qA.lead, [
      figure(2, 'Quotations by month and status', qt.quotations
        ? stackedColumns({
            categories: shortMonths(quotationStatus.months),
            series: statusRows.filter((row) => row.field).map((row) => ({
              name: row.label,
              color: row.color,
              values: quotationStatus.months.map((m) => m[row.field]),
            })),
            width: W,
            height: 190,
            yTitle: 'Quotations',
            integer: true,
          })
        : null, 'No quotations were raised in this period.'),
    ]),
    qt.quotations
      ? {
          columns: [
            {
              width: 236,
              stack: [figure(3, 'Quotation status split', donut({
                slices: statusRows.map((row) => ({ label: row.label, value: row.quotations, color: row.color, legend: `${row.label} — ${number(row.quotations)}` })),
                size: 104,
                legendWidth: 132,
                centerValue: number(qt.quotations),
                centerLabel: qt.quotations === 1 ? 'quotation' : 'quotations',
              }), '')],
            },
            { width: '*', stack: qA.insights.map(callout) },
          ],
          columnGap: 14,
          unbreakable: true,
        }
      : insightsBlock(qA.insights),
    reportTable({
      columns: [
        { header: 'Quotation status', value: (r) => r.label },
        { header: 'Quotations', value: (r) => number(r.quotations), total: (s) => number(s.quotations), align: 'right', width: 60 },
        { header: '% of quotations', value: (r) => percent(share(r.quotations, qt.quotations)), total: (s) => (s.quotations ? '100%' : '—'), align: 'right', width: 76 },
        {
          header: 'Quoted value (INR)',
          value: (r) => wonValueCell(r.value_inr, r.unconverted, r.without_value),
          total: (s) => wonValueCell(s.value_inr, s.unconverted, s.without_value),
          align: 'right',
          width: 120,
        },
      ],
      rows: qt.quotations ? statusRows : [],
      total: qt,
      empty: '',
    }),
  ];

  const qPipeline = quotationStatus.pipeline;
  // Always says how many quotations the average is built from, and names
  // both reasons one can be left out: no value entered, or no exchange rate
  // for its currency — so the count behind the figure is never a mystery.
  const ticketExclusions = [
    qPipeline.quotations_without_value ? `${plural(qPipeline.quotations_without_value, 'quotation')} with no value` : null,
    qPipeline.quotations_without_rate ? `${plural(qPipeline.quotations_without_rate, 'quotation')} with no exchange rate` : null,
  ].filter(Boolean);
  const ticketDetail = `From ${plural(qPipeline.average_ticket_count, 'quotation')} of ${number(qPipeline.total)}` +
    (ticketExclusions.length ? ` — ${ticketExclusions.join(', ')} excluded` : '');
  const conversionMeasures = [
    ['Conversion ratio (quotation → contract)', qPipeline.total ? percent(qPipeline.conversion_rate) : '—'],
    [
      'Average ticket size (INR)',
      qPipeline.average_ticket_inr != null ? lines(compactInr(qPipeline.average_ticket_inr), note(ticketDetail)) : '—',
    ],
    ['TAT — quotation to contract (average)', qPipeline.tat_count ? `${decimal(qPipeline.average_tat_days)} days` : '— (none reached a contract yet)'],
    // Status says won, but no PO is on record — a data gap, so named on its
    // own rather than folded into "pending" (a decided deal is not pending).
    ...(qPipeline.won_without_po
      ? [['Won, but no PO registered yet', { text: `${plural(qPipeline.won_without_po, 'quotation')} — register its purchase order`, alignment: 'left' }]]
      : []),
  ];
  const conversionSection = qt.quotations
    ? {
        columns: [
          { width: 250, stack: [measureTable(conversionMeasures)] },
          {
            width: '*',
            stack: [
              { text: 'Quotations by country', bold: true, fontSize: 8.5, color: NAVY, margin: [0, 0, 0, 3] },
              reportTable({
                columns: [
                  { header: 'Country', value: (r) => r.label },
                  { header: 'Quotations', value: (r) => number(r.count), align: 'right', width: 60 },
                ],
                rows: qPipeline.by_country,
                empty: 'Not recorded yet.',
                compact: true,
              }),
            ],
          },
        ],
        columnGap: 14,
        unbreakable: true,
        margin: [0, 4, 0, 0],
      }
    : null;

  // A stage name plus how long it has taken: a final TAT once there is a
  // contract, a running count ("so far") while the quotation is still open.
  const quotationStage = (row) => {
    if (row.tat_days != null) return `Contract awarded — ${plural(row.tat_days, 'day')}`;
    if (row.status === QUOTATION_STATUS.lost) return 'Lost';
    const label = STATUS_STYLE[row.status]?.label ?? row.status;
    const soFar = row.quotation_date ? daysBetween(row.quotation_date, today) : null;
    return soFar != null ? `${label} — ${plural(soFar, 'day')} so far` : label;
  };
  const quotationDetailSection = qt.quotations
    ? subsection(
        'Quotation detail',
        'Every quotation in the period: service, sector, country, quoted value and its stage, with TAT (turnaround time) to a signed contract.',
        reportTable({
          columns: [
            { header: 'Quotation', value: (r) => lines(r.quotation_no, note(dateLabel(r.quotation_date))), width: 70 },
            { header: 'Client', value: (r) => r.client },
            { header: 'Service', value: (r) => r.service || '—' },
            { header: 'Sector', value: (r) => r.sector || '—', width: 58 },
            { header: 'Country', value: (r) => r.country || '—', width: 58 },
            { header: 'Quoted value', value: (r) => money(r.quotation_value, r.currency), align: 'right', width: 68 },
            { header: 'Stage (TAT)', value: quotationStage, width: 96 },
          ],
          rows: qPipeline.detail,
          empty: 'No quotations in this period.',
          compact: true,
          fontSize: 7,
        }),
        qPipeline.detail.length + 1
      )
    : null;
  statusSection.push(conversionSection, quotationDetailSection);

  // ---------------------------------- contracts (purchase orders) received
  // By the PO's own date, not the quotation's — a contract can land in a
  // different period than the quotation that won it. service/sector/country
  // come from the linked quotation (purchaseOrderRows resolves that link).
  const contractMeasures = [
    ['Purchase orders received', number(contracts.total)],
    [
      'Total contract value (INR)',
      contracts.total ? lines(
        money(contracts.value_inr),
        contracts.unconverted?.length ? note(`+ ${amounts(contracts.unconverted)} (no rate)`, 'warnNote') : null,
        contracts.without_value ? note(`${plural(contracts.without_value, 'PO')} with no value`) : null
      ) : '—',
    ],
  ];
  const contractMixColumn = (title, rows) => ({
    width: '*',
    stack: [
      { text: title, bold: true, fontSize: 8.5, color: NAVY, margin: [0, 0, 0, 3] },
      reportTable({
        columns: [
          { header: title, value: (r) => r.label },
          { header: 'POs', value: (r) => number(r.count), align: 'right', width: 36 },
        ],
        rows,
        empty: 'Not recorded yet.',
        compact: true,
        fontSize: 7.5,
      }),
    ],
  });
  const contractIntro = subsection(
    'Contracts (purchase orders) received',
    contracts.total
      ? `${plural(contracts.total, 'purchase order')} ${contracts.total === 1 ? 'was' : 'were'} received in the period, by the PO's own date.`
      : 'No purchase orders were dated in this period.',
    contracts.total ? measureTable(contractMeasures) : { text: '', margin: [0, 0, 0, 0] },
    2
  );
  const contractMixRow = contracts.total
    ? { columns: [contractMixColumn('Service', contracts.by_service), contractMixColumn('Sector', contracts.by_sector), contractMixColumn('Country', contracts.by_country)], columnGap: 12, margin: [0, 8, 0, 0] }
    : null;
  const contractDetailSection = contracts.total
    ? subsection(
        'Contract detail',
        'Every purchase order received in the period: the service, sector and country of the quotation it fulfils, and its value.',
        reportTable({
          columns: [
            { header: 'PO', value: (r) => lines(r.po_number, note(dateLabel(r.po_date))), width: 74 },
            { header: 'Client', value: (r) => r.client || '—' },
            { header: 'Service', value: (r) => r.service || '—' },
            { header: 'Sector', value: (r) => r.sector || '—', width: 58 },
            { header: 'Country', value: (r) => r.country || '—', width: 58 },
            { header: 'PO value', value: (r) => money(r.po_value, r.currency), align: 'right', width: 74 },
          ],
          rows: contracts.detail,
          empty: 'No purchase orders in this period.',
          compact: true,
          fontSize: 7,
        }),
        contracts.detail.length + 1
      )
    : null;
  const contractSection = [contractIntro, contractMixRow, contractDetailSection].filter(Boolean);

  // ------------------------------------------------ 3. sector-wise
  const sectorBars = sectorRows
    .filter((row) => row.pos > 0)
    .sort((a, b) => a.not_set - b.not_set || b.won_value_inr - a.won_value_inr || b.pos - a.pos)
    .map((row) => ({
      label: row.sector,
      value: row.won_value_inr,
      valueLabel: `${row.won_value_inr ? compactInr(row.won_value_inr) : '—'}   (${plural(row.pos, 'PO')})`,
      color: row.not_set ? COLORS.pale : undefined,
    }));
  const sectorSection = [
    section(3, 'Sector-wise performance', sA.lead, [
      figure(4, 'Won value by sector (INR)', horizontalBars({ items: sectorBars, width: W, labelWidth: 140, valueWidth: 110, formatAxis: compactInr }), 'No POs were won in this period.'),
    ]),
    reportTable({
      columns: [
        { header: 'Sector', value: (r) => r.sector },
        { header: 'Enquiries', value: (r) => number(r.enquiries), total: (s) => number(s.enquiries), align: 'right', width: 42 },
        { header: 'Quotations', value: (r) => number(r.quotations), total: (s) => number(s.quotations), align: 'right', width: 48 },
        { header: 'POs won', value: (r) => number(r.pos), total: (s) => number(s.pos), align: 'right', width: 38 },
        { header: 'Lost', value: (r) => number(r.lost), total: (s) => number(s.lost), align: 'right', width: 28 },
        { header: 'Pipeline', value: (r) => number(r.pipeline), total: (s) => number(s.pipeline), align: 'right', width: 38 },
        { header: 'Win %', value: (r) => percent(r.win_rate), total: (s) => percent(s.win_rate), align: 'right', width: 32 },
        {
          header: 'Won value (INR)',
          value: (r) => wonValueCell(r.won_value_inr, r.unconverted, r.pos_without_value),
          total: (s) => wonValueCell(s.won_value_inr, s.unconverted),
          align: 'right',
          width: 92,
        },
      ],
      rows: sectorRows,
      total: sectorTotal,
      empty: 'No enquiries or quotations in this period.',
      compact: true,
    }),
    { text: '', margin: [0, 6, 0, 0] },
    insightsBlock(sA.insights),
  ];

  // ------------------------------------------------ 4. service-wise
  // "Won" is an actual PO (see serviceRows in salesReviewData.js), matched
  // to a line by its own quotation's service text — the same PO-based
  // definition Sector-wise and Client analysis use.
  const serviceBars = services.rows
    .filter((row) => row.won > 0)
    .sort((a, b) => a.other - b.other || b.won_value_inr - a.won_value_inr)
    .map((row) => ({
      label: row.service,
      value: row.won_value_inr,
      valueLabel: `${row.won_value_inr ? compactInr(row.won_value_inr) : '—'}   (${plural(row.won, 'PO')})`,
      color: row.other ? COLORS.pale : undefined,
    }));
  const serviceSection = [
    section(4, 'Service-wise sales', vA.lead, [
      figure(5, 'Won value by service line (INR)', horizontalBars({ items: serviceBars, width: W, labelWidth: 170, valueWidth: 105, formatAxis: compactInr }), 'No POs were won in this period.'),
    ]),
    reportTable({
      columns: [
        { header: 'Service line', value: (r) => r.service, totalLabel: 'Total (each quotation once)' },
        { header: 'Enquiries', value: (r) => number(r.enquiries), total: (s) => number(s.enquiries), align: 'right', width: 42 },
        { header: 'Quotations', value: (r) => number(r.quotations), total: (s) => number(s.quotations), align: 'right', width: 48 },
        { header: 'POs won', value: (r) => number(r.won), total: (s) => number(s.won), align: 'right', width: 38 },
        { header: 'Lost', value: (r) => number(r.lost), total: (s) => number(s.lost), align: 'right', width: 28 },
        { header: 'Win %', value: (r) => percent(r.win_rate), total: (s) => percent(s.win_rate), align: 'right', width: 32 },
        {
          header: 'Won value (INR)',
          value: (r) => wonValueCell(r.won_value_inr, r.won_unconverted, r.won_without_value),
          total: (s) => wonValueCell(s.won_value_inr, s.won_unconverted),
          align: 'right',
          width: 92,
        },
      ],
      rows: services.rows,
      total: services.summary,
      empty: 'No enquiries or quotations in this period.',
      compact: true,
    }),
    { text: '', margin: [0, 6, 0, 0] },
    insightsBlock(vA.insights),
  ];

  // ------------------------------------------------ 5. clients
  // The type the server gave each client (CLIENT_TYPES in salesReport.js).
  const repeatRows = customers.rows.filter((row) => row.client_type === REPEAT_CLIENT);
  const singleRows = customers.rows.filter((row) => row.client_type !== REPEAT_CLIENT);
  const topClients = customers.rows
    .filter((row) => row.won_value_inr > 0)
    .sort((a, b) => b.won_value_inr - a.won_value_inr)
    .slice(0, 6);
  const clientDonut = donut({
    slices: [
      { label: 'Repeat clients', value: customers.summary.repeat.clients, color: NAVY, legend: `Repeat — ${number(customers.summary.repeat.clients)} (${compactInr(customers.summary.repeat.won_value_inr)})` },
      { label: 'Single enquiry clients', value: customers.summary.single.clients, color: SKY, legend: `Single — ${number(customers.summary.single.clients)} (${compactInr(customers.summary.single.won_value_inr)})` },
    ],
    size: 104,
    legendWidth: 126,
    centerValue: number(ct.clients),
    centerLabel: ct.clients === 1 ? 'client' : 'clients',
  });
  const topClientBars = horizontalBars({
    items: topClients.map((row) => ({ label: row.client, value: row.won_value_inr, valueLabel: compactInr(row.won_value_inr) })),
    width: W - 244,
    labelWidth: 96,
    valueWidth: 56,
    rowHeight: 19,
    formatAxis: compactInr,
  });
  const clientColumns = [
    { header: 'Client group', value: (r) => r.client },
    { header: 'Enquiries', value: (r) => number(r.enquiries), total: (s) => number(s.enquiries), align: 'right', width: 46 },
    { header: 'POs won', value: (r) => number(r.pos), total: (s) => number(s.pos), align: 'right', width: 42 },
    { header: 'Win %', value: (r) => percent(r.win_rate), total: (s) => percent(s.win_rate), align: 'right', width: 36 },
    {
      header: 'Won value (INR)',
      value: (r) => wonValueCell(r.won_value_inr, r.unconverted),
      total: (s) => wonValueCell(s.won_value_inr, s.unconverted),
      align: 'right',
      width: 96,
    },
    { header: 'Repeat orders', value: (r) => number(r.repeat_orders), total: (s) => number(s.repeat_orders), align: 'right', width: 50 },
  ];
  const repeatNames = [...repeatRows]
    .sort((a, b) => b.deals_to_date - a.deals_to_date || b.pos_to_date - a.pos_to_date)
    .map((row) => `${row.client} (${plural(row.deals_to_date, 'deal')}${row.pos_to_date > row.deals_to_date ? `, ${plural(row.pos_to_date, 'PO')}` : ''})`);
  const clientSection = [
    section(5, 'Client analysis', kA.lead, [
      ct.clients
        ? {
            stack: [
              {
                columns: [
                  { width: 230, stack: [clientDonut ? { svg: clientDonut.svg, width: clientDonut.width } : { text: '' }] },
                  {
                    width: '*',
                    stack: [
                      { text: 'Top clients by won value', style: 'chartTitle' },
                      topClientBars ? { svg: topClientBars.svg, width: topClientBars.width } : { text: 'No won value in this period.', style: 'empty' },
                    ],
                  },
                ],
                columnGap: 14,
              },
              { text: 'Figure 6 — Repeat and single enquiry clients, and the top clients by won value', style: 'caption', margin: [0, 4, 0, 8] },
            ],
          }
        : { text: 'No clients in this period.', style: 'empty' },
    ]),
    reportTable({
      columns: [
        { header: 'Client type', value: (r) => r.label },
        { header: 'Clients', value: (r) => number(r.clients), total: (s) => number(s.clients), align: 'right', width: 42 },
        ...clientColumns.slice(1),
      ],
      rows: [
        { label: 'Repeat clients', ...customers.summary.repeat },
        { label: 'Single enquiry clients', ...customers.summary.single },
      ],
      total: ct,
      compact: true,
    }),
    repeatNames.length ? { text: [{ text: 'Clients with repeat orders: ', bold: true }, `${repeatNames.join(', ')}.`], style: 'body', margin: [0, 6, 0, 6] } : { text: '', margin: [0, 6, 0, 0] },
    insightsBlock(kA.insights),
  ];

  // ------------------------------------------------ 6. revenue
  const poCount = (r) => lines(
    number(r.pos),
    r.pos_unconverted > 0 ? note(`${r.pos_unconverted} rate not set`, 'warnNote') : null,
    r.stages_unconverted > 0 ? note(`${plural(r.stages_unconverted, 'stage')} with no rate on their date`, 'warnNote') : null,
  );
  const gainLoss = (r) => (r.fx_gain_loss_inr ? `${r.fx_gain_loss_inr > 0 ? '+' : '-'}${money(Math.abs(r.fx_gain_loss_inr))}` : '-');
  const poMoneyColumns = [
    { header: 'POs', value: poCount, total: poCount, align: 'right', width: 34 },
    { header: 'PO value (INR)', value: (r) => money(r.po_value_inr), total: (s) => money(s.po_value_inr), align: 'right' },
    { header: 'Invoiced (INR)', value: (r) => money(r.invoiced_inr), total: (s) => money(s.invoiced_inr), align: 'right' },
    { header: 'Received (INR)', value: (r) => money(r.received_inr), total: (s) => money(s.received_inr), align: 'right' },
    { header: 'Due now (INR)', value: (r) => money(r.due_now_inr), total: (s) => money(s.due_now_inr), align: 'right' },
    { header: 'To bill (INR)', value: (r) => money(r.to_bill_inr), total: (s) => money(s.to_bill_inr), align: 'right' },
    // What the currency moved between invoicing and collection. Always blank
    // on INR-only months, where both rates are 1.
    { header: 'FX gain / loss', value: gainLoss, total: gainLoss, align: 'right' },
  ];
  const noPos = `No purchase orders dated in ${revenueLabel}.`;
  const cashChart = p.pos
    ? stackedColumns({
        categories: ['PO value', 'Invoiced', 'Received', 'Due now'],
        series: [{ name: 'INR', colors: [NAVY, BLUE, GREEN, RED], values: [p.po_value_inr, p.invoiced_inr, p.received_inr, p.due_now_inr] }],
        width: W,
        height: 170,
        legend: false,
        formatValue: compactInr,
      })
    : null;
  const intakeMonths = revenue.orders.months;
  const intakeChart = stackedColumns({
    categories: shortMonths(intakeMonths),
    series: [{ name: 'Order intake', color: NAVY, values: intakeMonths.map((m) => m.order_intake_inr) }],
    width: W,
    height: 160,
    legend: false,
    formatValue: compactInr,
  });
  const revenueSection = [
    section(6, 'Revenue and collections', rA.lead, [
      figure(7, `From PO value to cash, ${revenueLabel}${p.pos ? ` — ${percent(p.invoiced_rate)} of PO value invoiced, ${percent(p.collection_rate)} of invoices collected` : ''}`, cashChart, noPos),
    ]),
    p.pos
      ? {
          columns: [
            {
              width: 230,
              stack: [reportTable({
                columns: [
                  { header: 'Stage', value: (r) => r[0] },
                  { header: 'Amount (INR)', value: (r) => money(r[1]), align: 'right', width: 70 },
                  { header: '% of PO value', value: (r) => percent(share(r[1], p.po_value_inr)), align: 'right', width: 56 },
                ],
                rows: [['PO value', p.po_value_inr], ['Invoiced', p.invoiced_inr], ['Received', p.received_inr], ['Due now', p.due_now_inr]],
                compact: true,
              })],
            },
            { width: '*', stack: rA.insights.map(callout) },
          ],
          columnGap: 14,
          unbreakable: true,
        }
      : insightsBlock(rA.insights),
    {
      stack: [
        { text: 'Quotations won by month', style: 'h2' },
        { text: 'Quotations marked Won - PO Received, by quotation date, in INR — not the same as the POs registered below, which can land in a different month · Average deal = order intake ÷ the orders that have a value', style: 'lead' },
        figure(8, `Quotations won by month (INR), ${revenueLabel}`, intakeChart, `No quotations were won in ${revenueLabel}.`),
      ],
      unbreakable: true,
    },
    reportTable({
      columns: [
        { header: 'Month', value: (r) => r.label, width: 70 },
        { header: 'Quotations won', value: (r) => number(r.orders_won), total: (s) => number(s.orders_won), align: 'right', width: 66 },
        {
          header: 'Order intake (INR)',
          value: (r) => lines(money(r.order_intake_inr), r.order_unconverted.length ? note(`+ ${amounts(r.order_unconverted)} (rate not set)`, 'warnNote') : null),
          total: (s) => lines(money(s.order_intake_inr), s.order_unconverted.length ? note(`+ ${amounts(s.order_unconverted)} (rate not set)`, 'warnNote') : null),
          align: 'right',
        },
        { header: 'Average deal (INR)', value: (r) => money(r.average_deal_inr), total: (s) => money(s.average_deal_inr), align: 'right' },
      ],
      rows: intakeMonths,
      total: revenue.orders.total,
      empty: `No months in ${revenueLabel}.`,
    }),
    subsection(
      'Invoicing & collections by month',
      'Every purchase order by its PO date, as on the Purchase orders page · Due now = invoiced − received · To bill = due to be invoiced, not yet billed',
      {
        stack: [
          reportTable({
            columns: [{ header: 'Month', value: (r) => r.label, width: 54 }, ...poMoneyColumns],
            rows: revenue.invoicing.months,
            total: p,
            empty: noPos,
          }),
          {
            text: [
              'Collection rate ', { text: percent(p.collection_rate), bold: true },
              { text: `  received ÷ invoiced (${money(p.received_inr)} of ${money(p.invoiced_inr)})`, color: INK_500 },
              '      Invoiced ', { text: percent(p.invoiced_rate), bold: true },
              { text: `  of PO value (${money(p.invoiced_inr)} of ${money(p.po_value_inr)})`, color: INK_500 },
            ],
            alignment: 'right',
            fontSize: 8,
            margin: [0, 5, 0, 0],
          },
        ],
      },
      revenue.invoicing.months.length + 2
    ),
    subsection(
      'Payment status',
      'Overdue = at least one invoice is past its due date, and Due now is every unpaid invoice on those POs, overdue or not · To Invoice = a stage is due to be billed · No stages = no payment schedule has been set up yet · Pending = invoiced, not yet overdue · Up to date = nothing due now · Fully Paid = every stage paid · Counts every PO, including revised and cancelled ones, which are still billed; POs won leaves those out',
      reportTable({
        columns: [{ header: 'Payment status', value: (r) => r.status, width: 62 }, ...poMoneyColumns],
        rows: revenue.payment_status.rows,
        total: revenue.payment_status.total,
        empty: noPos,
      }),
      revenue.payment_status.rows.length + 1
    ),
    subsection(
      'Overdue by client',
      'Every invoice overdue today, on a purchase order dated in the period · Due = invoiced − received on that invoice · Only the overdue invoices, so the total can be lower than Due now in the Payment status Overdue row',
      reportTable({
        columns: [
          { header: 'Client', value: (r) => r.client },
          { header: 'PO', value: (r) => r.po_number, width: 62 },
          { header: 'Invoice', value: (r) => r.invoice_no || '—', width: 58 },
          { header: 'Due date', value: (r) => dateLabel(r.due_date), width: 58 },
          { header: 'Days overdue', value: (r) => number(r.days_overdue), align: 'right', width: 54 },
          {
            header: 'Received (INR)',
            value: (r) => (r.received_rate !== null
              ? money(r.received_inr)
              : lines(money(r.amount_received, r.currency), note('rate not set', 'warnNote'))),
            total: (s) => lines(money(s.received_inr), s.received_unconverted.length ? note(`+ ${amounts(s.received_unconverted)} (rate not set)`, 'warnNote') : null),
            align: 'right',
            width: 76,
          },
          {
            header: 'Due (INR)',
            value: (r) => (r.due_rate !== null
              ? money(r.due_inr)
              : lines(money(r.due_now_amount, r.currency), note('rate not set', 'warnNote'))),
            total: (s) => lines(money(s.due_inr), s.due_unconverted.length ? note(`+ ${amounts(s.due_unconverted)} (rate not set)`, 'warnNote') : null),
            align: 'right',
            width: 76,
          },
        ],
        rows: revenue.overdue_by_client.rows,
        total: revenue.overdue_by_client.total,
        empty: 'Nothing overdue in this period.',
        compact: true,
      }),
      revenue.overdue_by_client.rows.length + 1
    ),
  ];

  // ------------------------------------------------ 7. what to fix
  const fixSection = [
    section(7, 'What management needs to fix',
      fixes.length
        ? `${plural(fixes.length, 'change')} to the source data would remove the blind spots in this report.`
        : null,
      [
        fixes.length
          ? { ol: fixes.map((fix) => ({ text: [{ text: `${fix.title}. `, bold: true, color: INK_900 }, fix.detail], margin: [0, 0, 0, 5] })), style: 'body' }
          : callout({ tag: 'ALL CLEAR', tone: 'good', text: 'No gaps were found in the source data for this period.' }),
      ]),
    { text: [{ text: 'Exchange rates used: ', bold: true }, ratesText], style: 'small', margin: [0, 4, 0, 0] },
  ];

  // ------------------------------------------------ appendix
  const appendix = [
    { text: 'Appendix', style: 'h1', pageBreak: 'before' },
    rule(),
    subsection('A.  FX deals', `${periodText} · registered POs billed in a currency other than INR · INR value = won value × the exchange rate`, reportTable({
      columns: [
        { header: 'Client', value: (r) => lines(r.customer, note(r.po_numbers)) },
        { header: 'Sector', value: (r) => r.sector, width: 70 },
        { header: 'Currency', value: (r) => r.currency, width: 38 },
        { header: 'Won POs', value: (r) => number(r.deals), total: (s) => number(s.deals), align: 'right', width: 34 },
        {
          header: 'Won value',
          value: (r) => lines(money(r.amount, r.currency), r.deals_without_value > 0 ? note(`${r.deals_without_value} with no value`) : null),
          total: (s) => amounts(s.amounts),
          align: 'right',
          width: 72,
        },
        { header: 'Rate', value: (r) => (r.rate === null ? 'Not set' : `₹${r.rate} / ${r.currency}`), align: 'right', width: 60 },
        {
          header: 'Won value (INR)',
          value: (r) => (r.amount_inr === null ? 'Rate not set' : money(r.amount_inr)),
          total: (s) => lines(money(s.amount_inr), s.missing_rates.length ? note(`excludes ${s.missing_rates.join(', ')}`, 'warnNote') : null),
          align: 'right',
          width: 72,
        },
      ],
      rows: fx.rows,
      total: fx.summary,
      empty: 'No FX deals in this period: every won PO is in INR.',
      compact: true,
    }), fx.rows.length + 1),
    subsection(`B.  Repeat clients (${repeatRows.length})`, '2 or more deals won up to the end of the period · a deal is a quotation with a PO, so phase POs on one quotation are one deal · repeat orders = deals after the first',
      reportTable({ columns: clientColumns, rows: repeatRows, total: customers.summary.repeat, empty: 'No repeat clients in this period.', compact: true }),
      repeatRows.length),
    subsection(`C.  Single enquiry clients (${singleRows.length})`, 'Every other client: one won PO, quoted but not won yet, or only on the Enquiries page',
      reportTable({ columns: clientColumns, rows: singleRows, total: customers.summary.single, empty: 'No single enquiry clients in this period.', compact: true }),
      singleRows.length),
    subsection('D.  Notes and definitions', null, {
      ul: [
        `Every section covers ${periodText}: enquiries by enquiry date, quotations by quotation date, purchase orders by PO date.`,
        'Enquiries are the rows on the Enquiries page, counted by their status there: open (New, Contacted, Qualified or Nurture), Unqualified, or Converted ("quotation sent").',
        'Quotation status is the status on the Quotations page: Submitted, Under Negotiation, On Hold, Won - PO Received or Lost. Open = anything not yet won or lost.',
        `A PO won (Sector-wise performance, Service-wise sales, Client analysis, FX deals) is an actual purchase order registered in the Purchase Orders register, dated by its own PO date — not simply a quotation marked "${WON}": a quotation can be marked won with nothing registered yet, and one won quotation can carry more than one PO. Service-wise sales matches each PO to a line by its own quotation's service text. "Quotations won" (Quotations won by month, in Revenue and collections) is the one exception: it counts the quotation itself, by quotation date, and can differ from the PO count for the same reason. Pipeline = quotations Submitted, Under Negotiation or On Hold.`,
        'Win % = deals won ÷ (deals won + lost), where a deal won is a quotation with a PO dated in the period: several POs against one quotation (a project split into phases) are one deal won, so it is counted in the same units as lost. Open deals have no outcome yet, so they are left out.',
        'Won value (INR) converts each quotation or PO at the exchange rate set in Settings, on its own date. An amount in a currency with no rate is shown separately, never guessed.',
        'Service lines are matched from the service text by keywords. A quotation naming several services counts in each of its lines; the Total row counts it once. "Other services" is text that matches no line.',
        'Clients and sectors are grouped by spelling: capital letters and extra spaces are ignored, any other difference is a separate name.',
        'Repeat client = 2 or more deals won up to the end of the period, a deal being a quotation with a PO registered against it: a project split into several phase POs is one deal, so it does not by itself make a client a repeat client. Every other client is a single enquiry client. Repeat orders = deals after a client\'s first. A client with only a quotation lost in the period is not listed — a quotation still open (Submitted, Under Negotiation or On Hold) is, since it can still become a PO.',
        'Quotations won = won quotation values in INR, by quotation date. Invoicing, collections and payment status list every purchase order by its PO date, exactly as the Purchase orders page shows them. Due now = invoiced − received on invoices that have been raised; work that is due to be billed but has no invoice yet is shown separately as To bill. Collection rate = received against invoices ÷ invoiced. Every amount is converted at the rate in force on its own date, so the INR Due now differs from invoiced − received by the realised FX movement, reported as FX gain / loss.',
        'Overdue by client lists every invoice past its due date today, one row per invoice, for a PO dated in the period. Payment status counts whole purchase orders instead: a PO with one overdue invoice is in its Overdue row with every unpaid invoice it has, overdue or not, so the Due now in that row can be higher than the Overdue by client total. Received and Due convert at the rate on the payment date and the invoice date respectively.',
        'The written analysis is produced from these figures by fixed rules, so the same data always reads the same way: a rate of 60% or more reads as strong and under 40% as weak; one sector with half of won value, or two clients with 35%, is flagged as concentration; under 50% of PO value invoiced, or under 70% of invoices collected, is named as the priority. No AI or outside service is used.',
      ],
      style: 'body',
    }, 1), // kept whole: a list split across a page break leaves a near-empty last page
  ];

  return {
    pageSize: 'A4',
    pageOrientation: 'portrait',
    pageMargins: [MARGIN_X, 48, MARGIN_X, 42],
    info: {
      title: `Cetizion Sales & Enquiry Performance Review — ${periodText}`,
      author: 'Cetizion Tracker',
      subject: `Period: ${periodText}`,
      creator: 'Cetizion Tracker',
    },
    defaultStyle: { font: 'Roboto', fontSize: 8, color: INK_900, lineHeight: 1.15 },
    header: (currentPage) =>
      currentPage === 1
        ? { text: '' }
        : {
            columns: [
              { text: 'CETIZION  ·  SALES & ENQUIRY PERFORMANCE REVIEW', style: 'runningHead' },
              { text: periodText, style: 'runningHead', alignment: 'right' },
            ],
            margin: [MARGIN_X, 22, MARGIN_X, 0],
          },
    footer: (currentPage, pageCount) => ({
      columns: [
        { text: `Generated ${stamp}  ·  Internal and confidential`, style: 'footer' },
        { text: `Page ${currentPage} of ${pageCount}`, style: 'footer', alignment: 'right' },
      ],
      margin: [MARGIN_X, 14, MARGIN_X, 0],
    }),
    content: [
      ...cover,
      { text: '', pageBreak: 'after' },
      ...volumeSection,
      ...statusSection,
      ...contractSection,
      ...sectorSection,
      ...serviceSection,
      ...clientSection,
      ...revenueSection,
      ...fixSection,
      ...appendix,
    ].filter(Boolean),
    styles: PDF_STYLES,
  };
}

/** The finished PDF as a Buffer. */
export function salesReportPdf(data) {
  return pdfmake.createPdf(salesReportDocDefinition(data)).getBuffer();
}
