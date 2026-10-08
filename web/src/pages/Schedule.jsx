import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Plus, X } from 'lucide-react';
import { toast as sonnerToast } from 'sonner';
import { PageHeader } from '../App.jsx';
import { useShell } from '../components/shell/Shell.jsx';
import { Field, Input, Modal, useToast } from '../components/ui.jsx';
import { VISIT_TYPES, VISIT_STATUS, VisitDialog } from '../components/VisitDialog.jsx';
import {
  FailedCard, FilterSelect, ListTable, MgTabs, Panel, PanelSkeleton, PhoneRow, StateCard, plural, useEntrance,
} from '../components/daily.jsx';
import { api } from '../lib/api.js';
import { invalidateLookups, useFetch, useLookups } from '../lib/hooks.js';
import { date, today } from '../lib/format.js';
import { Sec } from '../components/sales.jsx';

/**
 * Audit and site-visit schedule (#42): a month calendar, an agenda, each
 * person's load for the month, and people's working days and leave.
 * Filters sit on the Calendar/Agenda panel because they only apply there.
 */
const TZ = 'Asia/Kolkata';
const dayOf = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(iso));
const timeOf = (iso) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
const BADGE = { planned: 'mg-badge--info', confirmed: 'mg-badge--ok', done: 'mg-badge--plain', cancelled: 'mg-badge--late', rescheduled: 'mg-badge--late' };
const WEEK = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const WEEK_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const shift = (ym, n) => { const [y, m] = ym.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.toISOString().slice(0, 7); };
const monthName = (ym) => new Date(`${ym}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const monthOnly = (ym) => new Date(`${ym}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' });
const dayLong = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
const statusLabel = (s) => VISIT_STATUS.find((x) => x.value === s)?.label || s;
const typeLabel = (t) => VISIT_TYPES.find((x) => x.value === t)?.label || t;
const team = (v) => v.assignees.map((a) => `${a.name}${a.role === 'lead' ? ' (lead)' : ''}`).join(', ');
const onDay = (v, d) => dayOf(v.starts_at) <= d && dayOf(v.ends_at) >= d;
/** "PRJ-2026-011", or "PO 4500-2231 (no project)" for a PO-only visit. */
const linkedTo = (v) => v.project_id || (v.po_number ? `PO ${v.po_number} (no project)` : '—');

export default function Schedule() {
  const { isAdmin } = useShell();
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState('calendar');
  const [month, setMonth] = useState(today().slice(0, 7));
  const [staffId, setStaffId] = useState('');
  const [type, setType] = useState('');
  const [dialog, setDialog] = useState(null);   // { visit } | { preset }
  const lookups = useLookups();
  const first = `${month}-01`;
  const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).toISOString().slice(0, 10);
  const qs = new URLSearchParams({ from: first, to: last, ...(staffId ? { staff_id: staffId } : {}), ...(type ? { type } : {}) }).toString();
  const { data, loading, error, refetch } = useFetch(() => api.raw(`/visits?${qs}`), [qs]);
  const visits = data?.data ?? [];
  const ref = useEntrance(Boolean(data) || Boolean(error));

  // A link to one visit (Today's diary, a reminder email) opens it, in its own month.
  const linked = params.get('visit');
  useEffect(() => {
    if (!linked) return;
    let gone = false;
    api.raw(`/visits/${Number(linked)}`).then((r) => {
      if (gone || !r?.data) return;
      setMonth(dayOf(r.data.starts_at).slice(0, 7));
      setDialog({ visit: r.data });
    }).catch(() => {});
    return () => { gone = true; };
  }, [linked]);

  const open = (v) => setDialog({ visit: v });
  const closeLinked = () => { if (params.get('visit')) setParams({}, { replace: true }); };
  const done = () => { setDialog(null); closeLinked(); refetch(); };
  const live = dialog?.visit ? visits.find((v) => v.id === dialog.visit.id) || dialog.visit : null;
  const plan = (day) => setDialog({ preset: { day } });

  return (
    <>
      <PageHeader
        title="Schedule"
        subtitle="Audits, assessments and site visits: who goes where, and who is free."
        actions={<>
          {tab !== 'people' && (
            <div className="mg-controlbar" role="group" aria-label="Month">
              <button type="button" className="mg-iconbtn" aria-label={`Previous month, ${monthName(shift(month, -1))}`} onClick={() => setMonth(shift(month, -1))}><ChevronLeft className="size-[18px]" aria-hidden="true" /></button>
              <span aria-live="polite" className="min-w-[118px] text-center text-[13.5px] font-extrabold">{monthName(month)}</span>
              <button type="button" className="mg-iconbtn" aria-label={`Next month, ${monthName(shift(month, 1))}`} onClick={() => setMonth(shift(month, 1))}><ChevronRight className="size-[18px]" aria-hidden="true" /></button>
              <button type="button" className="mg-btn mg-btn--sm mg-btn--ghost" onClick={() => setMonth(today().slice(0, 7))} disabled={month === today().slice(0, 7)}>Today</button>
            </div>
          )}
          <button type="button" className="mg-btn mg-btn--primary" onClick={() => plan(today())}><Plus className="size-4" strokeWidth={2} aria-hidden="true" />Visit</button>
        </>}
      />
      <div className="app-page" ref={ref}>
        <MgTabs label="Schedule views" active={tab} onChange={setTab}
          tabs={[{ key: 'calendar', label: 'Calendar' }, { key: 'agenda', label: 'Agenda', count: data ? visits.length : undefined }, { key: 'capacity', label: 'Capacity' }, { key: 'people', label: 'People' }]} />

        {(tab === 'calendar' || tab === 'agenda') && (error ? (
          <FailedCard title="Couldn’t load the schedule" text="The server didn’t answer, so this month may look emptier than it is. Don’t plan over it yet; try again." onRetry={refetch} />
        ) : (
          <Panel id="cal-t" title={tab === 'agenda' ? `${plural(visits.length, 'visit')} in ${monthOnly(month)}` : monthName(month)}
            tools={<>
              {tab === 'calendar' && (
                <span className="mg-legend mg-shell__wide" aria-label="Status key">
                  <span><i style={{ background: 'var(--info-soft)', boxShadow: 'inset 0 0 0 1px var(--info)' }} />Planned (dashed)</span>
                  <span><i style={{ background: 'var(--ok)' }} />Confirmed</span>
                  <span><i style={{ background: 'var(--track)', boxShadow: 'inset 0 0 0 1px var(--muted)' }} />Done (struck)</span>
                  <span><i style={{ background: 'var(--late)' }} />Cancelled or moved</span>
                </span>
              )}
              <FilterSelect label="Who" value={staffId} onChange={setStaffId} placeholder="Everyone" options={(lookups.staff || []).map((s) => ({ value: String(s.id), label: s.name }))} width={140} />
              <FilterSelect label="Type" value={type} onChange={setType} placeholder="All types" options={VISIT_TYPES} width={140} />
            </>}>
            {loading && !data ? <PanelSkeleton rows={4} />
              : tab === 'calendar' ? <MonthGrid month={month} visits={visits} onOpen={open} onNew={plan} />
                : visits.length ? <Agenda visits={visits} onOpen={open} />
                  : <StateCard inPanel tone="plain" title={`No visits in ${monthOnly(month)}`} text="Nothing is planned for this month with these filters. Plan one with the Visit button."><button type="button" className="mg-btn mg-btn--sm" onClick={() => plan(month === today().slice(0, 7) ? today() : first)}>Plan a visit</button></StateCard>}
          </Panel>
        ))}
        {tab === 'capacity' && <Capacity month={month} />}
        {tab === 'people' && <People isAdmin={isAdmin} />}
      </div>
      {live && <VisitSheet visit={live} onClose={() => { setDialog(null); closeLinked(); }} onChanged={refetch} />}
      {dialog?.preset && <VisitDialog preset={dialog.preset} onClose={() => setDialog(null)} onSaved={done} />}
    </>
  );
}

function MonthGrid({ month, visits, onOpen, onNew }) {
  const [picked, setPicked] = useState(null);
  const firstDay = new Date(`${month}-01T00:00:00Z`);
  const lead = (firstDay.getUTCDay() + 6) % 7;
  const days = new Date(Date.UTC(firstDay.getUTCFullYear(), firstDay.getUTCMonth() + 1, 0)).getUTCDate();
  const iso = (offset) => { const d = new Date(firstDay); d.setUTCDate(1 + offset); return d.toISOString().slice(0, 10); };
  const total = Math.ceil((lead + days) / 7) * 7;
  const cells = Array.from({ length: total }, (_, i) => iso(i - lead));
  const weeks = Array.from({ length: total / 7 }, (_, w) => cells.slice(w * 7, w * 7 + 7));
  const t = today();
  const inMonth = (d) => d.slice(0, 7) === month;
  const chosen = picked && inMonth(picked) ? picked : (t.slice(0, 7) === month ? t : `${month}-01`);
  const ofDay = (d) => visits.filter((v) => onDay(v, d));
  const chipLabel = (v) => `${v.title}${v.assignees.length ? ` · ${v.assignees.map((a) => a.name.split(' ')[0]).join(', ')}` : ''}`;
  const dayVisits = ofDay(chosen);

  return (
    <>
      <div className="mg-shell__wide app-panel__body" role="grid" aria-label={monthName(month)}>
        <div role="row" className="app-cal__row">
          {WEEK.map((w, i) => <span key={w} role="columnheader" className="app-cal__dow" aria-label={WEEK_LONG[i]}>{w}</span>)}
        </div>
        {weeks.map((week) => (
          <div key={week[0]} role="row" className="app-cal__row">
            {week.map((d) => (
              <div key={d} role="gridcell" aria-label={`${dayLong(d)}${ofDay(d).length ? `, ${plural(ofDay(d).length, 'visit')}` : ''}`}
                className={`app-cal__day ${d === t ? 'is-today' : ''} ${inMonth(d) ? '' : 'is-out'}`} onDoubleClick={() => inMonth(d) && onNew(d)}>
                <div className="app-cal__head">
                  <span className="app-cal__num">{Number(d.slice(8))}</span>
                  {inMonth(d) && <button type="button" className="mg-iconbtn app-cal__add" aria-label={`Plan a visit on ${dayLong(d)}`} onClick={() => onNew(d)}><Plus className="size-3.5" aria-hidden="true" /></button>}
                </div>
                {inMonth(d) && ofDay(d).map((v) => (
                  <button type="button" key={v.id} className={`app-cal__chip app-visit--${v.status}`} title={`${v.title} · ${team(v) || 'nobody yet'} · ${statusLabel(v.status)}`}
                    aria-label={`${v.title}, ${statusLabel(v.status)}${v.assignees.length ? `, ${team(v)}` : ''}`} onClick={() => onOpen(v)}>
                    {chipLabel(v)}
                  </button>
                ))}
              </div>
            ))}
          </div>
        ))}
        <p className="app-panel__note">Double-click a day, or use its + button, to plan a visit on it. Click a visit to see it.</p>
      </div>

      {/* On a phone: a month of dots, then the chosen day's visits. */}
      <div className="mg-shell__narrow app-panel__body">
        <div className="app-mini" role="grid" aria-label={monthName(month)}>
          {WEEK.map((w, i) => <span key={w} role="columnheader" className="app-mini__dow" aria-label={WEEK_LONG[i]}>{w.slice(0, 1)}</span>)}
          {cells.map((d) => {
            const vs = inMonth(d) ? ofDay(d) : [];
            return inMonth(d) ? (
              <button key={d} type="button" className={`app-mini__day ${d === t ? 'is-today' : ''}`} aria-pressed={d === chosen}
                aria-label={`${dayLong(d)}${vs.length ? `, ${plural(vs.length, 'visit')}` : ''}`} onClick={() => setPicked(d)}>
                <span className="mg-num">{Number(d.slice(8))}</span>
                <span className="app-mini__dots">{vs.slice(0, 3).map((v) => <i key={v.id} className={v.status === 'confirmed' ? 'is-confirmed' : ['cancelled', 'rescheduled'].includes(v.status) ? 'is-late' : ''} />)}</span>
              </button>
            ) : <span key={d} aria-hidden="true" />;
          })}
        </div>
        <div className="app-daytitle">{dayLong(chosen)}</div>
        <div className="mg-rows">
          {dayVisits.map((v) => (
            <PhoneRow key={v.id} onClick={() => onOpen(v)} title={v.title} amount={<span className="text-[12.5px] text-info">{v.all_day ? 'All day' : timeOf(v.starts_at)}</span>}
              meta={[v.client_name, v.city].filter(Boolean).join(', ') + (v.assignees.length ? ` · ${team(v)}` : '')}
              state={<span className={`mg-badge ${BADGE[v.status]}`}>{statusLabel(v.status)}</span>} />
          ))}
          {!dayVisits.length && (
            <div className="flex flex-wrap items-center gap-3 px-4 pt-3.5 pb-4 text-[13px] text-muted-foreground">
              Nothing planned on this day.
              <button type="button" className="mg-btn mg-btn--sm" onClick={() => onNew(chosen)}>Plan a visit</button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function Agenda({ visits, onOpen }) {
  const span = (v) => `${date(dayOf(v.starts_at))}${dayOf(v.ends_at) !== dayOf(v.starts_at) ? ` – ${date(dayOf(v.ends_at))}` : ''}`;
  const struck = (v) => (['done', 'cancelled', 'rescheduled'].includes(v.status) ? 'line-through' : '');
  return (
    <ListTable
      label="Visits this month"
      rows={visits}
      onRowClick={onOpen}
      columns={[
        { key: 'when', header: 'When', className: 'mg-num', render: (v) => <>{span(v)}<span className="sub">{v.all_day ? 'All day' : `${timeOf(v.starts_at)}–${timeOf(v.ends_at)}`}</span></> },
        { key: 'visit', header: 'Visit', className: 'app-wrap', render: (v) => <><button type="button" className={`text-left font-bold text-foreground hover:underline ${struck(v)}`} onClick={() => onOpen(v)}>{v.title}</button><span className="sub">{typeLabel(v.type)}{v.city ? ` · ${v.city}` : ''}</span></> },
        { key: 'client', header: 'Client', className: 'app-wrap--sm', render: (v) => <><b>{v.client_name || '—'}</b><span className="sub">{v.project_id ? <Link className="mg-num text-muted-foreground" to={`/projects/${encodeURIComponent(v.project_id)}`}>{v.project_id}</Link> : linkedTo(v)}</span></> },
        { key: 'team', header: 'Team', className: 'app-wrap--sm', render: (v) => team(v) || <span className="text-muted-foreground">Nobody yet</span> },
        { key: 'status', header: 'Status', render: (v) => <span className={`mg-badge ${BADGE[v.status]}`}>{statusLabel(v.status)}</span> },
        { key: 'linked', header: 'Linked to', className: 'text-[12.5px]', render: (v) => (
          <>
            {v.milestone_stage_name && <span className="block text-secondary-text">Milestone: {v.milestone_stage_name}</span>}
            {v.travel_id && <Link className="app-ref" to={`/travel/${encodeURIComponent(v.travel_id)}`}>Trip {v.travel_id}</Link>}
            {!v.milestone_stage_name && !v.travel_id && <span className="text-muted-foreground">—</span>}
          </>
        ) },
      ]}
      phone={(v) => (
        <PhoneRow onClick={() => onOpen(v)} title={<span className={struck(v)}>{v.title}{v.client_name ? ` · ${v.client_name}` : ''}</span>}
          amount={<span className="text-[12.5px]">{date(dayOf(v.starts_at))}</span>}
          meta={[typeLabel(v.type), v.city, team(v)].filter(Boolean).join(' · ')}
          state={<span className={`mg-badge ${BADGE[v.status]}`}>{statusLabel(v.status)}</span>} />
      )}
    />
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
  const fmt = (iso) => new Date(iso).toLocaleString('en-IN', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', ...(v.all_day ? {} : { hour: '2-digit', minute: '2-digit', hour12: false }) });
  return (
    <Modal title={v.title} subtitle={[typeLabel(v.type), v.client_name, linkedTo(v)].filter(Boolean).join(' · ')} onClose={onClose}
      footer={<>
        <button type="button" className="mg-btn mg-btn--ghost mr-auto" onClick={() => setEditing(true)}>Edit</button>
        {!v.travel_id && v.assignees.length > 0 && <button type="button" className="mg-btn" disabled={busy} onClick={() => act(() => api.action(`/visits/${v.id}/trip`, {}), 'Trip created')}>Create trip</button>}
        {v.status === 'planned' && <button type="button" className="mg-btn" disabled={busy} onClick={() => act(() => api.raw(`/visits/${v.id}`, { method: 'PATCH', body: { status: 'confirmed', force: true } }), 'Confirmed')}>Confirm</button>}
        {live && <button type="button" className="mg-btn mg-btn--primary" disabled={busy} onClick={() => act(() => api.raw(`/visits/${v.id}`, { method: 'PATCH', body: { status: 'done', force: true } }), v.milestone_stage_name ? 'Done; the milestone stage can be invoiced' : 'Marked done')}>Mark done</button>}
      </>}>
      <div className="flex flex-col gap-3.5">
        <dl className="mg-facts">
          <div><dt>When</dt><dd>{fmt(v.starts_at)} – {fmt(v.ends_at)}</dd></div>
          <div><dt>Where</dt><dd>{[v.location, v.city, v.state].filter(Boolean).join(', ') || '—'}</dd></div>
          <div><dt>Status</dt><dd><span className={`mg-badge ${BADGE[v.status]}`}>{statusLabel(v.status)}</span></dd></div>
          <div><dt>Team</dt><dd>{team(v) || 'Nobody yet'}</dd></div>
          <div><dt>Milestone</dt><dd>{v.milestone_stage_name || '—'}</dd></div>
          <div><dt>PO</dt><dd>{v.po_number ? <Link className="text-foreground underline" to={`/purchase-orders/${encodeURIComponent(v.po_number)}`}>PO {v.po_number}</Link> : '—'}</dd></div>
          <div><dt>Trip</dt><dd>{v.travel_id ? <Link className="text-foreground underline" to={`/travel/${encodeURIComponent(v.travel_id)}`}>{v.travel_id}</Link> : <span className="font-semibold text-muted-foreground">None yet</span>}</dd></div>
          <div><dt>Client reminder</dt><dd>{v.notify_client ? 'Also the client contact' : 'Team only'}</dd></div>
        </dl>
        {v.notes && <p className="m-0 whitespace-pre-wrap text-[13px] text-secondary-text">{v.notes}</p>}
      </div>
    </Modal>
  );
}

function Capacity({ month }) {
  const { data, loading, error, refetch } = useFetch(() => api.raw(`/visits/capacity?month=${month}`), [month]);
  const rows = [...(data?.data ?? [])].sort((a, b) => (Number(b.load_percent) || 0) - (Number(a.load_percent) || 0) || b.visits - a.visits);
  if (error) return <FailedCard title="Couldn’t work out the load" text="The server didn’t answer. Try again in a moment." onRetry={refetch} />;
  const bar = (r) => (r.load_percent > 80 ? 'var(--late)' : r.load_percent > 60 ? 'var(--wait)' : 'var(--figure)');
  return (
    <Panel id="cap-t" title={`Load in ${monthOnly(month)}`} hint="Visit days against the days each person is available (working days less leave). Busiest first.">
      {loading && !data ? <PanelSkeleton /> : rows.length ? (
        <ListTable
          label={`Load in ${monthOnly(month)}`}
          rows={rows}
          rowKey={(r) => r.staff_id ?? r.name}
          columns={[
            { key: 'name', header: 'Person', className: 'strong', render: (r) => r.name },
            { key: 'avail', header: 'Available', num: true, render: (r) => `${r.available_days} of ${r.working_days}` },
            { key: 'leave', header: 'Leave', num: true, render: (r) => r.leave_days },
            { key: 'visits', header: 'Visits', num: true, render: (r) => r.visits },
            { key: 'days', header: 'Visit days', num: true, render: (r) => r.visit_days },
            { key: 'load', header: 'Load', width: 280, render: (r) => (r.load_percent == null ? '—' : (
              <div className="flex items-center gap-2.5">
                <div className="mg-progress h-2 flex-1" role="img" aria-label={`${r.name}: ${r.load_percent}% loaded`}><span className="mg-progress__done" style={{ width: `${Math.min(100, r.load_percent)}%`, background: bar(r) }} /></div>
                <span className="mg-num w-10 text-right font-extrabold" style={{ color: r.load_percent > 80 ? 'var(--late)' : undefined }}>{r.load_percent}%</span>
                {r.load_percent > 80 && <span className="mg-badge mg-badge--late">Over 80%</span>}
              </div>
            )) },
          ]}
          phone={(r) => (
            <PhoneRow title={r.name} amount={<span style={{ color: r.load_percent > 80 ? 'var(--late)' : undefined }}>{r.load_percent == null ? '—' : `${r.load_percent}%`}</span>}
              meta={`${r.visit_days} visit days · ${r.available_days} available · ${r.leave_days} leave`}
              state={r.load_percent > 80 ? <span className="mg-badge mg-badge--late">Over 80%</span> : null}>
              <div className="mg-progress mt-1.5 h-1.5" style={{ gridColumn: '1 / -1' }}><span className="mg-progress__done" style={{ width: `${Math.min(100, r.load_percent || 0)}%`, background: bar(r) }} /></div>
            </PhoneRow>
          )}
        />
      ) : <StateCard inPanel tone="plain" title="Nobody to plan for yet" text="Add the people who go on visits under People, with their working days." />}
    </Panel>
  );
}

function People({ isAdmin }) {
  const toast = useToast();
  const { data, loading, error, refetch } = useFetch(() => api.raw('/visits/staff'));
  const [name, setName] = useState('');
  const [leave, setLeave] = useState(null);
  /** Runs a change; true when it worked, so a dialog only closes on success. */
  async function run(fn, ok) {
    try {
      const r = await fn();
      if (ok) toast(typeof ok === 'function' ? ok(r) : ok, 'success');
      refetch(); invalidateLookups();
      return true;
    } catch (err) { toast(err.fields ? Object.values(err.fields)[0] : err.message, 'danger'); return false; }
  }
  async function removeLeave(person, l) {
    const ok = await run(() => api.remove('visits/leave', l.id));
    if (!ok) return;
    sonnerToast.success(`Leave removed for ${person.name}`, {
      className: 'toast',
      action: { label: 'Undo', onClick: () => run(() => api.action(`/visits/staff/${person.id}/leave`, { starts_on: l.starts_on.slice(0, 10), ends_on: l.ends_on.slice(0, 10), reason: l.reason || undefined }), 'Leave put back') },
    });
  }
  const toggleDay = (s, d) => run(() => api.raw(`/visits/staff/${s.id}`, { method: 'PATCH', body: { working_days: s.working_days.includes(d) ? s.working_days.filter((x) => x !== d) : [...s.working_days, d].sort() } }));
  const rows = data?.data ?? [];
  const leaveText = (l) => `${date(l.starts_on)} – ${date(l.ends_on)}${l.reason ? ` · ${l.reason}` : ''}`;
  const days = (r) => (
    <div role="group" aria-label={`${r.name} works on`} className="flex flex-wrap gap-1">
      {WEEK.map((w, i) => (
        <button type="button" key={w} className="mg-chip h-[30px] min-w-10 justify-center px-2 text-[11.5px] disabled:opacity-100" aria-pressed={r.working_days.includes(i + 1)}
          aria-label={WEEK_LONG[i]} disabled={!isAdmin} onClick={() => toggleDay(r, i + 1)}>{w}</button>
      ))}
    </div>
  );
  if (error) return <FailedCard title="Couldn’t load the people" text="The server didn’t answer. Try again in a moment." onRetry={refetch} />;

  return (
    <Panel id="ppl-t" title="People"
      hint={isAdmin ? 'Working days and leave decide who is free. Everyone who runs a project or travels is listed to begin with.' : 'Who is free, and when. An admin keeps these up to date.'}
      tools={isAdmin && (
        <form className="flex gap-2" onSubmit={async (e) => { e.preventDefault(); if (await run(() => api.action('/visits/staff', { name }), 'Added')) setName(''); }}>
          <input className="mg-input h-9 w-[180px] rounded-full" aria-label="Name of the person to add" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <button type="submit" className="mg-btn mg-btn--sm" disabled={!name.trim()}>Add person</button>
        </form>
      )}>
      {loading && !data ? <PanelSkeleton /> : rows.length ? (
        <ListTable
          label="People"
          rows={rows}
          columns={[
            { key: 'name', header: 'Person', className: 'strong', render: (r) => <span className={r.active ? '' : 'text-muted-foreground'}>{r.name}{!r.active && <span className="sub"><span className="mg-badge mg-badge--plain">Inactive</span></span>}</span> },
            { key: 'email', header: 'Email for reminders', render: (r) => (isAdmin
              ? <input className="mg-input h-9 w-[240px]" type="email" defaultValue={r.email || ''} key={`${r.id}-${r.email}`} aria-label={`Email for ${r.name}`} placeholder="name@yourcompany.com"
                onBlur={(e) => e.target.value !== (r.email || '') && run(() => api.raw(`/visits/staff/${r.id}`, { method: 'PATCH', body: { email: e.target.value } }), 'Saved')} />
              : <span className="text-secondary-text">{r.email || 'No email'}</span>) },
            { key: 'days', header: 'Works on', render: days },
            { key: 'leave', header: 'Leave', className: 'app-wrap--sm', render: (r) => (r.leave.length ? r.leave.map((l) => (
              <div key={l.id} className="flex items-center gap-1.5 text-[12.5px]">
                <span className="mg-num">{leaveText(l)}</span>
                {isAdmin && <button type="button" className="mg-iconbtn size-7 text-muted-foreground" aria-label={`Remove leave ${date(l.starts_on)} – ${date(l.ends_on)} for ${r.name}`} onClick={() => removeLeave(r, l)}><X className="size-3.5" aria-hidden="true" /></button>}
              </div>
            )) : <span className="text-[12.5px] text-muted-foreground">No leave booked</span>) },
            ...(isAdmin ? [{ key: 'act', header: '', className: 'actions', render: (r) => (
              <>
                <button type="button" className="mg-btn mg-btn--sm" onClick={() => setLeave({ staff: r, starts_on: today(), ends_on: today(), reason: '' })}>Add leave</button>
                <button type="button" className="mg-btn mg-btn--sm mg-btn--ghost" onClick={() => run(() => api.raw(`/visits/staff/${r.id}`, { method: 'PATCH', body: { active: !r.active } }), r.active ? `${r.name} deactivated` : `${r.name} activated`)}>{r.active ? 'Deactivate' : 'Activate'}</button>
              </>
            ) }] : []),
          ]}
          phone={(r) => (
            <PhoneRow title={<span className={r.active ? '' : 'text-muted-foreground'}>{r.name}{!r.active && ' (inactive)'}</span>}
              amount={<span className="text-[12.5px] font-semibold text-secondary-text">{WEEK.filter((_, i) => r.working_days.includes(i + 1)).join(' ')}</span>}
              meta={`${r.email || 'No email'} · ${r.leave.length ? r.leave.map(leaveText).join('; ') : 'No leave booked'}`} state={null}>
              {isAdmin && (
                <span className="mt-2 flex flex-col gap-2" style={{ gridColumn: '1 / -1' }}>
                  {days(r)}
                  <span className="flex flex-wrap gap-2">
                    <button type="button" className="mg-btn mg-btn--sm" onClick={() => setLeave({ staff: r, starts_on: today(), ends_on: today(), reason: '' })}>Add leave</button>
                    {r.leave.map((l) => <button key={l.id} type="button" className="mg-btn mg-btn--sm mg-btn--ghost" aria-label={`Remove leave ${date(l.starts_on)} – ${date(l.ends_on)} for ${r.name}`} onClick={() => removeLeave(r, l)}>Remove {date(l.starts_on)}</button>)}
                  </span>
                </span>
              )}
            </PhoneRow>
          )}
        />
      ) : <StateCard inPanel tone="plain" title="Nobody listed yet" text={isAdmin ? 'Add the people who go on visits by name above, then set their working days.' : 'An admin adds the people who go on visits.'} />}
      {leave && (
        <Modal size="sm" title={`Leave for ${leave.staff.name}`} subtitle={`Leave takes these days out of ${leave.staff.name.split(' ')[0]}’s availability.`} onClose={() => setLeave(null)}
          footer={<>
            <button type="button" className="mg-btn mg-btn--ghost" onClick={() => setLeave(null)}>Cancel</button>
            <button type="button" className="mg-btn mg-btn--primary" disabled={!leave.starts_on || !leave.ends_on}
              onClick={async () => { if (await run(() => api.action(`/visits/staff/${leave.staff.id}/leave`, { starts_on: leave.starts_on, ends_on: leave.ends_on, reason: leave.reason }), (r) => (r.clashes?.length ? `Saved. It clashes with ${plural(r.clashes.length, 'planned visit')}: ${r.clashes.map((c) => c.title).join(', ')}.` : 'Leave saved'))) setLeave(null); }}>Save leave</button>
          </>}>
          <div className="flex flex-col gap-3.5">
            <div className="mg-grid2">
              <Field label="From" required><Input type="date" value={leave.starts_on} onChange={(e) => setLeave((l) => ({ ...l, starts_on: e.target.value, ends_on: l.ends_on < e.target.value ? e.target.value : l.ends_on }))} /></Field>
              <Field label="To" required><Input type="date" value={leave.ends_on} min={leave.starts_on} onChange={(e) => setLeave((l) => ({ ...l, ends_on: e.target.value }))} /></Field>
            </div>
            <Field label="Reason"><Input value={leave.reason} onChange={(e) => setLeave((l) => ({ ...l, reason: e.target.value }))} /></Field>
          </div>
        </Modal>
      )}
    </Panel>
  );
}

export function ProjectVisits({ projectId, flat = false }) {
  const { data, refetch } = useFetch(() => api.raw(`/visits?project_id=${encodeURIComponent(projectId)}`), [projectId]);
  const [dialog, setDialog] = useState(null);
  const rows = data?.data ?? [];
  // `flat`: a section of the project's tab panel, which is already glass.
  const Wrap = flat ? FlatSection : Panel;
  return (
    <Wrap id="prj-visits" title="Visits" hint="Audits and site visits for this project."
      tools={<button type="button" className="mg-btn mg-btn--sm" onClick={() => setDialog({ preset: { project_id: projectId, day: today() } })}><Plus className="size-4" aria-hidden="true" />Plan a visit</button>}>
      {rows.length ? (
        <ListTable
          label="Visits"
          rows={rows}
          onRowClick={(r) => setDialog({ visit: r })}
          columns={[
            { key: 'when', header: 'When', className: 'mg-num', render: (r) => <>{date(dayOf(r.starts_at))}{dayOf(r.ends_at) !== dayOf(r.starts_at) && ` – ${date(dayOf(r.ends_at))}`}</> },
            { key: 'title', header: 'Visit', className: 'app-wrap strong', render: (r) => r.title },
            { key: 'team', header: 'Team', className: 'app-wrap--sm', render: (r) => r.assignees.map((a) => a.name).join(', ') || '—' },
            { key: 'status', header: 'Status', render: (r) => <span className={`mg-badge ${BADGE[r.status]}`}>{statusLabel(r.status)}</span> },
          ]}
          phone={(r) => <PhoneRow wraps onClick={() => setDialog({ visit: r })} title={r.title} amount={<span className="text-[12.5px]">{date(dayOf(r.starts_at))}</span>} meta={r.assignees.map((a) => a.name).join(', ') || 'Nobody yet'} state={<span className={`mg-badge ${BADGE[r.status]}`}>{statusLabel(r.status)}</span>} />}
        />
      ) : <p className="app-panel__note">No visits planned. Plan one and the team sees it in Schedule.</p>}
      {dialog?.visit && <VisitSheet visit={dialog.visit} onClose={() => setDialog(null)} onChanged={refetch} />}
      {dialog?.preset && <VisitDialog preset={dialog.preset} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); refetch(); }} />}
    </Wrap>
  );
}

/** A titled section inside a panel, its rows in a bordered box. */
function FlatSection({ id, title, hint, tools, children }) {
  return (
    <Sec id={id} title={title} hint={hint} tools={tools}>
      <div className="app-box app-box--flush">{children}</div>
    </Sec>
  );
}

export { VISIT_STATUS };
