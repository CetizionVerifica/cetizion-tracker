import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { PageHeader } from '../App.jsx';
import {
  Card, Stat, Badge, DataTable, KeyValues, ErrorState, Empty, Alert, DocumentLink, useToast,
} from '../components/ui.jsx';
import { RecordInvoiceDialog, RecordPaymentDialog, PaymentSplitDialog } from '../components/actions.jsx';
import { RecordForm } from '../components/RecordForm.jsx';
import { Timeline } from '../components/Timeline.jsx';
import { api } from '../lib/api.js';
import { useFetch, useLookups } from '../lib/hooks.js';
import { money, date, percent, number } from '../lib/format.js';

export default function PurchaseOrderDetail() {
  const { poNumber } = useParams();
  const toast = useToast();
  const lookups = useLookups();
  const [dialog, setDialog] = useState(null);

  const { data, loading, error, refetch } = useFetch(
    () => api.raw(`/purchase-orders/${encodeURIComponent(poNumber)}/full`),
    [poNumber]
  );

  if (error) {
    return (
      <>
        <PageHeader title={poNumber} />
        <div className="page"><ErrorState message={error} onRetry={refetch} /></div>
      </>
    );
  }
  if (loading || !data) {
    return (
      <>
        <PageHeader title={poNumber} />
        <div className="page"><div className="skeleton" style={{ height: 200 }} /></div>
      </>
    );
  }

  const { purchase_order: po, services, payment_stages: stages, travel } = data.data;
  const close = () => setDialog(null);
  const done = () => { close(); refetch(); };
  const stagesOff = po.stage_count > 0 && Math.abs(Number(po.stages_percent_total) - 1) > 0.0001;
  const serviceTotal = services.reduce((sum, s) => sum + Number(s.service_value || 0), 0);

  async function deleteService(row) {
    try {
      await api.remove('po-services', row.id);
      toast('Service line removed', 'success');
      refetch();
    } catch (err) {
      toast(err.message, 'danger');
    }
  }

  return (
    <>
      <PageHeader
        title={`${po.po_number} · ${po.client_name}`}
        subtitle={<>Project <Link to={`/projects/${po.project_id}`} className="mono">{po.project_id}</Link> · {po.payment_terms_days}-day terms</>}
        actions={
          <>
            <Link className="btn" to="/purchase-orders">All POs</Link>
            <button type="button" className="btn" onClick={() => setDialog({ type: 'edit' })}>Edit PO</button>
            <button type="button" className="btn btn--primary" onClick={() => setDialog({ type: 'split' })}>
              {po.stage_count ? 'Reset payment stages' : 'Set payment stages'}
            </button>
          </>
        }
      />

      <div className="page stack">
        {po.follow_up_action && (
          <Alert tone={po.payment_status === 'Overdue' ? 'danger' : 'warning'}>{po.follow_up_action}</Alert>
        )}
        {po.stage_count === 0 && (
          <Alert tone="warning">
            No payment stages set. Nothing can be invoiced against this PO until they exist.
          </Alert>
        )}
        {stagesOff && (
          <Alert tone="danger">
            The stages on this PO total {percent(po.stages_percent_total, 1)} — they should total 100%.
          </Alert>
        )}
        {!po.po_date && (
          <Alert tone="warning">
            No PO date recorded, so advance stages are not yet due to invoice. Add it on Edit PO.
          </Alert>
        )}

        <div className="auto-grid--stats">
          <Stat label="PO value" value={money(po.po_value, po.currency)} meta={`${number(po.service_count)} service line(s)`} tone="brand" />
          <Stat label="Invoiced" value={money(po.total_invoiced, po.currency)} meta={`${money(po.total_received, po.currency)} received`} />
          <Stat label="Due now" value={money(po.balance_due_now, po.currency)} tone={po.balance_due_now > 0 ? 'warn' : 'ok'} meta={po.payment_status} />
          <Stat label="To bill" value={money(po.balance_to_bill, po.currency)} tone={po.balance_to_bill > 0 ? 'warn' : 'ok'} meta="Due to be invoiced, not yet billed" />
          <Stat label="Overdue stages" value={number(po.overdue_stages)} tone={po.overdue_stages > 0 ? 'danger' : 'ok'} meta={`${po.stages_to_invoice} to invoice`} />
          <Stat label="Travel cost" value={money(po.total_travel_cost)} meta={`${travel.length} trip(s)`} />
        </div>

        <Card title="Purchase order details">
          <KeyValues
            items={[
              {
                label: 'Won quotation',
                value: po.quotation_no
                  ? <Link className="mono" to={`/quotations?q=${encodeURIComponent(po.quotation_no)}`}>{po.quotation_no}</Link>
                  : <span className="muted">Not linked — revenue does not count this PO</span>,
              },
              { label: 'PO date', value: date(po.po_date) },
              { label: 'Payment terms', value: `${po.payment_terms_days} days` },
              { label: 'Actual initiation', value: date(po.actual_initiation_date) },
              { label: 'Actual delivery', value: date(po.actual_delivery_date) },
              { label: 'Manager email', value: po.project_manager_email },
              { label: 'Payment status', value: <Badge>{po.payment_status}</Badge> },
              { label: 'PO document', value: <DocumentLink id={po.document_id} name={po.document_name} /> },
              po.remarks && { label: 'Remarks', value: po.remarks },
            ]}
          />
        </Card>

        <Card
          flush
          title="Payment stages"
          hint="Advance stages become invoiceable on PO registration; delivery stages when the delivery date is set"
          actions={<button type="button" className="btn btn--sm" onClick={() => setDialog({ type: 'newStage' })}>+ Stage</button>}
        >
          <DataTable
            rows={stages}
            columns={[
              { key: 'stage_no', header: '#', align: 'right', width: 50 },
              { key: 'stage_name', header: 'Stage', className: 'strong' },
              { key: 'trigger_event', header: 'Trigger', className: 'small' },
              { key: 'stage_percent', header: '%', align: 'right', render: (r) => percent(r.stage_percent) },
              { key: 'stage_amount', header: 'Value', align: 'right', render: (r) => money(r.stage_amount, r.currency) },
              { key: 'invoice_no', header: 'Invoice', className: 'mono small', render: (r) => (r.invoice_no ? <>{r.invoice_no}<div className="muted">{date(r.invoice_date)}</div></> : <span className="muted">—</span>) },
              { key: 'invoice_due_date', header: 'Due', render: (r) => date(r.invoice_due_date) },
              { key: 'amount_received', header: 'Received', align: 'right', render: (r) => money(r.amount_received, r.currency) },
              { key: 'stage_status', header: 'Status', render: (r) => <Badge>{r.stage_status}</Badge> },
              {
                key: 'act', header: '', align: 'right',
                render: (r) => (
                  <div className="table__actions">
                    {r.stage_status === 'To Invoice' && <button type="button" className="btn btn--sm btn--primary" onClick={() => setDialog({ type: 'invoice', row: r })}>Invoice</button>}
                    {['Overdue', 'Due', 'Partially Paid'].includes(r.stage_status) && <button type="button" className="btn btn--sm" onClick={() => setDialog({ type: 'payment', row: r })}>Payment</button>}
                    {r.stage_status === 'Not Due' && <span className="muted small nowrap">waiting on trigger</span>}
                  </div>
                ),
              },
            ]}
            footer={
              stages.length ? (
                <>
                  <td colSpan={3}>Total</td>
                  <td className="num">{percent(po.stages_percent_total)}</td>
                  <td className="num">{money(po.po_value, po.currency)}</td>
                  <td colSpan={2} />
                  <td className="num">{money(po.total_received, po.currency)}</td>
                  <td colSpan={2} />
                </>
              ) : null
            }
            empty={
              <Empty
                title="No payment stages"
                text="Set the split agreed on this PO — 50/50, 30/70, or anything else."
                action={<button type="button" className="btn btn--primary" onClick={() => setDialog({ type: 'split' })}>Set payment stages</button>}
              />
            }
          />
        </Card>

        <Card
          flush
          title="Services on this PO"
          hint="A PO can cover several services — list them one per row"
          actions={<button type="button" className="btn btn--sm" onClick={() => setDialog({ type: 'newService' })}>+ Service</button>}
        >
          <DataTable
            rows={services}
            columns={[
              { key: 'service', header: 'Service', className: 'strong wrap' },
              { key: 'service_value', header: 'Value', align: 'right', render: (r) => money(r.service_value, po.currency) },
              { key: 'remarks', header: 'Remarks', className: 'wrap small' },
              {
                key: 'act', header: '', align: 'right',
                render: (r) => (
                  <div className="table__actions">
                    <button type="button" className="btn btn--sm btn--ghost" onClick={() => setDialog({ type: 'editService', row: r })}>Edit</button>
                    <button type="button" className="btn btn--sm btn--ghost" onClick={() => deleteService(r)}>✕</button>
                  </div>
                ),
              },
            ]}
            footer={
              services.length ? (
                <>
                  <td>Total{Math.abs(serviceTotal - Number(po.po_value)) > 0.5 && <span className="small muted"> — differs from the PO value</span>}</td>
                  <td className="num">{money(serviceTotal, po.currency)}</td>
                  <td colSpan={2} />
                </>
              ) : null
            }
            empty={<Empty title="No service lines yet" text="Add what this PO actually covers." />}
          />
        </Card>

        {travel.length > 0 && (
          <Card flush title="Travel billed to this PO">
            <DataTable
              rows={travel}
              columns={[
                { key: 'travel_id', header: 'Trip', className: 'mono' },
                { key: 'employee_name', header: 'Employee', className: 'strong' },
                { key: 'destination', header: 'Destination' },
                { key: 'total_travel_cost', header: 'Cost', align: 'right', render: (r) => money(r.total_travel_cost) },
                { key: 'vendor_invoice_status', header: 'Vendor invoice', render: (r) => <Badge>{r.vendor_invoice_status}</Badge> },
              ]}
            />
          </Card>
        )}
        <Timeline entity="purchase_order" id={po.po_number} />
      </div>

      {dialog?.type === 'invoice' && <RecordInvoiceDialog stage={dialog.row} onClose={close} onDone={done} />}
      {dialog?.type === 'payment' && <RecordPaymentDialog stage={dialog.row} onClose={close} onDone={done} />}
      {dialog?.type === 'split' && (
        <PaymentSplitDialog
          po={po}
          // Invoiced or paid stages are never replaced, so only what is left
          // can be re-split. The dialog needs to know before the user types.
          lockedPercent={stages
            .filter((s) => s.invoice_no || Number(s.amount_received) > 0)
            .reduce((sum, s) => sum + Number(s.stage_percent || 0), 0)}
          onClose={close}
          onDone={done}
        />
      )}

      {dialog?.type === 'edit' && (
        <RecordForm
          title="Edit purchase order"
          resource="purchase-orders"
          record={po}
          onClose={close}
          onSaved={refetch}
          fields={[
            {
              name: 'quotation_no',
              label: 'Won quotation',
              type: 'select',
              span: 2,
              hint: 'The order this PO fulfils; revenue counts the PO against it',
              options: [
                ...(po.quotation_no && !lookups.won_quotations.some((q) => q.quotation_no === po.quotation_no)
                  ? [{ value: po.quotation_no, label: po.quotation_no }]
                  : []),
                ...lookups.won_quotations
                  .filter((q) => q.project_id === po.project_id)
                  .map((q) => ({ value: q.quotation_no, label: `${q.quotation_no} — ${q.client_name}` })),
              ],
            },
            { name: 'po_date', label: 'PO date', type: 'date', hint: 'Makes advance stages invoiceable' },
            { name: 'po_value', label: 'PO value', type: 'money', required: true },
            { name: 'currency', label: 'Currency', type: 'select', options: lookups.enums?.currency || ['INR'] },
            { name: 'payment_terms_days', label: 'Payment terms (days)', type: 'number' },
            { name: 'actual_initiation_date', label: 'Actual initiation', type: 'date' },
            { name: 'actual_delivery_date', label: 'Actual delivery', type: 'date', hint: 'Makes on-delivery stages invoiceable' },
            { name: 'project_manager_email', label: 'Manager email', type: 'email' },
            { name: 'document_id', label: 'PO document', type: 'document', owner: 'purchase-orders', maxBytes: lookups.limits?.document_max_bytes, span: 2 },
            { name: 'remarks', label: 'Remarks', type: 'textarea', span: 'all' },
          ]}
        />
      )}

      {(dialog?.type === 'newService' || dialog?.type === 'editService') && (
        <RecordForm
          title={dialog.type === 'newService' ? 'Add a service line' : 'Edit service line'}
          resource="po-services"
          record={dialog.type === 'newService' ? { po_number: po.po_number } : dialog.row}
          onClose={close}
          onSaved={refetch}
          fields={[
            { name: 'po_number', label: 'PO number', required: true, disabled: true },
            { name: 'service', label: 'Service', required: true, type: 'combo', options: lookups.services, span: 2 },
            { name: 'service_value', label: 'Service value', type: 'money', hint: 'Optional — should add up to the PO value' },
            { name: 'remarks', label: 'Remarks', type: 'textarea', span: 'all' },
          ]}
        />
      )}

      {dialog?.type === 'newStage' && (
        <RecordForm
          title="Add a payment stage"
          resource="payment-stages"
          record={{ po_number: po.po_number, stage_no: po.stage_count + 1, trigger_event: 'On Delivery', amount_received: 0 }}
          onClose={close}
          onSaved={refetch}
          fields={[
            { name: 'po_number', label: 'PO number', required: true, disabled: true },
            { name: 'stage_no', label: 'Stage number', type: 'number', required: true },
            { name: 'stage_name', label: 'Stage name', required: true },
            { name: 'trigger_event', label: 'Trigger', type: 'select', options: lookups.enums?.trigger || [], required: true },
            { name: 'stage_percent', label: 'Stage %', type: 'percent', required: true },
            { name: 'remarks', label: 'Remarks', type: 'textarea', span: 'all' },
          ]}
        />
      )}
    </>
  );
}
