import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import pdfmake from 'pdfmake';

/**
 * The whole sales report as one A4 landscape PDF, built on the server from
 * the same report data the page and the CSV downloads use, so the numbers
 * cannot disagree. Nothing is stored and no outside service is involved.
 */

const require = createRequire(import.meta.url);
const ROBOTO = require('pdfmake/fonts/Roboto.js');
const FONT_DIR = resolve(dirname(ROBOTO.Roboto.normal));

pdfmake.setFonts(ROBOTO);
// The report is built only from our own data: it may read the bundled fonts
// and nothing else, and it never fetches a URL.
pdfmake.setUrlAccessPolicy(() => false);
pdfmake.setLocalAccessPolicy((path) => resolve(path).startsWith(FONT_DIR));

// The app's palette (web/src/styles.css).
const BRAND_700 = '#0f766e';
const BRAND_600 = '#0d9488';
const BRAND_200 = '#99f6e4';
const BRAND_100 = '#ccfbf1';
const BRAND_50 = '#f0fdfa';
const INK_900 = '#0f172a';
const INK_700 = '#334155';
const INK_500 = '#64748b';
const INK_200 = '#e2e8f0';
const INK_100 = '#f1f5f9';
const INK_50 = '#f8fafc';
const WARN_BG = '#fffbeb';
const WARN_FG = '#b45309';
const WARN_BR = '#fde68a';

const PAGE_WIDTH = 841.89 - 72; // A4 landscape less the side margins
const WON = 'Won - PO Received';

// ---------------------------------------------------------------------
// Formatting — the same conventions as the web app
// ---------------------------------------------------------------------

const SYMBOL = { INR: '₹', EUR: '€', USD: '$', GBP: '£', AED: 'AED ', SGD: 'S$' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Indian grouping for rupees, western grouping for everything else. */
export function money(value, currency = 'INR') {
  if (value === null || value === undefined || value === '' || Number.isNaN(Number(value))) return '—';
  const n = Number(value);
  const locale = currency === 'INR' ? 'en-IN' : 'en-US';
  const digits = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(Math.abs(n));
  return `${n < 0 ? '-' : ''}${SYMBOL[currency] ?? `${currency} `}${digits}`;
}

const number = (value) => (value === null || value === undefined ? '—' : new Intl.NumberFormat('en-IN').format(Number(value)));
const percent = (value) => (value === null || value === undefined ? '—' : `${Math.round(Number(value) * 100)}%`);
const amounts = (list) => (list?.length ? list.map((a) => money(a.amount, a.currency)).join(' · ') : '—');

function dateLabel(value) {
  if (!value) return '—';
  const [y, m, d] = String(value).slice(0, 10).split('-');
  return `${d} ${MONTHS[Number(m) - 1]} ${y}`;
}

function periodLabel({ from, to } = {}) {
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

function generatedStamp(date, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone, day: '2-digit', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(date).map((part) => [part.type, part.value])
  );
  return `${parts.day} ${MONTHS[Number(parts.month) - 1]} ${parts.year}, ${parts.hour}:${parts.minute} (${timeZone})`;
}

// ---------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------

const TABLE_LAYOUT = {
  hLineWidth: (i, node) => (i === 0 || i === node.table.body.length ? 0 : i === node.table.headerRows ? 0.8 : 0.4),
  vLineWidth: () => 0,
  hLineColor: (i, node) => (i === node.table.headerRows ? BRAND_700 : INK_200),
  fillColor: (row, node) => (row < node.table.headerRows ? BRAND_700 : row % 2 === 0 ? INK_50 : null),
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
 * A report table: brand header, zebra rows, right-aligned figures, and an
 * optional bold Total row. column.value(row) and column.total(total) return
 * a string or a pdfmake node.
 */
function reportTable({ columns, rows, total, empty, fontSize = 8, compact = false }) {
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
      ...cell(i === 0 ? 'Total' : col.total ? col.total(total) : '', col),
      bold: true,
      fillColor: BRAND_50,
    })));
  }
  return {
    table: { headerRows: 1, dontBreakRows: true, widths: columns.map((col) => col.width ?? '*'), body },
    // Wide tables trade cell padding for column width so they fit the page.
    layout: compact ? { ...TABLE_LAYOUT, paddingLeft: () => 3, paddingRight: () => 3 } : TABLE_LAYOUT,
    fontSize,
  };
}

function sectionHeading(numberLabel, title, lead) {
  return [
    { text: [{ text: `${numberLabel}   `, color: BRAND_600 }, title], style: 'h1' },
    { canvas: [{ type: 'line', x1: 0, y1: 0, x2: PAGE_WIDTH, y2: 0, lineWidth: 1.2, lineColor: BRAND_200 }], margin: [0, 3, 0, 4] },
    lead ? { text: lead, style: 'lead' } : null,
  ].filter(Boolean);
}

/** Keep a sub-heading on the same page as a short table under it. */
function subsection(title, lead, table, rowCount) {
  const block = [{ text: title, style: 'h2' }, lead ? { text: lead, style: 'lead' } : null, table].filter(Boolean);
  return rowCount <= 14 ? { stack: block, unbreakable: true } : { stack: block };
}

function kpiCard(label, value, meta) {
  return {
    table: {
      widths: ['*'],
      body: [[{
        stack: [
          { text: label.toUpperCase(), style: 'kpiLabel' },
          { text: value, style: 'kpiValue' },
          { text: meta, style: 'kpiMeta' },
        ],
        margin: [9, 7, 9, 7],
      }]],
    },
    layout: {
      hLineWidth: () => 0.6,
      vLineWidth: (i) => (i === 0 ? 3 : 0.6),
      hLineColor: () => INK_200,
      vLineColor: (i) => (i === 0 ? BRAND_600 : INK_200),
      paddingLeft: () => 0,
      paddingRight: () => 0,
      paddingTop: () => 0,
      paddingBottom: () => 0,
    },
  };
}

function sectorBars(rows) {
  const won = rows.filter((row) => row.pos > 0);
  if (!won.length) return { text: 'No won POs in this period.', style: 'empty' };
  const width = 190;
  const max = Math.max(...won.map((row) => row.pos));
  return {
    stack: won.map((row) => ({
      stack: [
        {
          columns: [
            { text: row.sector, width: '*', bold: true },
            { text: `${row.pos} PO${row.pos === 1 ? '' : 's'} · ${row.customers} client${row.customers === 1 ? '' : 's'}`, width: 'auto', color: INK_500 },
          ],
          fontSize: 7.5,
        },
        {
          canvas: [
            { type: 'rect', x: 0, y: 0, w: width, h: 6, r: 3, color: INK_100 },
            { type: 'rect', x: 0, y: 0, w: Math.max(3, (width * row.pos) / max), h: 6, r: 3, color: BRAND_600 },
          ],
          margin: [0, 2, 0, 7],
        },
      ],
    })),
  };
}

// ---------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------

export function salesReportDocDefinition(data) {
  const {
    period = {}, year, filters = {}, sectors, customers, fx, revenue,
    generatedAt = new Date(), timeZone = 'UTC',
  } = data;

  const stamp = generatedStamp(generatedAt, timeZone);
  const periodText = periodLabel(period);
  const filterText = [
    filters.sector ? `Sector: ${filters.sector === '__none__' ? 'Not set' : filters.sector}` : null,
    filters.sales_person ? `Sales person: ${filters.sales_person}` : null,
  ].filter(Boolean).join(' · ') || 'None';

  // Exchange rates the figures used, and any currency left unconverted.
  const rates = new Map();
  for (const row of [...fx.rows, ...revenue.rows]) {
    if (row.currency !== 'INR' && !rates.has(row.currency)) rates.set(row.currency, row.rate);
  }
  const missingRates = [...new Set([
    ...fx.summary.missing_rates,
    ...customers.summary.total.unconverted.map((a) => a.currency),
    ...revenue.total.order_unconverted.map((a) => a.currency),
    ...revenue.total.po_missing_rates,
  ])].sort();
  const ratesText = rates.size
    ? [...rates].sort(([a], [b]) => a.localeCompare(b)).map(([currency, rate]) =>
        rate === null ? `${currency}: not set` : `1 ${currency} = ₹${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 4 }).format(rate)}`
      ).join('   ·   ')
    : 'Not needed — every amount in this report is in INR';

  const t = customers.summary.total;
  const rt = revenue.total;

  // ------------------------------------------------------------ warnings
  const warnings = [];
  if (sectors.summary.pos_without_sector > 0) {
    warnings.push(`${sectors.summary.pos_without_sector} of ${sectors.summary.pos} won POs have no sector, so they are shown under "Not set".`);
  }
  if (missingRates.length) {
    warnings.push(`No exchange rate is set for ${missingRates.join(', ')}. Those amounts are left out of the INR figures and shown next to them instead.`);
  }
  if (rt.not_registered > 0) {
    const withProject = rt.not_registered - rt.no_project;
    warnings.push(
      `No PO linked yet for ${rt.not_registered} of ${rt.orders_won} won orders in ${year}` +
      ` (${rt.no_project} without a project, ${withProject} with a project but no linked PO).` +
      ' Their PO value, invoiced and received are not in the invoicing figures yet.'
    );
  }
  const unlinked = revenue.unlinked_pos ?? [];
  if (unlinked.length) {
    warnings.push(
      `${unlinked.length} purchase order${unlinked.length === 1 ? ' is' : 's are'} not linked to a won quotation, so revenue` +
      ` does not count ${unlinked.length === 1 ? 'it' : 'them'}: ${unlinked.map((po) => po.po_number).join(', ')}.`
    );
  }

  // ------------------------------------------------------------- page 1
  const cover = [
    {
      table: {
        widths: ['*', 'auto'],
        body: [[
          {
            stack: [
              { text: 'CETIZION', style: 'brandTag' },
              { text: 'Sales Report', style: 'title' },
              { text: 'Sales performance, clients and revenue', style: 'subtitle' },
            ],
            fillColor: BRAND_700,
            margin: [18, 16, 0, 16],
          },
          {
            stack: [
              { text: 'SALES PERIOD', style: 'brandTag', alignment: 'right' },
              { text: periodText, color: '#ffffff', fontSize: 11, bold: true, alignment: 'right', margin: [0, 2, 0, 6] },
              { text: 'REVENUE YEAR', style: 'brandTag', alignment: 'right' },
              { text: String(year), color: '#ffffff', fontSize: 11, bold: true, alignment: 'right', margin: [0, 2, 0, 0] },
            ],
            fillColor: BRAND_700,
            margin: [0, 16, 18, 16],
          },
        ]],
      },
      layout: 'noBorders',
    },
    {
      table: {
        widths: [78, '*', 78, '*'],
        body: [
          [{ text: 'Generated', style: 'paramKey' }, { text: stamp, style: 'paramValue' },
            { text: 'Revenue filters', style: 'paramKey' }, { text: filterText, style: 'paramValue' }],
          [{ text: 'Exchange rates', style: 'paramKey' }, { text: ratesText, style: 'paramValue', colSpan: 3 }, {}, {}],
        ],
      },
      layout: {
        hLineWidth: (i, node) => (i === node.table.body.length ? 0.6 : 0),
        vLineWidth: () => 0,
        hLineColor: () => INK_200,
        paddingTop: () => 4,
        paddingBottom: () => 4,
        paddingLeft: () => 2,
      },
      margin: [0, 8, 0, 12],
    },
    {
      columns: [
        kpiCard('Won POs', number(sectors.summary.pos), `Win rate ${percent(sectors.summary.win_rate)} · ${number(sectors.summary.lost)} lost`),
        kpiCard(
          'Won value (INR)',
          money(t.won_value_inr),
          t.unconverted.length ? `+ ${amounts(t.unconverted)} without a rate` : fx.rows.length ? 'FX deals converted at the rates above' : 'All deals in INR'
        ),
        kpiCard('Pipeline', number(sectors.summary.pipeline), 'Open quotations'),
        kpiCard('Clients', number(t.clients), `${number(customers.summary.repeat.clients)} repeat · ${number(customers.summary.single.clients)} single enquiry`),
        kpiCard(`Order intake ${year}`, money(rt.order_intake_inr), `${number(rt.orders_won)} orders · average ${money(rt.average_deal_inr)}`),
      ],
      columnGap: 8,
    },
    warnings.length
      ? {
          table: {
            widths: ['*'],
            body: [[{
              stack: [
                { text: 'Needs attention', bold: true, color: WARN_FG, fontSize: 8.5, margin: [0, 0, 0, 3] },
                { ul: warnings, fontSize: 8, color: INK_700 },
              ],
              fillColor: WARN_BG,
              margin: [10, 7, 10, 7],
            }]],
          },
          layout: { hLineWidth: () => 0.6, vLineWidth: () => 0.6, hLineColor: () => WARN_BR, vLineColor: () => WARN_BR },
          margin: [0, 12, 0, 0],
        }
      : null,
  ].filter(Boolean);

  // ------------------------------------------------ 1. sector-wise POs
  const sectorSection = [
    { text: '', margin: [0, 14, 0, 0] },
    ...sectionHeading('1', 'Sector-wise POs', `${periodText} · enquiries by enquiry date, everything else by quotation date · won value in each deal's own currency`),
    {
      columns: [
        {
          width: '*',
          stack: [reportTable({
            columns: [
              { header: 'Sector', value: (r) => r.sector, width: '*' },
              { header: 'Enquiries', value: (r) => number(r.enquiries), total: (s) => number(s.enquiries), align: 'right', width: 48 },
              { header: 'POs won', value: (r) => number(r.pos), total: (s) => number(s.pos), align: 'right', width: 44 },
              { header: 'Lost', value: (r) => number(r.lost), total: (s) => number(s.lost), align: 'right', width: 32 },
              { header: 'Pipeline', value: (r) => number(r.pipeline), total: (s) => number(s.pipeline), align: 'right', width: 42 },
              { header: 'Win %', value: (r) => percent(r.win_rate), total: (s) => percent(s.win_rate), align: 'right', width: 36 },
              { header: 'Won value', value: (r) => amounts(r.amounts), total: (s) => amounts(s.amounts), align: 'right', width: 150 },
              { header: 'FX deals', value: (r) => number(r.fx_deals), total: (s) => number(s.fx_deals), align: 'right', width: 40 },
            ],
            rows: sectors.rows,
            total: sectors.summary,
            empty: 'No enquiries or quotations in this period.',
          })],
        },
        {
          width: 200,
          stack: [{ text: 'POs by sector', style: 'h2', margin: [0, 0, 0, 6] }, sectorBars(sectors.rows)],
        },
      ],
      columnGap: 18,
    },
  ];

  // ---------------------------------------------------- 2. FX deals
  const fxSection = [
    ...sectionHeading('2', 'FX deals', `${periodText} · won POs billed in a currency other than INR · INR value = won value × the exchange rate above`),
    reportTable({
      columns: [
        { header: 'Client', value: (r) => lines(r.customer, note(r.quotation_nos)), width: '*' },
        { header: 'Sector', value: (r) => r.sector, width: 110 },
        { header: 'Currency', value: (r) => r.currency, width: 48 },
        { header: 'Won POs', value: (r) => number(r.deals), total: (s) => number(s.deals), align: 'right', width: 46 },
        {
          header: 'Won value',
          value: (r) => lines(money(r.amount, r.currency), r.deals_without_value > 0 ? note(`${r.deals_without_value} with no value`) : null),
          total: (s) => amounts(s.amounts),
          align: 'right',
          width: 110,
        },
        { header: 'Rate', value: (r) => (r.rate === null ? 'Not set' : `₹${r.rate} / ${r.currency}`), align: 'right', width: 80 },
        {
          header: 'Won value (INR)',
          value: (r) => (r.amount_inr === null ? 'Rate not set' : money(r.amount_inr)),
          total: (s) => lines(money(s.amount_inr), s.missing_rates.length ? note(`excludes ${s.missing_rates.join(', ')}`, 'warnNote') : null),
          align: 'right',
          width: 100,
        },
      ],
      rows: fx.rows,
      total: fx.summary,
      empty: 'No FX deals in this period: every won PO is in INR.',
    }),
  ];

  // ------------------------------------------------ 3. client analysis
  const clientColumns = [
    { header: 'Client group', value: (r) => r.client, width: '*' },
    { header: 'Enquiries', value: (r) => number(r.enquiries), total: (s) => number(s.enquiries), align: 'right', width: 60 },
    { header: 'POs won', value: (r) => number(r.pos), total: (s) => number(s.pos), align: 'right', width: 60 },
    { header: 'Win %', value: (r) => percent(r.win_rate), total: (s) => percent(s.win_rate), align: 'right', width: 60 },
    {
      header: 'Won value (INR)',
      value: (r) => lines(money(r.won_value_inr), r.unconverted.length ? note(`+ ${amounts(r.unconverted)} (rate not set)`, 'warnNote') : null),
      total: (s) => lines(money(s.won_value_inr), s.unconverted.length ? note(`+ ${amounts(s.unconverted)} (rate not set)`, 'warnNote') : null),
      align: 'right',
      width: 150,
    },
    { header: 'Repeat orders', value: (r) => number(r.repeat_orders), total: (s) => number(s.repeat_orders), align: 'right', width: 70 },
  ];
  const repeatRows = customers.rows.filter((row) => row.pos_to_date >= 2);
  const singleRows = customers.rows.filter((row) => row.pos_to_date < 2);

  const clientSection = [
    ...sectionHeading('3', 'Client analysis', `${periodText} · each client counted once · repeat = 2 or more won POs up to the end of the period · repeat orders = won POs after the first`),
    subsection(
      `Repeat clients (${repeatRows.length})`,
      null,
      reportTable({ columns: clientColumns, rows: repeatRows, total: customers.summary.repeat, empty: 'No repeat clients in this period.' }),
      repeatRows.length
    ),
    subsection(
      `Single enquiry clients (${singleRows.length})`,
      'Every other client: one won PO, quoted but not won yet, or only on the Enquiries page',
      reportTable({ columns: clientColumns, rows: singleRows, total: customers.summary.single, empty: 'No single enquiry clients in this period.' }),
      singleRows.length
    ),
    subsection(
      'Client summary',
      null,
      reportTable({
        columns: [
          { header: 'Client type', value: (r) => r.label, width: '*' },
          { header: 'Clients', value: (r) => number(r.clients), total: (s) => number(s.clients), align: 'right', width: 60 },
          ...clientColumns.slice(1),
        ],
        rows: [
          { label: 'Repeat clients', ...customers.summary.repeat },
          { label: 'Single enquiry clients', ...customers.summary.single },
        ],
        total: t,
        empty: '',
      }),
      3
    ),
  ];

  // -------------------------------------------------------- 4. revenue
  const monthRows = revenue.months;
  const revenueSection = [
    ...sectionHeading('4', `Revenue ${year}`, `Calendar year ${year} · orders by their won quotation's date · filters: ${filterText}`),
    {
      columns: [
        {
          width: 290,
          stack: [
            { text: 'Order intake by month', style: 'h2', margin: [0, 0, 0, 4] },
            reportTable({
              columns: [
                { header: 'Month', value: (r) => r.label, width: 52 },
                { header: 'Orders won', value: (r) => number(r.orders_won), total: (s) => number(s.orders_won), align: 'right', width: 44 },
                {
                  header: 'Order intake (INR)',
                  value: (r) => lines(money(r.order_intake_inr), r.order_unconverted.length ? note(`+ ${amounts(r.order_unconverted)}`, 'warnNote') : null),
                  total: (s) => lines(money(s.order_intake_inr), s.order_unconverted.length ? note(`+ ${amounts(s.order_unconverted)}`, 'warnNote') : null),
                  align: 'right',
                  width: '*',
                },
                { header: 'Average deal (INR)', value: (r) => money(r.average_deal_inr), total: (s) => money(s.average_deal_inr), align: 'right', width: 68 },
              ],
              rows: monthRows,
              total: rt,
              empty: `No months in ${year}.`,
            }),
          ],
        },
        {
          width: '*',
          stack: [
            { text: 'Invoicing & collections by month', style: 'h2', margin: [0, 0, 0, 4] },
            reportTable({
              columns: [
                { header: 'Month', value: (r) => r.label, width: 48 },
                {
                  header: 'POs',
                  value: (r) => lines(number(r.pos), r.not_registered > 0 ? note(`${r.not_registered} without PO`, 'warnNote') : null),
                  total: (s) => lines(number(s.pos), s.not_registered > 0 ? note(`${s.not_registered} without PO`, 'warnNote') : null),
                  align: 'right',
                  width: 50,
                },
                { header: 'PO value (INR)', value: (r) => money(r.po_value_inr), total: (s) => money(s.po_value_inr), align: 'right', width: '*' },
                { header: 'Invoiced (INR)', value: (r) => money(r.invoiced_inr), total: (s) => money(s.invoiced_inr), align: 'right', width: '*' },
                { header: 'Received (INR)', value: (r) => money(r.received_inr), total: (s) => money(s.received_inr), align: 'right', width: '*' },
                { header: 'Due now (INR)', value: (r) => money(r.due_now_inr), total: (s) => money(s.due_now_inr), align: 'right', width: '*' },
                { header: 'Balance (INR)', value: (r) => money(r.balance_inr), total: (s) => money(s.balance_inr), align: 'right', width: '*' },
              ],
              rows: monthRows,
              total: rt,
              empty: `No months in ${year}.`,
            }),
          ],
        },
      ],
      columnGap: 14,
    },
    {
      stack: [
        { text: `Orders won in ${year} (${revenue.rows.length})`, style: 'h2', margin: [0, 14, 0, 2] },
        { text: 'PO value, invoiced, received and balance come from each order\'s purchase order · Balance = PO value − received', style: 'lead' },
        reportTable({
          fontSize: 7,
          compact: true,
          // 12 columns with 3pt padding each side leave 698pt; the fixed
          // widths below take 578 and Client takes the rest.
          columns: [
            { header: 'Date', value: (r) => dateLabel(r.quotation_date), width: 44 },
            { header: 'Quotation', value: (r) => r.quotation_no, width: 66 },
            { header: 'Client', value: (r) => r.client, width: '*' },
            { header: 'Sector', value: (r) => r.sector, width: 58 },
            { header: 'Sales person', value: (r) => r.sales_person ?? '—', width: 48 },
            {
              header: 'Order value',
              value: (r) => lines(
                r.quotation_value === null ? 'No value' : money(r.quotation_value, r.currency),
                r.currency !== 'INR' && r.quotation_value !== null ? note(r.order_value_inr === null ? 'rate not set' : money(r.order_value_inr)) : null
              ),
              align: 'right',
              width: 58,
            },
            { header: 'PO', value: (r) => (r.po_count > 0 ? r.po_numbers : r.project_id ? 'No PO yet' : 'No project yet'), width: 52 },
            { header: 'PO value (INR)', value: (r) => money(r.po_value_inr), align: 'right', width: 52 },
            { header: 'Invoiced (INR)', value: (r) => money(r.invoiced_inr), align: 'right', width: 52 },
            { header: 'Received (INR)', value: (r) => money(r.received_inr), align: 'right', width: 52 },
            { header: 'Balance (INR)', value: (r) => money(r.balance_inr), align: 'right', width: 52 },
            { header: 'Status', value: (r) => r.payment_status ?? '—', width: 44 },
          ],
          rows: revenue.rows,
          empty: `No orders won in ${year}${filterText === 'None' ? '' : ' matching the filters'}.`,
        }),
      ],
    },
  ];

  // --------------------------------------------------------- 5. notes
  const notesSection = [
    ...sectionHeading('5', 'Notes & definitions'),
    {
      ul: [
        `Sections 1–3 cover ${periodText}: quotations by quotation date, enquiries by enquiry date. Section 4 covers calendar year ${year}${filterText === 'None' ? '' : ` (${filterText})`}.`,
        `A PO is a quotation marked "${WON}". Enquiries are the rows on the Enquiries page; an enquiry that became a quotation counts once, as an enquiry.`,
        'Pipeline = quotations Submitted, Under Negotiation or On Hold, so POs won + Lost + Pipeline = all quotations in the period.',
        'Win % = POs won ÷ (POs won + Lost). Open deals have no outcome yet, so they are left out.',
        'FX deal = a won PO in a currency other than INR. INR values use the exchange rates set in Settings; an amount with no rate is shown separately, never guessed.',
        'Clients and sectors are grouped by spelling: capital letters and extra spaces are ignored, any other difference is a separate name.',
        'Repeat client = 2 or more won POs up to the end of the period; every other client is a single enquiry client. Repeat orders = won POs after a client\'s first.',
        'Order intake = won quotation values in INR. Average deal = order intake ÷ the orders that have a value.',
        'PO value, invoiced, received and due now come from the purchase orders linked to each won order, so a PO counts once. Balance = PO value − received.',
      ],
      fontSize: 8.5,
      color: INK_700,
      lineHeight: 1.3,
    },
  ];

  return {
    pageSize: 'A4',
    pageOrientation: 'landscape',
    pageMargins: [36, 46, 36, 40],
    info: {
      title: `Cetizion Sales Report — ${periodText}`,
      author: 'Cetizion Tracker',
      subject: `Sales ${periodText}; revenue ${year}`,
      creator: 'Cetizion Tracker',
    },
    defaultStyle: { font: 'Roboto', fontSize: 8, color: INK_900, lineHeight: 1.15 },
    header: (currentPage) =>
      currentPage === 1
        ? { text: '' }
        : {
            columns: [
              { text: 'CETIZION  ·  SALES REPORT', style: 'runningHead' },
              { text: `Sales ${periodText}  ·  Revenue ${year}`, style: 'runningHead', alignment: 'right' },
            ],
            margin: [36, 22, 36, 0],
          },
    footer: (currentPage, pageCount) => ({
      columns: [
        { text: `Generated ${stamp}  ·  Internal and confidential`, style: 'footer' },
        { text: `Page ${currentPage} of ${pageCount}`, style: 'footer', alignment: 'right' },
      ],
      margin: [36, 14, 36, 0],
    }),
    content: [
      ...cover,
      ...sectorSection,
      { text: '', pageBreak: 'before' },
      ...fxSection,
      { text: '', margin: [0, 10, 0, 0] },
      ...clientSection,
      { text: '', pageBreak: 'before' },
      ...revenueSection,
      { text: '', pageBreak: 'before' },
      ...notesSection,
    ],
    styles: {
      brandTag: { fontSize: 7, bold: true, color: BRAND_100, characterSpacing: 1.5 },
      title: { fontSize: 24, bold: true, color: '#ffffff', margin: [0, 2, 0, 1] },
      subtitle: { fontSize: 9.5, color: BRAND_100 },
      h1: { fontSize: 13, bold: true, color: INK_900 },
      h2: { fontSize: 9.5, bold: true, color: INK_900, margin: [0, 10, 0, 3] },
      lead: { fontSize: 7.5, color: INK_500, margin: [0, 0, 0, 6] },
      th: { bold: true, color: '#ffffff', fontSize: 7.5 },
      cellNote: { fontSize: 6.5, color: INK_500 },
      warnNote: { fontSize: 6.5, color: WARN_FG },
      kpiLabel: { fontSize: 6.5, bold: true, color: INK_500, characterSpacing: 0.6 },
      kpiValue: { fontSize: 15, bold: true, color: INK_900, margin: [0, 3, 0, 2] },
      kpiMeta: { fontSize: 7, color: INK_500 },
      paramKey: { fontSize: 7.5, color: INK_500 },
      paramValue: { fontSize: 8, color: INK_900 },
      runningHead: { fontSize: 7, color: INK_500, characterSpacing: 0.4 },
      footer: { fontSize: 7, color: INK_500 },
      empty: { fontSize: 8, italics: true, color: INK_500, margin: [0, 2, 0, 8] },
    },
  };
}

/** The finished PDF as a Buffer. */
export function salesReportPdf(data) {
  return pdfmake.createPdf(salesReportDocDefinition(data)).getBuffer();
}
