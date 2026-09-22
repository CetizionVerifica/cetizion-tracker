import { useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader } from '../App.jsx';
import { Badge, Card, DataTable, Empty, Select, useToast } from '../components/ui.jsx';
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

export default function Tasks() {
  const toast = useToast();
  const lookups = useLookups();
  const [when, setWhen] = useState('open');
  const [who, setWho] = useState('');
  const params = { limit: 500, ...(who ? { assignee: who } : {}) };
  if (when === 'open') params.status = 'todo,in_progress';
  if (when === 'done') params.status = 'done';
  const { data, loading, refetch } = useFetch(() => api.list('tasks', params), [when, who]);
  const summary = useFetch(() => api.raw('/tasks/summary'), [when, who]);
  let rows = data?.data ?? [];
  if (when === 'overdue') rows = rows.filter((t) => t.status !== 'done' && t.due_at && t.due_at < today());
  if (when === 'today') rows = rows.filter((t) => t.status !== 'done' && t.due_at === today());
  if (when === 'week') rows = rows.filter((t) => t.status !== 'done' && t.due_at && t.due_at >= today() && t.due_at <= plusDays(7));
  rows = [...rows].sort((a, b) => (a.due_at || '9999').localeCompare(b.due_at || '9999'));

  async function toggle(t) {
    try { await api.update('tasks', t.id, { status: t.status === 'done' ? 'todo' : 'done' }); refetch(); summary.refetch(); }
    catch (err) { toast(err.message, 'danger'); }
  }
  const s = summary.data?.data;

  return (
    <>
      <PageHeader title="Tasks" subtitle={s ? `${s.open} open · ${s.overdue} overdue · ${s.today} due today · ${s.this_week} this week` : 'Everything to do, across every record'} actions={
        <>
          <Select value={when} placeholder={null} options={[{ value: 'open', label: 'Open' }, { value: 'overdue', label: 'Overdue' }, { value: 'today', label: 'Due today' }, { value: 'week', label: 'This week' }, { value: 'done', label: 'Done' }]} onChange={(e) => setWhen(e.target.value)} />
          <Select value={who} placeholder="Anyone" options={lookups.sales_people} onChange={(e) => setWho(e.target.value)} />
        </>
      } />
      <div className="page stack">
        <Card flush hint="Tasks are added from any record's Activity card. Tick one to mark it done.">
          <DataTable
            rows={rows}
            loading={loading && !data}
            columns={[
              { key: 'done', header: '', width: 36, render: (t) => <input type="checkbox" checked={t.status === 'done'} onChange={() => toggle(t)} /> },
              { key: 'title', header: 'Task', className: 'strong wrap', render: (t) => <>{t.title}{t.description && <div className="small muted">{t.description}</div>}</> },
              { key: 'entity', header: 'On', render: (t) => <Link className="mono small" to={LINK[t.entity]?.(t.entity_id) || '/'}>{t.entity.replace('_', ' ')} {t.entity_id}</Link> },
              { key: 'type', header: 'Type', render: (t) => t.type.replace('_', ' ') },
              { key: 'due_at', header: 'Due', render: (t) => t.due_at ? <span style={{ color: t.status !== 'done' && t.due_at < today() ? 'var(--danger-fg)' : undefined }}>{date(t.due_at)}</span> : <span className="muted">—</span> },
              { key: 'priority', header: 'Priority', render: (t) => <Badge tone={t.priority === 'high' ? 'danger' : t.priority === 'low' ? 'neutral' : 'info'}>{t.priority}</Badge> },
              { key: 'assignee', header: 'For', render: (t) => t.assignee || <span className="muted">—</span> },
              { key: 'status', header: 'Status', render: (t) => <Badge tone={t.status === 'done' ? 'success' : t.status === 'in_progress' ? 'info' : 'neutral'}>{t.status.replace('_', ' ')}</Badge> },
            ]}
            empty={<Empty title="Nothing to do" text="Tasks added on companies, enquiries, quotations, projects and POs appear here." />}
          />
        </Card>
      </div>
    </>
  );
}

function plusDays(n) {
  const d = new Date(); d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
