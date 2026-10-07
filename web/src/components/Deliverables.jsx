import { useState } from 'react';
import { Badge, Card, DataTable, Empty, ErrorState, Field, Input, Modal, Select, Textarea, useToast } from './ui.jsx';
import { api } from '../lib/api.js';
import { useFetch, useLookups } from '../lib/hooks.js';
import { date, today } from '../lib/format.js';
import { earlierLabel, reissueChain } from '../lib/deliverableHistory.js';

/**
 * Certificates and deliverables (#43): the table, the issue/edit dialog,
 * supersede and withdraw. Used by the register, the company page and the
 * project page.
 */
export const DELIVERABLE_TYPES = [
  { value: 'certificate', label: 'Certificate' }, { value: 'scorecard', label: 'Scorecard' },
  { value: 'report', label: 'Report' }, { value: 'audit_finding', label: 'Audit finding' }, { value: 'statement', label: 'Statement' },
];
const TONE = { issued: 'success', draft: '', expired: 'danger', withdrawn: 'danger', superseded: '' };

export function DeliverablesTable({ params, preset = {}, title = 'Certificates and deliverables', hint, compact = false }) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v != null)).toString();
  const { data, loading, refetch } = useFetch(() => api.raw(`/deliverables${qs ? `?${qs}` : ''}`), [qs]);
  const [dialog, setDialog] = useState(null);   // { mode: 'new'|'edit'|'supersede'|'withdraw', row }
  const rows = data?.data ?? [];
  const cols = [
    { key: 'type', header: 'Type', render: (r) => DELIVERABLE_TYPES.find((t) => t.value === r.type)?.label },
    { key: 'reference', header: 'Reference', className: 'mono', render: (r) => r.reference || <span className="muted">—</span> },
    { key: 'title', header: 'What', className: 'wrap strong', render: (r) => <>{r.title}{r.scope && <div className="small muted">{r.scope}</div>}</> },
    !compact && { key: 'client_name', header: 'Client', render: (r) => r.client_name },
    { key: 'service_name', header: 'Service', className: 'wrap' },
    { key: 'issued_on', header: 'Issued', render: (r) => date(r.issued_on) },
    { key: 'valid_until', header: 'Valid until', render: (r) => (r.valid_until ? <>{date(r.valid_until)}{r.status === 'issued' && r.days_left <= 90 && <> <Badge tone={r.days_left <= 30 ? 'danger' : 'warning'}>{r.days_left}d</Badge></>}</> : '—') },
    { key: 'status', header: 'Status', render: (r) => <>{<Badge tone={TONE[r.status]}>{r.status}</Badge>}{r.superseded_by_reference && <div className="small muted">by {r.superseded_by_reference}</div>}</> },
    { key: 'renewal', header: 'Renewal', className: 'small', render: (r) => (r.engagement_status ? `${r.engagement_status.replace('_', ' ')} · due ${date(r.engagement_due)}` : '—') },
    { key: 'file', header: 'File', render: (r) => (r.document_id ? <a className="btn btn--sm btn--ghost" href={api.documentUrl(r.document_id)} target="_blank" rel="noopener noreferrer">Open</a> : null) },
    {
      key: 'act', header: '', align: 'right', render: (r) => (
        <div className="table__actions">
          {/* Read-only, so it is offered on every row — including a superseded
              one, which until now had no action at all (#103 item 6). Whether
              there is anything earlier to show is the server's answer, not a
              guess made from this list's one-hop superseded_by_reference. */}
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => setDialog({ mode: 'history', row: r })}>History</button>
          {['draft', 'issued', 'expired'].includes(r.status) && <button type="button" className="btn btn--sm btn--ghost" onClick={() => setDialog({ mode: 'edit', row: r })}>Edit</button>}
          {['issued', 'expired'].includes(r.status) && <button type="button" className="btn btn--sm btn--ghost" onClick={() => setDialog({ mode: 'supersede', row: r })}>Supersede</button>}
          {['issued', 'expired'].includes(r.status) && <button type="button" className="btn btn--sm btn--ghost" onClick={() => setDialog({ mode: 'withdraw', row: r })}>Withdraw</button>}
        </div>
      ),
    },
  ].filter(Boolean);

  return (
    <Card flush title={title} hint={hint} actions={<button type="button" className="btn btn--sm btn--primary" onClick={() => setDialog({ mode: 'new' })}>+ Issue</button>}>
      <DataTable rows={rows} loading={loading && !data} columns={cols} empty={<Empty title="Nothing recorded yet" text="Record what the client holds: its reference, dates, scope and file. An expiry date schedules the renewal." />} />
      {dialog?.mode === 'history' && <HistoryDialog row={dialog.row} onClose={() => setDialog(null)} />}
      {dialog?.mode === 'withdraw' && <WithdrawDialog row={dialog.row} onClose={() => setDialog(null)} onDone={() => { setDialog(null); refetch(); }} />}
      {dialog && !['withdraw', 'history'].includes(dialog.mode) && <DeliverableDialog mode={dialog.mode} row={dialog.row} preset={preset} onClose={() => setDialog(null)} onDone={() => { setDialog(null); refetch(); }} />}
    </Card>
  );
}

/** One line per issue in a chain: what it is, where it stands, its dates, its file. */
function ChainRows({ entries }) {
  return (
    <table className="table">
      <tbody>
        {entries.map((e) => (
          <tr key={e.id}>
            <td className="mono">{e.reference || <span className="muted">no reference</span>}</td>
            <td>{e.status ? <Badge tone={TONE[e.status]}>{e.status}</Badge> : null}{e.current && <span className="small muted"> · the one you opened</span>}</td>
            <td className="small">Issued {date(e.issued_on)}</td>
            <td className="small">Valid until {date(e.valid_until)}</td>
            <td>{e.document_id ? <a className="btn btn--sm btn--ghost" href={api.documentUrl(e.document_id)} target="_blank" rel="noopener noreferrer">Open</a> : null}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * The reissue chain for one certificate (#103 item 6).
 *
 * Read-only and fetched when it opens, the way Collections' invoice history
 * dialog works. Its own fetch, so a chain that fails to load leaves the
 * register beside it untouched — the list never re-reads anything here.
 */
function HistoryDialog({ row, onClose }) {
  const { data, loading, error, refetch } = useFetch(() => api.raw(`/deliverables/${row.id}`), [row.id]);
  const { current, earlier, supersededById } = reissueChain(data?.data);

  return (
    <Modal title={`${row.reference || row.title}: reissue history`} subtitle={`${row.client_name} · ${row.title}`} size="lg" onClose={onClose}
      footer={<button type="button" className="btn" onClick={onClose}>Close</button>}>
      {loading && !data ? <div className="skeleton" style={{ height: 140 }} />
        : error ? <ErrorState message={error} onRetry={refetch} />
          : (
            <div className="stack">
              <div>
                <div className="strong" style={{ marginBottom: 6 }}>This issue</div>
                {current ? <ChainRows entries={[current]} /> : <span className="muted small">Not available.</span>}
                {/* The route walks backwards only, so an older issue cannot see
                    the newer ones. Say that instead of showing half a chain. */}
                {supersededById !== null && (
                  <div className="small muted" style={{ marginTop: 6 }}>
                    This one has since been replaced{row.superseded_by_reference ? ` by ${row.superseded_by_reference}` : ''}. Open the newest issue to see the whole chain.
                  </div>
                )}
              </div>
              <div>
                <div className="strong" style={{ marginBottom: 6 }}>{earlierLabel(earlier.length)}</div>
                {earlier.length ? (
                  <>
                    <ChainRows entries={earlier} />
                    {earlier.length > 1 && <div className="small muted" style={{ marginTop: 6 }}>Most recent first, by validity date.</div>}
                  </>
                ) : <span className="muted small">Nothing earlier on file — this is the first issue.</span>}
              </div>
            </div>
          )}
    </Modal>
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
      toast(mode === 'supersede' ? 'Superseded; the old one is kept' : 'Saved', 'success'); onDone();
    } catch (err) { setErrors(err.fields || {}); toast(err.fields ? Object.values(err.fields)[0] : err.message, 'danger'); setBusy(false); }
  }

  const title = mode === 'new' ? 'Issue a deliverable' : mode === 'edit' ? `Edit ${row.reference || row.title}` : `Supersede ${row.reference || row.title}`;
  return (
    <Modal title={title} subtitle={mode === 'supersede' ? 'Records the new issue. The old one stays on file, marked superseded, and the renewal follows the new expiry.' : 'An expiry date schedules the renewal and reminders at 120, 90 and 30 days.'} size="lg" onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" form="deliverable-form" className="btn btn--primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button></>}>
      <form id="deliverable-form" onSubmit={save} className="form-grid">
        {!fixed && <>
          <Field label="Client" error={errors.company_id}><Select value={v.company_id} options={lookups.companies.map((c) => ({ value: String(c.id), label: c.name }))} onChange={set('company_id')} /></Field>
          <Field label="Project" hint="Fills the client"><Select value={v.project_id} options={lookups.projects.map((p) => ({ value: p.project_id, label: `${p.project_id} · ${p.client_name}` }))} onChange={set('project_id')} /></Field>
        </>}
        <Field label="Type"><Select value={v.type} placeholder={null} options={DELIVERABLE_TYPES} onChange={set('type')} /></Field>
        <Field label="Reference" error={errors.reference} hint="Certificate or scorecard number"><Input value={v.reference} onChange={set('reference')} /></Field>
        <div className="span-all"><Field label="Title" required error={errors.title}><Input value={v.title} onChange={set('title')} placeholder="ISO 14001 certificate" /></Field></div>
        {mode !== 'supersede' && <Field label="Service"><Select value={String(v.service_id || '')} options={lookups.catalogue.map((s) => ({ value: String(s.id), label: s.name }))} onChange={set('service_id')} /></Field>}
        <Field label="Issuing body" hint="For third-party certificates"><Input value={v.issuing_body} onChange={set('issuing_body')} /></Field>
        <Field label="Issued on"><Input type="date" value={v.issued_on || ''} onChange={set('issued_on')} /></Field>
        <Field label="Valid from"><Input type="date" value={v.valid_from || ''} onChange={set('valid_from')} /></Field>
        <Field label="Valid until" error={errors.valid_until}><Input type="date" value={v.valid_until || ''} onChange={set('valid_until')} /></Field>
        {mode === 'new' && <Field label="Status"><Select value={v.status} placeholder={null} options={[{ value: 'issued', label: 'Issued' }, { value: 'draft', label: 'Draft' }]} onChange={set('status')} /></Field>}
        {mode !== 'supersede' && <Field label="Owner" hint="Who is reminded"><Input list="deliverable-people" value={v.owner} onChange={set('owner')} /><datalist id="deliverable-people">{lookups.sales_people.map((p) => <option key={p} value={p} />)}</datalist></Field>}
        <div className="span-all"><Field label="Scope" hint="Sites, standards, boundaries"><Textarea rows={2} value={v.scope} onChange={set('scope')} /></Field></div>
        <div className="span-all"><Field label="File" hint={row?.document_id && mode === 'edit' ? 'A file is attached; choose one to replace it' : undefined}><input type="file" className="input" onChange={(e) => setFile(e.target.files?.[0] || null)} /></Field></div>
        <div className="span-all"><Field label="Notes"><Textarea rows={2} value={v.notes} onChange={set('notes')} /></Field></div>
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
    <Modal title={`Withdraw ${row.reference || row.title}`} subtitle="It stays on file, marked withdrawn, and its renewal is marked lapsed." onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button><button type="button" className="btn btn--danger" disabled={busy || !reason.trim()} onClick={go}>Withdraw</button></>}>
      <Field label="Why" required><Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus /></Field>
    </Modal>
  );
}
