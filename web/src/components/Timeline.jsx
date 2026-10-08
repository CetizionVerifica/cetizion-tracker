import { useEffect, useState } from 'react';
import { toast as sonnerToast } from 'sonner';
import {
  CalendarClock, ClipboardList, Inbox, Mail, MessageCircle, NotebookPen, Paperclip, Phone, X,
} from 'lucide-react';
import { cn } from 'cn';
import { ConfirmDialog, Field, FileDrop, Input, Modal, Select, Textarea, useToast } from './ui.jsx';
import { Sec, Tone } from './sales.jsx';
import { initialsOf } from './record.jsx';
import { api } from '../lib/api.js';
import { useFetch, useLookups } from '../lib/hooks.js';
import { date, fileSize, today } from '../lib/format.js';
import { EmailThreadDialog } from './EmailThread.jsx';
import { FollowUpBanner, FOLLOW_UP_KINDS, useLogParam } from './FollowUpBanner.jsx';

/**
 * Tasks, notes, files and the timeline of one record (#22). Drop it on any
 * detail page: <Timeline entity="quotation" id={quotation_no} />. These are
 * the shared Timeline dialogs (Wave 3 owns them): New/Edit note with Pin,
 * the full task dialog with "Also on", Attach a file, Log a touch, and the
 * "Remove this?" confirm. `flat` draws it as a section of a panel that is
 * already glass (a record's tabs); otherwise it is its own glass card.
 */
const KINDS = [{ value: 'note', label: 'Notes' }, { value: 'task', label: 'Tasks' }, { value: 'file', label: 'Files' }, { value: 'email', label: 'Emails' }, { value: 'touch', label: 'Calls & meetings' }, { value: 'event', label: 'Milestones' }];
// The records a client portal reaches (#198): a file on one of these can be shared with the client.
const SHAREABLE = new Set(['company', 'project', 'purchase_order', 'payment_stage']);
const NOUN = { note: 'note', task: 'task', file: 'file' };

/** "2h ago", "Yesterday", "Mon", then a date: the Timeline's own rule. */
function whenText(iso) {
  const t = new Date(iso);
  const mins = Math.round((Date.now() - t.getTime()) / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 60 * 12) return `${Math.round(mins / 60)}h ago`;
  const days = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(t).setHours(0, 0, 0, 0)) / 864e5);
  if (days <= 0) return t.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (days === 1) return 'Yesterday';
  if (days < 7) return t.toLocaleDateString('en-GB', { weekday: 'long' });
  return date(iso);
}

function dotTone(it) {
  if (it.kind === 'task') {
    if (it.record.status === 'done') return 'ok';
    if (it.record.due_at && it.record.due_at < today()) return 'late';
    return 'info';
  }
  if (it.kind === 'file') return 'wait';
  if (it.kind === 'email') return 'info';
  if (it.kind === 'event') return 'ok';
  return null; // notes, calls and meetings: calm sage
}

export function Timeline({ entity, id, title = 'Activity', flat = false }) {
  const toast = useToast();
  const lookups = useLookups();
  const [kind, setKind] = useState('');
  const [note, setNote] = useState(null);       // 'new' | record
  const [task, setTask] = useState(null);       // 'new' | record
  const [file, setFile] = useState(false);
  const [thread, setThread] = useState(null);   // synced email thread id
  const [touch, setTouch] = useState(null);     // { channel, contact_id } for the log dialog
  const [removing, setRemoving] = useState(null);
  const [unsharing, setUnsharing] = useState(null);
  const [busy, setBusy] = useState(false);
  // Anything logged here may answer an open follow-up; the banner re-asks.
  const [logged, setLogged] = useState(0);
  // Reached from a follow-up email: open "Log a touch" straight away.
  useLogParam(() => setTouch({ channel: 'call', contact_id: null }), FOLLOW_UP_KINDS.includes(entity));
  const { data, loading, error, refetch: refetchItems } = useFetch(() => api.raw(`/timeline?entity=${entity}&id=${encodeURIComponent(id)}${kind ? `&kind=${kind}` : ''}`), [entity, id, kind]);
  const items = data?.data ?? [];
  const refetch = () => { refetchItems(); setLogged((n) => n + 1); };

  async function toggleTask(t) {
    try {
      await api.update('tasks', t.id, { status: t.status === 'done' ? 'todo' : 'done' });
      toast(t.status === 'done' ? `Reopened: ${t.title}` : `Done: ${t.title}`, 'success');
      refetch();
    } catch (err) { toast(err.message, 'danger'); }
  }
  // Opt-in per file (#198): nothing attached before is shown to the client.
  // Sharing is one click with Undo; stopping asks first (the client may
  // already rely on it).
  async function setShared(f, shared) {
    try {
      await api.update('attachments', f.id, { shared_with_client: shared });
      refetch();
      return true;
    } catch (err) { toast(err.message, 'danger'); return false; }
  }
  async function share(f) {
    if (!(await setShared(f, true))) return;
    sonnerToast.success('Shared: the client sees it in the portal', {
      action: { label: 'Undo', onClick: () => { setShared(f, false); } },
    });
  }
  async function unshare() {
    setBusy(true);
    if (await setShared(unsharing, false)) { toast('No longer shared with the client', 'success'); setUnsharing(null); }
    setBusy(false);
  }
  async function remove() {
    setBusy(true);
    try { await api.remove(removing.kind === 'note' ? 'notes' : removing.kind === 'task' ? 'tasks' : 'attachments', removing.id); toast(`Removed the ${NOUN[removing.kind] || 'item'}`, 'success'); setRemoving(null); refetch(); }
    catch (err) { toast(err.message, 'danger'); }
    finally { setBusy(false); }
  }

  const tools = (
    <>
      <label className="app-filter">
        Show
        <span className="mg-select-wrap" style={{ width: 170 }}>
          <select className="mg-select" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">Everything</option>
            {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
          </select>
        </span>
      </label>
      <button type="button" className="mg-btn mg-btn--sm" onClick={() => setNote('new')}><NotebookPen className="size-4" strokeWidth={1.8} aria-hidden="true" />Note</button>
      <button type="button" className="mg-btn mg-btn--sm" onClick={() => setTask('new')}><ClipboardList className="size-4" strokeWidth={1.8} aria-hidden="true" />Task</button>
      <button type="button" className="mg-btn mg-btn--sm" onClick={() => setFile(true)}><Paperclip className="size-4" strokeWidth={1.8} aria-hidden="true" />File</button>
    </>
  );

  const body = (
    <>
      <FollowUpBanner entity={entity} id={id} version={logged} onLog={() => setTouch({ channel: 'call', contact_id: null })} />
      <ContactBar entity={entity} id={id} onLog={setTouch} />
      {loading && !data ? (
        <div className="flex flex-col gap-2.5" aria-busy="true" aria-label="Loading the activity">
          {[0, 1, 2].map((i) => <div key={i} className="mg-skel" style={{ height: 40, width: i === 2 ? '70%' : undefined }} />)}
        </div>
      ) : error ? (
        <div className="mg-empty" role="alert">
          <h4 className="mg-empty__title">Couldn't load the activity</h4>
          <p className="mg-empty__text">{error}</p>
          <button type="button" className="mg-btn mg-btn--sm" onClick={refetchItems}>Try again</button>
        </div>
      ) : items.length === 0 ? (
        <div className="mg-empty">
          <span className="mg-empty__mark"><Inbox className="size-6" strokeWidth={1.8} aria-hidden="true" /></span>
          <h4 className="mg-empty__title">{kind ? `No ${KINDS.find((k) => k.value === kind)?.label.toLowerCase()} here yet` : 'Nothing here yet'}</h4>
          <p className="mg-empty__text">Add a note, a task or a file. Emails sent about this record and its milestones appear here on their own.</p>
          {kind && <button type="button" className="mg-btn mg-btn--sm" onClick={() => setKind('')}>Show everything</button>}
        </div>
      ) : (
        <ul className="mg-timeline app-tl" aria-label={`${title}, newest first`}>
          {items.map((it) => {
            const tone = dotTone(it);
            const done = it.kind === 'task' && it.record.status === 'done';
            return (
              <li key={`${it.kind}-${it.id ?? it.at}-${it.title}`}>
                {it.kind === 'task'
                  ? <input type="checkbox" className="app-tl__tick" checked={done} onChange={() => toggleTask(it.record)} aria-label={`${done ? 'Reopen' : 'Mark done'}: ${it.title}`} />
                  : <span className={cn('mg-timeline__dot', tone && `mg-timeline__dot--${tone}`)} aria-hidden="true" />}
                <div className="min-w-0">
                  <div className={cn('app-tl__what mg-timeline__what', done && 'is-done')}>
                    <span>{it.title}</span>
                    {it.kind === 'task' && it.record.priority === 'high' && <Tone tone="late">High</Tone>}
                    {it.kind === 'task' && !done && it.record.due_at && it.record.due_at < today() && <Tone tone="late">Overdue since {date(it.record.due_at)}</Tone>}
                    {it.kind === 'task' && !done && it.record.due_at && it.record.due_at >= today() && <Tone tone="plain">Due {date(it.record.due_at)}</Tone>}
                    {it.kind === 'file' && it.record.from_client && <Tone tone="info">From client</Tone>}
                    {it.kind === 'file' && !it.record.from_client && it.record.shared_with_client && <Tone tone="ok">Shared with client</Tone>}
                    {it.record?.pinned && <Tone tone="wait">Pinned</Tone>}
                  </div>
                  {it.detail && <div className="app-tl__detail">{it.detail}</div>}
                  {it.kind === 'task' && it.record.targets?.length > 0 && (
                    <div className="mg-timeline__meta">Also on {it.record.targets.map(targetLabel).join(', ')}</div>
                  )}
                  {(it.kind === 'note' || it.kind === 'task' || it.kind === 'file' || (it.kind === 'email' && it.thread_id)) && (
                    <div className="app-tl__acts">
                      {it.kind === 'email' && it.thread_id && <button type="button" className="mg-btn mg-btn--ghost" onClick={() => setThread(it.thread_id)}>Open the email</button>}
                      {it.kind === 'file' && <a className="mg-btn mg-btn--ghost" href={api.documentUrl(it.document_id)} target="_blank" rel="noopener noreferrer">Open</a>}
                      {it.kind === 'note' && <button type="button" className="mg-btn mg-btn--ghost" onClick={() => setNote(it.record)}>Edit</button>}
                      {it.kind === 'task' && <button type="button" className="mg-btn mg-btn--ghost" onClick={() => setTask(it.record)}>Edit</button>}
                      {it.kind === 'file' && !it.record.from_client && SHAREABLE.has(entity) && (
                        it.record.shared_with_client
                          ? <button type="button" className="mg-btn mg-btn--ghost" onClick={() => setUnsharing(it.record)}>Stop sharing</button>
                          : <button type="button" className="mg-btn mg-btn--ghost" onClick={() => share(it.record)}>Share with client</button>
                      )}
                      {it.kind !== 'email' && <button type="button" className="mg-btn mg-btn--ghost" aria-label={`Remove the ${NOUN[it.kind]} ${it.title}`} onClick={() => setRemoving({ kind: it.kind, id: it.id, title: it.title })}>Remove</button>}
                    </div>
                  )}
                </div>
                <time className="mg-timeline__when" dateTime={it.at} title={new Date(it.at).toLocaleString()}>{whenText(it.at)}{it.by ? ` · ${it.by}` : ''}</time>
              </li>
            );
          })}
        </ul>
      )}

      {note && <NoteDialog entity={entity} id={id} record={note === 'new' ? null : note} onClose={() => setNote(null)} onSaved={() => { setNote(null); refetch(); }} />}
      {task && <TaskDialog entity={entity} id={id} record={task === 'new' ? null : task} people={lookups.sales_people} onClose={() => setTask(null)} onSaved={() => { setTask(null); refetch(); }} />}
      {file && <FileDialog entity={entity} id={id} maxBytes={lookups.limits?.document_max_bytes} onClose={() => setFile(false)} onSaved={() => { setFile(false); refetch(); }} />}
      {thread && <EmailThreadDialog threadId={thread} onClose={() => setThread(null)} onReplied={refetch} />}
      {touch && <TouchDialog entity={entity} id={id} start={touch} onClose={() => setTouch(null)} onSaved={() => { setTouch(null); refetch(); }} />}
      {removing && <ConfirmDialog title="Remove this?" message={`The ${NOUN[removing.kind] || 'item'} "${removing.title}" leaves the timeline for good.`} confirmLabel={`Remove the ${NOUN[removing.kind] || 'item'}`} busy={busy} onConfirm={remove} onClose={() => setRemoving(null)} />}
      {unsharing && <ConfirmDialog title="Stop sharing this file?" message={`${unsharing.label || 'The file'} leaves the client's portal at once. It stays here on the record.`} confirmLabel="Stop sharing" tone="neutral" busy={busy} onConfirm={unshare} onClose={() => setUnsharing(null)} />}
    </>
  );

  if (flat) {
    return <Sec id={`tl-${entity}`} title={title} hint="notes, tasks, files and emails, with milestones, newest first" tools={tools}>{body}</Sec>;
  }
  return (
    <section className="mg-glass mg-glass--strong app-panel" aria-labelledby={`tl-${entity}-title`} data-a="rise">
      <div className="app-panel__head">
        <div className="app-panel__titles">
          <h2 id={`tl-${entity}-title`} className="mg-panel__title">{title}</h2>
          <span className="mg-panel__hint">Notes, tasks, files and emails on this record, with its milestones, newest first.</span>
        </div>
        <div className="app-panel__tools">{tools}</div>
      </div>
      <div className="app-tabbody" style={{ paddingTop: 0 }}>{body}</div>
    </section>
  );
}

function NoteDialog({ entity, id, record, onClose, onSaved }) {
  const [body, setBody] = useState(record?.body || '');
  const [pinned, setPinned] = useState(Boolean(record?.pinned));
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(null);
  async function save(e) {
    e.preventDefault(); setBusy(true); setFailed(null);
    try {
      if (record) await api.update('notes', record.id, { body, pinned }); else await api.create('notes', { entity, entity_id: id, body, pinned });
      onSaved();
    } catch (err) { setFailed(err.message); setBusy(false); }
  }
  return (
    <Modal title={record ? 'Edit note' : 'New note'} onClose={onClose} footer={<>
      <button type="button" className="mg-btn mg-btn--ghost" onClick={onClose} disabled={busy}>Cancel</button>
      <button type="submit" form="note-form" className="mg-btn mg-btn--primary" disabled={busy || !body.trim()}>{busy ? 'Saving…' : failed ? 'Try again' : record ? 'Save note' : 'Add note'}</button>
      {!body.trim() && <span className="app-why">Write the note to save it.</span>}
    </>}>
      <form id="note-form" onSubmit={save} className="stack">
        {failed && <div className="mg-banner mg-banner--late" role="alert"><div className="mg-banner__body"><strong>Couldn't save the note.</strong>{failed} What you wrote is still here.</div></div>}
        <Field label="Note" required><Textarea rows={5} value={body} onChange={(e) => setBody(e.target.value)} autoFocus /></Field>
        <label className="mg-check"><input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} /> Pin to the top</label>
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
  const free = !record && !entity;
  const knowsTargets = !record || Array.isArray(record.targets);
  const [v, setV] = useState(() => record ? { ...record, due_at: record.due_at || '', targets: record.targets || [] } : { title: '', description: '', due_at: '', type: 'follow_up', priority: 'normal', assignee: '', status: 'todo', targets: [] });
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(null);
  const set = (k, val) => setV((s) => ({ ...s, [k]: val }));
  async function save(e) {
    e.preventDefault(); setBusy(true); setFailed(null);
    const targets = v.targets.map((t) => ({ entity: t.entity, entity_id: t.entity_id }));
    const payload = { title: v.title, description: v.description || null, due_at: v.due_at || null, type: v.type, priority: v.priority, assignee: v.assignee || null, status: v.status,
      ...(knowsTargets ? { targets } : {}) };
    try {
      if (record) await api.update('tasks', record.id, payload);
      else if (free) await api.create('tasks', { ...payload, entity: targets[0].entity, entity_id: targets[0].entity_id, targets: targets.slice(1) });
      else await api.create('tasks', { ...payload, entity, entity_id: id });
      onSaved();
    } catch (err) { setFailed(err.fields ? Object.values(err.fields)[0] : err.message); setBusy(false); }
  }
  return (
    <Modal title={record ? 'Edit task' : 'New task'} subtitle={record ? `${record.title}` : free ? 'Pick the record it is about; it shows on that record’s Activity too.' : undefined} onClose={onClose} footer={<>
      <button type="button" className="mg-btn mg-btn--ghost" onClick={onClose} disabled={busy}>Cancel</button>
      <button type="submit" form="task-form" className="mg-btn mg-btn--primary" disabled={busy || !v.title.trim() || (free && !v.targets.length)} aria-describedby="task-why">{busy ? 'Saving…' : record ? 'Save task' : 'Add task'}</button>
      {(!v.title.trim() || (free && !v.targets.length)) && <span id="task-why" className="app-why">{!v.title.trim() ? 'Say what the task is to save it.' : 'Pick the record it is on to save it.'}</span>}
    </>}>
      <form id="task-form" onSubmit={save} className="form-grid">
        {failed && <div className="span-all mg-banner mg-banner--late" role="alert"><div className="mg-banner__body"><strong>Couldn't save the task.</strong>{failed}</div></div>}
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
        <div className="app-chiprow" style={{ marginBottom: 4 }}>
          {value.map((t) => (
            <button key={targetKey(t)} type="button" className="mg-chip" aria-pressed="true" aria-label={`Remove ${targetLabel(t)}`} onClick={() => onChange(value.filter((x) => targetKey(x) !== targetKey(t)))}>
              {targetLabel(t)}<X className="mg-chip__x" strokeWidth={2.2} aria-hidden="true" />
            </button>
          ))}
        </div>
      )}
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a company, quotation, project, PO…" aria-label="Search a record to add" />
      {hits.length > 0 && (
        <ul className="mg-menu m-0 list-none rounded-[14px] border border-[var(--line)] p-1.5" aria-label="Records found">
          {hits.map((h) => (
            <li key={`${h.type}-${h.id}`}>
              <button type="button" className="mg-menu__item" disabled={taken.has(targetKey(TARGET_OF[h.type](h)))} onClick={() => add(h)}>
                <span className="min-w-0 truncate"><b>{h.title}</b> <span className="font-normal text-muted-foreground">{h.label}{h.subtitle ? ` · ${h.subtitle}` : ''}</span></span>
                {taken.has(targetKey(TARGET_OF[h.type](h))) && <small>added</small>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {q.trim().length >= 2 && hits.length === 0 && <span className="text-[12px] text-muted-foreground">No record matches “{q.trim()}” yet.</span>}
      <span className="text-[12px] text-muted-foreground">{hint || 'Other records this task is about. It shows on each of their timelines too.'}</span>
    </div>
  );
}

function FileDialog({ entity, id, maxBytes, onClose, onSaved }) {
  const [file, setFile] = useState(null);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [failed, setFailed] = useState(null);
  const pick = (f) => {
    setFailed(null);
    if (f && maxBytes && f.size > maxBytes) { setFile(null); setError(`This file is ${fileSize(f.size)}: the limit is ${fileSize(maxBytes)}. Pick a smaller one.`); return; }
    setError(null); setFile(f);
  };
  async function save(e) {
    e.preventDefault(); if (!file) return; setBusy(true); setFailed(null);
    try {
      const { data } = await api.uploadDocument(file, 'attachments');
      await api.create('attachments', { entity, entity_id: id, document_id: data.id, label: label || null });
      onSaved();
    } catch (err) { setFailed(err.message); setBusy(false); }
  }
  return (
    <Modal title="Attach a file" subtitle="It shows on this record's timeline. Nothing is shared with the client until you say so." onClose={onClose} footer={<>
      <button type="button" className="mg-btn mg-btn--ghost" onClick={onClose} disabled={busy}>Cancel</button>
      <button type="submit" form="file-form" className="mg-btn mg-btn--primary" disabled={busy || !file}>{busy ? 'Uploading…' : failed ? 'Try again' : 'Attach'}</button>
      {!file && !busy && <span className="app-why">Choose a file to attach it.</span>}
    </>}>
      <form id="file-form" onSubmit={save} className="stack">
        {failed && <div className="mg-banner mg-banner--late" role="alert"><div className="mg-banner__body"><strong>Couldn't attach it.</strong>{failed}</div></div>}
        <Field as="div" label="File" required error={error} hint={file ? `Chosen: ${file.name} · ${fileSize(file.size)}` : maxBytes ? `Any file, up to ${fileSize(maxBytes)}` : undefined}>
          <FileDrop label="File" text={file ? `${file.name} · ${fileSize(file.size)}` : 'Drop a file here'} error={error} onFile={pick} />
        </Field>
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
  const missing = c && !c.blocked ? [!c.links.email && 'email', !c.links.call && 'phone', !c.links.whatsapp && 'WhatsApp number'].filter(Boolean) : [];
  return (
    <div className="app-contact" role="group" aria-label="Contact the client">
      {contacts.length === 0 ? (
        <span className="text-[12.5px] text-muted-foreground">No contacts on this client yet. Add one on the company page to email, call or WhatsApp in one click.</span>
      ) : (
        <>
          <span className="app-contact__who">
            <span className="mg-avatar size-[34px] shrink-0 text-[11.5px]" aria-hidden="true">{initialsOf(c.name)}</span>
            {contacts.length > 1 ? (
              <label className="flex flex-col gap-0.5">
                <span className="mg-label">Contact</span>
                <span className="mg-select-wrap">
                  <select className="mg-select" value={pick || String(c.id)} onChange={(e) => setPick(e.target.value)}>
                    {contacts.map((x) => <option key={x.id} value={String(x.id)}>{`${x.name}${x.role ? ` · ${x.role}` : ''}${x.blocked ? ' (do not contact)' : ''}`}</option>)}
                  </select>
                </span>
              </label>
            ) : <span className="flex flex-col"><span className="mg-label">Contact</span><b className="text-[13.5px]">{c.name}{c.role ? ` · ${c.role}` : ''}</b></span>}
          </span>
          {c.blocked ? <Tone tone="late">{c.blocked}</Tone> : (
            <>
              <button type="button" className="mg-btn mg-btn--sm" disabled={!c.links.email} title={c.email || 'No email'} onClick={() => go('email', c.links.email)}><Mail className="size-4" strokeWidth={1.8} aria-hidden="true" />Email</button>
              <button type="button" className="mg-btn mg-btn--sm" disabled={!c.links.call} title={c.phone || 'No phone'} onClick={() => { if (c.phone) navigator.clipboard?.writeText(c.phone).catch(() => {}); go('call', c.links.call); }}><Phone className="size-4" strokeWidth={1.8} aria-hidden="true" />Call</button>
              <button type="button" className="mg-btn mg-btn--sm" disabled={!c.links.whatsapp} title={c.whatsapp_number || c.phone || 'No number'} onClick={() => go('whatsapp', c.links.whatsapp)}><MessageCircle className="size-4" strokeWidth={1.8} aria-hidden="true" />WhatsApp</button>
            </>
          )}
          <span className="app-contact__meta">
            {[c.last_contacted_at && `Last contacted ${date(c.last_contacted_at)}`, c.preferred_channel && `prefers ${c.preferred_channel}${c.best_time_to_call ? `, ${c.best_time_to_call}` : ''}`, missing.length > 0 && `no ${missing.join(' or ')} on ${c.name}`].filter(Boolean).join(' · ')}
          </span>
        </>
      )}
      {!c?.blocked && <button type="button" className="mg-btn mg-btn--ghost mg-btn--sm app-contact__log" onClick={() => onLog({ channel: 'call', contact_id: c?.id ?? null })}><CalendarClock className="size-4" strokeWidth={1.8} aria-hidden="true" />Log a touch</button>}
    </div>
  );
}

export function TouchDialog({ entity, id, start, onClose, onSaved, subtitle }) {
  const toast = useToast();
  const now = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const [v, setV] = useState({ channel: start.channel, direction: 'outbound', outcome: OUTCOMES[start.channel][0], started_at: now, duration_minutes: '', summary: '', attendees: '', next_title: '', next_due: '' });
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(null);
  const set = (k, val) => setV((s) => ({ ...s, [k]: val, ...(k === 'channel' ? { outcome: OUTCOMES[val][0] } : {}) }));
  async function save(e) {
    e.preventDefault(); setBusy(true); setFailed(null);
    try {
      await api.action('/communications', {
        entity, entity_id: id, contact_id: start.contact_id, channel: v.channel, direction: v.direction, outcome: v.outcome,
        started_at: new Date(v.started_at).toISOString(), duration_minutes: v.duration_minutes === '' ? null : Number(v.duration_minutes),
        summary: v.summary || null, attendees: v.attendees || null,
        next_step: v.next_title.trim() ? { title: v.next_title.trim(), due_at: v.next_due || null } : null,
      });
      toast('Logged', 'success'); onSaved();
    } catch (err) { setFailed(err.fields ? Object.values(err.fields)[0] : err.message); setBusy(false); }
  }
  return (
    <Modal title="Log a touch" subtitle={subtitle || 'What happened, and what comes next. The next step becomes a task.'} onClose={onClose} footer={<>
      <button type="button" className="mg-btn mg-btn--ghost" onClick={onClose} disabled={busy}>Skip</button>
      <button type="submit" form="touch-form" className="mg-btn mg-btn--primary" disabled={busy}>{busy ? 'Logging…' : failed ? 'Try again' : 'Log it'}</button>
    </>}>
      <form id="touch-form" onSubmit={save} className="form-grid">
        {failed && <div className="span-all mg-banner mg-banner--late" role="alert"><div className="mg-banner__body"><strong>Couldn't log it.</strong>{failed}</div></div>}
        <Field label="Channel"><Select value={v.channel} placeholder={null} options={CHANNELS} onChange={(e) => set('channel', e.target.value)} /></Field>
        <Field label="Direction"><Select value={v.direction} placeholder={null} options={[{ value: 'outbound', label: 'We reached out' }, { value: 'inbound', label: 'They reached us' }]} onChange={(e) => set('direction', e.target.value)} /></Field>
        <Field label="Outcome"><Select value={v.outcome} placeholder={null} options={OUTCOMES[v.channel].map((o) => ({ value: o, label: o.replace('_', ' ') }))} onChange={(e) => set('outcome', e.target.value)} /></Field>
        <Field label="When"><Input type="datetime-local" value={v.started_at} onChange={(e) => set('started_at', e.target.value)} /></Field>
        {(v.channel === 'call' || v.channel === 'meeting') && <Field label="Minutes"><Input type="number" min="0" value={v.duration_minutes} onChange={(e) => set('duration_minutes', e.target.value)} /></Field>}
        {v.channel === 'meeting' && <Field label="Attendees" hint="Who was there, theirs and ours"><Input value={v.attendees} onChange={(e) => set('attendees', e.target.value)} /></Field>}
        <div className="span-all"><Field label="Notes"><Textarea rows={3} value={v.summary} onChange={(e) => set('summary', e.target.value)} placeholder="What was agreed" autoFocus /></Field></div>
        <Field label="Next step"><Input value={v.next_title} onChange={(e) => set('next_title', e.target.value)} placeholder="Send revised quote" /></Field>
        <Field label="By" hint="Sets the next follow-up date: the owner is reminded on it if nothing is logged"><Input type="date" value={v.next_due} onChange={(e) => set('next_due', e.target.value)} /></Field>
      </form>
    </Modal>
  );
}
