/**
 * A questionnaire version's pricing rules (#208 phase 2, module CLAUDE.md
 * §3). Pure functions: no database.
 *
 * A version's `pricing` is { lines: PricingLine[] }. Each line says when it
 * is included, and how its quantity and rate come from the answers, in a
 * small fixed vocabulary that our own code evaluates:
 *
 *   { fixed: 3 }                          a number
 *   { answer: "employee_count" }          a number or money answer
 *   { count: "standards" }                options chosen on a multi-select
 *   { rows: "sites" }                     rows in a table answer
 *   { sum: { table: "sites", column: "employees" } }   a table column added up
 *   { band: { of: <value>, bands: [[from, to, result], …] } }  inclusive ranges
 *   { catalogue: true }                   the service's default rate
 *   { multiply: [..] } { add: [..] } { min: [..] } { max: [..] }
 *   { round_up: <value> }                 up to the next whole number
 *
 * Nothing else: no eval, no Function, no user JavaScript, no AI.
 *
 *   pricingSchema                  the shape the rules must have
 *   validatePricing(pricing, def)  problems in the admin's words: a shape
 *                                  error, a key the definition does not
 *                                  have, a question of the wrong type, a
 *                                  band that is malformed or overlaps
 *   priceLines(version, answers, service)
 *                                  the quotation lines the answers produce.
 *                                  A line whose input is missing, outside
 *                                  every band, or beyond what a quotation
 *                                  line can hold is kept at rate 0 with
 *                                  price_needed and a reason: never a guess
 */
import { z } from 'zod';
import { allQuestions, isVisible, SHOW_IF_OPS } from '../questionnaireDefinition.js';

const NUMERIC = new Set(['number', 'money']);
const MANY = new Set(['multiselect', 'checkbox']);
/** How deep one value may nest, so a rule stays readable by a reviewer. */
const MAX_DEPTH = 6;
const NOT_A_BLOCK = 'not one of the pricing blocks: fixed, answer, count, rows, sum, band, catalogue, multiply, add, min, max, round_up';

const key = z.string().regex(/^[a-z][a-z0-9_]{0,59}$/, 'Lower-case letters, digits and _ only, starting with a letter');
const num = z.number().finite();

const value = z.lazy(() => z.union([
  z.object({ fixed: num }).strict(),
  z.object({ answer: key }).strict(),
  z.object({ count: key }).strict(),
  z.object({ rows: key }).strict(),
  z.object({ sum: z.object({ table: key, column: key }).strict() }).strict(),
  z.object({ band: z.object({ of: value, bands: z.array(z.tuple([num, num, num])).min(1).max(50) }).strict() }).strict(),
  z.object({ catalogue: z.literal(true) }).strict(),
  z.object({ multiply: z.array(value).min(1).max(10) }).strict(),
  z.object({ add: z.array(value).min(1).max(10) }).strict(),
  z.object({ min: z.array(value).min(1).max(10) }).strict(),
  z.object({ max: z.array(value).min(1).max(10) }).strict(),
  z.object({ round_up: value }).strict(),
]));

const includeIf = z.object({
  key,
  op: z.enum(SHOW_IF_OPS),
  value: z.union([z.string().max(200), z.number(), z.boolean(), z.array(z.union([z.string().max(200), z.number()])).max(50)]).optional(),
}).strict();

const line = z.object({
  key,
  description: z.string().trim().min(1).max(500),
  include_if: includeIf.optional(),
  qty: value.optional(),                       // left out = 1
  rate: value,
  multiply: z.array(value).max(10).optional(),
  unit: z.string().trim().max(40).nullable().optional(),        // null = the service's
  sac_code: z.string().trim().max(20).nullable().optional(),
  gst_rate: z.number().min(0).max(100).nullable().optional(),
  sort_order: z.number().int().optional(),
}).strict();

export const pricingSchema = z.object({ lines: z.array(line).max(50) }).strict();

/** Every answer a value reads, as { kind, key, column? }, and how deep it nests. */
function walk(v, refs = [], depth = 1) {
  let deepest = depth;
  const inner = (x) => { deepest = Math.max(deepest, walk(x, refs, depth + 1).depth); };
  if ('answer' in v) refs.push({ kind: 'answer', key: v.answer });
  else if ('count' in v) refs.push({ kind: 'count', key: v.count });
  else if ('rows' in v) refs.push({ kind: 'rows', key: v.rows });
  else if ('sum' in v) refs.push({ kind: 'sum', key: v.sum.table, column: v.sum.column });
  else if ('band' in v) inner(v.band.of);
  else if ('round_up' in v) inner(v.round_up);
  else for (const op of ['multiply', 'add', 'min', 'max']) if (op in v) v[op].forEach(inner);
  return { refs, depth: deepest };
}

/** A band list's own problems: from above to, or two ranges that share a number. */
function bandProblems(bands, where) {
  const problems = [];
  bands.forEach(([from, to], i) => { if (from > to) problems.push(`${where}: band ${i + 1} starts above where it ends`); });
  const sorted = bands.map(([from, to], i) => ({ from, to, n: i + 1 })).sort((a, b) => a.from - b.from);
  for (let i = 1; i < sorted.length; i++) {
    // Inclusive at both ends, so 1–45 and 45–125 overlap at 45.
    if (sorted[i].from <= sorted[i - 1].to) problems.push(`${where}: bands ${sorted[i - 1].n} and ${sorted[i].n} overlap`);
  }
  return problems;
}

function bandsIn(v, where, problems) {
  if ('band' in v) { problems.push(...bandProblems(v.band.bands, where)); bandsIn(v.band.of, where, problems); }
  else if ('round_up' in v) bandsIn(v.round_up, where, problems);
  else for (const op of ['multiply', 'add', 'min', 'max']) if (op in v) v[op].forEach((x) => bandsIn(x, where, problems));
}

/**
 * What "include when" may compare each kind of question with, following how
 * isVisible reads answers: "answered" works on any of them; a yes/no is
 * true or false; a number or money answer is a number, and the only one
 * "greater than" and the like make sense on; a choice is one of its own
 * options; text and dates are text.
 */
const INCLUDE_IF_BY_TYPE = {
  yesno: { ops: ['eq', 'neq'], fits: (x) => typeof x === 'boolean', needs: 'true or false' },
  number: { ops: ['eq', 'neq', 'in', 'gt', 'gte', 'lt', 'lte'], fits: (x) => typeof x === 'number', needs: 'a number' },
  money: { ops: ['eq', 'neq', 'in', 'gt', 'gte', 'lt', 'lte'], fits: (x) => typeof x === 'number', needs: 'a number' },
  select: { ops: ['eq', 'neq', 'in'], option: true },
  radio: { ops: ['eq', 'neq', 'in'], option: true },
  multiselect: { ops: ['eq', 'neq', 'in'], option: true },
  checkbox: { ops: ['eq', 'neq', 'in'], option: true },
  text: { ops: ['eq', 'neq', 'in'], fits: (x) => typeof x === 'string', needs: 'text' },
  textarea: { ops: ['eq', 'neq', 'in'], fits: (x) => typeof x === 'string', needs: 'text' },
  date: { ops: ['eq', 'neq', 'in'], fits: (x) => typeof x === 'string', needs: 'a date as text' },
};

/** An "include when" rule's problems against the question it points at. */
function includeIfProblems(rule, target, where) {
  if (!target) return [`${where}: "include when" points to "${rule.key}", which is not a question in this version`];
  if (['table', 'file', 'info'].includes(target.type)) return [`${where}: "include when" cannot depend on a ${target.type} question`];
  if (rule.op === 'answered') return [];
  const kind = INCLUDE_IF_BY_TYPE[target.type];
  if (!kind) return [`${where}: "include when" cannot depend on a ${target.type} question`];
  if (!kind.ops.includes(rule.op)) return [`${where}: "include when" on a ${target.type} question cannot use "${rule.op}"`];
  if (rule.value === undefined) return [`${where}: "include when" needs a value to compare with`];
  if (rule.op === 'in' && !Array.isArray(rule.value)) return [`${where}: "is one of" needs a list of values`];
  if (rule.op !== 'in' && Array.isArray(rule.value)) return [`${where}: "include when" compares with one value; use "is one of" for a list`];
  const values = Array.isArray(rule.value) ? rule.value : [rule.value];
  if (kind.option) {
    const keys = new Set((target.options || []).map((o) => o.key));
    return values.filter((x) => !keys.has(x)).map((x) => `${where}: "${x}" is not an option of "${rule.key}"`);
  }
  return values.some((x) => !kind.fits(x)) ? [`${where}: "include when" on "${rule.key}" needs ${kind.needs}`] : [];
}

/** Whether a question can feed a reference of this kind; the reason when not. */
function refProblem(ref, q) {
  if (!q) return `"${ref.key}" is not a question in this version`;
  switch (ref.kind) {
    case 'answer': return NUMERIC.has(q.type) ? null : `"${ref.key}" is a ${q.type} question; a quantity or rate needs a number or money answer`;
    case 'count': return MANY.has(q.type) ? null : `"${ref.key}" is a ${q.type} question; counting needs a multi-select or checkbox question`;
    case 'rows': return q.type === 'table' ? null : `"${ref.key}" is a ${q.type} question; counting rows needs a table question`;
    case 'sum': {
      if (q.type !== 'table') return `"${ref.key}" is a ${q.type} question; adding up a column needs a table question`;
      const col = (q.columns || []).find((c) => c.key === ref.column);
      if (!col) return `the table "${ref.key}" has no column "${ref.column}"`;
      return NUMERIC.has(col.type) ? null : `column "${ref.column}" of "${ref.key}" is ${col.type}; adding up needs a number or money column`;
    }
    default: return null;
  }
}

/**
 * Every problem with a version's pricing, checked against its definition,
 * in the admin's words. An empty list means the rules can be published.
 * Saving a draft shows the list but still saves; publishing refuses it.
 */
export function validatePricing(pricing, definition) {
  const parsed = pricingSchema.safeParse(pricing ?? { lines: [] });
  if (!parsed.success) {
    return parsed.error.issues.map((i) => `${i.path.join('.') || 'pricing'}: ${i.code === 'invalid_union' ? NOT_A_BLOCK : i.message}`);
  }
  const byKey = new Map(allQuestions(definition).map((q) => [q.key, q]));
  const problems = [];
  const seen = new Set();
  parsed.data.lines.forEach((l, li) => {
    const where = `Line ${li + 1} (${l.key})`;
    if (seen.has(l.key)) problems.push(`${where}: the key "${l.key}" is used twice`);
    seen.add(l.key);

    const values = [['quantity', l.qty], ['rate', l.rate], ...(l.multiply || []).map((m, i) => [`multiplier ${i + 1}`, m])]
      .filter(([, v]) => v);
    for (const [label, v] of values) {
      const { refs, depth } = walk(v);
      if (depth > MAX_DEPTH) problems.push(`${where}, ${label}: nested more than ${MAX_DEPTH} deep; split it up`);
      for (const ref of refs) {
        const why = refProblem(ref, byKey.get(ref.key));
        if (why) problems.push(`${where}, ${label}: ${why}`);
      }
      bandsIn(v, `${where}, ${label}`, problems);
    }

    if (l.include_if) problems.push(...includeIfProblems(l.include_if, byKey.get(l.include_if.key), where));
  });
  return problems;
}

const blank = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
/** An answer the client gave, never one inherited from Object (a question keyed "constructor"). */
const own = (obj, k) => (obj && Object.hasOwn(obj, k) ? obj[k] : undefined);
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * What a quotation line can hold (quotation_lines in schema.sql): qty
 * numeric(12,2), rate numeric(16,2), and amount numeric(16,2) generated as
 * qty × rate (a generated line has no discount). A line beyond them needs a
 * price rather than failing when it is saved.
 */
const MAX_QTY = 9_999_999_999.99;
const MAX_RATE = 99_999_999_999_999.99;
const MAX_AMOUNT = 99_999_999_999_999.99;
/** A number for a reason: Indian grouping, or 1.23e+20 when it is far beyond any line. */
const money = (n) => (Math.abs(n) < 1e15 ? n.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : n.toPrecision(3));
// Quantities round up, never down (module CLAUDE.md §3); toFixed first so 0.1 × 3 is 0.3, not 0.31.
const roundUp2 = (n) => Math.ceil(Number((n * 100).toFixed(6))) / 100;

/** A value in words, for the reason a line needs a price. */
function describe(v) {
  if ('answer' in v) return `"${v.answer}"`;
  if ('count' in v) return `the number of "${v.count}" chosen`;
  if ('rows' in v) return `the number of "${v.rows}" rows`;
  if ('sum' in v) return `the total "${v.sum.column}" in "${v.sum.table}"`;
  return 'the value';
}

const FOLDS = {
  multiply: (xs) => xs.reduce((a, b) => a * b, 1),
  add: (xs) => xs.reduce((a, b) => a + b, 0),
  min: (xs) => Math.min(...xs),
  max: (xs) => Math.max(...xs),
};

/**
 * One value worked out from the answers: { n } or { why }. Anything
 * missing or out of range comes back as a reason, never as a number.
 */
function evaluate(v, answers, service) {
  if ('fixed' in v) return { n: v.fixed };
  if ('answer' in v) {
    const a = own(answers, v.answer);
    if (blank(a)) return { why: `"${v.answer}" is not answered` };
    if (typeof a !== 'number' || !Number.isFinite(a)) return { why: `"${v.answer}" is not a number` };
    return { n: a };
  }
  if ('count' in v) {
    const a = own(answers, v.count);
    if (blank(a)) return { why: `"${v.count}" is not answered` };
    if (!Array.isArray(a)) return { why: `"${v.count}" is not a list of choices` };
    return { n: a.length };
  }
  if ('rows' in v) {
    const a = own(answers, v.rows);
    if (blank(a) || !Array.isArray(a)) return { why: `"${v.rows}" has no rows` };
    return { n: a.length };
  }
  if ('sum' in v) {
    const { table, column } = v.sum;
    const rows = own(answers, table);
    if (blank(rows) || !Array.isArray(rows)) return { why: `"${table}" has no rows` };
    let total = 0;
    for (let i = 0; i < rows.length; i++) {
      const cell = own(rows[i], column);
      if (typeof cell !== 'number' || !Number.isFinite(cell)) return { why: `"${column}" is missing in row ${i + 1} of "${table}"` };
      total += cell;
    }
    return { n: total };
  }
  if ('band' in v) {
    const of = evaluate(v.band.of, answers, service);
    if (of.why) return of;
    const hit = v.band.bands.find(([from, to]) => of.n >= from && of.n <= to);
    if (!hit) return { why: `${describe(v.band.of)} is ${of.n}, outside every band` };
    return { n: hit[2] };
  }
  if ('catalogue' in v) {
    const rate = service?.default_rate == null ? null : Number(service.default_rate);
    if (rate == null || !Number.isFinite(rate) || rate <= 0) return { why: 'the service has no default rate in the catalogue' };
    return { n: rate };
  }
  if ('round_up' in v) {
    const r = evaluate(v.round_up, answers, service);
    return r.why ? r : { n: Math.ceil(r.n) };
  }
  for (const [op, fold] of Object.entries(FOLDS)) {
    if (!(op in v)) continue;
    const ns = [];
    for (const x of v[op]) {
      const r = evaluate(x, answers, service);
      if (r.why) return r;
      ns.push(r.n);
    }
    return { n: fold(ns) };
  }
  return { why: 'the rule is not one this version understands' };
}

/** The questions a line's quantity, rate and multipliers read. */
function readsFrom(l) {
  return [l.qty, l.rate, ...(l.multiply || [])].filter(Boolean).flatMap((v) => walk(v).refs.map((r) => r.key));
}

/**
 * The lines a set of answers produces under a version's pricing. Pure:
 * reads and writes nothing. `answers` are the checked values
 * (checkAnswers); `service` is the services row (default_rate, unit,
 * gst_rate, sac_code).
 *
 * A line is left out when its "include when" is false, or when a question
 * it reads is hidden by show-if (that part of the form did not apply to
 * this client). A line that cannot be worked out is kept with qty 1,
 * rate 0, price_needed and `why` naming the answer.
 */
export function priceLines(version, answers = {}, service = {}) {
  const parsed = pricingSchema.safeParse(version?.pricing ?? { lines: [] });
  if (!parsed.success) throw new Error('The pricing rules are not valid; check them before pricing');
  const byKey = new Map(allQuestions(version?.definition).map((q) => [q.key, q]));
  // No prototype, so show-if and include-when (isVisible) see only the client's own answers too.
  const given = Object.assign(Object.create(null), answers && typeof answers === 'object' && !Array.isArray(answers) ? answers : {});

  const out = [];
  parsed.data.lines.forEach((l, index) => {
    if (l.include_if && !isVisible({ show_if: l.include_if }, given, byKey)) return;
    if (readsFrom(l).some((k) => byKey.has(k) && !isVisible(byKey.get(k), given, byKey))) return;

    const base = {
      rule_key: l.key,
      description: l.description,
      unit: l.unit ?? service?.unit ?? null,
      gst_rate: l.gst_rate ?? (service?.gst_rate == null ? null : Number(service.gst_rate)),
      sac_code: l.sac_code ?? service?.sac_code ?? null,
      sort_order: l.sort_order ?? index,
      index,
    };
    const needed = (why) => out.push({ ...base, qty: 1, rate: 0, price_needed: true, why });

    const qty = evaluate(l.qty ?? { fixed: 1 }, given, service);
    if (qty.why) return needed(qty.why);
    let q = qty.n;
    for (const m of l.multiply || []) {
      const r = evaluate(m, given, service);
      if (r.why) return needed(r.why);
      q *= r.n;
    }
    const rate = evaluate(l.rate, given, service);
    if (rate.why) return needed(rate.why);

    if (!Number.isFinite(q)) return needed('the quantity could not be worked out (the numbers are too large)');
    if (!Number.isFinite(rate.n)) return needed('the rate could not be worked out (the numbers are too large)');
    q = roundUp2(q);
    const r = round2(rate.n);
    if (!(q > 0)) return needed(`the quantity came to ${q}`);
    if (q > MAX_QTY) return needed(`the quantity came to ${money(q)}, more than a quotation line can hold (${money(MAX_QTY)})`);
    if (r < 0) return needed(`the rate came to ${r}`);
    if (r > MAX_RATE) return needed(`the rate came to ${money(r)}, more than a quotation line can hold (${money(MAX_RATE)})`);
    if (round2(q * r) > MAX_AMOUNT) return needed(`the amount came to ${money(round2(q * r))}, more than a quotation line can hold (${money(MAX_AMOUNT)})`);
    out.push({ ...base, qty: q, rate: r, price_needed: false, why: null });
  });

  return out
    .sort((a, b) => a.sort_order - b.sort_order || a.index - b.index)
    .map(({ index, ...rest }) => rest);
}
