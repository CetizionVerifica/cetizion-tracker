import { useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Paperclip, Plus, Trash2 } from 'lucide-react';
import { Button } from './ui/button.tsx';
import { Input } from './ui/input.tsx';
import { Label } from './ui/label.tsx';
import { Textarea } from './ui/textarea.tsx';

/**
 * A service questionnaire, filled in step by step (#208 phase 1, §3.1).
 *
 * One component for the client's page (/q/:token), for staff filling it in
 * for a client, and for the builder's preview. It shows a step at a time,
 * checks what is required before moving on, saves as it goes through
 * `onSave`, and ends on a review page that submits. The server checks
 * every answer again (lib/questionnaireDefinition.js); what it refuses
 * comes back as `fields` and is shown next to the question.
 *
 *   definition      { intro?, steps: [{ key, title, description?, questions }] }
 *   onSave(step, answers)          save as you go (omitted in a preview)
 *   onUpload(questionKey, file)    → { document_id, file_name }
 *   onSubmit({ answers, name, email })
 *   askContact      the client gives their name and email on the review page
 *   readOnly        the review page only, without edits (a submitted response)
 */
const CHOICE = new Set(['select', 'radio', 'multiselect', 'checkbox']);
const blank = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

/** The question's show-if rule, as the server reads it. */
export function visible(q, answers, byKey) {
  const rule = q.show_if;
  if (!rule) return true;
  if (byKey?.has(rule.key) && !visible(byKey.get(rule.key), answers, byKey)) return false;
  const v = answers?.[rule.key];
  const n = (x) => Number(x);
  switch (rule.op) {
    case 'answered': return !blank(v);
    case 'eq': return Array.isArray(v) ? v.includes(rule.value) : v === rule.value || (typeof rule.value === 'number' && n(v) === rule.value);
    case 'neq': return Array.isArray(v) ? !v.includes(rule.value) : !(v === rule.value || (typeof rule.value === 'number' && n(v) === rule.value));
    case 'in': return Array.isArray(v) ? v.some((x) => rule.value.includes(x)) : rule.value.includes(v);
    case 'gt': return !blank(v) && n(v) > n(rule.value);
    case 'gte': return !blank(v) && n(v) >= n(rule.value);
    case 'lt': return !blank(v) && n(v) < n(rule.value);
    case 'lte': return !blank(v) && n(v) <= n(rule.value);
    default: return true;
  }
}

/** An answer in words, for the review page and the staff view. */
export function answerText(q, v, fileNames = {}) {
  if (blank(v)) return '—';
  const opt = (k) => q.options?.find((o) => o.key === k)?.label ?? k;
  switch (q.type) {
    case 'select': case 'radio': return opt(v);
    case 'multiselect': case 'checkbox': return v.map(opt).join(', ');
    case 'yesno': return v ? 'Yes' : 'No';
    case 'money': return `${q.currency || 'INR'} ${Number(v).toLocaleString('en-IN')}`;
    case 'number': return Number(v).toLocaleString('en-IN');
    case 'date': return new Date(`${v}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
    case 'file': return v.map((id) => fileNames[id] || 'File').join(', ');
    case 'table': return `${v.length} row${v.length === 1 ? '' : 's'}`;
    default: return String(v);
  }
}

const field = 'h-9 w-full rounded-md border border-input bg-transparent px-3 text-base md:text-sm dark:bg-input/30 outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive';

/** One question's input. */
function Control({ q, value, onChange, error, onUpload, fileNames, disabled }) {
  const id = `q-${q.key}`;
  const invalid = error ? true : undefined;
  switch (q.type) {
    case 'textarea':
      return <Textarea id={id} rows={4} value={value ?? ''} placeholder={q.placeholder} onChange={(e) => onChange(e.target.value)} aria-invalid={invalid} disabled={disabled} />;
    case 'number': case 'money':
      return (
        <div className="flex items-center gap-2">
          {q.type === 'money' && <span className="text-[13px] text-muted-foreground">{q.currency || 'INR'}</span>}
          <Input id={id} type="number" inputMode="decimal" step={q.integer ? 1 : 'any'} min={q.min} max={q.max} value={value ?? ''} placeholder={q.placeholder}
            onChange={(e) => onChange(e.target.value)} aria-invalid={invalid} disabled={disabled} className="max-w-[240px]" />
        </div>
      );
    case 'date':
      return <Input id={id} type="date" value={value ?? ''} onChange={(e) => onChange(e.target.value)} aria-invalid={invalid} disabled={disabled} className="max-w-[220px]" />;
    case 'select':
      return (
        <select id={id} className={field} value={value ?? ''} onChange={(e) => onChange(e.target.value || undefined)} aria-invalid={invalid} disabled={disabled}>
          <option value="">Choose…</option>
          {q.options.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
        </select>
      );
    case 'radio': case 'yesno': {
      const options = q.type === 'yesno' ? [{ key: true, label: 'Yes' }, { key: false, label: 'No' }] : q.options;
      return (
        <div role="radiogroup" aria-labelledby={`${id}-label`} className="flex flex-wrap gap-x-5 gap-y-2">
          {options.map((o) => (
            <label key={String(o.key)} className="flex items-center gap-2 text-[14px]">
              <input type="radio" name={id} checked={value === o.key} onChange={() => onChange(o.key)} disabled={disabled} className="size-4 accent-[var(--primary)]" />
              {o.label}
            </label>
          ))}
        </div>
      );
    }
    case 'multiselect': case 'checkbox': {
      const list = Array.isArray(value) ? value : [];
      return (
        <div className="flex flex-col gap-2">
          {q.options.map((o) => (
            <label key={o.key} className="flex items-center gap-2 text-[14px]">
              <input type="checkbox" checked={list.includes(o.key)} disabled={disabled} className="size-4 accent-[var(--primary)]"
                onChange={(e) => onChange(e.target.checked ? [...list, o.key] : list.filter((x) => x !== o.key))} />
              {o.label}
            </label>
          ))}
        </div>
      );
    }
    case 'file':
      return <FileControl q={q} value={value} onChange={onChange} onUpload={onUpload} fileNames={fileNames} disabled={disabled} />;
    case 'table':
      return <TableControl q={q} value={value} onChange={onChange} error={error} disabled={disabled} />;
    default:
      return <Input id={id} value={value ?? ''} placeholder={q.placeholder} onChange={(e) => onChange(e.target.value)} aria-invalid={invalid} disabled={disabled} />;
  }
}

function FileControl({ q, value, onChange, onUpload, fileNames, disabled }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const input = useRef(null);
  const list = Array.isArray(value) ? value : [];
  async function pick(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !onUpload) return;
    setBusy(true); setErr(null);
    try {
      const up = await onUpload(q.key, file);
      fileNames[up.document_id] = up.file_name;
      onChange(q.multiple ? [...list, up.document_id] : [up.document_id]);
    } catch (ex) { setErr(ex.fields?.file || ex.message); } finally { setBusy(false); }
  }
  return (
    <div className="flex flex-col gap-2">
      {list.map((id) => (
        <div key={id} className="flex items-center gap-2 text-[13.5px]">
          <Paperclip className="size-3.5 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 truncate">{fileNames[id] || 'File'}</span>
          {!disabled && <Button type="button" variant="ghost" size="xs" onClick={() => onChange(list.filter((x) => x !== id))}>Remove</Button>}
        </div>
      ))}
      {!disabled && (q.multiple || !list.length) && (
        <div>
          <input ref={input} type="file" className="sr-only" accept=".pdf,.png,.jpg,.jpeg,.webp,.doc,.docx,.xls,.xlsx" onChange={pick} tabIndex={-1} />
          <Button type="button" variant="outline" size="sm" disabled={busy || !onUpload} onClick={() => input.current?.click()}>
            <Paperclip aria-hidden="true" />{busy ? 'Uploading…' : list.length ? 'Add another file' : 'Choose a file'}
          </Button>
          <div className="mt-1 text-[12px] text-muted-foreground">PDF, image, Word or Excel.</div>
        </div>
      )}
      {err && <div className="text-[12.5px] text-destructive">{err}</div>}
    </div>
  );
}

/** A repeating group: one row per site, scope or the like. Stacked on a phone. */
function TableControl({ q, value, onChange, error, disabled }) {
  const rows = Array.isArray(value) && value.length ? value : [{}];
  const set = (ri, key, v) => onChange(rows.map((r, i) => (i === ri ? { ...r, [key]: v } : r)));
  const max = q.max_rows ?? 200;
  return (
    <div className="flex flex-col gap-3">
      {rows.map((row, ri) => (
        <div key={ri} className="rounded-md border border-border p-3">
          <div className="mb-2 flex items-center justify-between text-[12px] text-muted-foreground">
            <span>{q.label.replace(/s$/, '')} {ri + 1}</span>
            {!disabled && rows.length > 1 && <Button type="button" variant="ghost" size="xs" onClick={() => onChange(rows.filter((_, i) => i !== ri))}><Trash2 aria-hidden="true" />Remove</Button>}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {q.columns.map((c) => {
              const cellError = error?.[`${q.key}.${ri}.${c.key}`];
              return (
                <div key={c.key} className="flex min-w-0 flex-col gap-1.5">
                  <Label htmlFor={`q-${q.key}-${ri}-${c.key}`} className="text-[12.5px]">{c.label}{c.required && <span className="text-destructive"> *</span>}</Label>
                  <Control q={{ ...c, key: `${q.key}-${ri}-${c.key}` }} value={row[c.key]} onChange={(v) => set(ri, c.key, v)} error={cellError} disabled={disabled} />
                  {cellError && <div className="text-[12px] text-destructive">{cellError}</div>}
                </div>
              );
            })}
          </div>
        </div>
      ))}
      {!disabled && rows.length < max && (
        <div><Button type="button" variant="outline" size="sm" onClick={() => onChange([...rows, {}])}><Plus aria-hidden="true" />Add {q.label.toLowerCase().replace(/s$/, '')}</Button></div>
      )}
    </div>
  );
}

function Question({ q, value, onChange, errors, onUpload, fileNames, disabled }) {
  if (q.type === 'info') return <p className="text-[14px]/[1.6] text-secondary-text">{q.label}</p>;
  const error = q.type === 'table' ? errors : errors[q.key];
  const own = errors[q.key];
  const labelled = !['radio', 'yesno', 'multiselect', 'checkbox', 'table', 'file'].includes(q.type);
  return (
    <div className="flex flex-col gap-1.5">
      {labelled
        ? <Label htmlFor={`q-${q.key}`} className="text-[14px] font-medium">{q.label}{q.required && <span className="text-destructive"> *</span>}</Label>
        : <div id={`q-${q.key}-label`} className="text-[14px] font-medium">{q.label}{q.required && <span className="text-destructive"> *</span>}</div>}
      {q.help && <div className="text-[12.5px]/[1.5] text-muted-foreground">{q.help}</div>}
      <Control q={q} value={value} onChange={onChange} error={error} onUpload={onUpload} fileNames={fileNames} disabled={disabled} />
      {own && <div className="text-[12.5px] text-destructive" role="alert">{own}</div>}
    </div>
  );
}

/** Required questions of one step, answered? The server checks types; this keeps the client from moving on with a gap. */
function stepGaps(step, answers, byKey) {
  const out = {};
  for (const q of step.questions) {
    if (q.type === 'info' || !visible(q, answers, byKey)) continue;
    const v = answers[q.key];
    if (q.type === 'table') {
      const rows = (Array.isArray(v) ? v : []).filter((r) => Object.values(r || {}).some((x) => !blank(x)));
      if (q.required && !rows.length) out[q.key] = 'Add at least one';
      rows.forEach((r, ri) => q.columns.forEach((c) => { if (c.required && blank(r[c.key])) out[`${q.key}.${ri}.${c.key}`] = 'Required'; }));
      continue;
    }
    if (q.required && blank(v)) out[q.key] = 'Required';
  }
  return out;
}

/** A table's empty rows are not sent. */
function tidy(answers, def) {
  const out = { ...answers };
  for (const s of def.steps) for (const q of s.questions) {
    if (q.type === 'table' && Array.isArray(out[q.key])) out[q.key] = out[q.key].filter((r) => Object.values(r || {}).some((x) => !blank(x)));
  }
  return out;
}

export function QuestionnaireForm({
  definition, initialAnswers = {}, initialStep = 0, files = [], onSave, onUpload, onSubmit,
  askContact = true, readOnly = false, preview = false, submitLabel = 'Submit answers',
}) {
  const steps = definition?.steps || [];
  const byKey = useMemo(() => new Map(steps.flatMap((s) => s.questions).map((q) => [q.key, q])), [steps]);
  const [answers, setAnswers] = useState(initialAnswers || {});
  const [step, setStep] = useState(readOnly ? steps.length : Math.min(initialStep || 0, Math.max(steps.length - 1, 0)));
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);
  const [contact, setContact] = useState({ name: '', email: '' });
  const fileNames = useRef(Object.fromEntries(files.map((f) => [f.document_id, f.file_name]))).current;
  const top = useRef(null);
  const onReview = step >= steps.length;

  const set = (key, v) => { setAnswers((a) => ({ ...a, [key]: v })); setErrors((e) => { const n = { ...e }; for (const k of Object.keys(n)) if (k === key || k.startsWith(`${key}.`)) delete n[k]; return n; }); setNote(null); };
  const scrollUp = () => top.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  async function save(next) {
    if (preview || !onSave) return true;
    setBusy(true);
    try { await onSave(Math.min(next, steps.length - 1), tidy(answers, definition)); return true; }
    catch (ex) { setErrors(ex.fields || {}); setNote({ tone: 'error', text: ex.message }); return false; }
    finally { setBusy(false); }
  }
  async function go(next) {
    if (next > step && !onReview) {
      const gaps = stepGaps(steps[step], answers, byKey);
      if (Object.keys(gaps).length) { setErrors(gaps); setNote({ tone: 'error', text: 'Please answer the questions marked below.' }); return; }
    }
    if (await save(next)) { setErrors({}); setNote(null); setStep(next); scrollUp(); }
  }
  async function later() {
    if (await save(step)) setNote({ tone: 'ok', text: 'Saved. Open the same link to carry on where you left off.' });
  }
  async function submit(e) {
    e.preventDefault();
    if (preview) { setNote({ tone: 'ok', text: 'This is a preview: nothing is saved or sent.' }); return; }
    setBusy(true); setNote(null);
    try { await onSubmit({ answers: tidy(answers, definition), ...(askContact ? contact : {}) }); }
    catch (ex) {
      const f = ex.fields || {};
      setErrors(f);
      const first = steps.findIndex((s) => s.questions.some((q) => Object.keys(f).some((k) => k === q.key || k.startsWith(`${q.key}.`))));
      if (first >= 0) { setStep(first); scrollUp(); setNote({ tone: 'error', text: 'Some answers need another look.' }); }
      else setNote({ tone: 'error', text: f.name || f.email || ex.message });
    } finally { setBusy(false); }
  }

  if (!steps.length) return <p className="text-[14px] text-muted-foreground">This questionnaire has no questions yet.</p>;

  const banner = note && (
    <div role="status" className={`rounded-md border px-3 py-2 text-[13px] ${note.tone === 'error' ? 'border-destructive/40 text-destructive' : 'border-border text-secondary-text'}`}>{note.text}</div>
  );

  if (onReview) {
    return (
      <form ref={top} onSubmit={submit} className="flex flex-col gap-6">
        {!readOnly && <div className="text-[12.5px] font-medium uppercase tracking-[0.08em] text-muted-foreground">Check your answers</div>}
        {steps.map((s, si) => {
          const shown = s.questions.filter((q) => q.type !== 'info' && visible(q, answers, byKey));
          return (
            <section key={s.key} className="flex flex-col gap-2">
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="text-[15px] font-semibold text-foreground">{s.title}</h3>
                {!readOnly && <Button type="button" variant="link" size="xs" onClick={() => { setStep(si); scrollUp(); }}>Edit</Button>}
              </div>
              <dl className="flex flex-col divide-y divide-border rounded-md border border-border">
                {shown.map((q) => (
                  <div key={q.key} className="grid gap-1 px-3 py-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] sm:gap-4">
                    <dt className="text-[13px] text-muted-foreground">{q.label}</dt>
                    <dd className="min-w-0 text-[13.5px] text-foreground [overflow-wrap:anywhere]">
                      {q.type === 'table' && Array.isArray(answers[q.key]) && answers[q.key].length
                        ? <ul className="flex flex-col gap-1">{answers[q.key].map((r, ri) => <li key={ri}>{q.columns.filter((c) => !blank(r[c.key])).map((c) => `${c.label}: ${answerText(c, r[c.key])}`).join(' · ') || '—'}</li>)}</ul>
                        : answerText(q, answers[q.key], fileNames)}
                      {errors[q.key] && <div className="text-[12px] text-destructive">{errors[q.key]}</div>}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          );
        })}
        {!readOnly && (
          <>
            {askContact && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5"><Label htmlFor="q-contact-name">Your name</Label><Input id="q-contact-name" required value={contact.name} onChange={(e) => setContact({ ...contact, name: e.target.value })} autoComplete="name" /></div>
                <div className="flex flex-col gap-1.5"><Label htmlFor="q-contact-email">Your email</Label><Input id="q-contact-email" type="email" required value={contact.email} onChange={(e) => setContact({ ...contact, email: e.target.value })} autoComplete="email" /></div>
              </div>
            )}
            {banner}
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" onClick={() => { setStep(steps.length - 1); scrollUp(); }} disabled={busy}><ArrowLeft aria-hidden="true" />Back</Button>
              <Button type="submit" disabled={busy}>{busy ? 'Sending…' : submitLabel}</Button>
            </div>
          </>
        )}
      </form>
    );
  }

  const s = steps[step];
  return (
    <div ref={top} className="flex flex-col gap-6">
      <div>
        <div className="text-[12.5px] font-medium uppercase tracking-[0.08em] text-muted-foreground">Step {step + 1} of {steps.length}</div>
        <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-secondary" aria-hidden="true">
          <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${((step + 1) / (steps.length + 1)) * 100}%` }} />
        </div>
        <h2 className="mt-4 text-[18px] font-semibold text-foreground">{s.title}</h2>
        {s.description && <p className="mt-1 text-[13.5px]/[1.6] text-secondary-text">{s.description}</p>}
        {step === 0 && definition.intro && <p className="mt-2 text-[13.5px]/[1.6] text-secondary-text">{definition.intro}</p>}
      </div>
      {s.questions.filter((q) => visible(q, answers, byKey)).map((q) => (
        <Question key={q.key} q={q} value={answers[q.key]} onChange={(v) => set(q.key, v)} errors={errors} onUpload={preview ? null : onUpload} fileNames={fileNames} disabled={busy} />
      ))}
      {banner}
      <div className="flex flex-wrap items-center gap-2">
        {step > 0 && <Button type="button" variant="outline" onClick={() => go(step - 1)} disabled={busy}><ArrowLeft aria-hidden="true" />Back</Button>}
        {!preview && onSave && <Button type="button" variant="ghost" onClick={later} disabled={busy}>Save and finish later</Button>}
        <Button type="button" className="ml-auto" onClick={() => go(step + 1)} disabled={busy}>{step === steps.length - 1 ? 'Review' : 'Next'}<ArrowRight aria-hidden="true" /></Button>
      </div>
    </div>
  );
}
