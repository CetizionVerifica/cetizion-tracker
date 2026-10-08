import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { PageHeader } from '../App.jsx';
import { Badge, Card, DataTable, Empty, Field, Input, Modal, Progress, Select, Tabs, useToast } from '../components/ui.jsx';
import { VISIT_STATUS, VISIT_TYPES, VisitDialog } from '../components/VisitDialog.jsx';
import { api } from '../lib/api.js';
import { invalidateLookups, useFetch, useLookups } from '../lib/hooks.js';
import { date, today } from '../lib/format.js';

/**
 * Audit and site-visit schedule (#42): a month calendar, an agenda, each
 * person's load for the month, and people's working days and leave.
 */
const TZ = 'Asia/Kolkata';
const dayOf = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(iso));
const TONE = { planned: 'info', confirmed: 'success', done: '', cancelled: 'danger', rescheduled: 'warning' };
const WEEK = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const shift = (ym, n) => { const [y, m] = ym.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.toISOString().slice(0, 7); };
const monthName = (ym) => new Date(`${ym}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });

export default function Schedule() {
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState('calendar');
  const [month, setMonth] = useState(today().slice(0, 7));
  const [staffId, setStaffId] = useState('');
  const [type, setType] = useState('');
  const [dialog, setDialog] = useState(params.get('visit') ? { id: Number(params.get('visit')) } : null);
  const lookups = useLookups();
  const first = `${month}-01`;
  const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).toISOString().slice(0, 10);
  const qs = new URLSearchParams({ from: first, to: last, ...(staffId ? { staff_id: staffId } : {}), ...(type ? { type } : {}) }).toString();
  const { data, refetch } = useFetch(() => api.raw(`/visits?${qs}`), [qs]);
  const visits = data?.data ?? [];
  const open = (v) => setDialog({ visit: v });
  const done = () => { setDialog(null); if (params.get('visit')) setParams({}, { replace: true }); refetch(); };
  const editing = dialog?.id ? visits.find((v) => v.id === dialog.id) : dialog?.visit;

  return (
    <>
      <PageHeader title="Schedule" subtitle="Audits, assessments and site visits: who goes where, and who is free."
        actions={<>
          <button type="button" className="btn" onClick={() => setMonth(shift(month, -1))}>‹</button>
          <span className="strong" style={{ minWidth: 130, textAlign: 'center' }}>{monthName(month)}</span>
          <button type="button" className="btn" onClick={() => setMonth(shift(month, 1))}>›</button>
          <Select value={staffId} placeholder="Everyone" options={(lookups.staff || []).map((s) => ({ value: String(s.id), label: s.name }))} onChange={(e) => setStaffId(e.target.value)} />
          <Select value={type} placeholder="All types" options={VISIT_TYPES} onChange={(e) => setType(e.target.value)} />
          <button type="button" className="btn btn--primary" onClick={() => setDialog({ preset: { day: today() } })}>Schedule a visit</button>
        </>} />
      <div className="page stack">
        <Tabs active={tab} onChange={setTab} tabs={[{ key: 'calendar', label: 'Calendar' }, { key: 'agenda', label: 'Agenda', count: visits.length }, { key: 'capacity', label: 'Capacity' }, { key: 'people', label: 'People' }]} />
        {tab === 'calendar' && <MonthGrid month={month} visits={visits} onOpen={open} onNew={(day) => setDialog({ preset: { day } })} />}
        {tab === 'agenda' && (
          <Card flush>
            <DataTable rows={visits} onRowClick={open} empty={<Empty title="No visits this month" />} columns={[
              { key: 'when', header: 'When', render: (r) => <>{date(dayOf(r.starts_at))}{dayOf(r.ends_at) !== dayOf(r.starts_at) && ` – ${date(dayOf(r.ends_at))}`}</> },
              { key: 'title', header: 'Visit', className: 'wrap strong', render: (r) => <>{r.title}<div className="small muted">{VISIT_TYPES.find((t) => t.value === r.type)?.label}{r.city ? ` · ${r.city}` : ''}</div></> },
              { key: 'client', header: 'Client', render: (r) => <>{r.client_name}<div className="small"><Link to={`/projects/${r.project_id}`} onClick={(e) => e.stopPropagation()}>{r.project_id}</Link></div></> },
              { key: 'team', header: 'Team', className: 'wrap', render: (r) => r.assignees.map((a) => `${a.name}${a.role === 'lead' ? ' ★' : ''}`).join(', ') || <span className="muted">nobody</span> },
              { key: 'status', header: 'Status', render: (r) => <Badge tone={TONE[r.status]}>{r.status}</Badge> },
              { key: 'extra', header: '', className: 'small', render: (r) => <>{r.milestone_stage_name && <div>milestone: {r.milestone_stage_name}</div>}{r.travel_id && <div>trip {r.travel_id}</div>}</> },
            ]} />
          </Card>
        )}
        {tab === 'capacity' && <Capacity month={month} />}
        {tab === 'people' && <People />}
      </div>
      {dialog && (dialog.preset || editing) && (editing
        ? <VisitSheet visit={editing} onClose={done} onChanged={refetch} />
        : <VisitDialog preset={dialog.preset} onClose={() => setDialog(null)} onSaved={done} />)}
    </>
  );
}

function MonthGrid({ month, visits, onOpen, onNew }) {
  const first = new Date(`${month}-01T00:00:00Z`);
  const lead = (first.getUTCDay() + 6) % 7;
  const days = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  const cells = [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`)];
  const t = today();
  return (
    <Card flush>
      <div className="cal">
        {WEEK.map((w) => <div key={w} className="cal__head">{w}</div>)}
        {cells.map((d, i) => (
          <div key={i} className={`cal__day ${d === t ? 'is-today' : ''} ${!d ? 'is-blank' : ''}`} onDoubleClick={() => d && onNew(d)}>
            {d && <div className="cal__num">{Number(d.slice(8))}</div>}
            {d && visits.filter((v) => dayOf(v.starts_at) <= d && dayOf(v.ends_at) >= d).map((v) => (
              <button type="button" key={v.id} className={`cal__visit cal__visit--${v.status}`} title={`${v.title} · ${v.assignees.map((a) => a.name).join(', ')}`} onClick={() => onOpen(v)}>
                {v.title}{v.assignees.length ? ` · ${v.assignees.map((a) => a.name.split(' ')[0]).join(', ')}` : ''}
              </button>
            ))}
          </div>
        ))}
      </div>
      <div className="small muted px-3.5 py-2">Double-click a day to plan a visit on it.</div>
    </Card>
  );
}

function VisitSheet({ visit: v, onClose, onChanged }) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  async function act(fn, ok) {
    setBusy(true);
    try { await fn(); toast(ok, 'success'); onChanged(); onClose(); }
    catch (err) { toast(err.message, 'danger'); }
    finally { setBusy(false); }
  }
  if (editing) return <VisitDialog visit={v} onClose={() => setEditing(false)} onSaved={() => { onChanged(); onClose(); }} />;
  const live = ['planned', 'confirmed'].includes(v.status);
  return (
    <Modal title={v.title} subtitle={`${VISIT_TYPES.find((t) => t.value === v.type)?.label} · ${v.client_name || ''} · ${v.project_id}`} onClose={onClose}
      footer={<>
        <button type="button" className="btn" onClick={() => setEditing(true)}>Edit</button>
        {!v.travel_id && v.assignees.length > 0 && <button type="button" className="btn" disabled={busy} onClick={() => act(() => api.action(`/visits/${v.id}/trip`, {}), 'Trip created')}>Create trip</button>}
        {v.status === 'planned' && <button type="button" className="btn" disabled={busy} onClick={() => act(() => api.raw(`/visits/${v.id}`, { method: 'PATCH', body: { status: 'confirmed', force: true } }), 'Confirmed')}>Confirm</button>}
        {live && <button type="button" className="btn btn--primary" disabled={busy} onClick={() => act(() => api.raw(`/visits/${v.id}`, { method: 'PATCH', body: { status: 'done', force: true } }), v.milestone_stage_name ? 'Done; the milestone stage can be invoiced' : 'Marked done')}>Mark done</button>}
      </>}>
      <div className="kv">
        <div><div className="kv__k">When</div><div className="kv__v">{new Date(v.starts_at).toLocaleString('en-IN', { timeZone: TZ, dateStyle: 'medium', ...(v.all_day ? {} : { timeStyle: 'short' }) })} – {new Date(v.ends_at).toLocaleString('en-IN', { timeZone: TZ, dateStyle: 'medium', ...(v.all_day ? {} : { timeStyle: 'short' }) })}</div></div>
        <div><div className="kv__k">Where</div><div className="kv__v">{[v.location, v.city, v.state].filter(Boolean).join(', ') || '—'}</div></div>
        <div><div className="kv__k">Status</div><div className="kv__v"><Badge tone={TONE[v.status]}>{v.status}</Badge></div></div>
        <div><div className="kv__k">Team</div><div className="kv__v">{v.assignees.map((a) => `${a.name}${a.role === 'lead' ? ' (lead)' : ''}`).join(', ') || '—'}</div></div>
        <div><div className="kv__k">Milestone</div><div className="kv__v">{v.milestone_stage_name || '—'}</div></div>
        <div><div className="kv__k">Trip</div><div className="kv__v">{v.travel_id ? <Link to={`/travel-logs?q=${v.travel_id}`}>{v.travel_id}</Link> : '—'}</div></div>
        <div><div className="kv__k">PO</div><div className="kv__v">{v.po_number || '—'}</div></div>
        <div><div className="kv__k">Client reminder</div><div className="kv__v">{v.notify_client ? 'yes' : 'team only'}</div></div>
      </div>
      {v.notes && <p style={{ whiteSpace: 'pre-wrap' }}>{v.notes}</p>}
    </Modal>
  );
}

function Capacity({ month }) {
  const { data } = useFetch(() => api.raw(`/visits/capacity?month=${month}`), [month]);
  const rows = (data?.data ?? []).filter((r) => r.visits > 0 || r.leave_days > 0).concat((data?.data ?? []).filter((r) => r.visits === 0 && r.leave_days === 0));
  return (
    <Card flush title="Load this month" hint="Visit days against the days each person is available (working days less leave).">
      <DataTable rows={rows} columns={[
        { key: 'name', header: 'Person', className: 'strong' },
        { key: 'available_days', header: 'Available', align: 'right', render: (r) => `${r.available_days} of ${r.working_days}` },
        { key: 'leave_days', header: 'Leave', align: 'right' },
        { key: 'visits', header: 'Visits', align: 'right' },
        { key: 'visit_days', header: 'Visit days', align: 'right' },
        { key: 'load_percent', header: 'Load', width: 180, render: (r) => (r.load_percent == null ? '—' : <span title={`${r.load_percent}%`}><Progress value={r.load_percent / 100} />{r.load_percent > 80 && <Badge tone="danger">{r.load_percent}%</Badge>}</span>) },
      ]} />
    </Card>
  );
}

function People() {
  const toast = useToast();
  const { data, refetch } = useFetch(() => api.raw('/visits/staff'));
  const [name, setName] = useState('');
  const [leave, setLeave] = useState(null);
  async function run(fn, ok) {
    try { const r = await fn(); if (ok) toast(typeof ok === 'function' ? ok(r) : ok, 'success'); refetch(); invalidateLookups(); }
    catch (err) { toast(err.fields ? Object.values(err.fields)[0] : err.message, 'danger'); }
  }
  const toggleDay = (s, d) => run(() => api.raw(`/visits/staff/${s.id}`, { method: 'PATCH', body: { working_days: s.working_days.includes(d) ? s.working_days.filter((x) => x !== d) : [...s.working_days, d].sort() } }));
  return (
    <Card flush title="People" hint="Working days and leave decide who is free. Everyone who runs a project or travels is listed to begin with."
      actions={<form className="card__actions" onSubmit={(e) => { e.preventDefault(); run(() => api.action('/visits/staff', { name }), 'Added').then(() => setName('')); }}><Input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} /><button type="submit" className="btn btn--sm" disabled={!name.trim()}>Add</button></form>}>
      <DataTable rows={data?.data ?? []} columns={[
        { key: 'name', header: 'Person', className: 'strong', render: (r) => <>{r.name}{!r.active && <> <Badge>inactive</Badge></>}</> },
        { key: 'email', header: 'Email (for reminders)', render: (r) => <Input defaultValue={r.email || ''} key={`${r.id}-${r.email}`} placeholder="name@cetizionverifica.com" onBlur={(e) => e.target.value !== (r.email || '') && run(() => api.raw(`/visits/staff/${r.id}`, { method: 'PATCH', body: { email: e.target.value } }), 'Saved')} /> },
        { key: 'days', header: 'Works on', render: (r) => <div className="chips">{WEEK.map((w, i) => <button type="button" key={w} className={`chip ${r.working_days.includes(i + 1) ? 'is-on' : ''}`} onClick={() => toggleDay(r, i + 1)}>{w}</button>)}</div> },
        { key: 'leave', header: 'Leave', className: 'small', render: (r) => r.leave.map((l) => <div key={l.id}>{date(l.starts_on)} – {date(l.ends_on)}{l.reason ? ` · ${l.reason}` : ''} <button type="button" className="btn btn--sm btn--ghost" onClick={() => run(() => api.remove('visits/leave', l.id), 'Removed')}>✕</button></div>) },
        { key: 'act', header: '', align: 'right', render: (r) => <div className="table__actions"><button type="button" className="btn btn--sm" onClick={() => setLeave({ staff: r, starts_on: today(), ends_on: today(), reason: '' })}>Add leave</button><button type="button" className="btn btn--sm btn--ghost" onClick={() => run(() => api.raw(`/visits/staff/${r.id}`, { method: 'PATCH', body: { active: !r.active } }))}>{r.active ? 'Deactivate' : 'Activate'}</button></div> },
      ]} />
      {leave && (
        <Modal size="sm" title={`Leave for ${leave.staff.name}`} onClose={() => setLeave(null)} footer={<><button type="button" className="btn" onClick={() => setLeave(null)}>Cancel</button><button type="button" className="btn btn--primary" onClick={() => run(() => api.action(`/visits/staff/${leave.staff.id}/leave`, { starts_on: leave.starts_on, ends_on: leave.ends_on, reason: leave.reason }), (r) => (r.clashes?.length ? `Saved. It clashes with ${r.clashes.length} planned visit(s).` : 'Saved')).then(() => setLeave(null))}>Save</button></>}>
          <div className="stack">
            <Field label="From"><Input type="date" value={leave.starts_on} onChange={(e) => setLeave((l) => ({ ...l, starts_on: e.target.value }))} /></Field>
            <Field label="To"><Input type="date" value={leave.ends_on} onChange={(e) => setLeave((l) => ({ ...l, ends_on: e.target.value }))} /></Field>
            <Field label="Reason"><Input value={leave.reason} onChange={(e) => setLeave((l) => ({ ...l, reason: e.target.value }))} /></Field>
          </div>
        </Modal>
      )}
    </Card>
  );
}

export function ProjectVisits({ projectId }) {
  const { data, refetch } = useFetch(() => api.raw(`/visits?project_id=${encodeURIComponent(projectId)}`), [projectId]);
  const [dialog, setDialog] = useState(null);
  const rows = data?.data ?? [];
  return (
    <Card flush title="Visits" hint="Audits and site visits for this project." actions={<button type="button" className="btn btn--sm" onClick={() => setDialog({ preset: { project_id: projectId, day: today() } })}>Schedule a visit</button>}>
      <DataTable rows={rows} onRowClick={(r) => setDialog({ visit: r })} empty={<div className="small muted px-[18px] py-3">No visits planned.</div>} columns={[
        { key: 'when', header: 'When', render: (r) => <>{date(dayOf(r.starts_at))}{dayOf(r.ends_at) !== dayOf(r.starts_at) && ` – ${date(dayOf(r.ends_at))}`}</> },
        { key: 'title', header: 'Visit', className: 'wrap strong' },
        { key: 'team', header: 'Team', className: 'wrap', render: (r) => r.assignees.map((a) => a.name).join(', ') || '—' },
        { key: 'status', header: 'Status', render: (r) => <Badge tone={TONE[r.status]}>{r.status}</Badge> },
      ]} />
      {dialog?.visit && <VisitSheet visit={dialog.visit} onClose={() => setDialog(null)} onChanged={refetch} />}
      {dialog?.preset && <VisitDialog preset={dialog.preset} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); refetch(); }} />}
    </Card>
  );
}

export { VISIT_STATUS };
