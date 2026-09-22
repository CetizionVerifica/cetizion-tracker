import { useState } from 'react';
import { PageHeader } from '../App.jsx';
import { Alert, Badge, Card, ConfirmDialog, DataTable, Empty, useToast } from '../components/ui.jsx';
import { RecordForm } from '../components/RecordForm.jsx';
import { api } from '../lib/api.js';
import { invalidateLookups, useFetch } from '../lib/hooks.js';

/**
 * Admin › Templates (#26): the payment schedules and onboarding checklists
 * that "Register the PO" offers. Each template is a header with lines.
 */
export default function Templates() {
  return (
    <>
      <PageHeader title="Templates" subtitle="Payment schedules and onboarding checklists offered when a PO is registered" />
      <div className="page stack">
        <TemplateSet
          kind="payment"
          title="Payment schedules"
          hint="Each line is a payment stage. Percentages must add up to 100. Credit days blank: the PO's payment terms apply."
          resource="payment-terms-templates"
          lineResource="payment-terms-template-lines"
          lineColumns={[
            { key: 'sort_order', header: '#', width: 40 },
            { key: 'stage_name', header: 'Stage', className: 'strong' },
            { key: 'percent', header: '%', align: 'right', render: (l) => `${Number(l.percent)}%` },
            { key: 'trigger_event', header: 'Trigger' },
            { key: 'credit_days', header: 'Credit days', align: 'right', render: (l) => l.credit_days ?? <span className="muted">PO terms</span> },
            { key: 'milestone_name', header: 'Milestone', render: (l) => l.milestone_name || <span className="muted">—</span> },
          ]}
          lineFields={(templateId) => [
            { name: 'template_id', type: 'hidden', default: templateId },
            { name: 'sort_order', label: 'Order', type: 'number', default: 1 },
            { name: 'stage_name', label: 'Stage name', required: true },
            { name: 'percent', label: 'Percent', type: 'number', required: true, step: '0.5' },
            { name: 'trigger_event', label: 'Trigger', type: 'select', options: ['On PO Registration', 'On Delivery', 'On Milestone', 'Manual'], default: 'On PO Registration', required: true },
            { name: 'credit_days', label: 'Credit days', type: 'number', hint: 'Blank: the PO payment terms' },
            { name: 'milestone_name', label: 'Milestone', hint: 'For On Milestone stages: what has to happen' },
          ]}
          lineCheck={(lines) => { const t = lines.reduce((n, l) => n + Number(l.percent), 0); return Math.abs(t - 100) > 0.01 ? `Adds up to ${t}%, not 100%` : null; }}
        />
        <TemplateSet
          kind="onboarding"
          title="Onboarding checklists"
          hint="Each line is a step on the project's checklist. Days after start set the step's target date."
          resource="onboarding-templates"
          lineResource="onboarding-template-lines"
          lineColumns={[
            { key: 'step_no', header: '#', width: 40 },
            { key: 'stage', header: 'Stage' },
            { key: 'step', header: 'Step', className: 'wrap strong' },
            { key: 'owner_role', header: 'Owner' },
            { key: 'days_after_start', header: 'Days after start', align: 'right' },
          ]}
          lineFields={(templateId) => [
            { name: 'template_id', type: 'hidden', default: templateId },
            { name: 'step_no', label: 'Step number', type: 'number', required: true, default: 1 },
            { name: 'stage', label: 'Stage', type: 'select', options: ['Onboarding', 'Execution', 'Delivery', 'Closure'] },
            { name: 'step', label: 'Step', required: true, span: 2 },
            { name: 'owner_role', label: 'Owner role', type: 'select', options: ['Sales', 'Finance', 'Delivery', 'HR', 'Admin'] },
            { name: 'days_after_start', label: 'Days after start', type: 'number' },
          ]}
        />
      </div>
    </>
  );
}

function TemplateSet({ title, hint, resource, lineResource, lineColumns, lineFields, lineCheck }) {
  const toast = useToast();
  const [open, setOpen] = useState(null);
  const [editing, setEditing] = useState(null);       // template record | 'new'
  const [line, setLine] = useState(null);             // { templateId, record | null }
  const [removing, setRemoving] = useState(null);     // { kind: 'template' | 'line', record }
  const [busy, setBusy] = useState(false);
  const templates = useFetch(() => api.list(resource, { limit: 200 }), []);
  const lines = useFetch(() => api.list(lineResource, { limit: 1000 }), []);
  const rows = templates.data?.data ?? [];
  const linesOf = (t) => (lines.data?.data ?? []).filter((l) => l.template_id === t.id);
  const refresh = () => { templates.refetch(); lines.refetch(); invalidateLookups(); };

  async function remove() {
    setBusy(true);
    try {
      await api.remove(removing.kind === 'template' ? resource : lineResource, removing.record.id);
      toast('Removed', 'success'); setRemoving(null); refresh();
    } catch (err) { toast(err.message, 'danger'); }
    finally { setBusy(false); }
  }

  const headerFields = [
    { name: 'name', label: 'Name', required: true, span: 2 },
    { name: 'is_default', label: 'Default', type: 'boolean', default: 'false', hint: 'Offered first when a PO is registered' },
    { name: 'active', label: 'Active', type: 'boolean', default: 'true' },
    { name: 'sort_order', label: 'Order', type: 'number', default: 0 },
  ];

  return (
    <Card flush title={title} hint={hint} actions={<button type="button" className="btn btn--primary btn--sm" onClick={() => setEditing('new')}>+ Template</button>}>
      {rows.length === 0 ? <Empty title="No templates" /> : rows.map((t) => {
        const tl = linesOf(t); const problem = lineCheck ? lineCheck(tl) : null;
        return (
          <div key={t.id} style={{ borderBottom: '1px solid var(--ink-200)' }}>
            <div className="card__head" style={{ borderBottom: 'none', cursor: 'pointer' }} onClick={() => setOpen(open === t.id ? null : t.id)}>
              <div className="card__lead">
                <div className="card__title">{t.name} {t.is_default && <Badge tone="info">default</Badge>} {!t.active && <Badge>inactive</Badge>}</div>
                <div className="card__hint">{tl.length} line{tl.length === 1 ? '' : 's'}{problem && <> · <span style={{ color: 'var(--danger-fg)' }}>{problem}</span></>}</div>
              </div>
              <div className="card__actions" onClick={(e) => e.stopPropagation()}>
                <button type="button" className="btn btn--sm" onClick={() => setLine({ templateId: t.id, record: null })}>+ Line</button>
                <button type="button" className="btn btn--sm btn--ghost" onClick={() => setEditing(t)}>Edit</button>
                <button type="button" className="btn btn--sm btn--ghost" onClick={() => setRemoving({ kind: 'template', record: t })}>✕</button>
                <button type="button" className="btn btn--sm btn--ghost" onClick={() => setOpen(open === t.id ? null : t.id)}>{open === t.id ? 'Hide' : 'Show'}</button>
              </div>
            </div>
            {open === t.id && (
              <DataTable rows={tl} columns={[...lineColumns, { key: 'act', header: '', align: 'right', render: (l) => <div className="table__actions"><button type="button" className="btn btn--sm btn--ghost" onClick={() => setLine({ templateId: t.id, record: l })}>Edit</button><button type="button" className="btn btn--sm btn--ghost" onClick={() => setRemoving({ kind: 'line', record: l })}>✕</button></div> }]} empty={<Empty title="No lines yet" action={<button type="button" className="btn btn--primary" onClick={() => setLine({ templateId: t.id, record: null })}>+ Line</button>} />} />
            )}
          </div>
        );
      })}
      {editing && <RecordForm title={editing === 'new' ? `New ${title.toLowerCase().replace(/s$/, '')} template` : 'Edit template'} resource={resource} fields={headerFields} record={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={refresh} />}
      {line && <RecordForm title={line.record ? 'Edit line' : 'Add line'} resource={lineResource} fields={lineFields(line.templateId)} record={line.record} onClose={() => setLine(null)} onSaved={refresh} />}
      {removing && <ConfirmDialog title={removing.kind === 'template' ? `Delete "${removing.record.name}"?` : 'Delete this line?'} message={removing.kind === 'template' ? 'Its lines go with it. POs already registered from it are not affected.' : 'The template changes for future POs only.'} onConfirm={remove} onClose={() => setRemoving(null)} busy={busy} />}
      {lineCheck && rows.some((t) => lineCheck(linesOf(t))) && <Alert tone="warning"><span>A template whose lines do not add up to 100% cannot be used to register a PO.</span></Alert>}
    </Card>
  );
}
