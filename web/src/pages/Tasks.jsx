import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { toast as sonnerToast } from 'sonner';
import { PageHeader } from '../App.jsx';
import { useToast } from '../components/ui.jsx';
import { TaskDialog } from '../components/Timeline.jsx';
import { FailedCard, FilterSelect, ListTable, LoadingPanel, Panel, PhoneRow, StateCard, plural, useEntrance } from '../components/daily.jsx';
import { api } from '../lib/api.js';
import { useFetch, useLookups } from '../lib/hooks.js';
import { date, today } from '../lib/format.js';

/** Every open task across the tracker (#22): what is due, for whom, on which record. */
const LINK = {
  company: (id) => `/companies/${id}`,
  contact: () => '/companies',
  enquiry: (id) => `/enquiries?q=${encodeURIComponent(id)}`,
  quotation: (id) => `/quotations/${encodeURIComponent(id)}`,
  project: (id) => `/projects/${encodeURIComponent(id)}`,
  purchase_order: (id) => `/purchase-orders/${encodeURIComponent(id)}`,
  payment_stage: () => '/payment-stages',
};
const ENTITY = { company: 'Company', contact: 'Contact', enquiry: 'Enquiry', quotation: 'Quotation', project: 'Project', purchase_order: 'PO', payment_stage: 'Payment stage' };
const TYPE = { call: 'Call', email: 'Email', meeting: 'Meeting', follow_up: 'Follow-up', document: 'Document', other: 'Other' };
const PRIORITY = { high: ['High', 'mg-badge--late'], normal: ['Normal', 'mg-badge--info'], low: ['Low', 'mg-badge--plain'] };
const STATUS = { todo: ['To do', 'mg-badge--plain'], in_progress: ['In progress', 'mg-badge--info'], done: ['Done', 'mg-badge--ok'] };
const WHEN = [
  { value: 'open', label: 'Open' }, { value: 'overdue', label: 'Overdue' }, { value: 'today', label: 'Due today' },
  { value: 'week', label: 'This week' }, { value: 'done', label: 'Done' },
];

function plusDays(n) {
  const d = new Date(); d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);

export default function Tasks() {
  const toast = useToast();
  const lookups = useLookups();
  const [when, setWhen] = useState('open');
  const [who, setWho] = useState('');
  const [dialog, setDialog] = useState(null);   // 'new' | task
  const params = { limit: 500, ...(who ? { assignee: who } : {}) };
  if (when === 'open') params.status = 'todo,in_progress';
  if (when === 'done') params.status = 'done';
  const { data, loading, error, refetch } = useFetch(() => api.list('tasks', params), [when, who]);
  const summary = useFetch(() => api.raw('/tasks/summary'), [when, who]);
  const t0 = today();
  let rows = data?.data ?? [];
  if (when === 'overdue') rows = rows.filter((t) => t.status !== 'done' && t.due_at && t.due_at < t0);
  if (when === 'today') rows = rows.filter((t) => t.status !== 'done' && t.due_at === t0);
  if (when === 'week') rows = rows.filter((t) => t.status !== 'done' && t.due_at && t.due_at >= t0 && t.due_at <= plusDays(7));
  rows = [...rows].sort((a, b) => (a.due_at || '9999').localeCompare(b.due_at || '9999'));
  const ref = useEntrance(Boolean(data));

  async function setStatus(t, status) {
    await api.update('tasks', t.id, { status });
    refetch(); summary.refetch();
  }
  async function toggle(t) {
    const before = t.status;
    const next = before === 'done' ? 'todo' : 'done';
    try {
      await setStatus(t, next);
      if (next === 'done') {
        sonnerToast.success(`Done: ${t.title}`, {
          className: 'toast',
          action: { label: 'Undo', onClick: () => setStatus(t, before).catch((err) => toast(err.message, 'danger')) },
        });
      }
    } catch (err) { toast(err.message, 'danger'); }
  }
  const s = summary.data?.data;
  const overdueOf = (t) => (t.status !== 'done' && t.due_at && t.due_at < t0 ? daysBetween(t.due_at, t0) : 0);
  const onLabel = (t) => `${ENTITY[t.entity] || t.entity} ${t.entity_id}`;

  return (
    <>
      <PageHeader
        title="Tasks"
        subtitle={s ? `${s.open} open · ${s.overdue} overdue · ${s.today} due today · ${s.this_week} this week` : 'Everything to do, across every record'}
        actions={<button type="button" className="mg-btn mg-btn--primary" onClick={() => setDialog('new')}><Plus className="size-4" strokeWidth={2} aria-hidden="true" />New task</button>}
      />
      <div className="app-page" ref={ref}>
        {error ? (
          <FailedCard title="Couldn’t load tasks" text="The server didn’t answer. Your tasks are safe; try again in a moment." onRetry={refetch} />
        ) : loading && !data ? <LoadingPanel /> : (
          <Panel label="Task list">
            <div className="mg-filterbar" style={{ padding: '16px 20px 12px' }}>
              <div className="mg-chiprow flex min-w-0 flex-[1_1_auto] flex-wrap items-center gap-2" role="group" aria-label="Show">
                {WHEN.map((c) => <button key={c.value} type="button" className="mg-chip" aria-pressed={when === c.value} onClick={() => setWhen(c.value)}>{c.label}</button>)}
              </div>
              <FilterSelect label="For" value={who} onChange={setWho} placeholder="Anyone" options={lookups.sales_people} width={170} />
            </div>
            <p className="m-0 px-5 pb-3 text-[12.5px] text-muted-foreground">Tasks are added from any record’s Activity card, or with New task. Tick one to mark it done; click its name to edit it.</p>
            {rows.length ? (
              <ListTable
                label="Tasks"
                rows={rows}
                columns={[
                  { key: 'done', header: '', aria: 'Done', width: 52, render: (t) => <label className="mg-check size-11 justify-center"><input type="checkbox" checked={t.status === 'done'} onChange={() => toggle(t)} aria-label={`Mark done: ${t.title}`} /></label> },
                  { key: 'title', header: 'Task', className: 'app-wrap', render: (t) => <><button type="button" className={`text-left font-bold text-foreground hover:underline ${t.status === 'done' ? 'line-through' : ''}`} onClick={() => setDialog(t)}>{t.title}</button>{t.description && <span className="sub">{t.description}</span>}</> },
                  { key: 'on', header: 'On', className: 'app-wrap--sm', render: (t) => <><Link className="app-ref text-[12.5px]" to={LINK[t.entity]?.(t.entity_id) || '/'} aria-label={`Open ${onLabel(t)}`}>{t.entity_id}</Link><span className="sub">{ENTITY[t.entity] || t.entity}</span></> },
                  { key: 'type', header: 'Type', render: (t) => TYPE[t.type] || t.type },
                  { key: 'due', header: 'Due', className: 'mg-num', render: (t) => (t.due_at
                    ? <span className={overdueOf(t) ? 'font-bold text-late' : ''}>{date(t.due_at)}{overdueOf(t) > 0 && <span className="sub font-semibold text-late">{plural(overdueOf(t), 'day')} overdue</span>}</span>
                    : <span className="text-muted-foreground">—</span>) },
                  { key: 'prio', header: 'Priority', render: (t) => <span className={`mg-badge ${(PRIORITY[t.priority] || PRIORITY.normal)[1]}`}>{(PRIORITY[t.priority] || [t.priority])[0]}</span> },
                  { key: 'for', header: 'For', render: (t) => t.assignee || <span className="text-muted-foreground">Nobody</span> },
                  { key: 'status', header: 'Status', render: (t) => <span className={`mg-badge ${(STATUS[t.status] || STATUS.todo)[1]}`}>{(STATUS[t.status] || [t.status])[0]}</span> },
                ]}
                phone={(t) => (
                  <PhoneRow className="grid-cols-[44px_minmax(0,1fr)_auto] items-start !pl-2"
                    title={<button type="button" className={`text-left font-bold ${t.status === 'done' ? 'line-through' : ''}`} onClick={() => setDialog(t)}>{t.title}</button>} wraps
                    amount={<span className={`text-[12.5px] ${overdueOf(t) ? 'text-late' : ''}`}>{t.due_at ? (overdueOf(t) ? `${plural(overdueOf(t), 'day')} overdue` : date(t.due_at)) : 'No date'}</span>}
                    meta={`${onLabel(t)} · ${TYPE[t.type] || t.type} · ${t.assignee || 'Nobody'}`}
                    state={<span className={`mg-badge ${(PRIORITY[t.priority] || PRIORITY.normal)[1]}`}>{(PRIORITY[t.priority] || [t.priority])[0]}</span>}
                  >
                    <label className="mg-check row-span-2 -mt-2.5 size-11 justify-center" style={{ gridColumn: 1, gridRow: '1 / span 2' }}>
                      <input type="checkbox" checked={t.status === 'done'} onChange={() => toggle(t)} aria-label={`Mark done: ${t.title}`} />
                    </label>
                  </PhoneRow>
                )}
              />
            ) : (
              <StateCard inPanel title={when === 'done' ? 'Nothing done yet' : 'Nothing to do'} text="Tasks added on companies, enquiries, quotations, projects and POs appear here. Add one with New task.">
                <button type="button" className="mg-btn mg-btn--sm" onClick={() => setDialog('new')}>New task</button>
              </StateCard>
            )}
          </Panel>
        )}
      </div>
      {dialog && (
        <TaskDialog
          record={dialog === 'new' ? null : dialog}
          people={lookups.sales_people}
          onClose={() => setDialog(null)}
          onSaved={() => { toast(dialog === 'new' ? 'Task added' : 'Task saved', 'success'); setDialog(null); refetch(); summary.refetch(); }}
        />
      )}
    </>
  );
}
