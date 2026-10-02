import pdfmake from './pdf.js';
import { COLORS, donut, horizontalBars, stackedColumns } from './pdfCharts.js';
import { compactInr, money, number, plural } from './reportFormat.js';
import { bucketLabel, weekStart } from './reportDefinitions.js';
import {
  INK, MARGIN_X, PDF_STYLES, dateLabel, figure, generatedStamp, periodLabel, reportTable, section, tile,
} from './salesReportPdf.js';

/**
 * The Reports section as a PDF (docs/sales-report-rework-plan.md §5.2): the
 * six questions in the order the screen asks them, each with the sentence the
 * server wrote, a chart and its table, from the same salesReport() result the
 * screen and the CSVs read — so the three never disagree.
 *
 * pdfmake and SVG charts, as for every PDF here: no browser, no outside
 * service. The building blocks and type styles are the sales review's
 * (salesReportPdf.js), so the two documents look like one family.
 */

const W = Math.floor(595.28 - MARGIN_X * 2);
const NOTHING = 'Nothing in this period.';

/** A daily chart wider than this many columns is drawn by week instead. */
export const MAX_DAILY_COLUMNS = 31;
/** The PO list behind the revenue figures stops here; the CSV has the rest. */
export const MAX_PO_ROWS = 200;
/** Customer lists stop here; the CSV has the rest. */
export const MAX_LIST_ROWS = 100;

const inr = (value) => money(value ?? 0, 'INR');
const nPct = (count, pct) => (pct == null ? number(count) : `${number(count)} · ${pct}%`);
const more = (shown, total, csv) => (total > shown
  ? { text: `…and ${plural(total - shown, 'more row')}: download the ${csv} CSV from the Reports page for the full list.`, style: 'lead', margin: [0, 3, 0, 0] }
  : null);

const OUTCOME_COLOUR = {
  converted: COLORS.green, pipeline: COLORS.sky, quoted_not_won: COLORS.gold, lost: COLORS.red,
};
const OUTCOME_LABEL = { converted: 'Converted to PO', pipeline: 'In pipeline', quoted_not_won: 'Quoted, not won', lost: 'Lost' };

/**
 * The enquiry buckets as the PDF draws them. A page fits about a month of
 * days; beyond that, days are summed into the weeks they fall in, and the
 * caller says so under the chart.
 */
export function pdfEnquiryBuckets(enquiries) {
  const dated = enquiries.buckets.filter((b) => b.key);
  if (enquiries.grain !== 'day' || dated.length <= MAX_DAILY_COLUMNS) {
    return { grain: enquiries.grain, buckets: dated, regrouped: false };
  }
  const weeks = new Map();
  for (const b of dated) {
    const key = weekStart(b.key);
    weeks.set(key, (weeks.get(key) ?? 0) + b.enquiries);
  }
  return {
    grain: 'week',
    buckets: [...weeks].map(([key, n]) => ({ key, label: bucketLabel(key, 'week'), enquiries: n })),
    regrouped: true,
  };
}

/** The four summary boxes: the same four as the strip on screen. */
function summaryStrip(report) {
  const converted = report.outcomes.slices.find((s) => s.key === 'converted');
  return {
    table: {
      widths: ['*', '*', '*', '*'],
      body: [[
        tile(number(report.enquiries.total), 'Enquiries', 'received in the period'),
        tile(nPct(converted.count, converted.pct), 'Converted to PO', "by the period's end"),
        tile(`${number(report.revenue.total.pos)} · ${compactInr(report.revenue.total.po_value_inr)}`, 'POs', 'incl. GST, by PO date'),
        tile(number(report.customers.tiles.new_customers), 'New clients', 'first-ever PO in the period'),
      ]],
    },
    layout: {
      hLineWidth: () => 0.6, vLineWidth: () => 0.6, hLineColor: () => INK[200], vLineColor: () => INK[200],
      fillColor: () => '#f7f9fc', paddingLeft: () => 0, paddingRight: () => 0, paddingTop: () => 0, paddingBottom: () => 0,
    },
    margin: [0, 0, 0, 10],
  };
}

const QUESTIONS = [
  'How many enquiries did we receive?',
  'What happened to them?',
  'Which sectors gave us POs?',
  'Which services sell best?',
  'New and existing customers',
  'Monthly revenue',
];
export { QUESTIONS as PDF_SECTION_HEADINGS };

/* ------------------------------------------------------------ sections */

function enquiriesSection(report) {
  const { enquiries, narrative } = report;
  if (!enquiries.total) return [section(1, QUESTIONS[0], NOTHING)];
  const drawn = pdfEnquiryBuckets(enquiries);
  const chart = stackedColumns({
    categories: drawn.buckets.map((b) => b.label),
    series: [{ name: 'Enquiries', color: COLORS.blue, values: drawn.buckets.map((b) => b.enquiries) }],
    width: W, integer: true, legend: false,
  });
  return [
    section(1, QUESTIONS[0], narrative.enquiries, [
      figure(1, `Enquiries per ${drawn.grain}${drawn.regrouped ? ' (more than a month of days, so drawn by week)' : ''}`, chart, NOTHING),
    ]),
    { text: 'By source', style: 'h2' },
    reportTable({
      columns: [
        { header: 'Source', value: (r) => r.name },
        { header: 'Enquiries', value: (r) => number(r.enquiries), total: (t) => number(t.enquiries), align: 'right', width: 70 },
      ],
      rows: enquiries.sources,
      total: { enquiries: enquiries.total },
    }),
    enquiries.dated_by_creation
      ? { text: `${plural(enquiries.dated_by_creation, 'enquiry', 'enquiries')} had no enquiry date and ${enquiries.dated_by_creation === 1 ? 'is' : 'are'} counted on the day ${enquiries.dated_by_creation === 1 ? 'it was' : 'they were'} created.`, style: 'lead', margin: [0, 3, 0, 0] }
      : null,
  ];
}

function outcomesSection(report) {
  const { outcomes, narrative } = report;
  if (!outcomes.total) return [section(2, QUESTIONS[1], NOTHING)];
  const chart = donut({
    slices: outcomes.slices.map((s) => ({
      label: s.label, value: s.count, color: OUTCOME_COLOUR[s.key], legend: `${s.label} — ${nPct(s.count, s.pct)}`,
    })),
    centerValue: number(outcomes.total),
    centerLabel: 'enquiries',
    legendWidth: 190,
  });
  const months = outcomes.months.filter((m) => m.key && m.enquiries);
  return [
    section(2, QUESTIONS[1], narrative.outcomes, [
      figure(2, 'Where the period\'s enquiries stood at its end. Lost means closed without a quotation.', chart, NOTHING),
    ]),
    reportTable({
      columns: [
        { header: 'Outcome', value: (r) => r.label },
        { header: 'Enquiries', value: (r) => number(r.count), total: (t) => number(t.count), align: 'right', width: 70 },
        { header: 'Share', value: (r) => (r.pct == null ? '—' : `${r.pct}%`), total: () => '100%', align: 'right', width: 60 },
      ],
      rows: [
        ...outcomes.slices.flatMap((s) => (s.key === 'pipeline'
          ? [s, { label: '– of which not yet quoted', count: outcomes.pipeline.not_quoted }, { label: '– of which quoted, awaiting a decision', count: outcomes.pipeline.quoted }]
          : [s])),
      ],
      total: { count: outcomes.total },
    }),
    outcomes.quoted_not_won_reasons.length ? { text: 'Why quoted enquiries were not won', style: 'h2' } : null,
    outcomes.quoted_not_won_reasons.length
      ? reportTable({
        columns: [
          { header: 'Reason', value: (r) => r.reason },
          { header: 'Enquiries', value: (r) => number(r.count), align: 'right', width: 70 },
        ],
        rows: outcomes.quoted_not_won_reasons,
      })
      : null,
    months.length > 1 ? { text: 'By month', style: 'h2' } : null,
    months.length > 1
      ? reportTable({
        columns: [
          { header: 'Month', value: (r) => r.label },
          { header: 'Enquiries', value: (r) => number(r.enquiries), align: 'right', width: 60 },
          ...['converted', 'pipeline', 'quoted_not_won', 'lost'].map((key) => ({
            header: OUTCOME_LABEL[key], value: (r) => nPct(r[key].count, r[key].pct), align: 'right', width: 76,
          })),
        ],
        rows: months,
      })
      : null,
  ];
}

function sectorsSection(report) {
  const { sectors, narrative } = report;
  if (!sectors.total.pos) return [section(3, QUESTIONS[2], NOTHING)];
  const chart = horizontalBars({
    items: sectors.rows.map((r, i) => ({
      label: r.sector, value: r.pos, valueLabel: `${number(r.pos)} · ${compactInr(r.value_inr)}`,
      color: r.other ? COLORS.pale : [COLORS.navy, COLORS.blue][i] ?? COLORS.sky,
    })),
    width: W, integer: true,
  });
  const other = sectors.rows.find((r) => r.sector === 'Other');
  return [
    section(3, QUESTIONS[2], narrative.sectors, [figure(3, 'POs by sector, with their value incl. GST', chart, NOTHING)]),
    reportTable({
      columns: [
        { header: 'Sector', value: (r) => r.sector },
        { header: 'POs', value: (r) => number(r.pos), total: (t) => number(t.pos), align: 'right', width: 50 },
        { header: 'Share', value: (r) => (r.pct == null ? '—' : `${r.pct}%`), align: 'right', width: 50 },
        { header: 'PO value (INR)', value: (r) => inr(r.value_inr), total: (t) => inr(t.value_inr), align: 'right', width: 100 },
      ],
      rows: sectors.rows,
      total: sectors.total,
    }),
    other?.raw.length
      ? { text: `Other is: ${other.raw.map((r) => `${r.name} (${r.pos})`).join(', ')}.`, style: 'lead', margin: [0, 3, 0, 0] }
      : null,
  ];
}

function servicesSection(report) {
  const { services, narrative } = report;
  if (!services.total.pos) return [section(4, QUESTIONS[3], NOTHING)];
  const chart = horizontalBars({
    items: services.rows.map((r, i) => ({
      label: r.line, value: r.value_inr, valueLabel: `${compactInr(r.value_inr)} · ${plural(r.pos, 'PO')}`,
      color: r.other ? COLORS.pale : [COLORS.navy, COLORS.blue][i] ?? COLORS.sky,
    })),
    width: W, labelWidth: 150, valueWidth: 110, formatAxis: compactInr,
  });
  const src = services.sources;
  return [
    section(4, QUESTIONS[3], narrative.services, [figure(4, 'PO value incl. GST per service line', chart, NOTHING)]),
    reportTable({
      columns: [
        { header: 'Service line', value: (r) => r.line },
        // Each PO once in the total, however many lines it is in.
        { header: 'POs', value: (r) => number(r.pos), total: (t) => number(t.pos), align: 'right', width: 50 },
        { header: 'PO value (INR)', value: (r) => inr(r.value_inr), total: (t) => inr(t.value_inr), align: 'right', width: 100 },
        { header: 'Share of value', value: (r) => (r.pct == null ? '—' : `${r.pct}%`), align: 'right', width: 70 },
      ],
      rows: services.rows,
      total: services.total,
    }),
    {
      text: 'A PO counts once in each line it names, so the PO counts can add up to more than the POs; its value is split between them, so the values add up to the total. '
        + `Split from: ${plural(src.po_services, 'PO')} by the service lines recorded on the PO, ${plural(src.quotation_lines, 'PO')} by quotation lines, `
        + `${plural(src.keywords, 'PO')} by keywords in the service text${services.bundled ? ', a bundle split equally' : ''}.`,
      style: 'lead',
      margin: [0, 3, 0, 0],
    },
  ];
}

function customersSection(report) {
  const { customers, narrative } = report;
  const t = customers.tiles;
  if (!t.customers && !t.enquiries_from_new && !t.enquiries_from_existing) return [section(5, QUESTIONS[4], NOTHING)];
  const enquiries = customers.new_customer_enquiries;
  const repeats = customers.repeat_orders;
  return [
    section(5, QUESTIONS[4], narrative.customers, [{
      table: {
        widths: ['*', '*', '*', '*'],
        body: [[
          tile(number(t.new_customers), 'New customers', 'first-ever PO in the period'),
          tile(number(t.existing_customers), 'Existing customers', 'ordered before the period too'),
          tile(number(t.repeat_orders), 'Repeat orders', `${compactInr(t.repeat_value_inr)} of PO value`),
          tile(t.repeat_share_pct == null ? '—' : `${t.repeat_share_pct}%`, 'Repeat share of value', `first orders ${compactInr(t.first_order_value_inr)}`),
        ]],
      },
      layout: { hLineWidth: () => 0.6, vLineWidth: () => 0.6, hLineColor: () => INK[200], vLineColor: () => INK[200], fillColor: () => '#f7f9fc' },
      margin: [0, 2, 0, 8],
    }]),
    { text: 'Enquiries from new customers', style: 'h2' },
    { text: 'Enquiries from a customer with no PO before the enquiry\'s own date, including customers who have never ordered.', style: 'lead' },
    reportTable({
      columns: [
        { header: 'Enquiry', value: (r) => r.enquiry_no, width: 80 },
        { header: 'Client', value: (r) => r.client },
        { header: 'Received', value: (r) => dateLabel(r.date), width: 70 },
        { header: 'Outcome', value: (r) => OUTCOME_LABEL[r.outcome] ?? r.outcome, width: 90 },
      ],
      rows: enquiries.slice(0, MAX_LIST_ROWS),
      empty: 'No enquiries from new customers in this period.',
    }),
    more(MAX_LIST_ROWS, enquiries.length, 'new customers'),
    { text: 'Repeat orders from existing customers', style: 'h2' },
    reportTable({
      columns: [
        { header: 'Client', value: (r) => r.customer },
        { header: 'PO', value: (r) => r.po_number, width: 80 },
        { header: 'PO date', value: (r) => dateLabel(r.po_date), width: 62 },
        { header: 'Service', value: (r) => r.service || '—' },
        { header: 'PO value (INR)', value: (r) => (r.po_value_inr == null ? '—' : inr(r.po_value_inr)), align: 'right', width: 80 },
        { header: 'Earlier POs', value: (r) => number(r.previous_orders), align: 'right', width: 48 },
      ],
      rows: repeats.slice(0, MAX_LIST_ROWS),
      empty: 'No repeat orders in this period.',
      compact: true,
    }),
    more(MAX_LIST_ROWS, repeats.length, 'repeat orders'),
  ];
}

function revenueSection(report) {
  const { revenue, narrative } = report;
  if (!revenue.total.pos && !revenue.total.invoiced_inr && !revenue.total.received_inr) return [section(6, QUESTIONS[5], NOTHING)];
  const months = revenue.months.filter((m) => m.key);
  const chart = stackedColumns({
    categories: months.map((m) => m.label),
    series: [{ name: 'PO value incl. GST', color: COLORS.navy, values: months.map((m) => m.po_value_inr) }],
    width: W, legend: false, formatValue: compactInr, formatAxis: compactInr,
  });
  const pos = revenue.months.flatMap((m) => m.detail);
  return [
    section(6, QUESTIONS[5], narrative.revenue, [figure(6, 'PO value incl. GST per month, by PO date', chart, NOTHING)]),
    reportTable({
      columns: [
        { header: 'Month', value: (r) => r.label },
        { header: 'POs', value: (r) => number(r.pos), total: (t) => number(t.pos), align: 'right', width: 40 },
        { header: 'PO value incl. GST', value: (r) => inr(r.po_value_inr), total: (t) => inr(t.po_value_inr), align: 'right', width: 95 },
        { header: 'Invoiced', value: (r) => inr(r.invoiced_inr), total: (t) => inr(t.invoiced_inr), align: 'right', width: 85 },
        { header: 'Received', value: (r) => inr(r.received_inr), total: (t) => inr(t.received_inr), align: 'right', width: 85 },
      ],
      rows: revenue.months,
      total: revenue.total,
    }),
    {
      text: 'Revenue is the value of the POs that count as a sale (not cancelled, not replaced by a revision), including GST, by PO date, converted to INR at the rate on the PO date. '
        + 'Invoiced and received are dated by the invoice and the payment: the billing and cash view of each month, not a split of its PO value.',
      style: 'lead',
      margin: [0, 3, 0, 0],
    },
    // Nine columns do not fit a portrait page, so the list gets a landscape one.
    pos.length
      ? {
        stack: [
          { text: 'The sales behind each month', style: 'h2' },
          reportTable({
            columns: [
              { header: 'PO', value: (r) => r.po_number, width: 80 },
              { header: 'PO date', value: (r) => dateLabel(r.po_date), width: 62 },
              { header: 'Client', value: (r) => r.client },
              { header: 'Sector', value: (r) => r.sector, width: 80 },
              { header: 'Service', value: (r) => r.service || '—' },
              { header: 'Owner', value: (r) => r.owner || '—', width: 70 },
              { header: 'PO value (INR)', value: (r) => (r.po_value_inr == null ? (r.po_value == null ? 'No value' : money(r.po_value, r.currency)) : inr(r.po_value_inr)), align: 'right', width: 80 },
              { header: 'Invoiced', value: (r) => inr(r.invoiced_inr), align: 'right', width: 70 },
              { header: 'Received', value: (r) => inr(r.received_inr), align: 'right', width: 70 },
            ],
            rows: pos.slice(0, MAX_PO_ROWS),
            compact: true,
          }),
          more(MAX_PO_ROWS, pos.length, 'revenue POs'),
        ].filter(Boolean),
        pageBreak: 'before',
        pageOrientation: 'landscape',
      }
      : null,
  ];
}

function notesSection(report, { landscapeBefore }) {
  const items = [
    ...report.notes.map((n) => n.text),
    ...(report.stale_rates ?? []).map((r) => `The newest ${r.currency} rate is from ${dateLabel(r.effective_from)}; recent ${r.currency} amounts convert at it.`),
  ];
  return [{
    stack: [
      { text: 'Notes and what to fix', style: 'h1' },
      { text: items.length ? 'What limits these figures, and where to correct it in the tracker.' : 'Nothing in the source data limits these figures.', style: 'body' },
      items.length ? { ul: items, style: 'body' } : null,
      { text: 'How these are counted', style: 'h2' },
      {
        ul: [
          'Enquiries count on their enquiry date, or the day they were created when it is blank. Their outcome is judged as of the end of the period: a PO after it does not count.',
          'Lost means closed as Unqualified without a quotation. An enquiry that was quoted is never lost: if its quotation was lost or expired it is "Quoted, not won".',
          'Sectors and service lines are the categories set under Settings > Report categories; anything else is Other.',
          'A new customer\'s first-ever PO falls in the period, judged against every PO on record. A repeat order is any PO that is not the customer\'s first.',
          'Every amount is converted to INR at the rate in force on its own date. An amount with no rate is left out and named above, never guessed.',
        ],
        style: 'small',
      },
    ].filter(Boolean),
    ...(landscapeBefore ? { pageBreak: 'before', pageOrientation: 'portrait' } : { margin: [0, 16, 0, 0] }),
  }];
}

/* ------------------------------------------------------------ document */

/**
 * `report` is salesReport()'s result. `owner` names the salesperson an admin
 * narrowed it to; `company` is the name from Settings → Company profile.
 */
export function reportDocDefinition(report, { owner = null, company = 'Cetizion Verifica', generatedAt = new Date(), timeZone = 'Asia/Kolkata' } = {}) {
  const periodText = periodLabel(report.period);
  const stamp = generatedStamp(generatedAt, timeZone);
  const revenue = revenueSection(report);
  const landscape = revenue.some((node) => node?.pageOrientation === 'landscape');

  const cover = [
    {
      table: {
        widths: ['*'],
        body: [[{
          stack: [
            { text: company.toUpperCase(), style: 'brandTag' },
            { text: 'Sales Report', style: 'title' },
            { text: `Period: ${periodText}${owner ? `  ·  Owner: ${owner}` : ''}`, style: 'subtitle' },
          ],
          fillColor: COLORS.navy,
          margin: [18, 16, 18, 16],
        }]],
      },
      layout: 'noBorders',
    },
    { text: `Generated ${stamp}`, style: 'small', margin: [0, 6, 0, 10] },
    summaryStrip(report),
    { text: 'IN THIS REPORT', style: 'kicker' },
    { ol: [...QUESTIONS, 'Notes and what to fix'], style: 'small' },
  ];

  return {
    pageSize: 'A4',
    pageOrientation: 'portrait',
    pageMargins: [MARGIN_X, 48, MARGIN_X, 42],
    info: {
      title: `${company} Sales Report — ${periodText}`,
      author: 'Cetizion Tracker',
      subject: `Period: ${periodText}`,
      creator: 'Cetizion Tracker',
    },
    defaultStyle: { font: 'Roboto', fontSize: 8, color: INK[900], lineHeight: 1.15 },
    header: (currentPage) => (currentPage === 1
      ? { text: '' }
      : {
        columns: [
          { text: `${company.toUpperCase()}  ·  SALES REPORT`, style: 'runningHead' },
          { text: periodText, style: 'runningHead', alignment: 'right' },
        ],
        margin: [MARGIN_X, 22, MARGIN_X, 0],
      }),
    footer: (currentPage, pageCount) => ({
      columns: [
        { text: `${periodText}  ·  ${company}, confidential`, style: 'footer' },
        { text: `Page ${currentPage} of ${pageCount}`, style: 'footer', alignment: 'right' },
      ],
      margin: [MARGIN_X, 14, MARGIN_X, 0],
    }),
    content: [
      ...cover,
      { text: '', pageBreak: 'after' },
      ...enquiriesSection(report),
      ...outcomesSection(report),
      ...sectorsSection(report),
      ...servicesSection(report),
      ...customersSection(report),
      ...revenue,
      ...notesSection(report, { landscapeBefore: landscape }),
    ].filter(Boolean),
    styles: PDF_STYLES,
  };
}

/** The finished PDF as a Buffer. */
export function reportPdf(report, options) {
  return pdfmake.createPdf(reportDocDefinition(report, options)).getBuffer();
}

