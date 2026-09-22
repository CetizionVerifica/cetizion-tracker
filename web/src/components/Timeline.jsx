import { useState } from 'react';
import { Badge, Card, ConfirmDialog, Empty, Field, Input, Modal, Select, Textarea, useToast } from './ui.jsx';
import { api } from '../lib/api.js';
import { useFetch, useLookups } from '../lib/hooks.js';
import { date, fileSize, today } from '../lib/format.js';

/**
 * Tasks, notes, files and the timeline of one record (#22). Drop it on any
 * detail page: <Timeline entity="quotation" id={quotation_no} />.
 */
const KINDS = [{ value: 'note', label: 'Notes' }, { value: 'task', label: 'Tasks' }, { value: 'file', label: 'Files' }, { value: 'email', label: 'Emails' }, { value: 'event', label: 'Milestones' }];
const ICON = { note: '✎', task: '☐', file: '⎘', email: '✉', event: '●' };

export function Timeline({ entity, id, title = 'Activity' }) {
  const toast = useToast();
  const lookups = useLookups();
  const [kind, setKind] = useState('');
  const [note, setNote] = useState(null);       // 'new' | record
  const [task, setTask] = useState(null);       // 'new' | record
  const [file, setFile] = useState(false);
  const [removing, setRemoving] = useState(null);
  const [busy, setBusy] = useState(false);
  const { data, loading, refetch } = useFetch(() => api.raw(`/timeline?entity=${entity}&id=${encodeURIComponent(id)}${kind ? `&kind=${kind}` : ''}`), [entity, id, kind]);
  const items = data?.data ?? [];

  async function toggleTask(t) {
    try { await api.update('tasks', t.id, { status: t.status === 'done' ? 'todo' : 'done' }); refetch(); }
    catch (err) { toast(err.message, 'danger'); }
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
                  {it.kind === 'file' && <a className="btn btn--sm btn--ghost" href={api.documentUrl(it.document_id)} target="_blank" rel="noopener noreferrer">Open</a>}
                  <span className="small muted timeline__when">{new Date(it.at).toLocaleString()}{it.by ? ` · ${it.by}` : ''}</span>
                </div>
                {it.detail && <div className="timeline__detail">{it.detail}</div>}
                {(it.kind === 'note' || it.kind === 'task' || it.kind === 'file') && (
                  <div className="timeline__actions">
                    {it.kind === 'note' && <button type="button" className="btn btn--sm btn--ghost" onClick={() => setNote(it.record)}>Edit</button>}
                    {it.kind === 'task' && <button type="button" className="btn btn--sm btn--ghost" onClick={() => setTask(it.record)}>Edit</button>}
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

function TaskDialog({ entity, id, record, people, onClose, onSaved }) {
  const toast = useToast();
  const [v, setV] = useState(() => record ? { ...record, due_at: record.due_at || '' } : { title: '', description: '', due_at: '', type: 'follow_up', priority: 'normal', assignee: '', status: 'todo' });
  const [busy, setBusy] = useState(false);
  const set = (k, val) => setV((s) => ({ ...s, [k]: val }));
  async function save(e) {
    e.preventDefault(); setBusy(true);
    const payload = { title: v.title, description: v.description || null, due_at: v.due_at || null, type: v.type, priority: v.priority, assignee: v.assignee || null, status: v.status };
    try {
      if (record) await api.update('tasks', record.id, payload); else await api.create('tasks', { ...payload, entity, entity_id: id });
      onSaved();
    } catch (err) { toast(err.fields ? Object.values(err.fields)[0] : err.message, 'danger'); setBusy(false); }
  }
  return (
    <Modal title={record ? 'Edit task' : 'New task'} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" form="task-form" className="btn btn--primary" disabled={busy || !v.title.trim()}>Save</button></>}>
      <form id="task-form" onSubmit={save} className="form-grid">
        <div className="span-all"><Field label="What" required><Input value={v.title} onChange={(e) => set('title', e.target.value)} autoFocus placeholder="Call Ravi about the revised scope" /></Field></div>
        <Field label="Type"><Select value={v.type} placeholder={null} options={['call', 'email', 'meeting', 'follow_up', 'document', 'other'].map((t) => ({ value: t, label: t.replace('_', ' ') }))} onChange={(e) => set('type', e.target.value)} /></Field>
        <Field label="Due"><Input type="date" value={v.due_at} onChange={(e) => set('due_at', e.target.value)} /></Field>
        <Field label="Priority"><Select value={v.priority} placeholder={null} options={['low', 'normal', 'high']} onChange={(e) => set('priority', e.target.value)} /></Field>
        <Field label="For"><Input list="task-people" value={v.assignee} onChange={(e) => set('assignee', e.target.value)} placeholder="Who does it" /><datalist id="task-people">{people.map((p) => <option key={p} value={p} />)}</datalist></Field>
        {record && <Field label="Status"><Select value={v.status} placeholder={null} options={[{ value: 'todo', label: 'To do' }, { value: 'in_progress', label: 'In progress' }, { value: 'done', label: 'Done' }]} onChange={(e) => set('status', e.target.value)} /></Field>}
        <div className="span-all"><Field label="Details"><Textarea rows={3} value={v.description || ''} onChange={(e) => set('description', e.target.value)} /></Field></div>
      </form>
    </Modal>
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

