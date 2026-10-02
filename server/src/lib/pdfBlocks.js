import { COLORS } from './pdfCharts.js';
import { MONTH_NAMES } from './reportFormat.js';

/**
 * The building blocks the sales report PDF (reportPdf.js) is made of: the
 * period and time stamps, the navy-headed report table, numbered sections,
 * figures, summary tiles and the type styles. They came from the Sales &
 * Enquiry Performance Review that PDF replaced, so its look carries over.
 */

const { navy: NAVY, blue: BLUE } = COLORS;
export const INK = { 900: '#0f172a', 700: '#334155', 500: '#64748b', 200: '#e2e8f0', 50: '#f8fafc' };
const NAVY_50 = '#eef2f8';
const MONTHS = MONTH_NAMES;

export const MARGIN_X = 42;
const W = Math.floor(595.28 - MARGIN_X * 2); // A4 portrait less the side margins

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

// ---------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------

const TABLE_LAYOUT = {
  hLineWidth: (i, node) => (i === 0 || i === node.table.body.length ? 0 : i === node.table.headerRows ? 0.8 : 0.4),
  vLineWidth: () => 0,
  hLineColor: (i, node) => (i === node.table.headerRows ? NAVY : INK[200]),
  fillColor: (row, node) => (row < node.table.headerRows ? NAVY : row % 2 === 0 ? INK[50] : null),
  paddingLeft: () => 5,
  paddingRight: () => 5,
  paddingTop: () => 3.5,
  paddingBottom: () => 3.5,
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
  canvas: [{ type: 'line', x1: 0, y1: 0, x2: W, y2: 0, lineWidth: 0.8, lineColor: INK[200] }],
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

export function figure(no, caption, chart, emptyText) {
  if (!chart) return { text: emptyText, style: 'empty' };
  return {
    stack: [{ svg: chart.svg, width: chart.width }, { text: `Figure ${no} — ${caption}`, style: 'caption' }],
    unbreakable: true,
    margin: [0, 4, 0, 8],
  };
}

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

/** The type styles. */
export const PDF_STYLES = {
  brandTag: { fontSize: 7.5, bold: true, color: '#c9dbf0', characterSpacing: 1.2 },
  title: { fontSize: 21, bold: true, color: '#ffffff', margin: [0, 4, 0, 4] },
  subtitle: { fontSize: 8.5, color: '#dbe5f2' },
  kicker: { fontSize: 8, bold: true, color: BLUE, characterSpacing: 1.2, margin: [0, 12, 0, 5] },
  h1: { fontSize: 13.5, bold: true, color: NAVY },
  h2: { fontSize: 9.5, bold: true, color: NAVY, margin: [0, 12, 0, 3] },
  body: { fontSize: 9, color: INK[700], lineHeight: 1.35, margin: [0, 0, 0, 6] },
  lead: { fontSize: 7.5, color: INK[500], margin: [0, 0, 0, 5] },
  caption: { fontSize: 7.5, italics: true, color: INK[500], margin: [0, 3, 0, 0] },
  small: { fontSize: 7.5, color: INK[500], lineHeight: 1.3 },
  th: { bold: true, color: '#ffffff', fontSize: 7.5 },
  tileValue: { fontSize: 17, bold: true, color: NAVY },
  tileLabel: { fontSize: 7.5, bold: true, color: INK[700], margin: [0, 2, 0, 0] },
  tileMeta: { fontSize: 7, color: INK[500], margin: [0, 1, 0, 0] },
  runningHead: { fontSize: 7, color: INK[500], characterSpacing: 0.4 },
  footer: { fontSize: 7, color: INK[500] },
  empty: { fontSize: 8, italics: true, color: INK[500], margin: [0, 2, 0, 8] },
};
