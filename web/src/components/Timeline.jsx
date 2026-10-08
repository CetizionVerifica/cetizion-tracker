import { useEffect, useState } from 'react';
import { Badge, Card, ConfirmDialog, Empty, Field, Input, Modal, Select, Textarea, useToast } from './ui.jsx';
import { api } from '../lib/api.js';
import { useFetch, useLookups } from '../lib/hooks.js';
import { date, fileSize, today } from '../lib/format.js';
import { EmailThreadDialog } from './EmailThread.jsx';
import { FollowUpBanner, FOLLOW_UP_KINDS, useLogParam } from './FollowUpBanner.jsx';

/**
 * Tasks, notes, files and the timeline of one record (#22). Drop it on any
 * detail page: <Timeline entity="quotation" id={quotation_no} />.
 */
const KINDS = [{ value: 'note', label: 'Notes' }, { value: 'task', label: 'Tasks' }, { value: 'file', label: 'Files' }, { value: 'email', label: 'Emails' }, { value: 'touch', label: 'Calls & meetings' }, { value: 'event', label: 'Milestones' }];
const ICON = { note: '✎', task: '☐', file: '⎘', email: '✉', event: '●', touch: '☏' };
// The records a client portal reaches (#198): a file on one of these can be shared with the client.
const SHAREABLE = new Set(['company', 'project', 'purchase_order', 'payment_stage']);

export function Timeline({ entity, id, title = 'Activity' }) {
  const toast = useToast();
  const lookups = useLookups();
  const [kind, setKind] = useState('');
  const [note, setNote] = useState(null);       // 'new' | record
  const [task, setTask] = useState(null);       // 'new' | record
  const [file, setFile] = useState(false);
  const [thread, setThread] = useState(null);   // synced email thread id
  const [touch, setTouch] = useState(null);     // { channel, contact_id } for the log dialog
  const [removing, setRemoving] = useState(null);
  const [busy, setBusy] = useState(false);
  // Anything logged here may answer an open follow-up; the banner re-asks.
  const [logged, setLogged] = useState(0);
  // Reached from a follow-up email: open "Log a touch" straight away.
  useLogParam(() => setTouch({ channel: 'call', contact_id: null }), FOLLOW_UP_KINDS.includes(entity));
  const { data, loading, refetch: refetchItems } = useFetch(() => api.raw(`/timeline?entity=${entity}&id=${encodeURIComponent(id)}${kind ? `&kind=${kind}` : ''}`), [entity, id, kind]);
  const items = data?.data ?? [];
  const refetch = () => { refetchItems(); setLogged((n) => n + 1); };

  async function toggleTask(t) {
    try { await api.update('tasks', t.id, { status: t.status === 'done' ? 'todo' : 'done' }); refetch(); }
    catch (err) { toast(err.message, 'danger'); }
  }
  // Opt-in per file (#198): nothing attached before is shown to the client.
  async function share(f) {
    try {
      await api.update('attachments', f.id, { shared_with_client: !f.shared_with_client });
      toast(f.shared_with_client ? 'No longer shared with the client' : 'Shared: the client sees it in the portal', 'success');
      refetch();
    } catch (err) { toast(err.message, 'danger'); }
  }
  async function remove() {
    setBusy(true);
    try { await api.remove(removing.kind === 'note' ? 'notes' : removing.kind === 'task' ? 'tasks' : 'attachments', removing.id); setRemoving(null); refetch(); }
    catch (err) { toast(err.message, 'danger'); }
    finally { setBusy(false); }
  }

  return (
    <Card
      flush
      title={title}
      hint="Notes, tasks, files and emails on this record, with its milestones, newest first."
      actions={
        <div className="card__actions">
          <Select value={kind} placeholder="Everything" options={KINDS} onChange={(e) => setKind(e.target.value)} />
          <button type="button" className="btn btn--sm" onClick={() => setNote('new')}>+ Note</button>
          <button type="button" className="btn btn--sm" onClick={() => setTask('new')}>+ Task</button>
          <button type="button" className="btn btn--sm" onClick={() => setFile(true)}>+ File</button>
        </div>
      }
    >
      <FollowUpBanner className="px-4 pt-3" entity={entity} id={id} version={logged} onLog={() => setTouch({ channel: 'call', contact_id: null })} />
      <ContactBar entity={entity} id={id} onLog={setTouch} />
      {loading && !data ? <div className="skeleton" style={{ height: 80, margin: 18 }} /> : items.length === 0 ? (
        <Empty title="Nothing here yet" text="Add a note, a task or a file. Emails sent about this record and its milestones appear here on their own." />
      ) : (
        <ul className="timeline">
          {items.map((it) => (
            <li key={`${it.kind}-${it.id ?? it.at}-${it.title}`} className={`timeline__item timeline__item--${it.kind}`}>
              <span className="timeline__icon" aria-hidden="true">{ICON[it.kind]}</span>
              <div className="timeline__body">
                <div className="timeline__head">
                  {it.kind === 'task' && <input type="checkbox" checked={it.record.status === 'done'} onChange={() => toggleTask(it.record)} title="Mark done" />}
                  <span className={`strong ${it.record?.status === 'done' ? 'muted' : ''}`}>{it.title}</span>
                  {it.kind === 'task' && it.record.priority === 'high' && <Badge tone="danger">high</Badge>}
                  {it.kind === 'task' && it.record.status !== 'done' && it.record.due_at && it.record.due_at < today() && <Badge tone="danger">overdue</Badge>}
                  {it.kind === 'email' && it.thread_id && <button type="button" className="btn btn--sm btn--ghost" onClick={() => setThread(it.thread_id)}>Open</button>}
                  {it.kind === 'file' && it.record.from_client && <Badge tone="info">From client</Badge>}
                  {it.kind === 'file' && !it.record.from_client && it.record.shared_with_client && <Badge>Shared with client</Badge>}
                  {it.kind === 'file' && <a className="btn btn--sm btn--ghost" href={api.documentUrl(it.document_id)} target="_blank" rel="noopener noreferrer">Open</a>}
                  <span className="small muted timeline__when">{new Date(it.at).toLocaleString()}{it.by ? ` · ${it.by}` : ''}</span>
                </div>
                {it.detail && <div className="timeline__detail">{it.detail}</div>}
                {it.kind === 'task' && it.record.targets?.length > 0 && (
                  <div className="timeline__detail small muted">Also on {it.record.targets.map(targetLabel).join(', ')}</div>
                )}
                {(it.kind === 'note' || it.kind === 'task' || it.kind === 'file') && (
                  <div className="timeline__actions">
                    {it.kind === 'note' && <button type="button" className="btn btn--sm btn--ghost" onClick={() => setNote(it.record)}>Edit</button>}
                    {it.kind === 'task' && <button type="button" className="btn btn--sm btn--ghost" onClick={() => setTask(it.record)}>Edit</button>}
                    {it.kind === 'file' && !it.record.from_client && SHAREABLE.has(entity) && (
                      <button type="button" className="btn btn--sm btn--ghost" onClick={() => share(it.record)}>{it.record.shared_with_client ? 'Stop sharing' : 'Share with client'}</button>
                    )}
                    <button type="button" className="btn btn--sm btn--ghost" onClick={() => setRemoving({ kind: it.kind, id: it.id })}>✕</button>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {note && <NoteDialog entity={entity} id={id} record={note === 'new' ? null : note} onClose={() => setNote(null)} onSaved={() => { setNote(null); refetch(); }} />}
      {task && <TaskDialog entity={entity} id={id} record={task === 'new' ? null : task} people={lookups.sales_people} onClose={() => setTask(null)} onSaved={() => { setTask(null); refetch(); }} />}
      {file && <FileDialog entity={entity} id={id} maxBytes={lookups.limits?.document_max_bytes} onClose={() => setFile(false)} onSaved={() => { setFile(false); refetch(); }} />}
      {thread && <EmailThreadDialog threadId={thread} onClose={() => setThread(null)} onReplied={refetch} />}
      {touch && <TouchDialog entity={entity} id={id} start={touch} onClose={() => setTouch(null)} onSaved={() => { setTouch(null); refetch(); }} />}
      {removing && <ConfirmDialog title="Remove this?" message="It leaves the timeline for good." confirmLabel="Remove" busy={busy} onConfirm={remove} onClose={() => setRemoving(null)} />}
    </Card>
  );
}

function NoteDialog({ entity, id, record, onClose, onSaved }) {
  const toast = useToast();
  const [body, setBody] = useState(record?.body || '');
  const [pinned, setPinned] = useState(Boolean(record?.pinned));
  const [busy, setBusy] = useState(false);
  async function save(e) {
    e.preventDefault(); setBusy(true);
    try {
      if (record) await api.update('notes', record.id, { body, pinned }); else await api.create('notes', { entity, entity_id: id, body, pinned });
      onSaved();
    } catch (err) { toast(err.message, 'danger'); setBusy(false); }
  }
  return (
    <Modal title={record ? 'Edit note' : 'New note'} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" form="note-form" className="btn btn--primary" disabled={busy || !body.trim()}>Save</button></>}>
      <form id="note-form" onSubmit={save} className="stack">
        <Field label="Note" required><Textarea rows={5} value={body} onChange={(e) => setBody(e.target.value)} autoFocus /></Field>
        <label className="small" style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} /> Pin to the top</label>
      </form>
    </Modal>
  );
}

/**
 * New or edit task. Opened from a record (`entity`, `id`) the task lives
 * there; opened from the Tasks page with no record, the first record picked
 * under "On" is where it lives and the rest are "also on". A task row from
 * the Tasks list carries no `targets`, so its "Also on" records are left as
 * they are rather than cleared.
 */
export function TaskDialog({ entity, id, record, people, onClose, onSaved }) {
  const toast = useToast();
  const free = !record && !entity;
  const knowsTargets = !record || Array.isArray(record.targets);
  const [v, setV] = useState(() => record ? { ...record, due_at: record.due_at || '', targets: record.targets || [] } : { title: '', description: '', due_at: '', type: 'follow_up', priority: 'normal', assignee: '', status: 'todo', targets: [] });
  const [busy, setBusy] = useState(false);
  const set = (k, val) => setV((s) => ({ ...s, [k]: val }));
  async function save(e) {
    e.preventDefault(); setBusy(true);
    const targets = v.targets.map((t) => ({ entity: t.entity, entity_id: t.entity_id }));
    const payload = { title: v.title, description: v.description || null, due_at: v.due_at || null, type: v.type, priority: v.priority, assignee: v.assignee || null, status: v.status,
      ...(knowsTargets ? { targets } : {}) };
    try {
      if (record) await api.update('tasks', record.id, payload);
      else if (free) await api.create('tasks', { ...payload, entity: targets[0].entity, entity_id: targets[0].entity_id, targets: targets.slice(1) });
      else await api.create('tasks', { ...payload, entity, entity_id: id });
      onSaved();
    } catch (err) { toast(err.fields ? Object.values(err.fields)[0] : err.message, 'danger'); setBusy(false); }
  }
  return (
    <Modal title={record ? 'Edit task' : 'New task'} subtitle={record ? `${record.title}` : free ? 'Pick the record it is about; it shows on that record’s Activity too.' : undefined} onClose={onClose} footer={<>
      <button type="button" className="mg-btn mg-btn--ghost" onClick={onClose} disabled={busy}>Cancel</button>
      <button type="submit" form="task-form" className="mg-btn mg-btn--primary" disabled={busy || !v.title.trim() || (free && !v.targets.length)} aria-describedby="task-why">{busy ? 'Saving…' : record ? 'Save task' : 'Add task'}</button>
      {(!v.title.trim() || (free && !v.targets.length)) && <span id="task-why" className="app-why">{!v.title.trim() ? 'Say what the task is to save it.' : 'Pick the record it is on to save it.'}</span>}
    </>}>
      <form id="task-form" onSubmit={save} className="form-grid">
        <div className="span-all"><Field label="What" required><Input value={v.title} onChange={(e) => set('title', e.target.value)} autoFocus placeholder="Call Ravi about the revised scope" /></Field></div>
        <Field label="Type"><Select value={v.type} placeholder={null} options={[['call', 'Call'], ['email', 'Email'], ['meeting', 'Meeting'], ['follow_up', 'Follow-up'], ['document', 'Document'], ['other', 'Other']].map(([value, label]) => ({ value, label }))} onChange={(e) => set('type', e.target.value)} /></Field>
        <Field label="Due"><Input type="date" value={v.due_at} onChange={(e) => set('due_at', e.target.value)} /></Field>
        <Field label="Priority"><Select value={v.priority} placeholder={null} options={[{ value: 'normal', label: 'Normal' }, { value: 'high', label: 'High' }, { value: 'low', label: 'Low' }]} onChange={(e) => set('priority', e.target.value)} /></Field>
        <Field label="For"><Input list="task-people" value={v.assignee} onChange={(e) => set('assignee', e.target.value)} placeholder="Who does it" /><datalist id="task-people">{people.map((p) => <option key={p} value={p} />)}</datalist></Field>
        {record && <Field label="Status"><Select value={v.status} placeholder={null} options={[{ value: 'todo', label: 'To do' }, { value: 'in_progress', label: 'In progress' }, { value: 'done', label: 'Done' }]} onChange={(e) => set('status', e.target.value)} /></Field>}
        <div className="span-all"><Field label="Details"><Textarea rows={3} value={v.description || ''} onChange={(e) => set('description', e.target.value)} /></Field></div>
        {knowsTargets && <div className="span-all"><AlsoOn heading={free ? 'On' : 'Also on'} hint={free ? 'The first record is where the task lives; add more to show it on them too.' : undefined} value={v.targets} main={{ entity: record?.entity || entity, entity_id: record?.entity_id || id }} onChange={(targets) => set('targets', targets)} /></div>}
      </form>
    </Modal>
  );
}

// A search hit, as a record a task can be on.
const TARGET_OF = {
  deal: (h) => ({ entity: 'quotation', entity_id: h.title }),
  enquiry: (h) => ({ entity: 'enquiry', entity_id: h.title }),
  company: (h) => ({ entity: 'company', entity_id: String(h.id) }),
  contact: (h) => ({ entity: 'contact', entity_id: String(h.id) }),
  project: (h) => ({ entity: 'project', entity_id: h.title }),
  order: (h) => ({ entity: 'purchase_order', entity_id: h.title }),
};
const ENTITY_NAME = { quotation: 'quotation', enquiry: 'enquiry', company: 'company', contact: 'contact', project: 'project', purchase_order: 'PO', payment_stage: 'payment stage' };
const targetLabel = (t) => t.label || `${ENTITY_NAME[t.entity] || t.entity} ${t.entity_id}`;
const targetKey = (t) => `${t.entity}:${t.entity_id}`;

/**
 * The other records a task is on (#22): "send the revised quotation" is
 * work on the quotation and on the company, and shows on both timelines.
 */
function AlsoOn({ value, main, onChange, heading = 'Also on', hint }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState([]);
  useEffect(() => {
    const text = q.trim();
    if (text.length < 2) { setHits([]); return undefined; }
    const timer = setTimeout(async () => {
      try {
        const res = await api.raw(`/search?q=${encodeURIComponent(text)}`);
        setHits((res.data || []).filter((h) => TARGET_OF[h.type]).slice(0, 8));
      } catch { setHits([]); }
    }, 250);
    return () => clearTimeout(timer);
  }, [q]);
  const taken = new Set([targetKey(main), ...value.map(targetKey)]);
  const add = (h) => {
    const t = { ...TARGET_OF[h.type](h), label: `${h.label.toLowerCase()} ${h.title}` };
    if (!taken.has(targetKey(t))) onChange([...value, t]);
    setQ(''); setHits([]);
  };
  return (
    // Not a Field: that is a <label>, and a click on its text would press the
    // first chip's remove button.
    <div role="group" aria-labelledby="also-on-label" className="flex flex-col gap-1.5">
      <span id="also-on-label" className="text-[12px] font-medium text-secondary-foreground">{heading}{heading === 'On' && <span className="ml-0.5 text-late" aria-hidden="true">*</span>}</span>
      {value.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
          {value.map((t) => (
            <Badge key={targetKey(t)} tone="info">
              {targetLabel(t)}
              <button type="button" className="btn btn--sm btn--ghost" style={{ padding: '0 4px', minHeight: 0 }} aria-label={`Remove ${targetLabel(t)}`} onClick={() => onChange(value.filter((x) => targetKey(x) !== targetKey(t)))}>✕</button>
            </Badge>
          ))}
        </div>
      )}
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a company, quotation, project, PO…" aria-label="Search a record to add" />
      {hits.length > 0 && (
        <ul className="stack" style={{ listStyle: 'none', margin: '6px 0 0', padding: 0, gap: 2 }}>
          {hits.map((h) => (
            <li key={`${h.type}-${h.id}`}>
              <button type="button" className="btn btn--sm btn--ghost" disabled={taken.has(targetKey(TARGET_OF[h.type](h)))} onClick={() => add(h)} style={{ width: '100%', justifyContent: 'flex-start', textAlign: 'left' }}>
                <span className="strong">{h.title}</span>&nbsp;<span className="small muted">{h.label}{h.subtitle ? ` · ${h.subtitle}` : ''}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <span className="text-[12px] text-muted-foreground">{hint || 'Other records this task is about. It shows on each of their timelines too.'}</span>
    </div>
  );
}

function FileDialog({ entity, id, maxBytes, onClose, onSaved }) {
  const toast = useToast();
  const [file, setFile] = useState(null);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  async function save(e) {
    e.preventDefault(); if (!file) return; setBusy(true);
    try {
      const { data } = await api.uploadDocument(file, 'attachments');
      await api.create('attachments', { entity, entity_id: id, document_id: data.id, label: label || null });
      onSaved();
    } catch (err) { toast(err.message, 'danger'); setBusy(false); }
  }
  return (
    <Modal title="Attach a file" onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" form="file-form" className="btn btn--primary" disabled={busy || !file}>{busy ? 'Uploading…' : 'Attach'}</button></>}>
      <form id="file-form" onSubmit={save} className="stack">
        <Field label="File" required hint={maxBytes ? `Up to ${fileSize(maxBytes)}` : undefined}><input type="file" className="input" onChange={(e) => setFile(e.target.files?.[0] || null)} /></Field>
        <Field label="Label" hint="What it is, e.g. Signed NDA"><Input value={label} onChange={(e) => setLabel(e.target.value)} /></Field>
      </form>
    </Modal>
  );
}


const CHANNELS = [{ value: 'call', label: 'Call' }, { value: 'whatsapp', label: 'WhatsApp' }, { value: 'meeting', label: 'Meeting' }, { value: 'email', label: 'Email' }, { value: 'sms', label: 'SMS' }, { value: 'other', label: 'Other' }];
const OUTCOMES = { call: ['connected', 'no_answer', 'left_message', 'wrong_number'], whatsapp: ['sent', 'connected'], meeting: ['held'], email: ['sent'], sms: ['sent'], other: ['connected'] };

/**
 * One-click contact (#31): email, call or WhatsApp the people behind this
 * record, then log the touch. Do-not-contact people show greyed out.
 */
export function ContactBar({ entity, id, onLog }) {
  const { data } = useFetch(() => api.raw(`/communications/contacts?entity=${entity}&id=${encodeURIComponent(id)}`), [entity, id]);
  const [pick, setPick] = useState('');
  const contacts = data?.data?.contacts ?? [];
  if (!data?.data?.company_id) return null;
  const c = contacts.find((x) => String(x.id) === pick) || contacts[0];
  const go = (channel, href) => {
    if (href) window.open(href, channel === 'whatsapp' ? '_blank' : '_self', 'noopener');
    // Give the other app a moment to take over, then offer to log what happened.
    setTimeout(() => onLog({ channel, contact_id: c?.id ?? null }), 400);
  };
  return (
    <div className="contact-bar">
      {contacts.length === 0 ? (
        <span className="small muted">No contacts on this client yet. Add one on the company page to email, call or WhatsApp in one click.</span>
      ) : (
        <>
          {contacts.length > 1 ? (
            <Select value={pick || String(c.id)} placeholder={null} options={contacts.map((x) => ({ value: String(x.id), label: `${x.name}${x.role ? ` · ${x.role}` : ''}${x.blocked ? ' (do not contact)' : ''}` }))} onChange={(e) => setPick(e.target.value)} />
          ) : <span className="strong small">{c.name}{c.role ? ` · ${c.role}` : ''}</span>}
          {c.blocked ? <Badge tone="danger">{c.blocked}</Badge> : (
            <>
              <button type="button" className="btn btn--sm" disabled={!c.links.email} title={c.email || 'No email'} onClick={() => go('email', c.links.email)}>✉ Email</button>
              <button type="button" className="btn btn--sm" disabled={!c.links.call} title={c.phone || 'No phone'} onClick={() => { if (c.phone) navigator.clipboard?.writeText(c.phone).catch(() => {}); go('call', c.links.call); }}>☏ Call</button>
              <button type="button" className="btn btn--sm" disabled={!c.links.whatsapp} title={c.whatsapp_number || c.phone || 'No number'} onClick={() => go('whatsapp', c.links.whatsapp)}>◍ WhatsApp</button>
            </>
          )}
          {c.last_contacted_at && <span className="small muted">last contacted {date(c.last_contacted_at)}</span>}
          {c.preferred_channel && <span className="small muted">prefers {c.preferred_channel}{c.best_time_to_call ? `, ${c.best_time_to_call}` : ''}</span>}
        </>
      )}
      {!c?.blocked && <button type="button" className="btn btn--sm btn--ghost" onClick={() => onLog({ channel: 'call', contact_id: c?.id ?? null })}>+ Log a touch</button>}
    </div>
  );
}

export function TouchDialog({ entity, id, start, onClose, onSaved }) {
  const toast = useToast();
  const now = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const [v, setV] = useState({ channel: start.channel, direction: 'outbound', outcome: OUTCOMES[start.channel][0], started_at: now, duration_minutes: '', summary: '', attendees: '', next_title: '', next_due: '' });
  const [busy, setBusy] = useState(false);
  const set = (k, val) => setV((s) => ({ ...s, [k]: val, ...(k === 'channel' ? { outcome: OUTCOMES[val][0] } : {}) }));
  async function save(e) {
    e.preventDefault(); setBusy(true);
    try {
      await api.action('/communications', {
        entity, entity_id: id, contact_id: start.contact_id, channel: v.channel, direction: v.direction, outcome: v.outcome,
        started_at: new Date(v.started_at).toISOString(), duration_minutes: v.duration_minutes === '' ? null : Number(v.duration_minutes),
        summary: v.summary || null, attendees: v.attendees || null,
        next_step: v.next_title.trim() ? { title: v.next_title.trim(), due_at: v.next_due || null } : null,
      });
      toast('Logged', 'success'); onSaved();
    } catch (err) { toast(err.fields ? Object.values(err.fields)[0] : err.message, 'danger'); setBusy(false); }
  }
  return (
    <Modal title="Log a touch" subtitle="What happened, and what comes next. The next step becomes a task." onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose} disabled={busy}>Skip</button><button type="submit" form="touch-form" className="btn btn--primary" disabled={busy}>Log it</button></>}>
      <form id="touch-form" onSubmit={save} className="form-grid">
        <Field label="Channel"><Select value={v.channel} placeholder={null} options={CHANNELS} onChange={(e) => set('channel', e.target.value)} /></Field>
        <Field label="Direction"><Select value={v.direction} placeholder={null} options={[{ value: 'outbound', label: 'We reached out' }, { value: 'inbound', label: 'They reached us' }]} onChange={(e) => set('direction', e.target.value)} /></Field>
        <Field label="Outcome"><Select value={v.outcome} placeholder={null} options={OUTCOMES[v.channel].map((o) => ({ value: o, label: o.replace('_', ' ') }))} onChange={(e) => set('outcome', e.target.value)} /></Field>
        <Field label="When"><Input type="datetime-local" value={v.started_at} onChange={(e) => set('started_at', e.target.value)} /></Field>
        {(v.channel === 'call' || v.channel === 'meeting') && <Field label="Minutes"><Input type="number" min="0" value={v.duration_minutes} onChange={(e) => set('duration_minutes', e.target.value)} /></Field>}
        {v.channel === 'meeting' && <Field label="Attendees"><Input value={v.attendees} onChange={(e) => set('attendees', e.target.value)} /></Field>}
        <div className="span-all"><Field label="Notes"><Textarea rows={3} value={v.summary} onChange={(e) => set('summary', e.target.value)} placeholder="What was agreed" autoFocus /></Field></div>
        <Field label="Next step"><Input value={v.next_title} onChange={(e) => set('next_title', e.target.value)} placeholder="Send revised quote" /></Field>
        <Field label="By" hint="Sets the next follow-up date: the owner is reminded on it if nothing is logged"><Input type="date" value={v.next_due} onChange={(e) => set('next_due', e.target.value)} /></Field>
      </form>
    </Modal>
  );
}
