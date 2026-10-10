import { useNavigate } from 'react-router-dom';
import { marginTone } from '../components/ProjectProfit.jsx';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/hooks.js';
import { ListPage } from '../components/ListPage.jsx';
import { Badge, Progress } from '../components/ui.jsx';
import { invalidateLookups, useLookups } from '../lib/hooks.js';
import { money, date, number } from '../lib/format.js';

const projectAmount = (row, value) =>
  (row.po_count > 0 && !row.currency
    ? <span className="muted" title="This project's purchase orders use more than one currency">—</span>
    : money(value, row.currency || 'INR'));

export default function Projects() {
  const navigate = useNavigate();
  const lookups = useLookups();
  const profit = useFetch(() => api.raw('/profitability'));
  const margins = Object.fromEntries((profit.data?.data ?? []).map((p) => [p.project_id, p]));

  const columns = [
    { key: 'project_id', header: 'Project', className: 'mono strong' },
    { key: 'client_name', header: 'Client', className: 'strong', render: (r) => <>{r.client_name}<div className="small muted">{r.primary_service}</div></> },
    { key: 'project_manager', header: 'Manager' },
    { key: 'po_count', header: 'POs', align: 'right', render: (r) => number(r.po_count) },
    // r.currency is null when the project's POs use more than one, and a sum
    // across currencies means nothing — so show a dash, not a rupee figure.
    { key: 'total_contract_value', header: 'Contract', align: 'right', render: (r) => projectAmount(r, r.total_contract_value) },
    { key: 'total_received', header: 'Received', align: 'right', render: (r) => projectAmount(r, r.total_received) },
    { key: 'balance_due_now', header: 'Due now', align: 'right', className: 'strong', render: (r) => projectAmount(r, r.balance_due_now) },
    { key: 'balance_to_bill', header: 'To bill', align: 'right', render: (r) => (r.balance_to_bill > 0 ? projectAmount(r, r.balance_to_bill) : <span className="muted">—</span>) },
    { key: 'margin', header: 'Margin', align: 'right', render: (r) => { const m = margins[r.project_id]; return m?.margin_percent == null ? <span className="muted">—</span> : <span title={`Margin ${m.margin} · cost ${m.total_cost}`}><Badge tone={marginTone(Number(m.margin_percent))}>{m.margin_percent}%</Badge>{m.low_margin && ' ⚑'}</span>; } },
    { key: 'onboarding_percent', header: 'Onboarding', width: 130, render: (r) => (r.onboarding_total ? <Progress value={r.onboarding_percent} /> : <span className="muted">—</span>) },
    { key: 'project_stage', header: 'Stage', render: (r) => <Badge>{r.project_stage}</Badge> },
    { key: 'payment_status', header: 'Payment', render: (r) => <Badge>{r.payment_status}</Badge> },
    { key: 'planned_delivery_date', header: 'Planned delivery', render: (r) => date(r.planned_delivery_date) },
  ];

  const fields = [
    { name: 'project_id', label: 'Project ID', auto: 'project' },
    { name: 'client_name', label: 'Client', required: true, type: 'combo', options: lookups.clients },
    { name: 'primary_service', label: 'Primary service', type: 'combo', options: lookups.services, span: 2 },
    { name: 'project_manager', label: 'Project manager' },
    { name: 'project_manager_email', label: 'Manager email', type: 'email' },
    { name: 'sales_person', label: 'Sales person', type: 'combo', options: lookups.sales_people },
    {
      name: 'quotation_no',
      label: 'Won quotation',
      type: 'select',
      // Only quotations that are won and not already registered elsewhere.
      options: (lookups.unregistered_quotations || []).map((q) => ({
        value: q.quotation_no, label: `${q.quotation_no} — ${q.client_name}`,
      })),
      hint: 'Registers this project against that quotation, the same as "Register" does from the Quotations page. Leave blank to change nothing',
      span: 2,
    },
    { name: 'planned_start_date', label: 'Planned start', type: 'date' },
    { name: 'planned_delivery_date', label: 'Planned delivery', type: 'date' },
    { name: 'service_request_no', label: 'Service request no.', hint: 'e.g. CV108: how a trip with no PO finds this project' },
    { name: 'percent_complete', label: '% complete', type: 'percent', hint: '0–100' },
    { name: 'estimated_cost', label: 'Planned cost', type: 'money', hint: 'Delivery cost expected, for planned against actual' },
    { name: 'remarks', label: 'Remarks', type: 'textarea', span: 'all' },
  ];

  return (
    <ListPage
      title="Projects"
      subtitle="Every registered project, with its POs, stages and money rolled up"
      resource="projects"
      columns={columns}
      fields={fields}
      newLabel="Project"
      formTitle="project"
      searchPlaceholder="Search project, client, manager…"
      onRowClick={(row) => navigate(`/projects/${row.project_id}`)}
      // Saving can register a won quotation, which takes it off the list the
      // form offers — the lookups are cached for the session until cleared.
      onSaved={() => invalidateLookups()}
      filters={[
        { name: 'project_stage', label: 'Stage', options: ['Not Started', 'Onboarding', 'In Progress', 'Delivered'] },
        { name: 'payment_status', label: 'Payment', options: ['Overdue', 'Invoicing pending', 'No stages', 'Pending', 'Up to date', 'Fully Paid'] },
        { name: 'sales_person', label: 'Sales person', options: [{ value: '__none__', label: 'Not set' }, ...lookups.sales_people] },
      ]}
    />
  );
}
