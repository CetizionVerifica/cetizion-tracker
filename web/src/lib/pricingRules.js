/**
 * The pricing rules' vocabulary as the Pricing tab edits it (#208 phase 2C).
 * Pure helpers, no React. The server is the judge of a rule (pricing.js
 * validatePricing): these only keep the editor offering what it accepts,
 * and never work a price out (web/CLAUDE.md §2.3).
 */

/** Every block a quantity or a rate may be built from, in the server's own words. */
export const VALUE_KINDS = [
  { kind: 'fixed', label: 'A fixed number' },
  { kind: 'catalogue', label: 'The catalogue rate' },
  { kind: 'answer', label: 'An answer (number or money)' },
  { kind: 'count', label: 'How many options were chosen' },
  { kind: 'rows', label: 'How many rows a table has' },
  { kind: 'sum', label: 'A table column added up' },
  { kind: 'band', label: 'Look up a band' },
  { kind: 'multiply', label: 'Multiply' },
  { kind: 'add', label: 'Add' },
  { kind: 'min', label: 'The smallest of' },
  { kind: 'max', label: 'The largest of' },
  { kind: 'round_up', label: 'Round up to a whole number' },
];
export const LIST_KINDS = new Set(['multiply', 'add', 'min', 'max']);

/** What "include when" may compare, by question type (pricing.js INCLUDE_IF_BY_TYPE). */
export const INCLUDE_OPS = {
  yesno: ['eq', 'neq'],
  number: ['eq', 'neq', 'in', 'gt', 'gte', 'lt', 'lte'],
  money: ['eq', 'neq', 'in', 'gt', 'gte', 'lt', 'lte'],
  select: ['eq', 'neq', 'in'], radio: ['eq', 'neq', 'in'], multiselect: ['eq', 'neq', 'in'], checkbox: ['eq', 'neq', 'in'],
  text: ['eq', 'neq', 'in'], textarea: ['eq', 'neq', 'in'], date: ['eq', 'neq', 'in'],
};

const NUMERIC = new Set(['number', 'money']);
const MANY = new Set(['multiselect', 'checkbox']);

export const kindOf = (v) => (v && typeof v === 'object' ? Object.keys(v)[0] : null);
export const allQuestions = (def) => (def?.steps || []).flatMap((s) => s.questions || []);

/** The questions a block of this kind may read; only these are offered. */
export function questionsFor(kind, def) {
  const qs = allQuestions(def);
  switch (kind) {
    case 'answer': return qs.filter((q) => NUMERIC.has(q.type));
    case 'count': return qs.filter((q) => MANY.has(q.type));
    case 'rows': case 'sum': return qs.filter((q) => q.type === 'table');
    case 'include': return qs.filter((q) => INCLUDE_OPS[q.type]);
    default: return [];
  }
}

/** A table's number or money columns, the only ones that can be added up. */
export const numericColumns = (table) => (table?.columns || []).filter((c) => NUMERIC.has(c.type));

/** A new block of a kind, filled with the first thing it can read. */
export function blankValue(kind, def) {
  const first = (k) => questionsFor(k, def)[0]?.key || '';
  switch (kind) {
    case 'fixed': return { fixed: 0 };
    case 'catalogue': return { catalogue: true };
    case 'answer': return { answer: first('answer') };
    case 'count': return { count: first('count') };
    case 'rows': return { rows: first('rows') };
    case 'sum': {
      const table = questionsFor('sum', def)[0];
      return { sum: { table: table?.key || '', column: numericColumns(table)[0]?.key || '' } };
    }
    case 'band': return { band: { of: { answer: first('answer') }, bands: [[1, 10, 1]] } };
    case 'round_up': return { round_up: { fixed: 0 } };
    default: return LIST_KINDS.has(kind) ? { [kind]: [{ fixed: 1 }] } : { fixed: 0 };
  }
}

/** Bands as rows: one changed cell, one row added after the last (starting where it stopped), one removed. */
export function setBandCell(bands, row, col, value) {
  return bands.map((b, i) => (i === row ? b.map((x, j) => (j === col ? value : x)) : b));
}
export function addBand(bands) {
  const last = bands[bands.length - 1];
  const from = last ? Number(last[1]) + 1 : 1;
  return [...bands, [from, from, last ? Number(last[2]) : 1]];
}
export const removeBand = (bands, row) => bands.filter((_, i) => i !== row);

/**
 * Why Publish waits, in one sentence, or null when nothing in the pricing
 * blocks it (web/src/components/serviceQuotes/CLAUDE.md §2): problems the
 * server listed, or pricing edits not saved yet, which Publish would
 * otherwise leave behind. The server refuses a publish with problems
 * regardless; this only says so before the click.
 */
export function publishHold(pricingProblems, unsavedPricing = false) {
  const n = (pricingProblems || []).length;
  if (n) return `Publishing waits until the ${n === 1 ? 'pricing problem' : `${n} pricing problems`} on the Pricing tab ${n === 1 ? 'is' : 'are'} fixed and saved.`;
  if (unsavedPricing) return 'Publishing waits until the changes on the Pricing tab are saved.';
  return null;
}

/** A new line with a key no other line has. */
export function newLine(lines) {
  const taken = new Set(lines.map((l) => l.key));
  let n = lines.length + 1;
  while (taken.has(`line_${n}`)) n += 1;
  return { key: `line_${n}`, description: '', rate: { catalogue: true } };
}

/**
 * The server's problems ("Line 2 (audit), rate: …") beside the line they are
 * about, found by its key, so they stay with it when lines are moved or
 * removed before the next save; anything else (a shape error, "lines.0.rate:
 * …", a line no longer there) is listed for the whole tab.
 */
export function problemsByLine(problems, lines) {
  const byLine = lines.map(() => []);
  const general = [];
  for (const p of problems || []) {
    const named = /^Line \d+ \(([^)]*)\)/.exec(p);
    const shaped = /^lines\.(\d+)\./.exec(p);
    const i = named ? lines.findIndex((l) => l.key === named[1]) : shaped ? Number(shaped[1]) : -1;
    if (i >= 0 && i < lines.length) byLine[i].push(named ? p.replace(/^Line \d+ \([^)]*\)(, )?:? ?/, '') : p.replace(/^lines\.\d+\./, ''));
    else general.push(p);
  }
  return { byLine, general };
}
