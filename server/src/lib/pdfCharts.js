import { number } from './reportFormat.js';

/**
 * Charts for the sales review PDF, drawn as SVG that pdfmake renders as
 * vector graphics — no image files, no browser, no outside service. Text is
 * set in Roboto, the PDF's own font, so ₹ prints. Each builder returns
 * { svg, width, height }, or null when there is nothing to draw.
 */

export const COLORS = {
  navy: '#1f3864',
  blue: '#2d5b8a',
  sky: '#7ba7d4',
  pale: '#c9dbf0',
  green: '#2e7d5b',
  gold: '#c79a2e',
  red: '#b3432f',
  ink: '#1e293b',
  muted: '#64748b',
  grid: '#e5e7eb',
  axis: '#9ca3af',
};

const FONT = 'Roboto';

const esc = (value) =>
  String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const f = (n) => Number(n.toFixed(2));
/** Roughly how wide a line of text is; Roboto averages about half its size per character. */
const approxWidth = (value, size, bold = false) => String(value).length * size * (bold ? 0.55 : 0.5);

function text(x, y, value, { size = 8, anchor = 'start', color = COLORS.ink, bold = false, rotate = 0 } = {}) {
  const transform = rotate ? ` transform="rotate(${rotate} ${f(x)} ${f(y)})"` : '';
  return `<text x="${f(x)}" y="${f(y)}" font-family="${FONT}" font-size="${size}" fill="${color}" text-anchor="${anchor}"${
    bold ? ' font-weight="bold"' : ''
  }${transform}>${esc(value)}</text>`;
}
const rect = (x, y, w, h, color) =>
  `<rect x="${f(x)}" y="${f(y)}" width="${f(Math.max(0, w))}" height="${f(Math.max(0, h))}" fill="${color}"/>`;
const line = (x1, y1, x2, y2, color, width = 0.5) =>
  `<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}" stroke="${color}" stroke-width="${width}"/>`;
const svgDoc = (width, height, parts) => ({
  width,
  height,
  svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${parts.join('')}</svg>`,
});

/** A round axis maximum and step: 0–25 in 5s rather than 0–23 in 5.75s. */
export function niceScale(max, ticks = 4, integer = false) {
  if (!(max > 0)) return { max: integer ? ticks : 1, step: integer ? 1 : 1 / ticks };
  const raw = max / ticks;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / magnitude;
  let step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * magnitude;
  if (integer) step = Math.max(1, Math.ceil(step));
  return { max: Math.ceil(max / step - 1e-9) * step, step };
}

/** Split a label into at most `maxLines` lines that fit `maxWidth`, ending in … if cut. */
export function wrapLabel(label, maxWidth, size = 8, maxLines = 2) {
  const maxChars = Math.max(4, Math.floor(maxWidth / (size * 0.5)));
  const lines = [];
  let current = '';
  for (const word of String(label).split(/\s+/).filter(Boolean)) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= maxChars || !current) current = next;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  const cut = lines.length > maxLines;
  const kept = lines.slice(0, maxLines).map((l) => (l.length > maxChars ? `${l.slice(0, maxChars - 1)}…` : l));
  if (cut) kept[maxLines - 1] = `${kept[maxLines - 1].slice(0, maxChars - 1).replace(/\s+$/, '')}…`;
  return kept;
}

const ticksOf = ({ max, step }) => Array.from({ length: Math.round(max / step) + 1 }, (_, i) => i * step);

/**
 * Vertical columns, stacked when there is more than one series. A series can
 * colour each column itself with `colors`. The total sits above each column.
 */
export function stackedColumns({
  categories,
  series,
  width,
  height = 190,
  yTitle = '',
  integer = false,
  formatValue = number,
  formatAxis = formatValue,
  legend = series.length > 1,
  valueLabels = true,
}) {
  const totals = categories.map((_, i) => series.reduce((sum, s) => sum + (s.values[i] || 0), 0));
  if (!categories.length || !totals.some((v) => v > 0)) return null;

  const scale = niceScale(Math.max(...totals), 4, integer);
  const ticks = ticksOf(scale);
  const left = (yTitle ? 14 : 0) + Math.max(...ticks.map((v) => approxWidth(formatAxis(v), 7))) + 8;
  const right = 6;
  const top = legend ? 28 : 16;
  const bottom = 20;
  const plotW = width - left - right;
  const plotH = height - top - bottom;
  const y = (v) => top + plotH - (v / scale.max) * plotH;
  const out = [];

  for (const v of ticks) {
    out.push(line(left, y(v), width - right, y(v), v === 0 ? COLORS.axis : COLORS.grid, v === 0 ? 0.8 : 0.5));
    out.push(text(left - 5, y(v) + 2.5, formatAxis(v), { size: 7, anchor: 'end', color: COLORS.muted }));
  }
  if (yTitle) out.push(text(8, top + plotH / 2, yTitle, { size: 7.5, anchor: 'middle', color: COLORS.muted, rotate: -90 }));

  const band = plotW / categories.length;
  const barW = Math.min(42, band * 0.64);
  // Thin the labels out when the columns are too narrow for every one.
  const every = Math.max(1, Math.ceil(categories.length / Math.max(1, Math.floor(plotW / 38))));
  const labelEveryBar = valueLabels && band >= 22;

  categories.forEach((category, i) => {
    const x = left + band * i + (band - barW) / 2;
    let base = 0;
    for (const s of series) {
      const v = s.values[i] || 0;
      if (v > 0) {
        out.push(rect(x, y(base + v), barW, y(base) - y(base + v), s.colors?.[i] ?? s.color));
        base += v;
      }
    }
    if (labelEveryBar && totals[i] > 0) {
      out.push(text(x + barW / 2, y(totals[i]) - 3.5, formatValue(totals[i]), { size: 7.5, anchor: 'middle', color: COLORS.navy, bold: true }));
    }
    if (i % every === 0) out.push(text(x + barW / 2, top + plotH + 12, category, { size: 7.5, anchor: 'middle' }));
  });

  if (legend) {
    let lx = left;
    for (const s of series) {
      out.push(rect(lx, 5, 9, 9, s.color));
      out.push(text(lx + 13, 12.5, s.name, { size: 7.5 }));
      lx += 13 + approxWidth(s.name, 7.5) + 18;
    }
  }
  return svgDoc(width, height, out);
}

const rankColor = (i) => [COLORS.navy, COLORS.blue][i] ?? (i < 5 ? COLORS.sky : COLORS.pale);

/** Horizontal bars with the label on the left and the value after the bar. */
export function horizontalBars({
  items,
  width,
  labelWidth = 130,
  valueWidth = 100,
  rowHeight = 22,
  integer = false,
  formatAxis = number,
}) {
  if (!items.length) return null;
  const top = 4;
  const axisH = 16;
  const height = top + items.length * rowHeight + axisH;
  const left = labelWidth;
  const plotW = width - left - valueWidth;
  const scale = niceScale(Math.max(0, ...items.map((item) => item.value)), 4, integer);
  const x = (v) => left + (v / scale.max) * plotW;
  const bottom = top + items.length * rowHeight;
  const out = [];

  for (const v of ticksOf(scale)) {
    if (v > 0) out.push(line(x(v), top, x(v), bottom, COLORS.grid));
    out.push(text(x(v), bottom + 11, formatAxis(v), { size: 7, anchor: 'middle', color: COLORS.muted }));
  }
  out.push(line(left, top, left, bottom, COLORS.axis, 0.8));

  items.forEach((item, i) => {
    const cy = top + i * rowHeight + rowHeight / 2;
    const barH = rowHeight * 0.62;
    const labels = wrapLabel(item.label, labelWidth - 10, 8);
    labels.forEach((label, k) => {
      out.push(text(left - 6, cy + 3 + (k - (labels.length - 1) / 2) * 9, label, { size: 8, anchor: 'end' }));
    });
    const end = item.value > 0 ? Math.max(left + 1.5, x(item.value)) : left;
    if (item.value > 0) out.push(rect(left, cy - barH / 2, end - left, barH, item.color ?? rankColor(i)));
    out.push(text(end + 5, cy + 3, item.valueLabel ?? formatAxis(item.value), { size: 7.5, bold: true, color: COLORS.navy }));
  });
  return svgDoc(width, height, out);
}

/** A donut with a figure in the middle and a legend to its right. */
export function donut({ slices, size = 120, legendWidth = 150, centerValue = '', centerLabel = '' }) {
  const total = slices.reduce((sum, s) => sum + (s.value > 0 ? s.value : 0), 0);
  if (!(total > 0)) return null;

  const legendH = slices.length * 16;
  const height = Math.max(size, legendH + 8);
  const width = size + legendWidth;
  const cx = size / 2;
  const cy = height / 2;
  const R = size / 2 - 3;
  const r = R * 0.6;
  const at = (radius, angle) => [f(cx + radius * Math.cos(angle)), f(cy + radius * Math.sin(angle))];
  const out = [];

  let angle = -Math.PI / 2;
  for (const s of slices) {
    if (!(s.value > 0)) continue;
    const sweep = (s.value / total) * Math.PI * 2;
    if (sweep >= Math.PI * 2 - 1e-6) {
      out.push(`<circle cx="${f(cx)}" cy="${f(cy)}" r="${f((R + r) / 2)}" fill="none" stroke="${s.color}" stroke-width="${f(R - r)}"/>`);
    } else {
      const large = sweep > Math.PI ? 1 : 0;
      const [x0, y0] = at(R, angle);
      const [x1, y1] = at(R, angle + sweep);
      const [x2, y2] = at(r, angle + sweep);
      const [x3, y3] = at(r, angle);
      out.push(
        `<path d="M ${x0} ${y0} A ${f(R)} ${f(R)} 0 ${large} 1 ${x1} ${y1} L ${x2} ${y2} A ${f(r)} ${f(r)} 0 ${large} 0 ${x3} ${y3} Z" fill="${s.color}" stroke="#ffffff" stroke-width="1.2"/>`
      );
    }
    if (s.value / total >= 0.08) {
      const [lx, ly] = at((R + r) / 2, angle + sweep / 2);
      out.push(text(lx, ly + 3, `${Math.round((s.value / total) * 100)}%`, { size: 7.5, anchor: 'middle', color: '#ffffff', bold: true }));
    }
    angle += sweep;
  }

  out.push(text(cx, cy + 3, centerValue, { size: 17, anchor: 'middle', color: COLORS.navy, bold: true }));
  out.push(text(cx, cy + 14, centerLabel, { size: 7, anchor: 'middle', color: COLORS.muted }));

  const legendTop = cy - legendH / 2 + 11;
  slices.forEach((s, i) => {
    const ly = legendTop + i * 16;
    out.push(rect(size + 12, ly - 8, 9, 9, s.color));
    const [label] = wrapLabel(s.legend ?? `${s.label} — ${number(s.value)}`, legendWidth - 26, 8, 1);
    out.push(text(size + 26, ly, label, { size: 8 }));
  });
  return svgDoc(width, height, out);
}
