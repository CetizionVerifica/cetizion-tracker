import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { PageHeader } from '../App.jsx';
import { FolderKanban } from 'lucide-react';
import { RecordPage, RecordStat } from '../components/record.jsx';
import {
  Card, Stat, Badge, DataTable, KeyValues, Progress, Tabs,
  ErrorState, Empty, useToast, Alert, ConfirmDialog,
} from '../components/ui.jsx';
import { RecordInvoiceDialog, RecordPaymentDialog } from '../components/actions.jsx';
import { RecordForm } from '../components/RecordForm.jsx';
import { Timeline } from '../components/Timeline.jsx';
import { ProjectProfit } from '../components/ProjectProfit.jsx';
import { ProjectVisits } from './Schedule.jsx';
import { DeliverablesTable } from '../components/Deliverables.jsx';
import { api } from '../lib/api.js';
import { useFetch, useLookups } from '../lib/hooks.js';
import { money, date, percent, number } from '../lib/format.js';

const MENU_ITEM = 'rounded-[6px] px-2.5 py-1.5 text-left text-[13px] text-secondary-text hover:bg-accent hover:text-foreground';

export default function ProjectDetail() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const lookups = useLookups();
  const [tab, setTab] = useState('pos');
  const [dialog, setDialog] = useState(null);
  const [busy, setBusy] = useState(false);

  const { data, loading, error, refetch } = useFetch(
    () => api.raw(`/projects/${encodeURIComponent(projectId)}/full`),
    [projectId]
  );

  if (error) {
    return (
      <>
        <PageHeader title={projectId} />
        <div className="page"><ErrorState message={error} onRetry={refetch} /></div>
      </>
    );
  }
  if (loading || !data) {
    return (
      <>
        <PageHeader title={projectId} />
        <div className="page"><div className="skeleton" style={{ height: 200 }} /></div>
      </>
    );
  }

  const { project: p, purchase_orders: pos, payment_stages: stages, onboarding, travel, quotations } = data.data;
  // One currency across every PO on the project, or null when they differ.
  const mixed = p.po_count > 0 && !p.currency;
  const amount = (v) => (mixed ? '—' : money(v, p.currency || 'INR'));

  const close = () => setDialog(null);
  const done = () => { close(); refetch(); };

  async function applyTemplate() {
    setBusy(true);
    try {
      const result = await api.action(`/projects/${encodeURIComponent(projectId)}/onboarding/apply-template`, {
        owner: p.project_manager,
        owner_email: p.project_manager_email,
      });
      toast(result.added ? `Added ${result.added} steps` : 'Checklist already applied', result.added ? 'success' : 'default');
      refetch();
    } catch (err) {
      toast(err.message, 'danger');
    } finally {
      setBusy(false);
    }
  }

  async function toggleStep(step) {
    const next = step.status === 'Done' ? 'Not Started' : 'Done';
    try {
      await api.update('onboarding', step.id, {
        status: next,
        completed_date: next === 'Done' ? new Date().toISOString().slice(0, 10) : null,
      });
      refetch();
    } catch (err) {
      toast(err.message, 'danger');
    }
  }

  async function deleteStep(step) {
    setBusy(true);
    try {
      await api.remove('onboarding', step.id);
      toast('Step removed', 'success');
      done();
    } catch (err) {
      toast(err.message, 'danger');
    } finally {
      setBusy(false);
    }
  }

  // Swap step numbers with the neighbour so the order is a stored fact,
  // not a display trick. Two small updates, then one refetch.
  async function moveStep(step, direction) {
    const index = onboarding.findIndex((s) => s.id === step.id);
    const other = onboarding[index + direction];
    if (!other) return;
    try {
      await api.update('onboarding', step.id, { step_no: other.step_no });
      await api.update('onboarding', other.id, { step_no: step.step_no });
      refetch();
    } catch (err) {
      toast(err.message, 'danger');
    }
  }

  const stageOptions = Array.from(
    new Set(['Onboarding', 'Execution', 'Delivery', 'Closure', ...onboarding.map((s) => s.stage).filter(Boolean)])
  );
  const nextStepNo = onboarding.reduce((max, s) => Math.max(max, Number(s.step_no) || 0), 0) + 1;
  const stepFields = [
    { name: 'project_id', label: 'Project', required: true, disabled: true },
    { name: 'step_no', label: 'Step number', type: 'number', min: 1, required: true },
    { name: 'stage', label: 'Stage', type: 'combo', options: stageOptions },
    { name: 'status', label: 'Status', type: 'select', options: lookups.enums?.onboarding || ['Not Started', 'In Progress', 'Done', 'N/A'] },
    { name: 'step', label: 'Step', required: true, type: 'textarea', rows: 2, span: 'all' },
    { name: 'owner', label: 'Owner' },
    { name: 'owner_email', label: 'Owner email', type: 'email' },
    { name: 'target_date', label: 'Target date', type: 'date' },
    { name: 'completed_date', label: 'Completed on', type: 'date' },
    { name: 'remarks', label: 'Remarks', type: 'textarea', span: 'all' },
  ];

  return (
    <>
      <RecordPage
        parent="Projects"
        parentTo="/projects"
        title={`${p.project_id} · ${p.client_name}`}
        mark={<FolderKanban className="size-5" strokeWidth={1.75} aria-hidden="true" />}
        facts={[
          p.primary_service,
          p.project_manager && `PM ${p.project_manager}`,
          p.sales_person && `Sold by ${p.sales_person}`,
          p.planned_delivery_date && `Due ${date(p.planned_delivery_date)}`,
        ]}
        action={
          /* The project manager's one button is the delivery date, because
             it is the only fact on this page that nothing else can tell us
             — everything else follows from a PO, a stage or a trip. */
          p.actual_delivery_date
            ? <button type="button" className="btn" onClick={() => setDialog({ type: 'edit' })}>Edit project</button>
            : <button type="button" className="btn btn--primary" onClick={() => setDialog({ type: 'edit' })}>Record delivery</button>
        }
        menu={
          <>
            <button type="button" className={MENU_ITEM} onClick={() => setDialog({ type: 'newPo' })}>Add a purchase order</button>
            <button type="button" className={MENU_ITEM} onClick={() => setDialog({ type: 'edit' })}>Edit the project</button>
          </>
        }
        stats={
          <>
            {/* Sums across the project's POs, so they only read in one
                currency. v_projects gives it, or null when the POs disagree
                — then the amount is withheld rather than shown with the
                wrong symbol, and the PO table below shows each properly. */}
            <RecordStat
              label="Money on this project"
              value={amount(p.total_contract_value)}
              detail={mixed ? 'POs in different currencies' : `${amount(p.total_invoiced)} invoiced · ${amount(p.total_received)} received`}
            />
            <RecordStat
              label="Due now"
              value={amount(p.balance_due_now)}
              tone={p.balance_due_now > 0 ? 'late' : 'settled'}
              detail={p.balance_to_bill > 0 ? `${amount(p.balance_to_bill)} still to bill` : p.payment_status}
            />
            <RecordStat
              label="Trips"
              value={number(travel.length)}
              detail={travel.length ? `${money(p.total_travel_cost)} spent` : 'Nobody has travelled yet'}
            />
            <RecordStat
              label="Delivery"
              value={p.actual_delivery_date ? date(p.actual_delivery_date) : p.project_stage}
              tone={p.delivery_variance_days > 0 ? 'late' : p.actual_delivery_date ? 'settled' : undefined}
              detail={p.delivery_variance_days !== null
                ? `${p.delivery_variance_days > 0 ? '+' : ''}${p.delivery_variance_days} days against plan`
                : p.planned_delivery_date ? `Planned ${date(p.planned_delivery_date)}` : 'No date planned'}
            />
          </>
        }
      >
        {p.follow_up_action && (
          <Alert tone={p.payment_status === 'Overdue' ? 'danger' : 'warning'}>{p.follow_up_action}</Alert>
        )}

        <Card title="Project details">
          <KeyValues
            items={[
              { label: 'Client', value: p.client_name },
              { label: 'Primary service', value: p.primary_service },
              { label: 'Project manager', value: p.project_manager },
              { label: 'Sales person', value: p.sales_person },
              { label: 'Planned start', value: date(p.planned_start_date) },
              { label: 'Planned delivery', value: date(p.planned_delivery_date) },
              { label: 'Actual initiation', value: date(p.actual_initiation_date) },
              { label: 'Actual delivery', value: date(p.actual_delivery_date) },
              { label: 'Payment status', value: <Badge>{p.payment_status}</Badge> },
              { label: 'Onboarding', value: p.onboarding_total ? <Progress value={p.onboarding_percent} /> : '—' },
              { label: '% complete', value: percent(p.percent_complete) },
              p.remarks && { label: 'Remarks', value: p.remarks },
            ]}
          />
        </Card>

        <Tabs
          active={tab}
          onChange={setTab}
          tabs={[
            { key: 'pos', label: 'Purchase orders', count: pos.length },
            { key: 'stages', label: 'Payment stages', count: stages.length },
            { key: 'onboarding', label: 'Onboarding', count: onboarding.length },
            { key: 'travel', label: 'Travel', count: travel.length },
            { key: 'quotes', label: 'Quotations', count: quotations.length },
          ]}
        />

        {tab === 'pos' && (
          <Card flush>
            <DataTable
              rows={pos}
              onRowClick={(row) => navigate(`/purchase-orders/${encodeURIComponent(row.po_number)}`)}
              columns={[
                { key: 'po_number', header: 'PO', className: 'mono strong' },
                { key: 'po_date', header: 'PO date', render: (r) => date(r.po_date) },
                { key: 'po_value', header: 'Value', align: 'right', render: (r) => money(r.po_value, r.currency) },
                { key: 'payment_terms_days', header: 'Terms', align: 'right', render: (r) => `${r.payment_terms_days} d` },
                { key: 'service_count', header: 'Services', align: 'right' },
                { key: 'stage_count', header: 'Stages', align: 'right' },
                { key: 'total_invoiced', header: 'Invoiced', align: 'right', render: (r) => money(r.total_invoiced, r.currency) },
                { key: 'balance_due_now', header: 'Due now', align: 'right', className: 'strong', render: (r) => money(r.balance_due_now, r.currency) },
                { key: 'balance_to_bill', header: 'To bill', align: 'right', render: (r) => (r.balance_to_bill > 0 ? money(r.balance_to_bill, r.currency) : <span className="muted">—</span>) },
                { key: 'payment_status', header: 'Status', render: (r) => <Badge>{r.payment_status}</Badge> },
                { key: 'actual_delivery_date', header: 'Delivered', render: (r) => (r.actual_delivery_date ? date(r.actual_delivery_date) : <span className="muted">not yet</span>) },
              ]}
              empty={
                <Empty
                  title="No purchase orders yet"
                  text="Register the PO so finance can raise the advance invoice."
                  action={<button type="button" className="btn btn--primary" onClick={() => setDialog({ type: 'newPo' })}>+ Purchase order</button>}
                />
              }
            />
          </Card>
        )}

        {tab === 'stages' && (
          <Card flush>
            <DataTable
              rows={stages}
              columns={[
                { key: 'po_number', header: 'PO', className: 'mono' },
                { key: 'stage_name', header: 'Stage', render: (r) => <>{r.stage_no}. {r.stage_name}<div className="small muted">{r.trigger_event}</div></> },
                { key: 'stage_amount', header: 'Value', align: 'right', render: (r) => money(r.stage_amount, r.currency) },
                { key: 'invoice_no', header: 'Invoice', className: 'mono small', render: (r) => r.invoice_no || <span className="muted">—</span> },
                { key: 'invoice_due_date', header: 'Due', render: (r) => date(r.invoice_due_date) },
                { key: 'amount_received', header: 'Received', align: 'right', render: (r) => money(r.amount_received, r.currency) },
                { key: 'stage_status', header: 'Status', render: (r) => <Badge>{r.stage_status}</Badge> },
                { key: 'follow_up_action', header: 'Follow-up', className: 'wrap small' },
                {
                  key: 'act', header: '', align: 'right',
                  render: (r) => (
                    <div className="table__actions">
                      {r.stage_status === 'To Invoice' && <button type="button" className="btn btn--sm btn--primary" onClick={() => setDialog({ type: 'invoice', row: r })}>Invoice</button>}
                      {['Overdue', 'Due', 'Partially Paid'].includes(r.stage_status) && <button type="button" className="btn btn--sm" onClick={() => setDialog({ type: 'payment', row: r })}>Payment</button>}
                    </div>
                  ),
                },
              ]}
              empty={<Empty title="No payment stages yet" text="Open a purchase order and set its payment split." />}
            />
          </Card>
        )}

        {tab === 'onboarding' && (
          <Card
            flush
            title="Onboarding & lifecycle"
            hint="Tick each step as it completes — the project's onboarding % follows"
            actions={
              <>
                {onboarding.length === 0 && (
                  <button type="button" className="btn btn--sm" onClick={applyTemplate} disabled={busy}>
                    Add standard checklist
                  </button>
                )}
                <button type="button" className="btn btn--primary btn--sm" onClick={() => setDialog({ type: 'newStep' })}>
                  + Add step
                </button>
              </>
            }
          >
            <DataTable
              rows={onboarding}
              columns={[
                { key: 'step_no', header: '#', align: 'right', width: 50 },
                { key: 'stage', header: 'Stage', render: (r) => <Badge>{r.stage}</Badge> },
                { key: 'step', header: 'Step', className: 'wrap' },
                { key: 'owner', header: 'Owner' },
                { key: 'target_date', header: 'Target', render: (r) => date(r.target_date) },
                { key: 'status', header: 'Status', render: (r) => <Badge>{r.status}</Badge> },
                {
                  key: 'act', header: '', align: 'right',
                  render: (r) => {
                    const i = onboarding.findIndex((s) => s.id === r.id);
                    return (
                      <div className="table__actions">
                        <button type="button" className="btn btn--sm btn--ghost" title="Move up" aria-label="Move up" onClick={() => moveStep(r, -1)} disabled={i <= 0}>▲</button>
                        <button type="button" className="btn btn--sm btn--ghost" title="Move down" aria-label="Move down" onClick={() => moveStep(r, 1)} disabled={i >= onboarding.length - 1}>▼</button>
                        <button type="button" className="btn btn--sm btn--ghost" onClick={() => setDialog({ type: 'editStep', row: r })}>Edit</button>
                        <button type="button" className="btn btn--sm" onClick={() => toggleStep(r)}>
                          {r.status === 'Done' ? 'Reopen' : 'Mark done'}
                        </button>
                        <button type="button" className="btn btn--sm btn--ghost" title="Delete step" aria-label="Delete step" onClick={() => setDialog({ type: 'deleteStep', row: r })}>✕</button>
                      </div>
                    );
                  },
                },
              ]}
              empty={
                <Empty
                  title="No onboarding steps"
                  text="Start from the 11 standard lifecycle steps, or add your own one at a time."
                  action={
                    <div className="table__actions">
                      <button type="button" className="btn btn--primary" onClick={applyTemplate} disabled={busy}>Add standard checklist</button>
                      <button type="button" className="btn" onClick={() => setDialog({ type: 'newStep' })}>+ Add step</button>
                    </div>
                  }
                />
              }
            />
          </Card>
        )}

        {tab === 'travel' && (
          <Card flush>
            <DataTable
              rows={travel}
              columns={[
                { key: 'travel_id', header: 'Trip', className: 'mono' },
                { key: 'employee_name', header: 'Employee', className: 'strong' },
                { key: 'destination', header: 'Destination' },
                { key: 'travel_start_date', header: 'Dates', className: 'small', render: (r) => `${date(r.travel_start_date)} — ${date(r.travel_end_date)}` },
                { key: 'vendor_cost', header: 'Vendor', align: 'right', render: (r) => money(r.vendor_cost) },
                { key: 'employee_claims', header: 'Claims', align: 'right', render: (r) => money(r.employee_claims) },
                { key: 'total_travel_cost', header: 'Total', align: 'right', className: 'strong', render: (r) => money(r.total_travel_cost) },
                { key: 'vendor_invoice_status', header: 'Vendor invoice', render: (r) => <Badge>{r.vendor_invoice_status}</Badge> },
              ]}
              empty={<Empty title="No travel recorded against this project" />}
            />
          </Card>
        )}

        {tab === 'quotes' && (
          <Card flush>
            <DataTable
              rows={quotations}
              columns={[
                { key: 'quotation_no', header: 'Quotation', className: 'mono' },
                { key: 'quotation_date', header: 'Date', render: (r) => date(r.quotation_date) },
                { key: 'service_quoted', header: 'Service', className: 'wrap' },
                { key: 'quotation_value', header: 'Value', align: 'right', render: (r) => money(r.quotation_value, r.currency) },
                { key: 'status', header: 'Status', render: (r) => <Badge>{r.status}</Badge> },
              ]}
              empty={<Empty title="No quotation linked to this project" />}
            />
          </Card>
        )}
        <ProjectVisits projectId={projectId} />
        <ProjectProfit projectId={projectId} />
        <DeliverablesTable params={{ project_id: projectId }} preset={{ project_id: projectId }} compact title="Deliverables" hint="Issue the certificate or report this project produced. An expiry date schedules the renewal." />
        <Timeline entity="project" id={projectId} />
      </RecordPage>

      {dialog?.type === 'newStep' && (
        <RecordForm
          title="Add onboarding step"
          subtitle={`For ${p.project_id} — ${p.client_name}`}
          resource="onboarding"
          record={{
            project_id: p.project_id,
            step_no: nextStepNo,
            stage: 'Onboarding',
            status: 'Not Started',
            owner: p.project_manager,
            owner_email: p.project_manager_email,
          }}
          onClose={close}
          onSaved={refetch}
          fields={stepFields}
        />
      )}

      {dialog?.type === 'editStep' && (
        <RecordForm
          title="Edit onboarding step"
          subtitle={`Step ${dialog.row.step_no} of ${p.project_id}`}
          resource="onboarding"
          record={dialog.row}
          onClose={close}
          onSaved={refetch}
          fields={stepFields}
        />
      )}

      {dialog?.type === 'deleteStep' && (
        <ConfirmDialog
          title="Delete this step?"
          message={`"${dialog.row.step}" will be removed from ${p.project_id}. The onboarding % will recalculate.`}
          confirmLabel="Delete step"
          busy={busy}
          onConfirm={() => deleteStep(dialog.row)}
          onClose={close}
        />
      )}

      {dialog?.type === 'invoice' && <RecordInvoiceDialog stage={dialog.row} onClose={close} onDone={done} />}
      {dialog?.type === 'payment' && <RecordPaymentDialog stage={dialog.row} onClose={close} onDone={done} />}

      {dialog?.type === 'edit' && (
        <RecordForm
          title="Edit project"
          resource="projects"
          record={p}
          onClose={close}
          onSaved={refetch}
          fields={[
            { name: 'client_name', label: 'Client', required: true },
            { name: 'primary_service', label: 'Primary service', type: 'combo', options: lookups.services, span: 2 },
            { name: 'project_manager', label: 'Project manager' },
            { name: 'project_manager_email', label: 'Manager email', type: 'email' },
            { name: 'sales_person', label: 'Sales person' },
            { name: 'planned_start_date', label: 'Planned start', type: 'date' },
            { name: 'planned_delivery_date', label: 'Planned delivery', type: 'date' },
            { name: 'percent_complete', label: '% complete', type: 'percent' },
            { name: 'remarks', label: 'Remarks', type: 'textarea', span: 'all' },
          ]}
        />
      )}

      {dialog?.type === 'newPo' && (
        <RecordForm
          title="New purchase order"
          subtitle={`For ${p.project_id} — ${p.client_name}`}
          resource="purchase-orders"
          record={{
            project_id: p.project_id,
            currency: 'INR',
            payment_terms_days: 30,
            // With one won quotation on the project, that is the order this PO fulfils.
            quotation_no: quotations.filter((q) => q.status === 'Won - PO Received').length === 1
              ? quotations.find((q) => q.status === 'Won - PO Received').quotation_no
              : '',
          }}
          onClose={close}
          onSaved={refetch}
          intro="Once the PO date is set, any stage triggered On PO Registration becomes invoiceable straight away."
          fields={[
            { name: 'po_number', label: 'PO number', required: true },
            { name: 'project_id', label: 'Project', required: true, disabled: true },
            {
              name: 'quotation_no',
              label: 'Won quotation',
              type: 'select',
              options: quotations
                .filter((q) => q.status === 'Won - PO Received')
                .map((q) => ({ value: q.quotation_no, label: `${q.quotation_no} — ${money(q.quotation_value, q.currency)}` })),
              hint: 'The order this PO fulfils; revenue counts the PO against it',
            },
            { name: 'po_date', label: 'PO date', type: 'date' },
            { name: 'po_value', label: 'PO value', type: 'money', required: true },
            { name: 'currency', label: 'Currency', type: 'select', options: lookups.enums?.currency || ['INR'] },
            { name: 'payment_terms_days', label: 'Payment terms (days)', type: 'number' },
            { name: 'project_manager_email', label: 'Manager email', type: 'email' },
            { name: 'document_id', label: 'PO document', type: 'document', owner: 'purchase-orders', maxBytes: lookups.limits?.document_max_bytes, span: 2 },
            { name: 'remarks', label: 'Remarks', type: 'textarea', span: 'all' },
          ]}
        />
      )}
    </>
  );
}
