import { useState } from 'react';
import { Star } from 'lucide-react';
import { Alert, Field, Input, Modal, Select, Textarea, useToast } from './ui.jsx';
import { api } from '../lib/api.js';
import { useFetch, useLookups } from '../lib/hooks.js';

/**
 * Plan or edit a visit (#42). People already booked, on leave or off that
 * day are listed before saving; the user can still save anyway.
 */
export const VISIT_TYPES = [
  { value: 'audit', label: 'Audit' }, { value: 'assessment', label: 'Assessment' }, { value: 'training', label: 'Training' },
  { value: 'meeting', label: 'Meeting' }, { value: 'follow_up', label: 'Follow-up' },
];
export const VISIT_STATUS = [
  { value: 'planned', label: 'Planned' }, { value: 'confirmed', label: 'Confirmed' }, { value: 'done', label: 'Done' },
  { value: 'cancelled', label: 'Cancelled' }, { value: 'rescheduled', label: 'Rescheduled' },
];
const TZ = 'Asia/Kolkata';
const localDate = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(iso));
const localTime = (iso) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

export function VisitDialog({ visit, preset = {}, onClose, onSaved }) {
  const toast = useToast();
  const lookups = useLookups();
  const staff = lookups.staff || [];
  const init = visit ? {
    ...visit,
    start_day: localDate(visit.starts_at), end_day: localDate(visit.ends_at),
    start_time: localTime(visit.starts_at), end_time: localTime(visit.ends_at),
    assignees: visit.assignees.map((a) => ({ staff_id: a.staff_id, role: a.role })),
  } : {
    type: 'audit', status: 'planned', all_day: true, title: '', project_id: '', po_number: '', milestone_stage_id: '', city: '', location: '', state: '', notes: '', notify_client: false,
    start_day: preset.day || '', end_day: preset.day || '', start_time: '10:00', end_time: '17:00', assignees: [], ...preset,
  };
  const [v, setV] = useState(init);
  const [conflicts, setConflicts] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k, val) => setV((s) => ({ ...s, [k]: val }));
  const stages = useFetch(() => (v.project_id ? api.list('payment-stages', { project_id: v.project_id, limit: 100 }) : Promise.resolve({ data: [] })), [v.project_id]);
  const pos = (lookups.purchase_orders || []).filter((p) => !v.project_id || p.project_id === v.project_id);

  async function save(force = false) {
    setBusy(true);
    const body = {
      project_id: v.project_id || null, po_number: v.po_number || null, type: v.type, title: v.title, status: v.status,
      starts_at: v.all_day ? v.start_day : `${v.start_day}T${v.start_time}`,
      ends_at: v.all_day ? (v.end_day || v.start_day) : `${v.end_day || v.start_day}T${v.end_time}`,
      all_day: v.all_day, location: v.location || null, city: v.city || null, state: v.state || null,
      milestone_stage_id: v.milestone_stage_id ? Number(v.milestone_stage_id) : null, notify_client: v.notify_client, notes: v.notes || null,
      assignees: v.assignees, force,
    };
    try {
      if (visit) await api.raw(`/visits/${visit.id}`, { method: 'PATCH', body }); else await api.action('/visits', body);
      toast(force ? 'Saved, though not everyone is free' : visit ? 'Visit saved' : 'Visit planned', 'success'); onSaved();
    } catch (err) {
      if (err.status === 409 && err.details?.conflicts) setConflicts(err.details.conflicts);
      else toast(err.fields ? Object.values(err.fields)[0] : err.message, 'danger');
    } finally { setBusy(false); }
  }
  const toggle = (id) => set('assignees', v.assignees.some((a) => a.staff_id === id) ? v.assignees.filter((a) => a.staff_id !== id) : [...v.assignees, { staff_id: id, role: v.assignees.length ? 'member' : 'lead' }]);
  const setLead = (id) => set('assignees', v.assignees.map((a) => ({ ...a, role: a.staff_id === id ? 'lead' : 'member' })));

  const missing = !v.title.trim() ? 'Say what the visit is to save it.' : !v.start_day ? 'Pick the day it starts to save it.' : (!v.project_id && !v.po_number) ? 'Pick the project to save it.' : null;
  return (
    <Modal size="lg" title={visit ? 'Edit visit' : 'Plan a visit'} subtitle="Completing a visit with a milestone makes that payment stage ready to invoice." onClose={onClose}
      footer={<>
        <button type="button" className="mg-btn mg-btn--ghost" onClick={onClose} disabled={busy}>Cancel</button>
        {conflicts ? <button type="button" className="mg-btn mg-btn--danger" disabled={busy} onClick={() => save(true)}>{busy ? 'Saving…' : 'Save anyway'}</button>
          : <button type="button" className="mg-btn mg-btn--primary" disabled={busy || Boolean(missing)} aria-describedby={missing ? 'visit-why' : undefined} onClick={() => save(false)}>{busy ? 'Saving…' : 'Save visit'}</button>}
        {missing && !conflicts && <span id="visit-why" className="app-why">{missing}</span>}
      </>}>
      <div className="flex flex-col gap-3.5">
        {conflicts && <Alert tone="warning"><span><strong>Not everyone is free.</strong><br />{conflicts.map((c, i) => <span key={i}>{c.name} {c.detail}<br /></span>)}You can still save it.</span></Alert>}
        <div className="mg-grid2">
          <div className="col-span-full"><Field label="What" required><Input value={v.title} onChange={(e) => set('title', e.target.value)} placeholder="Stage 1 audit, Pune plant" autoFocus /></Field></div>
          <Field label="Type"><Select value={v.type} placeholder={null} options={VISIT_TYPES} onChange={(e) => set('type', e.target.value)} /></Field>
          <Field label="Status"><Select value={v.status} placeholder={null} options={VISIT_STATUS} onChange={(e) => set('status', e.target.value)} /></Field>
          <Field label="Project" required hint={visit ? 'Changing it clears the PO and milestone.' : undefined}><Select value={v.project_id} options={lookups.projects.map((p) => ({ value: p.project_id, label: `${p.project_id} · ${p.client_name}` }))} onChange={(e) => { set('project_id', e.target.value); set('po_number', ''); set('milestone_stage_id', ''); }} /></Field>
          <Field label="PO"><Select value={v.po_number || ''} placeholder="No PO" options={pos.map((p) => p.po_number)} onChange={(e) => set('po_number', e.target.value)} /></Field>
          <Field label="From" required><Input type="date" value={v.start_day} onChange={(e) => { set('start_day', e.target.value); if (!v.end_day || v.end_day < e.target.value) set('end_day', e.target.value); }} /></Field>
          <Field label="To"><Input type="date" value={v.end_day} min={v.start_day} onChange={(e) => set('end_day', e.target.value)} /></Field>
          <Field label="Site"><Input value={v.location || ''} onChange={(e) => set('location', e.target.value)} placeholder="Plant 2, MIDC" /></Field>
          <Field label="City"><Input value={v.city || ''} onChange={(e) => set('city', e.target.value)} /></Field>
          <Field label="Timing"><Select value={v.all_day ? 'day' : 'time'} placeholder={null} options={[{ value: 'day', label: 'Whole days' }, { value: 'time', label: 'Set times' }]} onChange={(e) => set('all_day', e.target.value === 'day')} /></Field>
          {!v.all_day && (
            <div className="mg-field col-span-full">
              <span className="mg-field__label">Times</span>
              <div className="flex items-center gap-2">
                <Input type="time" value={v.start_time} onChange={(e) => set('start_time', e.target.value)} aria-label="Start time" className="min-w-0 flex-[0_1_170px]" />
                <span className="text-muted-foreground">to</span>
                <Input type="time" value={v.end_time} onChange={(e) => set('end_time', e.target.value)} aria-label="End time" className="min-w-0 flex-[0_1_170px]" />
              </div>
            </div>
          )}
          <Field label="Completes milestone" hint="An On Milestone stage becomes ready to invoice when the visit is done."><Select value={String(v.milestone_stage_id || '')} placeholder="None" options={(stages.data?.data ?? []).map((s) => ({ value: String(s.id), label: `${s.po_number} · ${s.stage_name}${s.trigger_event !== 'On Milestone' ? ` (${s.trigger_event})` : ''}` }))} onChange={(e) => set('milestone_stage_id', e.target.value)} /></Field>
          <Field label="Client reminder"><Select value={v.notify_client ? 'yes' : 'no'} placeholder={null} options={[{ value: 'no', label: 'Team only' }, { value: 'yes', label: 'Also remind the client contact' }]} onChange={(e) => set('notify_client', e.target.value === 'yes')} /></Field>
        </div>
        <div className="mg-field">
          <span className="mg-field__label" id="visit-team">Team</span>
          <div role="group" aria-labelledby="visit-team" className="flex flex-wrap gap-2">
            {staff.map((s) => {
              const a = v.assignees.find((x) => x.staff_id === s.id);
              return (
                <span key={s.id} className="app-teamchip">
                  <button type="button" className="mg-chip" aria-pressed={Boolean(a)} onClick={() => { toggle(s.id); setConflicts(null); }}>{s.name}</button>
                  {a && (
                    <button type="button" className="mg-iconbtn" aria-pressed={a.role === 'lead'} aria-label={a.role === 'lead' ? `${s.name} leads the visit` : `Make ${s.name} the lead`} onClick={() => setLead(s.id)}>
                      <Star className="size-4" fill={a.role === 'lead' ? 'currentColor' : 'none'} aria-hidden="true" />
                    </button>
                  )}
                </span>
              );
            })}
            {!staff.length && <span className="text-[12.5px] text-muted-foreground">Nobody to pick yet. Add people on the Schedule page, under People.</span>}
          </div>
          {staff.length > 0 && <span className="mg-field__hint">Tick people; the star marks the lead. Someone missing? Add them under Schedule › People.</span>}
        </div>
        <Field label="Notes"><Textarea rows={2} value={v.notes || ''} onChange={(e) => set('notes', e.target.value)} placeholder="Anything the team should know" /></Field>
      </div>
    </Modal>
  );
}
