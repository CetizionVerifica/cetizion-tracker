import { useState } from 'react';
import { Badge, Card, ConfirmDialog, DataTable, KeyValues, useToast } from './ui.jsx';
import { RecordForm } from './RecordForm.jsx';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { mayDeleteResource, mayWriteResource } from '../lib/permissions.js';
import { useFetch, useLookups } from '../lib/hooks.js';
import { date, money } from '../lib/format.js';

/**
 * A project's margin (#39): revenue against paid and committed cost, the
 * lines behind it, and manual costs with their documents.
 */
export const COST_CATEGORIES = [
  { value: 'subcontractor', label: 'Subcontractor' }, { value: 'auditor_fee', label: 'External auditor' },
  { value: 'certification_body', label: 'Certification body' }, { value: 'lab_testing', label: 'Lab testing' },
  { value: 'travel', label: 'Travel (other)' }, { value: 'accommodation', label: 'Accommodation' },
  { value: 'materials', label: 'Materials' }, { value: 'other', label: 'Other' },
];
const KIND = { travel_vendor: 'Travel vendor', expense_claim: 'Expense claim', manual: 'Cost' };

export function marginTone(pct, alert = 20) {
  if (pct == null) return '';
  return pct < 0 ? 'danger' : pct < alert ? 'warning' : 'success';
}

export function ProjectProfit({ projectId, onChanged }) {
  const toast = useToast();
  const lookups = useLookups();
  // A manual cost moves the margin this card is about, so project-costs is
  // adminOnlyWrites on the server (#85) — and adminOnlyWrites implies the
  // delete. The figures and the lines behind them stay readable to everyone;
  // only the three controls that change them are the admin's.
  const { isAdmin } = useAuth();
  const mayWriteCost = mayWriteResource('project-costs', isAdmin);
  const mayDeleteCost = mayDeleteResource('project-costs', isAdmin);
  const { data, refetch } = useFetch(() => api.raw(`/profitability/projects/${encodeURIComponent(projectId)}`), [projectId]);
  const [form, setForm] = useState(null);
  const [removing, setRemoving] = useState(null);
  const p = data?.data;
  if (!p) return <Card title="Margin"><div className="skeleton h-[80px]" /></Card>;

  const fields = [
    { name: 'project_id', type: 'hidden', default: projectId },
    { name: 'category', label: 'Category', type: 'select', options: COST_CATEGORIES, required: true, default: 'subcontractor' },
    { name: 'description', label: 'What', required: true, span: 2 },
    { name: 'vendor', label: 'Paid to' },
    { name: 'amount', label: 'Amount', type: 'number', hint: 'Leave blank if not known yet; it shows as a gap' },
    { name: 'currency', label: 'Currency', type: 'select', options: ['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD'], default: 'INR' },
    { name: 'incurred_on', label: 'Date', type: 'date' },
    { name: 'status', label: 'Status', type: 'select', options: [{ value: 'committed', label: 'Committed, not paid' }, { value: 'paid', label: 'Paid' }], default: 'committed' },
    { name: 'document_id', label: 'Bill or invoice', type: 'document', maxBytes: lookups.limits?.document_max_bytes, span: 'all' },
  ];

  async function remove() {
    try { await api.remove('project-costs', removing.id); setRemoving(null); refetch(); onChanged?.(); }
    catch (err) { toast(err.message, 'danger'); }
  }

  return (
    <>
      <Card title="Margin" hint="PO value against delivery cost, in INR. Committed cost is billed or claimed but not yet paid.">
        <KeyValues items={[
          { label: 'Revenue (PO value)', value: money(p.revenue) },
          { label: 'Invoiced / received', value: `${money(p.invoiced)} / ${money(p.received)}` },
          { label: 'Cost paid', value: money(p.cost_paid) },
          { label: 'Cost committed', value: money(p.cost_committed) },
          { label: 'Margin', value: <span className="strong">{money(p.margin)}</span> },
          { label: 'Margin %', value: p.margin_percent == null ? '—' : <Badge tone={marginTone(Number(p.margin_percent), p.margin_alert_percent)}>{p.margin_percent}%</Badge> },
          { label: 'Planned cost', value: p.estimated_cost == null ? 'not set (edit the project)' : `${money(p.estimated_cost)} · ${Number(p.cost_variance) > 0 ? `${money(p.cost_variance)} over` : `${money(-p.cost_variance)} under`}` },
          { label: 'Gaps', value: p.cost_gaps + p.revenue_gaps > 0 ? <Badge tone="warning">{p.cost_gaps + p.revenue_gaps} missing amount or rate</Badge> : 'none' },
        ]} />
      </Card>
      <Card flush title="Costs" hint="Travel vendor bills and expense claims on this project's trips, and costs added here." actions={mayWriteCost ? <button type="button" className="btn btn--sm" onClick={() => setForm('new')}>Add a cost</button> : null}>
        <DataTable rows={p.lines} rowClassName={(r) => (r.gap ? 'tr--dup' : '')} empty={<div className="small muted" style={{ padding: '12px 18px' }}>No costs recorded yet.</div>} columns={[
          { key: 'kind', header: 'Source', render: (r) => <Badge>{KIND[r.kind]}</Badge> },
          { key: 'what', header: 'What', className: 'wrap', render: (r) => (r.kind === 'manual' ? <>{r.description}<div className="small muted">{COST_CATEGORIES.find((c) => c.value === r.category)?.label}</div></> : <>{r.ref}<div className="small muted">{r.kind === 'expense_claim' ? `${r.expense_category || 'claim'} · ${r.approval_status}` : r.destination} · trip {r.travel_id}</div></>) },
          { key: 'vendor', header: 'Paid to' },
          { key: 'incurred_on', header: 'Date', render: (r) => date(r.incurred_on) },
          { key: 'amount', header: 'Amount', align: 'right', render: (r) => (r.gap ? <Badge tone="warning">{r.gap}</Badge> : money(r.amount, r.currency || 'INR')) },
          { key: 'state', header: 'Paid', align: 'right', render: (r) => (r.kind === 'manual' ? (r.status === 'paid' ? 'paid' : 'committed') : money(r.amount_paid)) },
          { key: 'file', header: '', render: (r) => (r.document_id ? <a className="btn btn--sm btn--ghost" href={api.documentUrl(r.document_id)} target="_blank" rel="noopener noreferrer">File</a> : null) },
          { key: 'act', header: '', align: 'right', render: (r) => r.kind === 'manual' && <div className="table__actions">{mayWriteCost && <button type="button" className="btn btn--sm btn--ghost" onClick={() => setForm(r)}>Edit</button>}{mayDeleteCost && <button type="button" className="btn btn--sm btn--ghost" onClick={() => setRemoving(r)}>✕</button>}</div> },
        ]} />
      </Card>
      {form && <RecordForm title={form === 'new' ? 'Add a cost' : 'Edit cost'} resource="project-costs" fields={fields} record={form === 'new' ? null : { ...form, document_name: form.file_name }} onClose={() => setForm(null)} onSaved={() => { setForm(null); refetch(); onChanged?.(); }} />}
      {removing && <ConfirmDialog title="Remove this cost?" message={removing.description} onConfirm={remove} onClose={() => setRemoving(null)} />}
    </>
  );
}
