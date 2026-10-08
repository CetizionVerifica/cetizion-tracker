import { useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, CircleAlert, CircleCheck, Paperclip, Pencil, Plus, Upload } from 'lucide-react';

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
 * Wave 9 (Mocha Glass): step bars, pill radios, rows as cards, the review
 * as a two-column list, and on a phone the primary button full width on top.
 * Classes in styles/mocha/questionnaire.css (`qn-*`).
 *
 *   definition      { intro?, steps: [{ key, title, description?, questions }] }
 *   onSave(step, answers)          save as you go (omitted in a preview)
 *   onUpload(questionKey, file)    → { document_id, file_name }
 *   onSubmit({ answers, name, email })
 *   askContact      the client gives their name and email on the review page
 *   readOnly        the review page only, without edits (a submitted response)
 */
const GROUPED = new Set(['radio', 'yesno', 'multiselect', 'checkbox', 'table']);
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

/** A table's rows in words, one line each. */
export function rowsText(q, rows) {
  return rows.map((r) => q.columns.filter((c) => !blank(r?.[c.key])).map((c) => `${c.label}: ${answerText(c, r[c.key])}`).join(' · ') || '—');
}

/** One question's input. */
function Control({ q, value, onChange, error, onUpload, fileNames, disabled, describedBy }) {
  const id = `q-${q.key}`;
  const own = { id, disabled, 'aria-invalid': error ? true : undefined, 'aria-describedby': describedBy };
  switch (q.type) {
    case 'textarea':
      return <textarea className="mg-textarea" rows={4} value={value ?? ''} placeholder={q.placeholder} onChange={(e) => onChange(e.target.value)} {...own} />;
    case 'number':
      return <input className="mg-input qn-short" type="number" inputMode="decimal" step={q.integer ? 1 : 'any'} min={q.min} max={q.max} value={value ?? ''} placeholder={q.placeholder} onChange={(e) => onChange(e.target.value)} {...own} />;
    case 'money':
      return (
        <span className="qn-money">
          <span className="qn-money__cur" aria-hidden="true">{q.currency || 'INR'}</span>
          <input className="mg-input mg-input--money" type="number" inputMode="decimal" step={q.integer ? 1 : 'any'} min={q.min} max={q.max} value={value ?? ''} placeholder={q.placeholder}
            onChange={(e) => onChange(e.target.value)} {...own} />
        </span>
      );
    case 'date':
      return <input className="mg-input qn-date" type="date" value={value ?? ''} onChange={(e) => onChange(e.target.value)} {...own} />;
    case 'select':
      return (
        <span className="mg-select-wrap qn-sel">
          <select className="mg-select" value={value ?? ''} onChange={(e) => onChange(e.target.value || undefined)} {...own}>
            <option value="">Choose…</option>
            {q.options.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
          </select>
        </span>
      );
    case 'radio': case 'yesno': {
      const options = q.type === 'yesno' ? [{ key: true, label: 'Yes' }, { key: false, label: 'No' }] : q.options;
      return (
        <div role="radiogroup" aria-labelledby={`${id}-label`} aria-describedby={describedBy} aria-invalid={own['aria-invalid']} className="qn-opts">
          {options.map((o) => (
            <label key={String(o.key)} className={`qn-opt${value === o.key ? ' is-on' : ''}`}>
              <span className="mg-check"><input type="radio" name={id} checked={value === o.key} onChange={() => onChange(o.key)} disabled={disabled} /></span>
              {o.label}
            </label>
          ))}
        </div>
      );
    }
    case 'multiselect': case 'checkbox': {
      const list = Array.isArray(value) ? value : [];
      return (
        <div className="qn-list" role="group" aria-labelledby={`${id}-label`} aria-describedby={describedBy}>
          {q.options.map((o) => (
            <label key={o.key} className="mg-check">
              <input type="checkbox" checked={list.includes(o.key)} disabled={disabled}
                onChange={(e) => onChange(e.target.checked ? [...list, o.key] : list.filter((x) => x !== o.key))} />
              <span>{o.label}</span>
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
      return <input className="mg-input" value={value ?? ''} placeholder={q.placeholder} onChange={(e) => onChange(e.target.value)} {...own} />;
  }
}

function FileControl({ q, value, onChange, onUpload, fileNames, disabled }) {
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);
  const input = useRef(null);
  const list = Array.isArray(value) ? value : [];
  async function pick(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !onUpload) return;
    setBusy(file.name); setErr(null);
    try {
      const up = await onUpload(q.key, file);
      fileNames[up.document_id] = up.file_name;
      onChange(q.multiple ? [...list, up.document_id] : [up.document_id]);
    } catch (ex) { setErr(ex.fields?.file || ex.message); } finally { setBusy(null); }
  }
  return (
    <div className="qn-files" aria-labelledby={`q-${q.key}-label`} role="group">
      {list.map((id) => (
        <div key={id} className="qn-file">
          <Paperclip aria-hidden="true" />
          <span className="qn-file__name">{fileNames[id] || 'File'}</span>
          {!disabled && <button type="button" className="mg-btn mg-btn--ghost mg-btn--sm" aria-label={`Remove ${fileNames[id] || 'the file'}`} onClick={() => onChange(list.filter((x) => x !== id))}>Remove</button>}
        </div>
      ))}
      {busy && <div className="qn-file is-busy" role="status"><Upload aria-hidden="true" /><span className="qn-file__name">Uploading {busy}…</span></div>}
      {!disabled && (q.multiple || !list.length) && (
        <div className="qn-file__pick">
          <input ref={input} type="file" className="sr-only" accept=".pdf,.png,.jpg,.jpeg,.webp,.doc,.docx,.xls,.xlsx" onChange={pick} tabIndex={-1} aria-hidden="true" />
          <button type="button" className="mg-btn mg-btn--sm" disabled={Boolean(busy) || !onUpload} aria-busy={busy ? true : undefined} onClick={() => input.current?.click()}>
            <Upload aria-hidden="true" />{busy ? 'Uploading…' : list.length ? 'Add another file' : 'Choose a file'}
          </button>
          <span className="qn-meta">{onUpload ? 'PDF, image, Word or Excel.' : 'Files are added on the client’s page.'}</span>
        </div>
      )}
      {!list.length && disabled && <span className="qn-meta">No file added.</span>}
      {err && <span className="mg-field__error" role="alert">{err}</span>}
    </div>
  );
}

/** A repeating group: one row per site, scope or the like. Stacked on a phone. */
function TableControl({ q, value, onChange, error, disabled }) {
  const rows = Array.isArray(value) && value.length ? value : [{}];
  const set = (ri, key, v) => onChange(rows.map((r, i) => (i === ri ? { ...r, [key]: v } : r)));
  const max = q.max_rows ?? 200;
  const one = q.label.replace(/s$/, '');
  return (
    <div className="qn-rows">
      {rows.map((row, ri) => (
        <div key={ri} className="qn-trow">
          <div className="qn-trow__head">
            <strong>{one} {ri + 1}</strong>
            {!disabled && rows.length > 1 && <button type="button" className="mg-btn mg-btn--ghost mg-btn--sm qn-danger" aria-label={`Remove ${one.toLowerCase()} ${ri + 1}`} onClick={() => onChange(rows.filter((_, i) => i !== ri))}>Remove</button>}
          </div>
          <div className="mg-grid2">
            {q.columns.map((c) => (
              <Ask key={c.key} q={{ ...c, key: `${q.key}-${ri}-${c.key}` }} value={row[c.key]} onChange={(v) => set(ri, c.key, v)} error={error?.[`${q.key}.${ri}.${c.key}`]} disabled={disabled} small />
            ))}
          </div>
        </div>
      ))}
      {!disabled && rows.length < max && (
        <div><button type="button" className="mg-btn mg-btn--sm" onClick={() => onChange([...rows, {}])}><Plus aria-hidden="true" />Add {one.toLowerCase()}</button></div>
      )}
    </div>
  );
}

/** A label, its hint, the control and its error: one question, or one cell of a table row. */
function Ask({ q, value, onChange, error, own = error, onUpload, fileNames, disabled, small = false }) {
  const id = `q-${q.key}`;
  const grouped = GROUPED.has(q.type);
  const Tag = grouped ? 'fieldset' : 'div';
  const Label = grouped ? 'legend' : q.type === 'file' ? 'span' : 'label';
  const label = (
    <Label className="mg-field__label" id={`${id}-label`} htmlFor={Label === 'label' ? id : undefined}>
      {q.label}{q.required && <span className="req" aria-hidden="true">*</span>}
    </Label>
  );
  return (
    <Tag className={`mg-field qn-q${small ? ' qn-q--cell' : ''}${own ? ' is-error' : ''}`}>
      {label}
      {q.help && <span className="mg-field__hint" id={`${id}-hint`}>{q.help}</span>}
      <Control q={q} value={value} onChange={onChange} error={error} onUpload={onUpload} fileNames={fileNames} disabled={disabled} describedBy={q.help ? `${id}-hint` : undefined} />
      {own && typeof own === 'string' && <span className="mg-field__error" role="alert">{own}</span>}
    </Tag>
  );
}

function Question({ q, value, onChange, errors, onUpload, fileNames, disabled }) {
  if (q.type === 'info') return <p className="qn-info">{q.label}</p>;
  return <Ask q={q} value={value} onChange={onChange} error={q.type === 'table' ? errors : errors[q.key]} own={errors[q.key]} onUpload={onUpload} fileNames={fileNames} disabled={disabled} />;
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

/** Step bars: one per step and one for the review. */
function Bars({ count, at }) {
  return (
    <div className="mg-steps" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => <span key={i} className={i < at ? 'is-done' : i === at ? 'is-on' : ''} />)}
    </div>
  );
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

  if (!steps.length) {
    return (
      <div className="mg-empty qn-none">
        <span className="mg-empty__mark" aria-hidden="true"><Pencil size={22} strokeWidth={1.8} /></span>
        <strong>Nothing to answer yet</strong>
        <p className="mg-empty__text">This questionnaire has no questions yet.</p>
      </div>
    );
  }

  const banner = note && (
    <div className={`mg-banner ${note.tone === 'error' ? 'mg-banner--late' : 'mg-banner--ok'}`} role={note.tone === 'error' ? 'alert' : 'status'}>
      {note.tone === 'error' ? <CircleAlert aria-hidden="true" /> : <CircleCheck aria-hidden="true" />}
      <div className="mg-banner__body">{note.text}</div>
    </div>
  );

  if (onReview) {
    return (
      <form ref={top} onSubmit={submit} className="qn-form">
        {!readOnly && (
          <div className="qn-progress">
            <span className="mg-label">Check your answers</span>
            <Bars count={steps.length + 1} at={steps.length} />
          </div>
        )}
        {steps.map((s, si) => {
          const shown = s.questions.filter((q) => q.type !== 'info' && visible(q, answers, byKey));
          if (!shown.length) return null;
          return (
            <section key={s.key} className="qn-group" aria-label={s.title}>
              <div className="qn-group__head">
                <h3>{s.title}</h3>
                {!readOnly && <button type="button" className="mg-btn mg-btn--ghost mg-btn--sm" aria-label={`Edit ${s.title}`} onClick={() => { setStep(si); scrollUp(); }}><Pencil aria-hidden="true" />Edit</button>}
              </div>
              <dl className="qn-dl">
                {shown.map((q) => (
                  <div key={q.key} className={errors[q.key] ? 'is-error' : undefined}>
                    <dt>{q.label}</dt>
                    <dd>
                      {q.type === 'table' && Array.isArray(answers[q.key]) && answers[q.key].length
                        ? <ul className="qn-lines">{rowsText(q, answers[q.key]).map((t, ri) => <li key={ri}>{t}</li>)}</ul>
                        : answerText(q, answers[q.key], fileNames)}
                      {errors[q.key] && <span className="mg-field__error" role="alert">{errors[q.key]}</span>}
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
              <div className="mg-grid2 qn-contact">
                <div className={`mg-field${errors.name ? ' is-error' : ''}`}>
                  <label className="mg-field__label" htmlFor="q-contact-name">Your name</label>
                  <input className="mg-input" id="q-contact-name" required value={contact.name} onChange={(e) => setContact({ ...contact, name: e.target.value })} autoComplete="name" readOnly={busy} aria-invalid={errors.name ? true : undefined} />
                  {errors.name && <span className="mg-field__error">{errors.name}</span>}
                </div>
                <div className={`mg-field${errors.email ? ' is-error' : ''}`}>
                  <label className="mg-field__label" htmlFor="q-contact-email">Your email</label>
                  <input className="mg-input" id="q-contact-email" type="email" required value={contact.email} onChange={(e) => setContact({ ...contact, email: e.target.value })} autoComplete="email" readOnly={busy} aria-invalid={errors.email ? true : undefined} />
                  {errors.email && <span className="mg-field__error">{errors.email}</span>}
                </div>
              </div>
            )}
            {banner}
            <div className="qn-btns">
              <button type="button" className="mg-btn" onClick={() => { setStep(steps.length - 1); scrollUp(); }} disabled={busy}><ArrowLeft aria-hidden="true" />Back</button>
              <button type="submit" className="mg-btn mg-btn--primary qn-next" disabled={busy} aria-busy={busy || undefined}>{busy ? 'Sending…' : submitLabel}</button>
            </div>
          </>
        )}
      </form>
    );
  }

  const s = steps[step];
  return (
    <div ref={top} className="qn-form">
      <div className="qn-progress">
        <span className="mg-label">Step {step + 1} of {steps.length}</span>
        <Bars count={steps.length + 1} at={step} />
      </div>
      <div className="qn-step">
        <h2>{s.title}</h2>
        {s.description && <p>{s.description}</p>}
      </div>
      {step === 0 && definition.intro && <blockquote className="qn-intro">{definition.intro}</blockquote>}
      {banner}
      {s.questions.filter((q) => visible(q, answers, byKey)).map((q) => (
        <Question key={q.key} q={q} value={answers[q.key]} onChange={(v) => set(q.key, v)} errors={errors} onUpload={preview ? null : onUpload} fileNames={fileNames} disabled={busy} />
      ))}
      <div className="qn-btns">
        {step > 0 && <button type="button" className="mg-btn" onClick={() => go(step - 1)} disabled={busy}><ArrowLeft aria-hidden="true" />Back</button>}
        {!preview && onSave && <button type="button" className="mg-btn mg-btn--ghost" onClick={later} disabled={busy}>Save and finish later</button>}
        <button type="button" className="mg-btn mg-btn--primary qn-next" onClick={() => go(step + 1)} disabled={busy}>{step === steps.length - 1 ? 'Review' : 'Next'}<ArrowRight aria-hidden="true" /></button>
      </div>
    </div>
  );
}
