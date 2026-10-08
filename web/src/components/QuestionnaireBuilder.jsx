import { useEffect, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, ClipboardList, Copy, Lock, Plus, Power, Trash2, TriangleAlert, X } from 'lucide-react';
import { toast as sonnerToast } from 'sonner';
import { cn } from 'cn';
import { ConfirmDialog, Modal, useToast } from './ui.jsx';
import { FailedCard, ListTable, LoadingPanel, PhoneRow, StateCard } from './daily.jsx';
import { MoneyBanner } from './money.jsx';
import { Tone } from './sales.jsx';
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
 *
 * Mocha Glass (Wave 3 canvas "Questionnaires"): the list, the New dialog,
 * the draft editor, the frozen published view, and confirm dialogs in
 * place of the browser's own.
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
const ORDERED_OPS = new Set(['gt', 'gte', 'lt', 'lte']);
const DATE_OPS = { gt: 'is after', gte: 'is on or after', lt: 'is before', lte: 'is on or before' };
const PREFILL = [
  { value: 'company.name', label: 'Company name' }, { value: 'company.gstin', label: 'Company GSTIN' }, { value: 'company.address', label: 'Company address' },
  { value: 'contact.name', label: 'Contact name' }, { value: 'contact.email', label: 'Contact email' }, { value: 'contact.phone', label: 'Contact phone' },
];

export const slug = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'q_$1').slice(0, 50) || 'question';
const uniqueKey = (base, taken) => { let k = base; let n = 2; while (taken.has(k)) k = `${base}_${n++}`.slice(0, 60); return k; };
const keysOf = (def) => new Set(def.steps.flatMap((s) => s.questions.map((q) => q.key)));
const move = (list, i, d) => { const j = i + d; if (j < 0 || j >= list.length) return list; const out = [...list]; [out[i], out[j]] = [out[j], out[i]]; return out; };
const times = (n) => `${n} time${n === 1 ? '' : 's'}`;
const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;
const STATE_TONE = { published: 'ok', draft: 'wait' };
const stateWord = (s) => (s ? `${s[0].toUpperCase()}${s.slice(1)}` : '');

/** The server names a problem "Step 2, question 3 (key): what is wrong". */
const PROBLEM = /^Step (\d+), question (\d+) \(([^)]+)\): (.+)$/;
function readProblem(p, def) {
  const m = PROBLEM.exec(p);
  if (!m) return { text: p };
  const step = def?.steps[Number(m[1]) - 1];
  const q = step?.questions.find((x) => x.key === m[3]) || step?.questions[Number(m[2]) - 1];
  return { key: m[3], where: `${step?.title || `Step ${m[1]}`} › ${q?.label || m[3]}`, text: m[4] };
}

/* ------------------------------------------------------------ small parts */

function F({ label, required, hint, error, className, children }) {
  return (
    <label className={cn('mg-field', className)}>
      <span className="mg-field__label">{label}{required && <span className="req" aria-hidden="true">*</span>}</span>
      {children}
      {error ? <span className="mg-field__error">{error}</span> : hint ? <span className="mg-field__hint">{hint}</span> : null}
    </label>
  );
}

function Sel({ value, onChange, options, placeholder, ...rest }) {
  return (
    <span className="mg-select-wrap" style={{ display: 'block' }}>
      <select className="mg-select" value={value} onChange={onChange} {...rest}>
        {placeholder != null && <option value="">{placeholder}</option>}
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </span>
  );
}

function Check({ checked, onChange, children }) {
  return (
    <label className="mg-check">
      <input type="checkbox" checked={checked} onChange={onChange} />
      <span>{children}</span>
    </label>
  );
}

function IconBtn({ label, icon: Icon, quiet, step, ...rest }) {
  return (
    <button type="button" className={cn('mg-iconbtn qb-ib', step && 'qb-ib--step', quiet && 'qb-ib--quiet')} aria-label={label} title={label.split(':')[0]} {...rest}>
      <Icon aria-hidden="true" strokeWidth={1.8} />
    </button>
  );
}

/* ------------------------------------------------------------------- list */

const defaultPane = (actions, body) => (
  <div className="flex flex-col gap-4">
    {actions && <div className="flex flex-wrap justify-end gap-2">{actions}</div>}
    {body}
  </div>
);

/**
 * `pane(actions, body)` lets the page put the header buttons in its own
 * header (Settings › Templates › Questionnaires).
 */
export function QuestionnaireBuilder({ pane = defaultPane }) {
  const [openId, setOpenId] = useState(null);
  const [creating, setCreating] = useState(false);
  const list = useFetch(() => api.raw('/questionnaires'), []);
  const rows = list.data?.data || [];
  if (openId) return pane(null, <QuestionnaireEditor id={openId} onBack={() => { setOpenId(null); list.refetch(); }} />);

  const newBtn = (cls = '') => (
    <button type="button" className={cn('mg-btn mg-btn--primary', cls)} onClick={() => setCreating(true)}>
      <Plus aria-hidden="true" />New questionnaire
    </button>
  );
  const body = list.error && !list.data ? (
    <FailedCard title="Couldn’t load the questionnaires" text="The server didn’t answer. Nothing was changed; try again in a moment." onRetry={list.refetch} />
  ) : list.loading && !list.data ? <LoadingPanel rows={3} /> : rows.length === 0 ? (
    <StateCard tone="plain" icon={ClipboardList} title="No questionnaires yet" text="Build one for a service: its steps and questions. Publish it, and staff can send it from an enquiry.">
      {newBtn()}
    </StateCard>
  ) : (
    <section className="mg-glass mg-glass--strong qb-list" data-a="rise" aria-label="Questionnaires">
      <ListTable
        bordered={false}
        label="Questionnaires, one per service"
        rows={rows}
        onRowClick={(r) => setOpenId(r.id)}
        columns={[
          { key: 'service_name', header: 'Service', render: (r) => <b>{r.service_name}</b> },
          { key: 'name', header: 'Questionnaire', className: 'qb-wrap', render: (r) => <button type="button" className="qb-link" onClick={(e) => { e.stopPropagation(); setOpenId(r.id); }}>{r.name}</button> },
          { key: 'published', header: 'Published', render: (r) => (r.published ? `Version ${r.published.version} · ${date(r.published.published_at)}` : <span className="mg-muted">not yet</span>) },
          { key: 'draft', header: 'Draft', render: (r) => (r.draft ? <Tone tone="wait">version {r.draft.version}</Tone> : <span className="mg-muted">—</span>) },
          { key: 'responses', header: 'Sent', num: true, render: (r) => <span className="mg-num">{r.responses ?? 0}</span> },
          { key: 'active', header: '', aria: 'Switched on or off', render: (r) => (!r.active ? <Tone>Switched off</Tone> : null) },
          { key: 'act', header: '', className: 'actions', render: (r) => <button type="button" className="mg-btn mg-btn--sm mg-btn--ghost" aria-label={`Open ${r.name}`} onClick={(e) => { e.stopPropagation(); setOpenId(r.id); }}>Open</button> },
        ]}
        phone={(r) => (
          <PhoneRow
            title={r.name}
            amount={`${r.responses ?? 0} sent`}
            meta={`${r.service_name} · ${r.published ? `version ${r.published.version} · ${date(r.published.published_at)}` : 'not published yet'}`}
            state={(r.draft || !r.active) && <span className="qb-badges">{r.draft && <Tone tone="wait">version {r.draft.version}</Tone>}{!r.active && <Tone>Off</Tone>}</span>}
            onClick={() => setOpenId(r.id)}
            label={`Open ${r.name}`}
            wraps
          />
        )}
      />
    </section>
  );
  return (
    <>
      {pane(rows.length > 0 || list.loading ? newBtn() : null, body)}
      {creating && <CreateDialog onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); setOpenId(id); }} />}
    </>
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
    <Modal title="New questionnaire" subtitle="One per service. It starts as a draft with one step, About you." size="sm" onClose={onClose}
      footer={<>
        <button type="button" className="mg-btn mg-btn--ghost max-sm:w-full" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="mg-btn mg-btn--primary max-sm:w-full" onClick={create} disabled={busy || !v.service_id || !v.name.trim()} aria-busy={busy || undefined}>{busy ? 'Creating…' : 'Create questionnaire'}</button>
      </>}>
      <div className="qb-dlg">
        <F label="Service" required error={errors.service_id} hint={services.error ? 'Couldn’t load the services. Close and try again.' : undefined}>
          <Sel value={v.service_id} placeholder="Choose a service" options={(services.rows || []).filter((s) => s.active !== false).map((s) => ({ value: String(s.id), label: s.name }))}
            aria-invalid={errors.service_id ? true : undefined}
            onChange={(e) => { const s = services.rows.find((x) => String(x.id) === e.target.value); setV({ service_id: e.target.value, name: v.name || (s ? `${s.name} questionnaire` : '') }); }} />
        </F>
        <F label="Name" required error={errors.name} hint="The client sees it as the title of the form">
          <input className="mg-input" value={v.name} aria-invalid={errors.name ? true : undefined} onChange={(e) => setV({ ...v, name: e.target.value })} />
        </F>
      </div>
    </Modal>
  );
}

/* ----------------------------------------------------------------- editor */

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
  const [preview, setPreview] = useState(null);     // { definition, label }
  const [confirm, setConfirm] = useState(null);     // 'leave' | 'discard' | 'switchoff'
  const [renaming, setRenaming] = useState(false);
  const [focus, setFocus] = useState(null);         // { key, n }: a problem's question to open

  useEffect(() => { if (draft) { setDef(structuredClone(draft.definition)); setProblems(draft.problems || []); setDirty(false); } else setDef(null); }, [draft?.id, draft?.updated_at]);

  const change = (next) => { setDef((d) => (typeof next === 'function' ? next(d) : next)); setDirty(true); };
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
  const toggleActive = () => run(() => api.raw(`/questionnaires/${id}`, { method: 'PATCH', body: { active: !q.active } }), q.active ? 'Switched off: staff can no longer send it' : 'Switched on')
    .then(() => { setConfirm(null); form.refetch(); });
  const discard = () => run(() => api.remove('questionnaire-versions', draft.id), 'Draft discarded').then(() => { setConfirm(null); form.refetch(); });
  const leave = () => (dirty ? setConfirm('leave') : onBack());
  const backBtn = (
    <button type="button" className="mg-btn mg-btn--sm mg-btn--ghost qb-ed__back" onClick={leave}><ChevronLeft aria-hidden="true" />All questionnaires</button>
  );

  if (!q) {
    return form.error ? (
      <FailedCard title="Couldn’t load this questionnaire" text="The server didn’t answer, so nothing is shown. Nothing has changed. Try again in a moment." onRetry={form.refetch}>
        <button type="button" className="mg-btn mg-btn--sm mg-btn--ghost" onClick={onBack}>All questionnaires</button>
      </FailedCard>
    ) : <LoadingPanel rows={4} />;
  }

  const sent = q.versions.reduce((n, v) => n + Number(v.responses || 0), 0);
  const badKeys = new Set(problems.map((p) => PROBLEM.exec(p)?.[3]).filter(Boolean));
  const shown = problems.slice(0, 12);

  return (
    <div className="flex min-w-0 flex-col gap-[18px]">
      <section className="mg-glass mg-glass--strong mg-panel qb-ed" data-a="rise" aria-labelledby="qb-ed-title">
        <div className="qb-ed__head">
          {backBtn}
          <span className="qb-ed__name">
            <h2 id="qb-ed-title">{q.name}</h2>
            <span>{q.service_name} · sent {times(sent)}</span>
          </span>
          <span className="qb-badges">
            {published && <Tone tone="ok">version {published.version} published</Tone>}
            {draft && <Tone tone="wait">version {draft.version} draft{dirty ? ', unsaved' : ''}</Tone>}
            {!q.active && <Tone>Switched off</Tone>}
          </span>
          <button type="button" className="mg-btn mg-btn--sm mg-btn--ghost" disabled={busy} onClick={() => setRenaming(true)}>Rename</button>
          {q.active && <button type="button" className="mg-btn mg-btn--sm mg-btn--ghost" disabled={busy} onClick={() => setConfirm('switchoff')}>Switch off</button>}
        </div>

        {!q.active && (
          <MoneyBanner tone="wait" icon={Power} title="Switched off." action={<button type="button" className="mg-btn mg-btn--sm" disabled={busy} onClick={toggleActive}>Switch on</button>}>
            {' '}Staff can’t send it from an enquiry. You can still edit and publish it; switch it on to offer it again.
          </MoneyBanner>
        )}

        {!draft ? (
          <>
            <MoneyBanner icon={Lock} role="note" title={`Version ${published?.version} is published and frozen.`}>
              {' '}To change the questions, start a new version: the published one stays in use until the new one is published, so answers always match the questions they were given.
            </MoneyBanner>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="mg-btn mg-btn--primary" disabled={busy} onClick={() => run(() => api.action(`/questionnaires/${id}/versions`)).then((r) => r && form.refetch())}>Edit as a new version</button>
              {published && <button type="button" className="mg-btn" onClick={() => setPreview({ definition: published.definition, label: `Version ${published.version}` })}>Preview as the client</button>}
            </div>
            {published && <Outline def={published.definition} />}
          </>
        ) : def && (
          <>
            <div className="qb-ed__bar">
              <button type="button" className="mg-btn" disabled={busy || !dirty} onClick={save}>Save draft</button>
              <button type="button" className="mg-btn" onClick={() => setPreview({ definition: def, label: `Version ${draft.version} draft` })}>Preview as the client</button>
              <button type="button" className="mg-btn mg-btn--primary" disabled={busy} onClick={publish}>Publish version {draft.version}</button>
              <span className={cn('qb-ed__state', dirty && 'is-dirty')} aria-live="polite">{dirty ? 'Unsaved changes' : busy ? 'Saving…' : 'All changes saved'}</span>
              {q.versions.length > 1 && <button type="button" className="mg-btn mg-btn--ghost qb-push" disabled={busy} onClick={() => setConfirm('discard')}>Discard draft</button>}
            </div>
            {problems.length > 0 && (
              <MoneyBanner tone="wait" icon={TriangleAlert} role="alert" title={`Before it can be published, fix ${problems.length === 1 ? 'one thing' : `${problems.length} things`}`}>
                <ul className="qb-problems">
                  {shown.map((p) => {
                    const x = readProblem(p, def);
                    return (
                      <li key={p}>
                        {x.where ? <><button type="button" onClick={() => setFocus({ key: x.key, n: Date.now() })}>{x.where}</button>: {x.text}</> : x.text}
                      </li>
                    );
                  })}
                </ul>
                {problems.length > 12 && <span> And {problems.length - 12} more.</span>}
              </MoneyBanner>
            )}
            <DefinitionEditor def={def} onChange={change} badKeys={badKeys} focus={focus}
              ctx={{ name: q.name, draft: draft.version, published: published?.version }} />
          </>
        )}
      </section>

      <section className="mg-glass mg-glass--strong qb-versions" data-a="rise" aria-labelledby="qb-ver-title">
        <div className="qb-versions__head">
          <h2 className="mg-panel__title" id="qb-ver-title">Versions</h2>
          <p>Each sent questionnaire keeps the version it was sent with, so old answers always match their questions.</p>
        </div>
        <ListTable
          bordered={false}
          label={`Versions of ${q.name}`}
          rows={q.versions}
          columns={[
            { key: 'version', header: 'Version', render: (v) => <b>Version {v.version}</b> },
            { key: 'status', header: 'State', render: (v) => <Tone tone={STATE_TONE[v.status] || 'plain'}>{stateWord(v.status)}</Tone> },
            { key: 'published_at', header: 'Published', render: (v) => (v.published_at ? `${date(v.published_at)}${v.published_by ? ` by ${v.published_by}` : ''}` : '—') },
            { key: 'responses', header: 'Sent', num: true, render: (v) => <span className="mg-num">{v.responses ?? 0}</span> },
            { key: 'act', header: '', className: 'actions', render: (v) => <button type="button" className="mg-btn mg-btn--sm mg-btn--ghost" aria-label={`Preview version ${v.version}`} onClick={() => setPreview({ definition: v.definition, label: `Version ${v.version}` })}>Preview</button> },
          ]}
          phone={(v) => (
            <PhoneRow title={`Version ${v.version}`} state={<Tone tone={STATE_TONE[v.status] || 'plain'}>{stateWord(v.status)}</Tone>}
              meta={`${v.published_at ? date(v.published_at) : 'not published'} · sent ${v.responses ?? 0}`}>
              <span className="set-rowacts">
                <button type="button" className="mg-btn mg-btn--sm mg-btn--ghost" aria-label={`Preview version ${v.version}`} onClick={() => setPreview({ definition: v.definition, label: `Version ${v.version}` })}>Preview</button>
              </span>
            </PhoneRow>
          )}
        />
      </section>

      {preview && (
        <Modal title={`Preview · ${q.name}`} subtitle={`${preview.label}. What the client sees. Nothing is saved or sent from here.`} size="lg" onClose={() => setPreview(null)}>
          <div className="qb-dlg">
            <MoneyBanner title="This is a preview.">{' '}Answers are not saved, and nothing is sent to the client.</MoneyBanner>
            <QuestionnaireForm definition={preview.definition} preview />
          </div>
        </Modal>
      )}
      {renaming && <RenameDialog q={q} onClose={() => setRenaming(false)} onSaved={() => { setRenaming(false); form.refetch(); }} />}
      {confirm === 'leave' && (
        <ConfirmDialog title="Leave without saving the draft?" subtitle={`${q.name} · version ${draft?.version}`}
          message={`Your changes since you last saved are lost.${published ? ` Version ${published.version} stays published and in use.` : ''}`}
          cancelLabel="Keep editing" confirmLabel="Leave without saving" onClose={() => setConfirm(null)} onConfirm={() => { setConfirm(null); onBack(); }} />
      )}
      {confirm === 'discard' && draft && (
        <ConfirmDialog title={`Discard the version ${draft.version} draft?`} subtitle={q.name}
          message={`${published ? `Version ${published.version} stays published and in use. ` : ''}The draft and all its changes are deleted; this cannot be undone.`}
          cancelLabel="Keep the draft" confirmLabel="Discard draft" busy={busy} busyLabel="Discarding…" onClose={() => setConfirm(null)} onConfirm={discard} />
      )}
      {confirm === 'switchoff' && (
        <ConfirmDialog tone="primary" title={`Switch off ${q.name}?`} subtitle={`Sent ${times(sent)}`}
          message="Staff can no longer send it from an enquiry. Nothing already sent or answered changes, and you can switch it back on at any time."
          confirmLabel="Switch off" busy={busy} busyLabel="Switching off…" onClose={() => setConfirm(null)} onConfirm={toggleActive} />
      )}
    </div>
  );
}

function RenameDialog({ q, onClose, onSaved }) {
  const toast = useToast();
  const [name, setName] = useState(q.name);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true); setError(null);
    try { await api.raw(`/questionnaires/${q.id}`, { method: 'PATCH', body: { name } }); toast('Renamed', 'success'); onSaved(); }
    catch (err) { setError(err.fields?.name || err.message); setBusy(false); }
  }
  return (
    <Modal title="Rename the questionnaire" subtitle={q.service_name} size="sm" onClose={onClose}
      footer={<>
        <button type="button" className="mg-btn mg-btn--ghost max-sm:w-full" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="mg-btn mg-btn--primary max-sm:w-full" onClick={save} disabled={busy || !name.trim() || name.trim() === q.name}>{busy ? 'Saving…' : 'Save name'}</button>
      </>}>
      <F label="Name" required error={error} hint="The client sees it as the title of the form">
        <input className="mg-input" value={name} aria-invalid={error ? true : undefined} onChange={(e) => setName(e.target.value)} />
      </F>
    </Modal>
  );
}

/** A frozen version, read: each step and what it asks. */
function Outline({ def }) {
  const note = (x) => (x.type === 'table' ? ` (table: ${(x.columns || []).map((c) => c.label).join(', ')})`
    : x.type === 'file' ? ' (file)' : x.prefill ? ' (filled in from our records)' : x.type === 'info' ? ' (guidance)' : '');
  return (
    <ol className="qb-outline" aria-label="What it asks">
      {(def?.steps || []).map((s, i) => (
        <li key={s.key || i}>
          <span className="mg-label">Step {i + 1}</span>
          <b>{s.title}</b>
          {s.questions.length ? <ul>{s.questions.map((x) => <li key={x.key}>{x.label}{note(x)}</li>)}</ul> : <span className="mg-muted">No questions</span>}
        </li>
      ))}
    </ol>
  );
}

/** The steps and their questions, edited in place. */
function DefinitionEditor({ def, onChange, badKeys, focus, ctx }) {
  const [removing, setRemoving] = useState(null);   // step index to confirm
  const setStep = (i, s) => onChange({ ...def, steps: def.steps.map((x, j) => (j === i ? s : x)) });
  const addStep = () => {
    const taken = new Set(def.steps.map((s) => s.key));
    onChange({ ...def, steps: [...def.steps, { key: uniqueKey(`step_${def.steps.length + 1}`, taken), title: `Step ${def.steps.length + 1}`, questions: [] }] });
  };
  const dropStep = (i) => onChange({ ...def, steps: def.steps.filter((_, j) => j !== i) });
  // Undo puts the question back where it was, in whatever the draft is by then.
  const restore = (stepKey, at, question) => onChange((d) => ({
    ...d,
    steps: d.steps.map((s) => (s.key === stepKey ? { ...s, questions: [...s.questions.slice(0, at), question, ...s.questions.slice(at)] } : s)),
  }));
  const gone = removing != null ? def.steps[removing] : null;
  return (
    <>
      <F label="Opening words" hint="Shown above the first step: why we ask, and how long it takes">
        <textarea className="mg-textarea" rows={2} value={def.intro || ''} onChange={(e) => onChange({ ...def, intro: e.target.value || undefined })} />
      </F>
      {def.steps.length === 0 && <p className="qb-step__none">No steps yet. Add a step, then the questions it asks.</p>}
      {def.steps.map((s, i) => (
        <StepEditor key={i} def={def} step={s} index={i} count={def.steps.length} badKeys={badKeys} focus={focus}
          onChange={(x) => setStep(i, x)}
          onMove={(d) => onChange({ ...def, steps: move(def.steps, i, d) })}
          onRemove={() => (s.questions.length ? setRemoving(i) : dropStep(i))}
          onRestore={(at, question) => restore(s.key, at, question)} />
      ))}
      <button type="button" className="mg-btn self-start" onClick={addStep}><Plus aria-hidden="true" />Add a step</button>
      {gone && (
        <ConfirmDialog title={`Delete the step "${gone.title}" and its ${plural(gone.questions.length, 'question')}?`}
          subtitle={`${ctx.name} · version ${ctx.draft} draft`}
          message={`Only the draft changes.${ctx.published ? ` Answers already given to version ${ctx.published} keep their questions.` : ''}`}
          confirmLabel="Delete step" onClose={() => setRemoving(null)} onConfirm={() => { dropStep(removing); setRemoving(null); }} />
      )}
    </>
  );
}

function StepEditor({ def, step, index, count, badKeys, focus, onChange, onMove, onRemove, onRestore }) {
  const [open, setOpen] = useState(null);   // question index being edited
  const setQ = (i, q) => onChange({ ...step, questions: step.questions.map((x, j) => (j === i ? q : x)) });
  const qid = (qi) => `qb-q-${index}-${qi}`;
  // A problem's link opens its question and brings it into view.
  useEffect(() => {
    if (!focus) return;
    const at = step.questions.findIndex((x) => x.key === focus.key);
    if (at < 0) return;
    setOpen(at);
    requestAnimationFrame(() => document.getElementById(qid(at))?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  }, [focus?.n]);
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
  const remove = (i) => {
    const gone = step.questions[i];
    onChange({ ...step, questions: step.questions.filter((_, j) => j !== i) });
    setOpen(null);
    sonnerToast(`Question deleted: ${gone.label || gone.key}`, { action: { label: 'Undo', onClick: () => onRestore(i, gone) } });
  };
  return (
    <section className="qb-step" aria-label={`Step ${index + 1}: ${step.title}`}>
      <div className="qb-step__head">
        <span className="mg-label qb-step__n">Step {index + 1}</span>
        <F label="Title" className="qb-step__title"><input className="mg-input" value={step.title} onChange={(e) => onChange({ ...step, title: e.target.value })} /></F>
        <F label="Explanation" className="qb-step__expl"><input className="mg-input" placeholder="Optional" value={step.description || ''} onChange={(e) => onChange({ ...step, description: e.target.value || undefined })} /></F>
        <span className="qb-tools qb-step__tools">
          <IconBtn step label="Move the step up" icon={ChevronUp} disabled={index === 0} onClick={() => onMove(-1)} />
          <IconBtn step label="Move the step down" icon={ChevronDown} disabled={index === count - 1} onClick={() => onMove(1)} />
          <IconBtn step quiet label={`Delete the step: ${step.title}`} icon={Trash2} onClick={onRemove} />
        </span>
      </div>
      {step.questions.length === 0 && <p className="qb-step__none">No questions in this step yet.</p>}
      {step.questions.map((q, qi) => {
        const isOpen = open === qi;
        const name = q.label || 'No label';
        return (
          <div key={qi} id={qid(qi)} className={cn('qb-q', badKeys.has(q.key) && 'is-bad')}>
            <div className="qb-q__head">
              <button type="button" className="qb-q__toggle" onClick={() => setOpen(isOpen ? null : qi)} aria-expanded={isOpen} aria-controls={`${qid(qi)}-body`}>
                <ChevronRight aria-hidden="true" />
                <span className={cn('qb-q__label', !q.label && 'is-empty')}>{name}</span>
                {q.required && <span className="qb-q__req">required</span>}
                {q.show_if && <span className="qb-q__cond">shown if…</span>}
                {badKeys.has(q.key) && <Tone tone="wait">needs a fix</Tone>}
              </button>
              <span className="qb-q__meta"><span className="qb-q__kind">{TYPE_LABEL[q.type] || q.type}</span><span className="qb-q__key">{q.key}</span></span>
              <span className="qb-tools">
                <IconBtn label={`Move up: ${name}`} icon={ChevronUp} disabled={qi === 0} onClick={() => onChange({ ...step, questions: move(step.questions, qi, -1) })} />
                <IconBtn label={`Move down: ${name}`} icon={ChevronDown} disabled={qi === step.questions.length - 1} onClick={() => onChange({ ...step, questions: move(step.questions, qi, 1) })} />
                <IconBtn label={`Duplicate: ${name}`} icon={Copy} onClick={() => duplicate(qi)} />
                <IconBtn quiet label={`Delete: ${name}`} icon={Trash2} onClick={() => remove(qi)} />
              </span>
            </div>
            {isOpen && (
              <div className="qb-q__body" id={`${qid(qi)}-body`}>
                <QuestionEditor q={q} taken={keysOf(def)} earlier={before(qi)} onChange={(x) => setQ(qi, x)} />
              </div>
            )}
          </div>
        );
      })}
      <button type="button" className="mg-btn mg-btn--sm self-start" onClick={add}><Plus aria-hidden="true" />Add a question</button>
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
  const backwards = (lo, hi) => lo !== undefined && hi !== undefined && lo > hi;
  return (
    <>
      <div className="qb-grid">
        <F label={q.type === 'info' ? 'Guidance text' : column ? 'Column' : 'Question'} required className="qb-all">
          {q.type === 'info'
            ? <textarea className="mg-textarea" rows={2} value={q.label} onChange={(e) => setLabel(e.target.value)} />
            : <input className="mg-input" value={q.label} onChange={(e) => setLabel(e.target.value)} />}
        </F>
        <F label="Kind of answer"><Sel value={q.type} options={types.map((t) => ({ value: t, label: TYPE_LABEL[t] }))} onChange={(e) => setType(e.target.value)} /></F>
        <F label="Key" hint="What pricing and wording refer to; keep it once answers exist"><input className="mg-input qb-key" value={q.key} onChange={(e) => set({ key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })} /></F>
        {q.type !== 'info' && <F label="Help text" className="qb-all"><input className="mg-input" placeholder="Optional, shown under the question" value={q.help || ''} onChange={(e) => set({ help: e.target.value })} /></F>}
        {['text', 'textarea'].includes(q.type) && !column && (
          <F label="Fill in from our records" hint="The client sees it filled in and can change it">
            <Sel value={q.prefill || ''} placeholder="No" options={PREFILL} onChange={(e) => set({ prefill: e.target.value || undefined })} />
          </F>
        )}
        {['number', 'money'].includes(q.type) && (
          <>
            <F label="Lowest allowed" hint="Optional" error={backwards(q.min, q.max) ? 'The lowest is above the highest' : undefined}>
              <input className="mg-input" type="number" value={q.min ?? ''} aria-invalid={backwards(q.min, q.max) || undefined} onChange={(e) => set({ min: num(e.target.value) })} />
            </F>
            <F label="Highest allowed" hint="Optional"><input className="mg-input" type="number" value={q.max ?? ''} onChange={(e) => set({ max: num(e.target.value) })} /></F>
          </>
        )}
        {q.type === 'money' && <F label="Currency" hint="Three letters, such as INR"><input className="mg-input" value={q.currency || 'INR'} maxLength={3} onChange={(e) => set({ currency: e.target.value.toUpperCase() })} /></F>}
        {q.type === 'table' && (
          <>
            <F label="Fewest rows" hint="Optional" error={backwards(q.min_rows, q.max_rows) ? 'Fewer rows allowed than required' : undefined}>
              <input className="mg-input" type="number" min="0" value={q.min_rows ?? ''} onChange={(e) => set({ min_rows: num(e.target.value) })} />
            </F>
            <F label="Most rows" hint="Optional"><input className="mg-input" type="number" min="1" value={q.max_rows ?? ''} onChange={(e) => set({ max_rows: num(e.target.value) })} /></F>
          </>
        )}
        {q.type !== 'info' && <Check checked={Boolean(q.required)} onChange={(e) => set({ required: e.target.checked || undefined })}>Required</Check>}
        {['number', 'money'].includes(q.type) && <Check checked={Boolean(q.integer)} onChange={(e) => set({ integer: e.target.checked || undefined })}>Whole numbers only</Check>}
        {q.type === 'file' && <Check checked={Boolean(q.multiple)} onChange={(e) => set({ multiple: e.target.checked || undefined })}>Several files</Check>}
      </div>
      {CHOICE.has(q.type) && <OptionsEditor options={q.options || []} onChange={(options) => set({ options })} />}
      {q.type === 'table' && <ColumnsEditor columns={q.columns || []} onChange={(columns) => set({ columns })} />}
      {!column && q.type !== 'info' && <ShowIfEditor rule={q.show_if} earlier={earlier} onChange={(show_if) => set({ show_if })} />}
    </>
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
    <fieldset className={cn('qb-set', !options.length && 'is-bad')}>
      <legend className="mg-field__label">Options</legend>
      {!options.length && <p className="mg-field__error" style={{ margin: 0 }}>Give it at least one option.</p>}
      {options.map((o, i) => (
        <div key={i} className="qb-opt">
          <input className="mg-input" value={o.label} placeholder="Type the option" onChange={(e) => setOpt(i, e.target.value)} aria-label={`Option ${i + 1}`} />
          <span className="qb-opt__key">{o.key}</span>
          <span className="qb-tools">
            <IconBtn label={`Move option ${i + 1} up`} icon={ChevronUp} disabled={i === 0} onClick={() => onChange(move(options, i, -1))} />
            <IconBtn label={`Move option ${i + 1} down`} icon={ChevronDown} disabled={i === options.length - 1} onClick={() => onChange(move(options, i, 1))} />
            <IconBtn quiet label={`Remove option ${i + 1}`} icon={X} onClick={() => onChange(options.filter((_, j) => j !== i))} />
          </span>
        </div>
      ))}
      <button type="button" className="mg-btn mg-btn--sm mg-btn--ghost qb-set__add" onClick={() => onChange([...options, { key: uniqueKey(`option_${options.length + 1}`, new Set(options.map((o) => o.key))), label: `Option ${options.length + 1}` }])}><Plus aria-hidden="true" />Add an option</button>
    </fieldset>
  );
}

function ColumnsEditor({ columns, onChange }) {
  const [open, setOpen] = useState(0);
  const taken = new Set(columns.map((c) => c.key));
  const moveCol = (i, d) => { onChange(move(columns, i, d)); if (open === i) setOpen(i + d); else if (open === i + d) setOpen(i); };
  return (
    <fieldset className={cn('qb-set', !columns.length && 'is-bad')}>
      <legend className="mg-field__label">Columns (asked once per row)</legend>
      {!columns.length && <p className="mg-field__error" style={{ margin: 0 }}>A table needs at least one column.</p>}
      {columns.map((c, i) => {
        const shown = open === i;
        const id = `qb-col-${i}-${c.key}`;
        return (
          <div key={i} className="qb-q qb-q--col">
            <div className="qb-q__head">
              <button type="button" className="qb-q__toggle" onClick={() => setOpen(shown ? null : i)} aria-expanded={shown} aria-controls={id}>
                <ChevronRight aria-hidden="true" />
                <span className="qb-q__label">{c.label || 'No label'}</span>
                {c.required && <span className="qb-q__req">required</span>}
              </button>
              <span className="qb-q__meta"><span className="qb-q__kind">{TYPE_LABEL[c.type]}</span></span>
              <span className="qb-tools">
                <IconBtn label={`Move column up: ${c.label}`} icon={ChevronUp} disabled={i === 0} onClick={() => moveCol(i, -1)} />
                <IconBtn label={`Move column down: ${c.label}`} icon={ChevronDown} disabled={i === columns.length - 1} onClick={() => moveCol(i, 1)} />
                <IconBtn quiet label={`Remove column: ${c.label}`} icon={Trash2} onClick={() => onChange(columns.filter((_, j) => j !== i))} />
              </span>
            </div>
            {shown && <div className="qb-q__body" id={id}><QuestionEditor column q={c} taken={taken} onChange={(x) => onChange(columns.map((y, j) => (j === i ? x : y)))} /></div>}
          </div>
        );
      })}
      <button type="button" className="mg-btn mg-btn--sm mg-btn--ghost qb-set__add" onClick={() => { onChange([...columns, { key: uniqueKey('column', taken), type: 'text', label: 'Column' }]); setOpen(columns.length); }}><Plus aria-hidden="true" />Add a column</button>
    </fieldset>
  );
}

/** "Show this question only if …", on an earlier answer. Only rules that can match are offered. */
function ShowIfEditor({ rule, earlier, onChange }) {
  const target = earlier.find((q) => q.key === rule?.key);
  const valueOptions = target?.type === 'yesno' ? [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }]
    : CHOICE.has(target?.type) ? (target.options || []).map((o) => ({ value: o.key, label: o.label })) : null;
  const parse = (v) => (target?.type === 'yesno' ? v === 'true' : ['number', 'money'].includes(target?.type) ? (v === '' ? undefined : Number(v)) : v);
  const ordered = ['number', 'money', 'date'].includes(target?.type);
  const ops = OPS
    .filter((o) => (ORDERED_OPS.has(o.value) ? ordered : o.value === 'in' ? Boolean(valueOptions) : true) || o.value === rule?.op)
    .map((o) => (target?.type === 'date' && DATE_OPS[o.value] ? { ...o, label: DATE_OPS[o.value] } : o));
  return (
    <fieldset className="qb-set">
      <legend className="mg-field__label">Show this question</legend>
      <div className="qb-rule">
        <F label="When" className="qb-rule__when">
          <Sel value={rule ? rule.key : ''} placeholder="Always" options={earlier.map((q) => ({ value: q.key, label: `only if "${q.label}"` }))}
            onChange={(e) => onChange(e.target.value ? { key: e.target.value, op: 'eq', value: undefined } : undefined)} />
        </F>
        {rule && (
          <>
            <F label="Rule" className="qb-rule__op">
              <Sel value={rule.op} options={ops} onChange={(e) => onChange({ key: rule.key, op: e.target.value, ...(e.target.value === 'in' ? { value: [] } : {}) })} />
            </F>
            {rule.op === 'in' && valueOptions && (
              <fieldset className="qb-rule__in" style={{ margin: 0, padding: 0, border: 0, minWidth: 0 }}>
                <legend className="mg-field__label" style={{ padding: 0, flex: '1 1 100%' }}>Any of these answers</legend>
                {valueOptions.map((o) => (
                  <Check key={o.value} checked={(rule.value || []).includes(parse(o.value))}
                    onChange={(e) => onChange({ ...rule, value: e.target.checked ? [...(rule.value || []), parse(o.value)] : (rule.value || []).filter((x) => x !== parse(o.value)) })}>
                    {o.label}
                  </Check>
                ))}
              </fieldset>
            )}
            {rule.op !== 'in' && rule.op !== 'answered' && (
              <F label="Answer" className="qb-rule__val">
                {valueOptions
                  ? <Sel value={rule.value === undefined ? '' : String(rule.value)} placeholder="Choose…" options={valueOptions} onChange={(e) => onChange({ ...rule, value: e.target.value === '' ? undefined : parse(e.target.value) })} />
                  : <input className="mg-input" type={['number', 'money'].includes(target?.type) ? 'number' : target?.type === 'date' ? 'date' : 'text'} value={rule.value ?? ''} onChange={(e) => onChange({ ...rule, value: parse(e.target.value) })} />}
              </F>
            )}
          </>
        )}
      </div>
      <p className="qb-set__note">
        {earlier.length
          ? 'Rules offer only what can match: "is one of" for questions with options, "is after / is before" for dates, "is more than / less than" for numbers and money.'
          : 'No earlier question can decide this one yet: tables, files and guidance text can’t be used.'}
      </p>
    </fieldset>
  );
}
