/**
 * A service questionnaire's definition, and the answers given to it
 * (#208 phase 1, §4). Pure functions: no database.
 *
 * A definition is steps of questions. Every question has a stable `key`
 * (pricing rules and quotation wording refer to it, so renaming a label
 * never breaks them), a type, and optionally a show-if rule on an earlier
 * answer. A "table" question repeats a small group of sub-questions, one
 * row per site, scope or the like.
 *
 *   definitionSchema           the shape an admin's form must have
 *   checkDefinition(def)       { ok, definition, errors } with the rules
 *                              a shape cannot say (keys unique, show-if
 *                              pointing back, options present)
 *   isVisible(q, answers)      the question's show-if rule
 *   checkAnswers(def, answers, { submit })
 *                              { values, errors }: unknown keys dropped,
 *                              each value checked against its question;
 *                              on submit, every visible required question
 *                              answered. The same function runs for the
 *                              client, for staff filling in, and on submit.
 *
 * Answers are data, never instructions: they are typed values, and the
 * page and the PDF print them as text.
 */
import { z } from 'zod';

export const QUESTION_TYPES = ['text', 'textarea', 'number', 'money', 'date', 'select', 'radio', 'multiselect', 'checkbox', 'yesno', 'table', 'file', 'info'];
const CHOICE = new Set(['select', 'radio', 'multiselect', 'checkbox']);
const MANY = new Set(['multiselect', 'checkbox']);
/** What a table's columns may be: one value per cell. */
const CELL_TYPES = ['text', 'textarea', 'number', 'money', 'date', 'select', 'radio', 'yesno'];
export const PREFILL = ['company.name', 'company.gstin', 'company.address', 'contact.name', 'contact.email', 'contact.phone'];
export const SHOW_IF_OPS = ['eq', 'neq', 'in', 'gt', 'gte', 'lt', 'lte', 'answered'];

const key = z.string().regex(/^[a-z][a-z0-9_]{0,59}$/, 'Lower-case letters, digits and _ only, starting with a letter');
const text = (max) => z.string().trim().min(1).max(max);
const optional = (max) => z.string().trim().max(max).optional();
const option = z.object({ key, label: text(200) }).strict();
const showIf = z.object({
  key,
  op: z.enum(SHOW_IF_OPS),
  value: z.union([z.string().max(200), z.number(), z.boolean(), z.array(z.union([z.string().max(200), z.number()])).max(50)]).optional(),
}).strict();

const base = {
  key,
  label: text(300),
  help: optional(1000),
  required: z.boolean().optional(),
  options: z.array(option).max(60).optional(),
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
  integer: z.boolean().optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  placeholder: optional(200),
};
const cell = z.object({ ...base, type: z.enum(CELL_TYPES) }).strict();
const question = z.object({
  ...base,
  type: z.enum(QUESTION_TYPES),
  columns: z.array(cell).max(12).optional(),
  min_rows: z.number().int().min(0).max(200).optional(),
  max_rows: z.number().int().min(1).max(200).optional(),
  multiple: z.boolean().optional(),
  show_if: showIf.optional(),
  prefill: z.enum(PREFILL).optional(),
}).strict();
const step = z.object({ key, title: text(200), description: optional(2000), questions: z.array(question).max(80) }).strict();

export const definitionSchema = z.object({
  intro: optional(4000),
  steps: z.array(step).max(20),
}).strict();

/** Every question, in order, with the step it is on. */
export function allQuestions(def) {
  return (def?.steps || []).flatMap((s, stepIndex) => s.questions.map((q) => ({ ...q, stepIndex })));
}

function shapeRules(q, where, errors) {
  if (CHOICE.has(q.type) && !(q.options?.length)) errors.push(`${where}: give it at least one option`);
  if (q.options) {
    const seen = new Set();
    for (const o of q.options) { if (seen.has(o.key)) errors.push(`${where}: option "${o.key}" twice`); seen.add(o.key); }
  }
  if (q.min !== undefined && q.max !== undefined && q.min > q.max) errors.push(`${where}: the minimum is above the maximum`);
}

/**
 * The definition checked as a whole. `ok` false lists every problem in the
 * admin's words, so the builder can show them all at once.
 */
export function checkDefinition(input) {
  const parsed = definitionSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.') || 'definition'}: ${i.message}`) };
  }
  const def = parsed.data;
  const errors = [];
  const stepKeys = new Set();
  const before = new Map();   // key → question, for show-if pointing back
  def.steps.forEach((s, si) => {
    if (stepKeys.has(s.key)) errors.push(`Step ${si + 1}: the key "${s.key}" is used twice`);
    stepKeys.add(s.key);
    s.questions.forEach((q, qi) => {
      const where = `Step ${si + 1}, question ${qi + 1} (${q.key})`;
      if (before.has(q.key)) errors.push(`${where}: the key "${q.key}" is used twice`);
      shapeRules(q, where, errors);
      if (q.type === 'table') {
        if (!(q.columns?.length)) errors.push(`${where}: a table needs at least one column`);
        const cols = new Set();
        for (const c of q.columns || []) {
          if (cols.has(c.key)) errors.push(`${where}: column "${c.key}" twice`);
          cols.add(c.key);
          shapeRules(c, `${where}, column ${c.key}`, errors);
        }
        if (q.min_rows !== undefined && q.max_rows !== undefined && q.min_rows > q.max_rows) errors.push(`${where}: fewer rows allowed than required`);
      } else if (q.columns) errors.push(`${where}: only a table has columns`);
      if (q.show_if) {
        const target = before.get(q.show_if.key);
        if (!target) errors.push(`${where}: "show if" must point to a question before it`);
        else if (['table', 'file', 'info'].includes(target.type)) errors.push(`${where}: "show if" cannot depend on a ${target.type} question`);
        else if (q.show_if.op === 'in' && !Array.isArray(q.show_if.value)) errors.push(`${where}: "is one of" needs a list of values`);
        else if (q.show_if.op !== 'answered' && q.show_if.value === undefined) errors.push(`${where}: "show if" needs a value to compare with`);
      }
      if (q.prefill && !['text', 'textarea'].includes(q.type)) errors.push(`${where}: only a text question can be prefilled`);
      before.set(q.key, q);
    });
  });
  return errors.length ? { ok: false, errors } : { ok: true, definition: def, errors: [] };
}

const blank = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

/** Whether a question shows, given the answers so far. Hidden questions are never required and their answers are dropped. */
export function isVisible(q, answers, byKey = null) {
  const rule = q.show_if;
  if (!rule) return true;
  // A question hidden by its own rule hides what depends on it.
  if (byKey?.has(rule.key) && !isVisible(byKey.get(rule.key), answers, byKey)) return false;
  const v = answers?.[rule.key];
  const num = (x) => (typeof x === 'number' ? x : Number(x));
  switch (rule.op) {
    case 'answered': return !blank(v);
    case 'eq': return Array.isArray(v) ? v.includes(rule.value) : v === rule.value;
    case 'neq': return Array.isArray(v) ? !v.includes(rule.value) : v !== rule.value;
    case 'in': return Array.isArray(v) ? v.some((x) => rule.value.includes(x)) : rule.value.includes(v);
    case 'gt': return !blank(v) && num(v) > num(rule.value);
    case 'gte': return !blank(v) && num(v) >= num(rule.value);
    case 'lt': return !blank(v) && num(v) < num(rule.value);
    case 'lte': return !blank(v) && num(v) <= num(rule.value);
    default: return true;
  }
}

/** One value checked against its question: [value, error]. A blank comes back undefined. */
function checkValue(q, raw) {
  if (blank(raw)) return [undefined, null];
  switch (q.type) {
    case 'text': case 'textarea': {
      if (typeof raw !== 'string' && typeof raw !== 'number') return [undefined, 'Text, please'];
      const s = String(raw).trim();
      const max = q.type === 'text' ? 2000 : 10000;
      if (s.length > max) return [undefined, `At most ${max} characters`];
      return [s || undefined, null];
    }
    case 'number': case 'money': {
      const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/,/g, ''));
      if (!Number.isFinite(n)) return [undefined, 'A number, please'];
      if (q.integer && !Number.isInteger(n)) return [undefined, 'A whole number, please'];
      if (q.min !== undefined && n < q.min) return [undefined, `At least ${q.min}`];
      if (q.max !== undefined && n > q.max) return [undefined, `At most ${q.max}`];
      return [n, null];
    }
    case 'date': {
      const s = String(raw);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) return [undefined, 'A date, please'];
      return [s, null];
    }
    case 'select': case 'radio': {
      if (!q.options.some((o) => o.key === raw)) return [undefined, 'Choose one of the options'];
      return [raw, null];
    }
    case 'multiselect': case 'checkbox': {
      const list = Array.isArray(raw) ? raw : [raw];
      if (list.some((x) => !q.options.some((o) => o.key === x))) return [undefined, 'Choose from the options'];
      return [[...new Set(list)], null];
    }
    case 'yesno': {
      if (typeof raw !== 'boolean') return [undefined, 'Yes or no, please'];
      return [raw, null];
    }
    case 'file': {
      const list = Array.isArray(raw) ? raw : [raw];
      if (list.some((x) => !Number.isInteger(x) || x <= 0)) return [undefined, 'Upload the file again'];
      if (!q.multiple && list.length > 1) return [undefined, 'One file only'];
      return [[...new Set(list)].slice(0, 20), null];
    }
    default: return [undefined, null];
  }
}

/**
 * Answers checked against a definition. Unknown keys and hidden questions
 * are dropped; a value of the wrong kind is an error, never coerced into
 * something else. With `submit`, every visible required question (and
 * required table cell) must be answered.
 *
 * Returns { values, errors }: errors keyed by question key, or
 * "key.row.column" inside a table.
 */
export function checkAnswers(def, answers = {}, { submit = false } = {}) {
  const input = answers && typeof answers === 'object' && !Array.isArray(answers) ? answers : {};
  const values = {};
  const errors = {};
  const questions = allQuestions(def);
  const byKey = new Map(questions.map((q) => [q.key, q]));
  for (const q of questions) {
    if (q.type === 'info') continue;
    // Visibility reads the answers as checked so far, so a rule never
    // depends on a value that was itself rejected.
    if (!isVisible(q, values, byKey)) continue;
    const raw = input[q.key];
    if (q.type === 'table') {
      const rows = Array.isArray(raw) ? raw : blank(raw) ? [] : null;
      if (rows === null) { errors[q.key] = 'Rows, please'; continue; }
      const limit = q.max_rows ?? 200;
      if (rows.length > limit) { errors[q.key] = `At most ${limit} rows`; continue; }
      const kept = [];
      rows.forEach((row, ri) => {
        const r = row && typeof row === 'object' && !Array.isArray(row) ? row : {};
        const out = {};
        for (const c of q.columns) {
          const [v, err] = checkValue(c, r[c.key]);
          if (err) errors[`${q.key}.${ri}.${c.key}`] = err;
          else if (v !== undefined) out[c.key] = v;
          else if (submit && c.required) errors[`${q.key}.${ri}.${c.key}`] = 'Required';
        }
        if (Object.keys(out).length || submit) kept.push(out);
      });
      if (submit && q.required && !kept.length) errors[q.key] = 'Add at least one row';
      if (submit && q.min_rows && kept.length < q.min_rows) errors[q.key] = `At least ${q.min_rows} row${q.min_rows === 1 ? '' : 's'}`;
      if (kept.length) values[q.key] = kept;
      continue;
    }
    const [v, err] = checkValue(q, raw);
    if (err) errors[q.key] = err;
    else if (v !== undefined) values[q.key] = v;
    else if (submit && q.required) errors[q.key] = 'Required';
  }
  return { values, errors };
}

/** The file ids an answer set refers to, for checking they belong to the response. */
export function fileIds(def, values) {
  return allQuestions(def).filter((q) => q.type === 'file').flatMap((q) => values[q.key] || []);
}

/** Answers prefilled from the enquiry's company and contact (the client may change them). */
export function prefillAnswers(def, { company = {}, contact = {} } = {}) {
  const source = {
    'company.name': company.name, 'company.gstin': company.gstin, 'company.address': company.address,
    'contact.name': contact.name, 'contact.email': contact.email, 'contact.phone': contact.phone,
  };
  const out = {};
  for (const q of allQuestions(def)) {
    const v = q.prefill ? source[q.prefill] : undefined;
    if (!blank(v)) out[q.key] = String(v);
  }
  return out;
}

/**
 * Where a submitted answer differs from what the company or contact
 * record says: offered to staff as an update, never written by itself
 * (the company's GSTIN lives on the company).
 */
export function prefillDifferences(def, values, { company = {}, contact = {} } = {}) {
  const source = {
    'company.name': company.name, 'company.gstin': company.gstin, 'company.address': company.address,
    'contact.name': contact.name, 'contact.email': contact.email, 'contact.phone': contact.phone,
  };
  return allQuestions(def)
    .filter((q) => q.prefill && !blank(values[q.key]) && String(values[q.key]).trim() !== String(source[q.prefill] ?? '').trim())
    .map((q) => ({ key: q.key, label: q.label, field: q.prefill, was: source[q.prefill] ?? null, now: values[q.key] }));
}
