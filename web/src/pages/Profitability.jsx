import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '../App.jsx';
import { Badge, Card, DataTable, Empty, Input, Select, Stat } from '../components/ui.jsx';
import { marginTone } from '../components/ProjectProfit.jsx';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/hooks.js';
import { money } from '../lib/format.js';

/**
 * Profitability report (#39): margin by project, client, service line,
 * sector or owner, for POs received in a period.
 */
const GROUPS = [{ value: 'project', label: 'By project' }, { value: 'service', label: 'By service line' }, { value: 'client', label: 'By client' }, { value: 'sector', label: 'By sector' }, { value: 'owner', label: 'By sales owner' }];

export default function Profitability() {
  const navigate = useNavigate();
  const [group, setGroup] = useState('service');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const qs = new URLSearchParams({ group, ...(from ? { from } : {}), ...(to ? { to } : {}) }).toString();
  const { data, loading } = useFetch(() => api.raw(`/profitability?${qs}`), [qs]);
  const rows = data?.data ?? [];
  const sum = (k) => rows.reduce((t, r) => t + Number(r[k] || 0), 0);
  const revenue = sum('revenue'); const margin = sum('margin');
  const gaps = rows.reduce((t, r) => t + Number(r.gaps ?? (Number(r.cost_gaps || 0) + Number(r.revenue_gaps || 0))), 0);

  const cols = group === 'project' ? [
    { key: 'project_id', header: 'Project', className: 'mono strong' },
    { key: 'client_name', header: 'Client', render: (r) => <>{r.client_name}<div className="small muted">{r.primary_service}</div></> },
    { key: 'revenue', header: 'Revenue', align: 'right', render: (r) => money(r.revenue) },
    { key: 'cost_paid', header: 'Paid cost', align: 'right', render: (r) => money(r.cost_paid) },
    { key: 'cost_committed', header: 'Committed', align: 'right', render: (r) => money(r.cost_committed) },
    { key: 'margin', header: 'Margin', align: 'right', className: 'strong', render: (r) => money(r.margin) },
    { key: 'margin_percent', header: 'Margin %', align: 'right', render: (r) => (r.margin_percent == null ? '—' : <Badge tone={marginTone(Number(r.margin_percent))}>{r.margin_percent}%</Badge>) },
    { key: 'estimated_cost', header: 'Planned vs actual', align: 'right', render: (r) => (r.estimated_cost == null ? '—' : `${money(r.estimated_cost)} → ${money(r.total_cost)}`) },
    { key: 'gaps', header: '', render: (r) => (r.cost_gaps + r.revenue_gaps > 0 ? <Badge tone="warning">{r.cost_gaps + r.revenue_gaps} gaps</Badge> : null) },
  ] : [
    { key: 'name', header: GROUPS.find((g) => g.value === group).label.replace('By ', ''), className: 'strong' },
    { key: 'projects', header: 'Projects', align: 'right' },
    { key: 'revenue', header: 'Revenue', align: 'right', render: (r) => money(r.revenue) },
    { key: 'total_cost', header: 'Cost', align: 'right', render: (r) => money(r.total_cost) },
    { key: 'margin', header: 'Margin', align: 'right', className: 'strong', render: (r) => money(r.margin) },
    { key: 'margin_percent', header: 'Margin %', align: 'right', render: (r) => (r.margin_percent == null ? '—' : <Badge tone={marginTone(Number(r.margin_percent))}>{r.margin_percent}%</Badge>) },
    { key: 'average_margin_percent', header: 'Avg per project', align: 'right', render: (r) => (r.average_margin_percent == null ? '—' : `${r.average_margin_percent}%`) },
    { key: 'planned', header: 'Planned vs actual', align: 'right', render: (r) => (r.estimated_cost == null ? '—' : `${money(r.estimated_cost)} → ${money(r.actual_cost_where_estimated)}`) },
    { key: 'gaps', header: '', render: (r) => (r.gaps > 0 ? <Badge tone="warning">{r.gaps} gaps</Badge> : null) },
  ];

  return (
    <>
      <PageHeader title="Profitability" subtitle="Margin on delivered work: PO value against travel, claims and other delivery costs, in INR. Periods follow the PO date."
        actions={<>
          <Select value={group} placeholder={null} options={GROUPS} onChange={(e) => setGroup(e.target.value)} />
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} title="POs from" />
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} title="POs to" />
        </>} />
      <div className="page stack">
        <div className="auto-grid--stats">
          <Stat label="Revenue" value={money(revenue)} />
          <Stat label="Cost" value={money(sum('total_cost'))} meta={`${money(sum('cost_committed'))} committed`} />
          <Stat label="Margin" value={money(margin)} meta={revenue > 0 ? `${((100 * margin) / revenue).toFixed(1)}%` : ''} tone={margin < 0 ? 'danger' : ''} />
          <Stat label="Gaps" value={gaps} meta="costs or POs with no amount or rate, left out" tone={gaps ? 'danger' : ''} />
        </div>
        <Card flush>
          <DataTable
            loading={loading && !data}
            rows={rows}
            columns={cols}
            onRowClick={group === 'project' ? (r) => navigate(`/projects/${r.project_id}`) : undefined}
            empty={<Empty title="Nothing delivered in this period" text="Margin is counted when a project is delivered. Widen the dates, or group by something else." />}
          />
        </Card>
      </div>
    </>
  );
}
