import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { PageHeader } from '../App.jsx';
import {
  Card, Stat, Badge, DataTable, KeyValues, Progress, Tabs,
  ErrorState, Empty, useToast, Alert,
} from '../components/ui.jsx';
import { RecordInvoiceDialog, RecordPaymentDialog } from '../components/actions.jsx';
import { RecordForm } from '../components/RecordForm.jsx';
import { api } from '../lib/api.js';
import { useFetch, useLookups } from '../lib/hooks.js';
import { money, date, percent, number } from '../lib/format.js';

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

  return (
    <>
      <PageHeader
        title={`${p.project_id} · ${p.client_name}`}
        subtitle={[p.primary_service, p.project_manager && `PM ${p.project_manager}`].filter(Boolean).join(' · ')}
        actions={
          <>
            <Link className="btn" to="/projects">All projects</Link>
            <button type="button" className="btn" onClick={() => setDialog({ type: 'edit' })}>Edit project</button>
            <button type="button" className="btn btn--primary" onClick={() => setDialog({ type: 'newPo' })}>+ Purchase order</button>
          </>
        }
      />

      <div className="page stack">
        {p.follow_up_action && (
          <Alert tone={p.payment_status === 'Overdue' ? 'danger' : 'warning'}>{p.follow_up_action}</Alert>
        )}

        <div className="grid grid--stats">
          <Stat label="Contract value" value={money(p.total_contract_value)} meta={`${number(p.po_count)} purchase order(s)`} tone="brand" />
          <Stat label="Invoiced" value={money(p.total_invoiced)} meta={`${money(p.total_received)} received`} />
          <Stat label="Due now" value={money(p.balance_due_now)} tone={p.balance_due_now > 0 ? 'warn' : 'ok'} meta={p.payment_status} />
          <Stat label="Travel cost" value={money(p.total_travel_cost)} meta={`${travel.length} trip(s)`} />
          <Stat label="Project stage" value={p.project_stage} meta={p.delivery_variance_days !== null ? `${p.delivery_variance_days > 0 ? '+' : ''}${p.delivery_variance_days} days vs plan` : 'Delivery not recorded'} />
        </div>

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
              onboarding.length === 0 && (
                <button type="button" className="btn btn--primary btn--sm" onClick={applyTemplate} disabled={busy}>
                  Add standard checklist
                </button>
              )
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
                  render: (r) => (
                    <div className="table__actions">
                      <button type="button" className="btn btn--sm" onClick={() => toggleStep(r)}>
                        {r.status === 'Done' ? 'Reopen' : 'Mark done'}
                      </button>
                    </div>
                  ),
                },
              ]}
              empty={
                <Empty
                  title="No onboarding steps"
                  text="Add the 11 standard lifecycle steps used across Cetizion projects."
                  action={<button type="button" className="btn btn--primary" onClick={applyTemplate} disabled={busy}>Add standard checklist</button>}
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
      </div>

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
          record={{ project_id: p.project_id, currency: 'INR', payment_terms_days: 30 }}
          onClose={close}
          onSaved={refetch}
          intro="Once the PO date is set, any stage triggered On PO Registration becomes invoiceable straight away."
          fields={[
            { name: 'po_number', label: 'PO number', required: true },
            { name: 'project_id', label: 'Project', required: true, disabled: true },
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
