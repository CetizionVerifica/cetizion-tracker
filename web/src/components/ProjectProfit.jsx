import { useState } from 'react';
import { ExternalLink, Lock, Pencil, Plus, Trash2 } from 'lucide-react';
import { ConfirmDialog, useToast } from './ui.jsx';
import { RecordForm } from './RecordForm.jsx';
import { ListTable, PanelSkeleton, PhoneRow, StateCard } from './daily.jsx';
import { Sec, Tone } from './sales.jsx';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { mayDeleteResource, mayWriteResource } from '../lib/permissions.js';
import { useFetch, useLookups } from '../lib/hooks.js';
import { date, money } from '../lib/format.js';

/**
 * A project's margin (#39): revenue against paid and committed cost, the
 * lines behind it, and manual costs with their documents. Drawn as two
 * sections of the project's "Margin and costs" tab (never glass inside
 * glass). The figures are the admin's unless Settings opens them to sales:
 * a refusal says so rather than loading for ever.
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
const TONE_OF = { danger: 'late', warning: 'wait', success: 'ok' };

export function ProjectProfit({ projectId, onChanged }) {
  const toast = useToast();
  const lookups = useLookups();
  // A manual cost moves the margin this tab is about, so project-costs is
  // adminOnlyWrites on the server (#85) — and adminOnlyWrites implies the
  // delete. When the figures are open to sales, they read them only.
  const { isAdmin } = useAuth();
  const mayWriteCost = mayWriteResource('project-costs', isAdmin);
  const mayDeleteCost = mayDeleteResource('project-costs', isAdmin);
  const { data, error, errorStatus, refetch } = useFetch(() => api.raw(`/profitability/projects/${encodeURIComponent(projectId)}`), [projectId]);
  const [form, setForm] = useState(null);
  const [removing, setRemoving] = useState(null);
  const [busy, setBusy] = useState(false);
  const p = data?.data;

  if (errorStatus === 403) {
    return (
      <StateCard inPanel bordered={false} tone="plain" icon={Lock} title="Margins are for admins"
        text="Delivery cost against the PO value is what the business earns, so an admin sees it. The money owed and billed is in the figures above." />
    );
  }
  if (error) {
    return (
      <StateCard inPanel bordered={false} tone="late" role="alert" title="Couldn’t load the margin" text={error}>
        <button type="button" className="mg-btn mg-btn--sm" onClick={refetch}>Try again</button>
      </StateCard>
    );
  }
  if (!p) return <PanelSkeleton rows={3} />;

  const fields = [
    { name: 'project_id', type: 'hidden', default: projectId },
    { name: 'category', label: 'Category', type: 'select', options: COST_CATEGORIES, required: true, default: 'subcontractor' },
    { name: 'description', label: 'What', required: true },
    { name: 'vendor', label: 'Paid to' },
    { name: 'amount', label: 'Amount', type: 'money', hint: 'Leave blank if not known yet; it shows as a gap' },
    { name: 'currency', label: 'Currency', type: 'select', options: ['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD'], default: 'INR' },
    { name: 'incurred_on', label: 'Date', type: 'date' },
    { name: 'status', label: 'Status', type: 'select', options: [{ value: 'committed', label: 'Committed, not paid' }, { value: 'paid', label: 'Paid' }], default: 'committed' },
    { name: 'document_id', label: 'Bill or invoice', type: 'document', maxBytes: lookups.limits?.document_max_bytes, span: 'all' },
  ];

  async function remove() {
    setBusy(true);
    try {
      await api.remove('project-costs', removing.id);
      toast('Cost removed', 'success');
      setRemoving(null);
      refetch();
      onChanged?.();
    } catch (err) {
      toast(err.message, 'danger');
    } finally {
      setBusy(false);
    }
  }

  const tone = TONE_OF[marginTone(p.margin_percent == null ? null : Number(p.margin_percent), p.margin_alert_percent)];
  const gaps = Number(p.cost_gaps || 0) + Number(p.revenue_gaps || 0);
  const facts = [
    ['Revenue (PO value)', money(p.revenue)],
    ['Invoiced / received', `${money(p.invoiced)} / ${money(p.received)}`],
    ['Cost paid', money(p.cost_paid)],
    ['Cost committed', money(p.cost_committed)],
    ['Margin', <strong key="m">{money(p.margin)}</strong>],
    ['Margin %', p.margin_percent == null ? '—' : <Tone key="p" tone={tone}>{p.margin_percent}%</Tone>],
    ['Planned cost', p.estimated_cost == null ? 'Not set (edit the project)' : `${money(p.estimated_cost)} · ${Number(p.cost_variance) > 0 ? `${money(p.cost_variance)} over` : `${money(-p.cost_variance)} under`}`],
    ['Gaps', gaps > 0 ? <Tone key="g" tone="wait">{gaps === 1 ? '1 missing amount' : `${gaps} missing amounts or rates`}</Tone> : 'None'],
  ];
  const what = (r) => (r.kind === 'manual'
    ? r.description
    : r.ref);
  const meta = (r) => (r.kind === 'manual'
    ? [COST_CATEGORIES.find((c) => c.value === r.category)?.label, r.vendor, r.incurred_on && date(r.incurred_on)].filter(Boolean).join(' · ')
    : [`Trip ${r.travel_id}`, r.kind === 'expense_claim' ? `${r.expense_category || 'claim'} · ${r.approval_status}` : r.destination, r.vendor, r.incurred_on && date(r.incurred_on)].filter(Boolean).join(' · '));
  const amount = (r) => (r.gap ? <Tone tone="wait">{r.gap}</Tone> : money(r.amount, r.currency || 'INR'));
  const paid = (r) => (r.kind === 'manual' ? (r.status === 'paid' ? 'paid' : 'committed, not paid') : `${money(r.amount_paid)} paid`);
  const acts = (r) => (
    <span className="app-rowacts">
      {r.document_id && <a className="mg-iconbtn" href={api.documentUrl(r.document_id)} target="_blank" rel="noopener noreferrer" aria-label={`Open the bill for ${what(r)}`} title="Open the file"><ExternalLink strokeWidth={1.8} aria-hidden="true" /></a>}
      {r.kind === 'manual' && mayWriteCost && <button type="button" className="mg-iconbtn" aria-label={`Edit cost ${what(r)}`} title="Edit" onClick={() => setForm(r)}><Pencil strokeWidth={1.8} aria-hidden="true" /></button>}
      {r.kind === 'manual' && mayDeleteCost && <button type="button" className="mg-iconbtn" aria-label={`Remove cost ${what(r)}`} title="Remove" onClick={() => setRemoving(r)}><Trash2 strokeWidth={1.8} aria-hidden="true" /></button>}
    </span>
  );

  return (
    <>
      <Sec id="prj-margin" title="Margin" hint="PO value against delivery cost, in INR. Committed cost is billed or claimed but not yet paid.">
        <dl className="app-kv">
          {facts.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
        </dl>
      </Sec>
      <Sec id="prj-costs" title="Costs" hint="Travel vendor bills and expense claims on this project's trips, and costs added here."
        tools={mayWriteCost ? <button type="button" className="mg-btn mg-btn--sm" onClick={() => setForm('new')}><Plus className="size-4" strokeWidth={2} aria-hidden="true" />Add a cost</button> : null}>
        <div className="app-box app-box--flush">
          {p.lines.length === 0 ? (
            <p className="app-panel__note" style={{ borderTop: 0 }}>No costs recorded yet. Travel on this project's trips and claims show here by themselves.</p>
          ) : (
            <ListTable
              label="Costs"
              bordered={false}
              rows={p.lines}
              rowKey={(r, i) => `${r.kind}-${r.id ?? i}`}
              rowClassName={(r) => (r.gap ? 'app-gaprow' : undefined)}
              columns={[
                { key: 'kind', header: 'Source', render: (r) => <Tone>{KIND[r.kind]}</Tone> },
                { key: 'what', header: 'What', className: 'app-wrap', render: (r) => <><b>{what(r)}</b><span className="sub">{meta(r)}</span></> },
                { key: 'amount', header: 'Amount', num: true, render: (r) => <>{amount(r)}<span className="sub">{paid(r)}</span></> },
                { key: 'act', header: '', className: 'actions', render: acts },
              ]}
              phone={(r) => <PhoneRow title={what(r)} amount={amount(r)} meta={`${KIND[r.kind]} · ${meta(r)}`} state={<span className="text-[12px] text-muted-foreground">{paid(r)}</span>} />}
            />
          )}
        </div>
      </Sec>
      {form && <RecordForm title={form === 'new' ? 'Add a cost' : 'Edit cost'} subtitle={form === 'new' ? `For ${projectId} · admins only` : form.description} submitLabel={form === 'new' ? 'Add cost' : undefined} resource="project-costs" fields={fields} record={form === 'new' ? null : { ...form, document_name: form.file_name }} onClose={() => setForm(null)} onSaved={() => { setForm(null); refetch(); onChanged?.(); }} />}
      {removing && (
        <ConfirmDialog
          title="Remove this cost?"
          message={`${removing.description}${removing.amount != null ? ` · ${money(removing.amount, removing.currency || 'INR')}` : ''}. This cannot be undone; the margin goes up until another cost replaces it.`}
          confirmLabel="Remove cost"
          busy={busy}
          onConfirm={remove}
          onClose={() => setRemoving(null)}
        />
      )}
    </>
  );
}
