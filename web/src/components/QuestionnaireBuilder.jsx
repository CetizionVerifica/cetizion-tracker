import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, ChevronLeft, ChevronRight, Copy, Plus, Trash2 } from 'lucide-react';
import { Alert, Badge, DataTable, Empty, Field, Input, Modal, Select, Textarea, useToast } from './ui.jsx';
import { QuestionnaireForm } from './QuestionnaireForm.jsx';
import { api } from '../lib/api.js';
import { useFetch, useList } from '../lib/hooks.js';
import { date } from '../lib/format.js';

/**
 * Admin › Templates › Questionnaires (#208 phase 1, §3.3): one form per
 * service, built here without code. A version is edited as a draft, then
 * published; a published version is frozen, so the answers given to it
 * always match their questions, and changing it means a new version.
 *
 * Every question has a key the pricing rules and quotation wording will
 * refer to (phase 2 and 3). It is made from the label until it is edited
 * by hand, and should not change once answers exist.
 */
export const TYPE_LABEL = {
  text: 'Short text', textarea: 'Long text', number: 'Number', money: 'Amount of money', date: 'Date',
  select: 'Drop-down list', radio: 'One of a few (buttons)', multiselect: 'Several of a list', checkbox: 'Tick boxes',
  yesno: 'Yes or no', table: 'Table (repeating rows)', file: 'File upload', info: 'Guidance text (no answer)',
};
const CELL_TYPES = ['text', 'textarea', 'number', 'money', 'date', 'select', 'radio', 'yesno'];
const CHOICE = new Set(['select', 'radio', 'multiselect', 'checkbox']);
const OPS = [
  { value: 'eq', label: 'is' }, { value: 'neq', label: 'is not' }, { value: 'in', label: 'is one of' },
  { value: 'gt', label: 'is more than' }, { value: 'gte', label: 'is at least' }, { value: 'lt', label: 'is less than' },
  { value: 'lte', label: 'is at most' }, { value: 'answered', label: 'is answered' },
];
const PREFILL = [
  { value: 'company.name', label: 'Company name' }, { value: 'company.gstin', label: 'Company GSTIN' }, { value: 'company.address', label: 'Company address' },
  { value: 'contact.name', label: 'Contact name' }, { value: 'contact.email', label: 'Contact email' }, { value: 'contact.phone', label: 'Contact phone' },
];

export const slug = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'q_$1').slice(0, 50) || 'question';
const uniqueKey = (base, taken) => { let k = base; let n = 2; while (taken.has(k)) k = `${base}_${n++}`.slice(0, 60); return k; };
const keysOf = (def) => new Set(def.steps.flatMap((s) => s.questions.map((q) => q.key)));
const move = (list, i, d) => { const j = i + d; if (j < 0 || j >= list.length) return list; const out = [...list]; [out[i], out[j]] = [out[j], out[i]]; return out; };

export function QuestionnaireBuilder() {
  const [openId, setOpenId] = useState(null);
  const [creating, setCreating] = useState(false);
  const list = useFetch(() => api.raw('/questionnaires'), []);
  const rows = list.data?.data || [];
  if (openId) return <QuestionnaireEditor id={openId} onBack={() => { setOpenId(null); list.refetch(); }} />;
  return (
    <div className="stack">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="small muted" style={{ maxWidth: '70ch' }}>
          What a client is asked before we quote, one form per service. Staff send it from an enquiry; the client fills it in from a link, on any device.
        </p>
        <button type="button" className="btn btn--sm btn--primary" onClick={() => setCreating(true)}><Plus className="size-3.5" aria-hidden="true" /> New questionnaire</button>
      </div>
      {list.loading && !list.data ? <div className="skeleton" style={{ height: 120 }} /> : (
        <DataTable
          rows={rows}
          onRowClick={(r) => setOpenId(r.id)}
          empty={<Empty title="No questionnaires yet" text="Build one for a service: its steps and questions, then publish it so staff can send it." />}
          columns={[
            { key: 'service_name', header: 'Service', className: 'strong' },
            { key: 'name', header: 'Questionnaire' },
            { key: 'published', header: 'Published', render: (r) => (r.published ? `Version ${r.published.version} · ${date(r.published.published_at)}` : <span className="muted">not yet</span>) },
            { key: 'draft', header: 'Draft', render: (r) => (r.draft ? <Badge tone="warning">version {r.draft.version}</Badge> : <span className="muted">—</span>) },
            { key: 'responses', header: 'Sent', align: 'right' },
            { key: 'active', header: '', render: (r) => (!r.active ? <Badge>off</Badge> : null) },
          ]}
        />
      )}
      {creating && <CreateDialog onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); setOpenId(id); }} />}
    </div>
  );
}

function CreateDialog({ onClose, onCreated }) {
  const toast = useToast();
  const services = useList('services', { limit: 200 });
  const [v, setV] = useState({ service_id: '', name: '' });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  async function create() {
    setBusy(true); setErrors({});
    try { const r = await api.action('/questionnaires', { service_id: Number(v.service_id), name: v.name }); onCreated(r.data.id); }
    catch (err) { setErrors(err.fields || {}); toast(err.fields ? Object.values(err.fields)[0] : err.message, 'danger'); setBusy(false); }
  }
  return (
    <Modal title="New questionnaire" size="sm" onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button><button type="button" className="btn btn--primary" onClick={create} disabled={busy || !v.service_id || !v.name.trim()}>Create</button></>}>
      <div className="stack">
        <Field label="Service" required error={errors.service_id}>
          <Select value={v.service_id} placeholder="Choose…" options={(services.rows || []).filter((s) => s.active !== false).map((s) => ({ value: String(s.id), label: s.name }))}
            onChange={(e) => { const s = services.rows.find((x) => String(x.id) === e.target.value); setV({ service_id: e.target.value, name: v.name || (s ? `${s.name} questionnaire` : '') }); }} />
        </Field>
        <Field label="Name" required error={errors.name} hint="The client sees it as the title of the form">
          <Input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />
        </Field>
      </div>
    </Modal>
  );
}

function QuestionnaireEditor({ id, onBack }) {
  const toast = useToast();
  const form = useFetch(() => api.raw(`/questionnaires/${id}`), [id]);
  const q = form.data?.data;
  const draft = q?.versions.find((v) => v.status === 'draft');
  const published = q?.versions.find((v) => v.status === 'published');
  const [def, setDef] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [problems, setProblems] = useState([]);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null);

  useEffect(() => { if (draft) { setDef(structuredClone(draft.definition)); setProblems(draft.problems || []); setDirty(false); } else setDef(null); }, [draft?.id, draft?.updated_at]);

  const change = (next) => { setDef(next); setDirty(true); };
  async function run(fn, ok) {
    setBusy(true);
    try { const r = await fn(); if (ok) toast(ok, 'success'); return r; }
    catch (err) { setProblems(err.details?.problems || problems); toast(err.message, 'danger'); return null; }
    finally { setBusy(false); }
  }
  async function save() {
    const r = await run(() => api.raw(`/questionnaire-versions/${draft.id}`, { method: 'PATCH', body: { definition: def } }), 'Draft saved');
    if (r) { setProblems(r.data.problems); setDirty(false); }
    return r;
  }
  async function publish() {
    if (dirty && !(await save())) return;
    const r = await run(() => api.action(`/questionnaire-versions/${draft.id}/publish`), `Version ${draft.version} published: staff can send it now`);
    if (r) form.refetch();
  }

  if (!q) return form.error ? <Alert tone="danger"><span>{form.error}</span></Alert> : <div className="skeleton" style={{ height: 200 }} />;
  return (
    <div className="stack">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn--sm btn--ghost" onClick={() => { if (!dirty || window.confirm('Leave without saving the draft?')) onBack(); }}><ChevronLeft className="size-3.5" aria-hidden="true" /> All questionnaires</button>
        <span className="strong">{q.name}</span>
        <span className="small muted">{q.service_name}</span>
        {published && <Badge tone="success">version {published.version} published</Badge>}
        {draft && <Badge tone="warning">version {draft.version} draft{dirty ? ', unsaved' : ''}</Badge>}
        <span className="ml-auto flex flex-wrap gap-2">
          <button type="button" className="btn btn--sm btn--ghost" disabled={busy} onClick={() => run(() => api.raw(`/questionnaires/${id}`, { method: 'PATCH', body: { active: !q.active } }), q.active ? 'Switched off: staff can no longer send it' : 'Switched on').then(() => form.refetch())}>{q.active ? 'Switch off' : 'Switch on'}</button>
        </span>
      </div>

      {!draft ? (
        <div className="stack">
          <Alert tone="info"><span>Version {published?.version} is published and frozen. To change the questions, start a new version: the published one stays in use until the new one is published.</span></Alert>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn--primary" disabled={busy} onClick={() => run(() => api.action(`/questionnaires/${id}/versions`)).then((r) => r && form.refetch())}>Edit as a new version</button>
            {published && <button type="button" className="btn" onClick={() => setPreview(published.definition)}>Preview as the client</button>}
          </div>
        </div>
      ) : def && (
        <>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn--sm" disabled={busy || !dirty} onClick={save}>Save draft</button>
            <button type="button" className="btn btn--sm" onClick={() => setPreview(def)}>Preview as the client</button>
            <button type="button" className="btn btn--sm btn--primary" disabled={busy} onClick={publish}>Publish version {draft.version}</button>
            {q.versions.length > 1 && <button type="button" className="btn btn--sm btn--ghost" disabled={busy} onClick={() => window.confirm('Discard this draft?') && run(() => api.remove('questionnaire-versions', draft.id), 'Draft discarded').then(() => form.refetch())}>Discard draft</button>}
          </div>
          {problems.length > 0 && (
            <Alert tone="warning">
              <span>
                <strong>Before it can be published:</strong>
                <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{problems.slice(0, 12).map((p) => <li key={p}>{p}</li>)}</ul>
                {problems.length > 12 && <span className="small"> and {problems.length - 12} more.</span>}
              </span>
            </Alert>
          )}
          <DefinitionEditor def={def} onChange={change} />
        </>
      )}

      <section>
        <div className="strong" style={{ margin: '8px 0 6px' }}>Versions</div>
        <DataTable rows={q.versions} columns={[
          { key: 'version', header: 'Version', render: (v) => `Version ${v.version}` },
          { key: 'status', header: 'State', render: (v) => <Badge tone={v.status === 'published' ? 'success' : v.status === 'draft' ? 'warning' : 'neutral'}>{v.status}</Badge> },
          { key: 'published_at', header: 'Published', render: (v) => (v.published_at ? `${date(v.published_at)}${v.published_by ? ` by ${v.published_by}` : ''}` : '—') },
          { key: 'responses', header: 'Sent', align: 'right' },
          { key: 'act', header: '', align: 'right', render: (v) => <button type="button" className="btn btn--sm btn--ghost" onClick={() => setPreview(v.definition)}>Preview</button> },
        ]} />
      </section>

      {preview && (
        <Modal title={`Preview · ${q.name}`} subtitle="What the client sees. Nothing is saved or sent from here." size="lg" onClose={() => setPreview(null)}>
          <QuestionnaireForm definition={preview} preview />
        </Modal>
      )}
    </div>
  );
}

/** The steps and their questions, edited in place. */
function DefinitionEditor({ def, onChange }) {
  const setStep = (i, s) => onChange({ ...def, steps: def.steps.map((x, j) => (j === i ? s : x)) });
  const addStep = () => {
    const taken = new Set(def.steps.map((s) => s.key));
    onChange({ ...def, steps: [...def.steps, { key: uniqueKey(`step_${def.steps.length + 1}`, taken), title: `Step ${def.steps.length + 1}`, questions: [] }] });
  };
  return (
    <div className="stack">
      <Field label="Opening words" hint="Shown above the first step: why we ask, and how long it takes">
        <Textarea rows={2} value={def.intro || ''} onChange={(e) => onChange({ ...def, intro: e.target.value || undefined })} />
      </Field>
      {def.steps.map((s, i) => (
        <StepEditor key={i} def={def} step={s} index={i} count={def.steps.length} onChange={(x) => setStep(i, x)}
          onMove={(d) => onChange({ ...def, steps: move(def.steps, i, d) })}
          onRemove={() => (!s.questions.length || window.confirm(`Delete the step "${s.title}" and its ${s.questions.length} questions?`)) && onChange({ ...def, steps: def.steps.filter((_, j) => j !== i) })} />
      ))}
      <div><button type="button" className="btn btn--sm" onClick={addStep}><Plus className="size-3.5" aria-hidden="true" /> Add a step</button></div>
    </div>
  );
}

function StepEditor({ def, step, index, count, onChange, onMove, onRemove }) {
  const [open, setOpen] = useState(null);   // question index being edited
  const setQ = (i, q) => onChange({ ...step, questions: step.questions.map((x, j) => (j === i ? q : x)) });
  // The questions before this one, anywhere in the form, are what "show if" can depend on.
  const before = (qi) => def.steps.slice(0, index).flatMap((s) => s.questions).concat(step.questions.slice(0, qi))
    .filter((q) => !['table', 'file', 'info'].includes(q.type));
  const add = () => {
    const key = uniqueKey('new_question', keysOf(def));
    onChange({ ...step, questions: [...step.questions, { key, type: 'text', label: 'New question' }] });
    setOpen(step.questions.length);
  };
  const duplicate = (i) => {
    const copy = structuredClone(step.questions[i]);
    copy.key = uniqueKey(copy.key, keysOf(def));
    copy.label = `${copy.label} (copy)`;
    const qs = [...step.questions]; qs.splice(i + 1, 0, copy);
    onChange({ ...step, questions: qs });
    setOpen(i + 1);
  };
  return (
    <section className="rounded-[10px] border border-border bg-card p-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="small muted" style={{ alignSelf: 'center' }}>Step {index + 1}</div>
        <div className="min-w-[200px] flex-1"><Field label="Title"><Input value={step.title} onChange={(e) => onChange({ ...step, title: e.target.value })} /></Field></div>
        <div className="flex gap-1">
          <button type="button" className="btn btn--sm btn--ghost" aria-label="Move the step up" disabled={index === 0} onClick={() => onMove(-1)}><ArrowUp className="size-3.5" aria-hidden="true" /></button>
          <button type="button" className="btn btn--sm btn--ghost" aria-label="Move the step down" disabled={index === count - 1} onClick={() => onMove(1)}><ArrowDown className="size-3.5" aria-hidden="true" /></button>
          <button type="button" className="btn btn--sm btn--ghost" aria-label="Delete the step" onClick={onRemove}><Trash2 className="size-3.5" aria-hidden="true" /></button>
        </div>
      </div>
      <div style={{ marginTop: 8 }}>
        <Field label="Explanation" hint="Optional"><Input value={step.description || ''} onChange={(e) => onChange({ ...step, description: e.target.value || undefined })} /></Field>
      </div>
      <div className="stack" style={{ marginTop: 12 }}>
        {step.questions.map((q, qi) => (
          <div key={qi} className="rounded-md border border-border">
            <div className="flex flex-wrap items-center gap-2 px-3 py-2">
              <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setOpen(open === qi ? null : qi)} aria-expanded={open === qi}>
                {open === qi ? <ChevronDown className="size-3.5 shrink-0" aria-hidden="true" /> : <ChevronRight className="size-3.5 shrink-0" aria-hidden="true" />}
                <span className="min-w-0 truncate text-[13.5px]">{q.label || <span className="muted">No label</span>}</span>
                {q.required && <span className="text-[12px] text-destructive">required</span>}
                {q.show_if && <span className="small muted">conditional</span>}
              </button>
              <span className="small muted">{TYPE_LABEL[q.type] || q.type}</span>
              <span className="mono small muted">{q.key}</span>
              <span className="flex gap-1">
                <button type="button" className="btn btn--sm btn--ghost" aria-label="Move up" disabled={qi === 0} onClick={() => onChange({ ...step, questions: move(step.questions, qi, -1) })}><ArrowUp className="size-3.5" aria-hidden="true" /></button>
                <button type="button" className="btn btn--sm btn--ghost" aria-label="Move down" disabled={qi === step.questions.length - 1} onClick={() => onChange({ ...step, questions: move(step.questions, qi, 1) })}><ArrowDown className="size-3.5" aria-hidden="true" /></button>
                <button type="button" className="btn btn--sm btn--ghost" aria-label="Duplicate" onClick={() => duplicate(qi)}><Copy className="size-3.5" aria-hidden="true" /></button>
                <button type="button" className="btn btn--sm btn--ghost" aria-label="Delete" onClick={() => { onChange({ ...step, questions: step.questions.filter((_, j) => j !== qi) }); setOpen(null); }}><Trash2 className="size-3.5" aria-hidden="true" /></button>
              </span>
            </div>
            {open === qi && (
              <div className="border-t border-border px-3 py-3">
                <QuestionEditor q={q} taken={keysOf(def)} earlier={before(qi)} onChange={(x) => setQ(qi, x)} />
              </div>
            )}
          </div>
        ))}
        <div><button type="button" className="btn btn--sm" onClick={add}><Plus className="size-3.5" aria-hidden="true" /> Add a question</button></div>
      </div>
    </section>
  );
}

/** One question's settings; a table column uses the same editor without the table-only parts. */
function QuestionEditor({ q, taken, earlier = [], onChange, column = false }) {
  const set = (patch) => {
    const next = { ...q, ...patch };
    for (const k of Object.keys(next)) if (next[k] === undefined || next[k] === '') delete next[k];
    onChange(next);
  };
  const setLabel = (label) => {
    // The key follows the label until somebody edits it.
    const follows = !q.key || q.key === slug(q.label) || /^new_question(_\d+)?$/.test(q.key) || /^column(_\d+)?$/.test(q.key);
    const others = new Set([...taken].filter((k) => k !== q.key));
    set({ label, ...(follows ? { key: uniqueKey(slug(label), others) } : {}) });
  };
  const setType = (type) => {
    const next = { ...q, type };
    if (CHOICE.has(type) && !next.options?.length) next.options = [{ key: 'option_1', label: 'Option 1' }];
    if (!CHOICE.has(type)) delete next.options;
    if (type === 'table' && !next.columns?.length) next.columns = [{ key: 'column', type: 'text', label: 'Column' }];
    if (type !== 'table') { delete next.columns; delete next.min_rows; delete next.max_rows; }
    if (!['number', 'money'].includes(type)) { delete next.min; delete next.max; delete next.integer; }
    if (type !== 'money') delete next.currency;
    if (type !== 'file') delete next.multiple;
    if (!['text', 'textarea'].includes(type)) delete next.prefill;
    if (type === 'info') delete next.required;
    onChange(next);
  };
  const num = (v) => (v === '' ? undefined : Number(v));
  const types = column ? CELL_TYPES : Object.keys(TYPE_LABEL);
  return (
    <div className="stack">
      <div className="form-grid">
        <div className="span-all">
          <Field label={q.type === 'info' ? 'Guidance text' : 'Question'} required>
            {q.type === 'info' ? <Textarea rows={2} value={q.label} onChange={(e) => setLabel(e.target.value)} /> : <Input value={q.label} onChange={(e) => setLabel(e.target.value)} />}
          </Field>
        </div>
        <Field label="Kind of answer"><Select value={q.type} placeholder={null} options={types.map((t) => ({ value: t, label: TYPE_LABEL[t] }))} onChange={(e) => setType(e.target.value)} /></Field>
        <Field label="Key" hint="What pricing and wording refer to; keep it once answers exist"><Input className="mono" value={q.key} onChange={(e) => set({ key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })} /></Field>
        {q.type !== 'info' && (
          <label className="flex items-center gap-2 text-[13px]" style={{ alignSelf: 'end', paddingBottom: 8 }}>
            <input type="checkbox" checked={Boolean(q.required)} onChange={(e) => set({ required: e.target.checked || undefined })} /> Required
          </label>
        )}
        {q.type !== 'info' && <div className="span-all"><Field label="Help text" hint="Optional, under the question"><Input value={q.help || ''} onChange={(e) => set({ help: e.target.value })} /></Field></div>}
        {['text', 'textarea'].includes(q.type) && !column && (
          <Field label="Fill in from our records" hint="The client sees it filled in and can change it">
            <Select value={q.prefill || ''} placeholder="No" options={PREFILL} onChange={(e) => set({ prefill: e.target.value || undefined })} />
          </Field>
        )}
        {['number', 'money'].includes(q.type) && (
          <>
            <Field label="Lowest allowed"><Input type="number" value={q.min ?? ''} onChange={(e) => set({ min: num(e.target.value) })} /></Field>
            <Field label="Highest allowed"><Input type="number" value={q.max ?? ''} onChange={(e) => set({ max: num(e.target.value) })} /></Field>
            <label className="flex items-center gap-2 text-[13px]" style={{ alignSelf: 'end', paddingBottom: 8 }}>
              <input type="checkbox" checked={Boolean(q.integer)} onChange={(e) => set({ integer: e.target.checked || undefined })} /> Whole numbers only
            </label>
          </>
        )}
        {q.type === 'money' && <Field label="Currency"><Input value={q.currency || 'INR'} maxLength={3} onChange={(e) => set({ currency: e.target.value.toUpperCase() })} /></Field>}
        {q.type === 'file' && (
          <label className="flex items-center gap-2 text-[13px]" style={{ alignSelf: 'end', paddingBottom: 8 }}>
            <input type="checkbox" checked={Boolean(q.multiple)} onChange={(e) => set({ multiple: e.target.checked || undefined })} /> Several files
          </label>
        )}
        {q.type === 'table' && (
          <>
            <Field label="Fewest rows"><Input type="number" min="0" value={q.min_rows ?? ''} onChange={(e) => set({ min_rows: num(e.target.value) })} /></Field>
            <Field label="Most rows"><Input type="number" min="1" value={q.max_rows ?? ''} onChange={(e) => set({ max_rows: num(e.target.value) })} /></Field>
          </>
        )}
      </div>
      {CHOICE.has(q.type) && <OptionsEditor options={q.options || []} onChange={(options) => set({ options })} />}
      {q.type === 'table' && <ColumnsEditor columns={q.columns || []} onChange={(columns) => set({ columns })} />}
      {!column && q.type !== 'info' && <ShowIfEditor rule={q.show_if} earlier={earlier} onChange={(show_if) => set({ show_if })} />}
    </div>
  );
}

function OptionsEditor({ options, onChange }) {
  const setOpt = (i, label) => {
    const o = options[i];
    const follows = o.key === slug(o.label) || /^option_\d+$/.test(o.key);
    const others = new Set(options.filter((_, j) => j !== i).map((x) => x.key));
    onChange(options.map((x, j) => (j === i ? { label, key: follows ? uniqueKey(slug(label), others) : x.key } : x)));
  };
  return (
    <div>
      <div className="small strong" style={{ marginBottom: 6 }}>Options</div>
      <div className="stack" style={{ gap: 6 }}>
        {options.map((o, i) => (
          <div key={i} className="flex items-center gap-2">
            <Input value={o.label} onChange={(e) => setOpt(i, e.target.value)} aria-label={`Option ${i + 1}`} />
            <span className="mono small muted" style={{ minWidth: 90 }}>{o.key}</span>
            <button type="button" className="btn btn--sm btn--ghost" aria-label="Move up" disabled={i === 0} onClick={() => onChange(move(options, i, -1))}><ArrowUp className="size-3.5" aria-hidden="true" /></button>
            <button type="button" className="btn btn--sm btn--ghost" aria-label="Remove option" onClick={() => onChange(options.filter((_, j) => j !== i))}><Trash2 className="size-3.5" aria-hidden="true" /></button>
          </div>
        ))}
        <div><button type="button" className="btn btn--sm" onClick={() => onChange([...options, { key: uniqueKey(`option_${options.length + 1}`, new Set(options.map((o) => o.key))), label: `Option ${options.length + 1}` }])}><Plus className="size-3.5" aria-hidden="true" /> Add an option</button></div>
      </div>
    </div>
  );
}

function ColumnsEditor({ columns, onChange }) {
  const [open, setOpen] = useState(0);
  const taken = new Set(columns.map((c) => c.key));
  return (
    <div>
      <div className="small strong" style={{ marginBottom: 6 }}>Columns (asked once per row)</div>
      <div className="stack" style={{ gap: 6 }}>
        {columns.map((c, i) => (
          <div key={i} className="rounded-md border border-border">
            <div className="flex items-center gap-2 px-3 py-1.5">
              <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setOpen(open === i ? null : i)}>
                {open === i ? <ChevronDown className="size-3.5" aria-hidden="true" /> : <ChevronRight className="size-3.5" aria-hidden="true" />}
                <span className="truncate text-[13px]">{c.label}</span>
                <span className="small muted">{TYPE_LABEL[c.type]}</span>
              </button>
              <button type="button" className="btn btn--sm btn--ghost" aria-label="Remove column" onClick={() => onChange(columns.filter((_, j) => j !== i))}><Trash2 className="size-3.5" aria-hidden="true" /></button>
            </div>
            {open === i && <div className="border-t border-border px-3 py-3"><QuestionEditor column q={c} taken={taken} onChange={(x) => onChange(columns.map((y, j) => (j === i ? x : y)))} /></div>}
          </div>
        ))}
        <div><button type="button" className="btn btn--sm" onClick={() => { onChange([...columns, { key: uniqueKey('column', taken), type: 'text', label: 'Column' }]); setOpen(columns.length); }}><Plus className="size-3.5" aria-hidden="true" /> Add a column</button></div>
      </div>
    </div>
  );
}

/** "Show this question only if …", on an earlier answer. */
function ShowIfEditor({ rule, earlier, onChange }) {
  const target = earlier.find((q) => q.key === rule?.key);
  const valueOptions = target?.type === 'yesno' ? [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }]
    : CHOICE.has(target?.type) ? target.options.map((o) => ({ value: o.key, label: o.label })) : null;
  const parse = (v) => (target?.type === 'yesno' ? v === 'true' : ['number', 'money'].includes(target?.type) ? (v === '' ? undefined : Number(v)) : v);
  const ops = ['number', 'money', 'date'].includes(target?.type) ? OPS : OPS.filter((o) => !['gt', 'gte', 'lt', 'lte'].includes(o.value));
  return (
    <div>
      <div className="small strong" style={{ marginBottom: 6 }}>Show this question</div>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={rule ? rule.key : ''} placeholder="Always" options={earlier.map((q) => ({ value: q.key, label: `only if "${q.label}"` }))}
          onChange={(e) => onChange(e.target.value ? { key: e.target.value, op: 'eq', value: undefined } : undefined)} />
        {rule && (
          <>
            <Select value={rule.op} placeholder={null} options={ops} onChange={(e) => onChange({ key: rule.key, op: e.target.value, ...(e.target.value === 'in' ? { value: [] } : {}) })} />
            {rule.op === 'in' && valueOptions && (
              <span className="flex flex-wrap gap-3">
                {valueOptions.map((o) => (
                  <label key={o.value} className="flex items-center gap-1.5 text-[13px]">
                    <input type="checkbox" checked={(rule.value || []).includes(parse(o.value))}
                      onChange={(e) => onChange({ ...rule, value: e.target.checked ? [...(rule.value || []), parse(o.value)] : (rule.value || []).filter((x) => x !== parse(o.value)) })} />
                    {o.label}
                  </label>
                ))}
              </span>
            )}
            {rule.op !== 'in' && rule.op !== 'answered' && (valueOptions
              ? <Select value={rule.value === undefined ? '' : String(rule.value)} placeholder="Choose…" options={valueOptions} onChange={(e) => onChange({ ...rule, value: e.target.value === '' ? undefined : parse(e.target.value) })} />
              : <Input style={{ width: 160 }} type={['number', 'money'].includes(target?.type) ? 'number' : target?.type === 'date' ? 'date' : 'text'} value={rule.value ?? ''} onChange={(e) => onChange({ ...rule, value: parse(e.target.value) })} />)}
          </>
        )}
      </div>
    </div>
  );
}
