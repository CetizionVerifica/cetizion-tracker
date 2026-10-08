import { useState } from 'react';
import { ExternalLink, Plus } from 'lucide-react';
import { Field, FileDrop, Input, Modal, Select, Textarea, useToast } from './ui.jsx';
import { ListTable, Panel, PanelSkeleton, PhoneRow, StateCard } from './daily.jsx';
import { Sec } from './sales.jsx';
import { api } from '../lib/api.js';
import { useFetch, useLookups } from '../lib/hooks.js';
import { date, today } from '../lib/format.js';

/**
 * Certificates and deliverables (#43): the register panel, the issue/edit
 * dialog, supersede and withdraw. Used by the register page, the company
 * page and the project page.
 */
export const DELIVERABLE_TYPES = [
  { value: 'certificate', label: 'Certificate' }, { value: 'scorecard', label: 'Scorecard' },
  { value: 'report', label: 'Report' }, { value: 'audit_finding', label: 'Audit finding' }, { value: 'statement', label: 'Statement' },
];
export const DELIVERABLE_STATUSES = [
  { value: 'issued', label: 'Issued' }, { value: 'draft', label: 'Draft' }, { value: 'expired', label: 'Expired' },
  { value: 'superseded', label: 'Superseded' }, { value: 'withdrawn', label: 'Withdrawn' },
];
const TONE = { issued: 'mg-badge--ok', draft: 'mg-badge--plain', expired: 'mg-badge--late', withdrawn: 'mg-badge--late', superseded: 'mg-badge--plain' };
const typeLabel = (t) => DELIVERABLE_TYPES.find((x) => x.value === t)?.label || t;
const statusLabel = (s) => DELIVERABLE_STATUSES.find((x) => x.value === s)?.label || s;
const renewal = (r) => (r.engagement_status ? `${r.engagement_status.replace('_', ' ').replace(/^./, (c) => c.toUpperCase())} · due ${date(r.engagement_due)}` : null);

/**
 * `filters` (the register's search and pickers) sit in the panel under its
 * head; `filtered` says whether any are set, so an empty list can say
 * "nothing matches" rather than "nothing recorded", and `onClear` resets them.
 */
export function DeliverablesTable({ params, preset = {}, title = 'Certificates and deliverables', hint, compact = false, filters, filtered = false, onClear, flat = false }) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v != null)).toString();
  const { data, loading, error, refetch } = useFetch(() => api.raw(`/deliverables${qs ? `?${qs}` : ''}`), [qs]);
  const [dialog, setDialog] = useState(null);   // { mode: 'new'|'edit'|'supersede'|'withdraw', row }
  const rows = data?.data ?? [];
  const name = (r) => r.reference || r.title;
  const actions = (r) => [
    ['draft', 'issued', 'expired'].includes(r.status) && ['edit', 'Edit'],
    ['issued', 'expired'].includes(r.status) && ['supersede', 'Supersede'],
    ['issued', 'expired'].includes(r.status) && ['withdraw', 'Withdraw'],
  ].filter(Boolean);

  const cols = [
    { key: 'what', header: 'What', className: 'app-wrap', render: (r) => <><b>{r.title}</b><span className="sub">{typeLabel(r.type)}{r.reference && <> · <span className="mg-num">{r.reference}</span></>}</span>{r.scope && <span className="sub">{r.scope}</span>}</> },
    !compact && { key: 'client', header: 'Client · service', className: 'app-wrap--sm', render: (r) => <><b>{r.client_name}</b>{r.service_name && <span className="sub">{r.service_name}</span>}</> },
    compact && { key: 'service', header: 'Service', className: 'app-wrap--sm', render: (r) => r.service_name || '—' },
    { key: 'issued', header: 'Issued', className: 'mg-num', render: (r) => (r.issued_on ? date(r.issued_on) : '—') },
    { key: 'until', header: 'Valid until', className: 'mg-num', render: (r) => (r.valid_until ? <>{date(r.valid_until)}{r.status === 'issued' && r.days_left <= 90 && <span className="sub"><span className={`mg-badge ${r.days_left <= 30 ? 'mg-badge--late' : 'mg-badge--wait'} mt-0.5 h-5`}>{r.days_left} days left</span></span>}</> : '—') },
    { key: 'status', header: 'Status', render: (r) => <><span className={`mg-badge ${TONE[r.status] || 'mg-badge--plain'}`}>{statusLabel(r.status)}</span>{r.superseded_by_reference && <span className="sub mg-num">by {r.superseded_by_reference}</span>}</> },
    { key: 'renewal', header: 'Renewal', className: 'app-wrap--sm text-[12.5px]', render: (r) => renewal(r) || <span className="text-muted-foreground">—</span> },
    { key: 'file', header: 'File', render: (r) => (r.document_id
      ? <a className="mg-btn mg-btn--ghost mg-btn--sm px-2.5" href={api.documentUrl(r.document_id)} target="_blank" rel="noopener noreferrer" aria-label={`Open the file for ${name(r)}`}>Open<ExternalLink className="size-3.5" aria-hidden="true" /></a>
      : <span className="text-[12.5px] text-muted-foreground">No file</span>) },
    { key: 'act', header: '', className: 'actions', render: (r) => actions(r).map(([mode, label]) => (
      <button key={mode} type="button" className="mg-btn mg-btn--sm mg-btn--ghost px-2.5" aria-label={`${label} ${name(r)}`} onClick={() => setDialog({ mode, row: r })}>{label}</button>
    )) },
  ].filter(Boolean);

  // `flat`: a section of a record's tab panel, which is already glass.
  const Wrap = flat ? FlatPanel : Panel;
  return (
    <Wrap id={`dl-${compact ? 'c' : 'r'}`} title={title} hint={hint}
      tools={<button type="button" className="mg-btn mg-btn--sm mg-btn--primary" onClick={() => setDialog({ mode: 'new' })}><Plus className="size-4" aria-hidden="true" />Issue a deliverable</button>}>
      {filters && <div className="mg-filterbar px-[22px] pt-1 pb-3.5">{filters}</div>}
      {error ? (
        <StateCard inPanel tone="late" role="alert" title="Couldn’t load the register" text="The server didn’t answer. Nothing on file has changed; try again.">
          <button type="button" className="mg-btn mg-btn--sm" onClick={refetch}>Try again</button>
        </StateCard>
      ) : loading && !data ? <PanelSkeleton /> : rows.length ? (
        <ListTable
          label={title}
          rows={rows}
          columns={cols}
          phone={(r) => {
            const first = actions(r)[0];
            return (
              <PhoneRow title={r.title} wraps amount={<span className="text-[12.5px]">{r.valid_until ? `until ${date(r.valid_until)}` : ''}</span>}
                meta={`${compact ? '' : `${r.client_name} · `}${typeLabel(r.type)}${r.reference ? ` · ${r.reference}` : ''}`}
                state={<span className={`mg-badge ${r.status === 'issued' && r.days_left <= 30 ? 'mg-badge--late' : TONE[r.status] || 'mg-badge--plain'}`}>{r.status === 'issued' && r.days_left <= 90 ? `${r.days_left} days left` : statusLabel(r.status)}</span>}
                go={first ? `${first[1]} →` : null} label={`${r.title}, ${statusLabel(r.status)}${first ? `. ${first[1]}` : ''}`}
                onClick={first ? () => setDialog({ mode: first[0], row: r }) : undefined}
              />
            );
          }}
        />
      ) : filtered ? (
        <StateCard inPanel tone="plain" title="Nothing matches these filters" text="Try a wider expiry window, another type or status, or clear the search.">
          {onClear && <button type="button" className="mg-btn mg-btn--sm" onClick={onClear}>Clear the filters</button>}
        </StateCard>
      ) : (
        <StateCard inPanel tone="plain" title="Nothing recorded yet" text="Record what the client holds: its reference, dates, scope and file. An expiry date schedules the renewal.">
          <button type="button" className="mg-btn mg-btn--sm mg-btn--primary" onClick={() => setDialog({ mode: 'new' })}>Issue a deliverable</button>
        </StateCard>
      )}
      {dialog?.mode === 'withdraw' && <WithdrawDialog row={dialog.row} onClose={() => setDialog(null)} onDone={() => { setDialog(null); refetch(); }} />}
      {dialog && dialog.mode !== 'withdraw' && <DeliverableDialog mode={dialog.mode} row={dialog.row} preset={preset} onClose={() => setDialog(null)} onDone={() => { setDialog(null); refetch(); }} />}
    </Wrap>
  );
}

/** The register as a section inside a panel: its head, then the table in a bordered box. */
function FlatPanel({ id, title, hint, tools, children }) {
  return (
    <Sec id={id} title={title} hint={hint} tools={tools}>
      <div className="app-box app-box--flush">{children}</div>
    </Sec>
  );
}

function DeliverableDialog({ mode, row, preset, onClose, onDone }) {
  const toast = useToast();
  const lookups = useLookups();
  const base = mode === 'new' ? { type: 'certificate', status: 'issued', issued_on: today(), ...preset } : row;
  const [v, setV] = useState(() => mode === 'supersede'
    ? { type: row.type, title: row.title, scope: row.scope || '', issuing_body: row.issuing_body || '', reference: '', issued_on: today(), valid_from: '', valid_until: '', notes: '' }
    : { company_id: '', project_id: '', po_number: '', service_id: '', reference: '', title: '', scope: '', issuing_body: '', valid_from: '', valid_until: '', owner: '', notes: '', ...Object.fromEntries(Object.entries(base).map(([k, x]) => [k, x ?? ''])) });
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState({});
  const set = (k) => (e) => setV((s) => ({ ...s, [k]: e.target.value }));
  const fixed = mode !== 'new' || preset.project_id || preset.company_id;
  const isDraft = mode === 'edit' && row.status === 'draft';

  async function save(e) {
    e.preventDefault(); setBusy(true); setErrors({});
    try {
      let document_id;
      if (file) document_id = (await api.uploadDocument(file, 'deliverables')).data.id;
      const keys = ['type', 'reference', 'title', 'issued_on', 'valid_from', 'valid_until', 'scope', 'issuing_body', 'owner', 'notes', 'status', 'service_id', ...(mode === 'new' ? ['company_id', 'project_id', 'po_number'] : [])];
      const body = Object.fromEntries(keys.filter((k) => v[k] !== undefined).map((k) => [k, v[k] === '' ? null : v[k]]));
      if (mode === 'supersede') { delete body.status; delete body.service_id; delete body.owner; }
      if (mode === 'edit' && row.status !== 'draft') delete body.status;
      if (document_id) body.document_id = document_id;
      if (mode === 'new') await api.action('/deliverables', body);
      else if (mode === 'edit') await api.raw(`/deliverables/${row.id}`, { method: 'PATCH', body });
      else await api.action(`/deliverables/${row.id}/supersede`, body);
      toast(mode === 'supersede' ? 'Superseded; the old one is kept'
        : isDraft && v.status === 'issued' ? 'Issued; reminders follow its expiry'
          : mode === 'new' ? 'Recorded' : 'Saved', 'success');
      onDone();
    } catch (err) { setErrors(err.fields || {}); toast(err.fields ? Object.values(err.fields)[0] : err.message, 'danger'); setBusy(false); }
  }
  async function removeDraft() {
    setBusy(true);
    try { await api.raw(`/deliverables/${row.id}`, { method: 'DELETE' }); toast('Draft deleted', 'success'); onDone(); }
    catch (err) { toast(err.message, 'danger'); setBusy(false); }
  }

  const noTitle = !String(v.title || '').trim();
  const title = mode === 'new' ? 'Issue a deliverable' : mode === 'edit' ? `Edit ${row.reference || row.title}` : `Supersede ${row.reference || row.title}`;
  return (
    <Modal title={title} subtitle={mode === 'supersede' ? 'Records the new issue. The old one stays on file, marked superseded, and the renewal follows the new expiry.' : 'An expiry date schedules the renewal and reminders at 120, 90 and 30 days.'} size="lg" onClose={onClose}
      footer={<>
        {isDraft && <button type="button" className="mg-btn mg-btn--ghost mr-auto text-late" onClick={removeDraft} disabled={busy}>Delete draft</button>}
        <button type="button" className="mg-btn mg-btn--ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="submit" form="deliverable-form" className="mg-btn mg-btn--primary" disabled={busy || noTitle} aria-describedby={noTitle ? 'dl-why' : undefined}>{busy ? 'Saving…' : mode === 'supersede' ? 'Record the new issue' : 'Save'}</button>
        {noTitle && <span id="dl-why" className="app-why">Give it a title to save it.</span>}
      </>}>
      <form id="deliverable-form" onSubmit={save} className="flex flex-col gap-3.5">
        <div className="mg-grid2">
          <div className="col-span-full"><Field label="Title" required error={errors.title}><Input value={v.title} onChange={set('title')} placeholder="ISO 14001 certificate" autoFocus /></Field></div>
          {!fixed && <>
            <Field label="Client" error={errors.company_id}><Select value={v.company_id} options={lookups.companies.map((c) => ({ value: String(c.id), label: c.name }))} onChange={set('company_id')} /></Field>
            <Field label="Project" hint="Fills the client."><Select value={v.project_id} options={lookups.projects.map((p) => ({ value: p.project_id, label: `${p.project_id} · ${p.client_name}` }))} onChange={set('project_id')} /></Field>
          </>}
          <Field label="Type"><Select value={v.type} placeholder={null} options={DELIVERABLE_TYPES} onChange={set('type')} /></Field>
          <Field label="Reference" error={errors.reference} hint="Certificate or scorecard number."><Input value={v.reference} onChange={set('reference')} /></Field>
          {mode !== 'supersede' && <Field label="Service"><Select value={String(v.service_id || '')} options={lookups.catalogue.map((s) => ({ value: String(s.id), label: s.name }))} onChange={set('service_id')} /></Field>}
          <Field label="Issuing body" hint="For third-party certificates."><Input value={v.issuing_body} onChange={set('issuing_body')} /></Field>
          <Field label="Issued on"><Input type="date" value={v.issued_on || ''} onChange={set('issued_on')} /></Field>
          <Field label="Valid from"><Input type="date" value={v.valid_from || ''} onChange={set('valid_from')} /></Field>
          <Field label="Valid until" error={errors.valid_until} hint="Sets the renewal and its reminders."><Input type="date" value={v.valid_until || ''} onChange={set('valid_until')} /></Field>
          {(mode === 'new' || isDraft) && (
            <Field label="Status" hint={isDraft ? 'Choose Issued to issue it now.' : undefined}>
              <Select value={v.status} placeholder={null} options={[{ value: 'issued', label: 'Issued' }, { value: 'draft', label: 'Draft' }]} onChange={set('status')} />
            </Field>
          )}
          {mode !== 'supersede' && <Field label="Owner" hint="Who is reminded."><Input list="deliverable-people" value={v.owner} onChange={set('owner')} placeholder="Who is reminded" /><datalist id="deliverable-people">{lookups.sales_people.map((p) => <option key={p} value={p} />)}</datalist></Field>}
        </div>
        <Field label="Scope" hint="Sites, standards, boundaries."><Textarea rows={2} value={v.scope} onChange={set('scope')} /></Field>
        <Field label="File" hint={row?.document_id && mode === 'edit' ? 'A file is attached. Leave this empty to keep it, or choose one to replace it.' : undefined}>
          <FileDrop label="File" text={row?.document_id && mode === 'edit' ? 'Current file kept · drop one here to replace it' : 'Drop the certificate or report here'} onFile={setFile} />
        </Field>
        <Field label="Notes"><Textarea rows={2} value={v.notes} onChange={set('notes')} placeholder="Anything else worth keeping with it" /></Field>
      </form>
    </Modal>
  );
}

function WithdrawDialog({ row, onClose, onDone }) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    try { await api.action(`/deliverables/${row.id}/withdraw`, { reason }); toast('Withdrawn; the renewal is marked lapsed', 'success'); onDone(); }
    catch (err) { toast(err.fields ? Object.values(err.fields)[0] : err.message, 'danger'); setBusy(false); }
  }
  return (
    <Modal size="sm" title={`Withdraw ${row.reference || row.title}`} subtitle="It stays on file, marked withdrawn, and its renewal is marked lapsed." onClose={onClose}
      footer={<>
        <button type="button" className="mg-btn mg-btn--ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="mg-btn mg-btn--danger" disabled={busy || !reason.trim()} onClick={go} aria-describedby={!reason.trim() ? 'wd-why' : undefined}>{busy ? 'Working…' : 'Withdraw'}</button>
        {!reason.trim() && <span id="wd-why" className="app-why">Say why to withdraw it.</span>}
      </>}>
      <Field label="Why" required hint="Kept with the record, and shown to anyone who opens it.">
        <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus placeholder="For example: the certification body suspended it after the surveillance audit" />
      </Field>
    </Modal>
  );
}
