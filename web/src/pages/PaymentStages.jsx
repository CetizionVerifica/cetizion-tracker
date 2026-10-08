import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { PageHeader } from '../App.jsx';
import { ListPage } from '../components/ListPage.jsx';
import { Badge, Alert, DocumentLink, Tabs } from '../components/ui.jsx';
import { InvoiceReviewList, useReviewCount } from '../components/EmailReview.jsx';
import { RecordInvoiceDialog, RecordPaymentDialog } from '../components/actions.jsx';
import { ClientSaidBadge, useClientSaid } from '../components/ClientSaid.jsx';
import { useLookups } from '../lib/hooks.js';
import { money, date, percent } from '../lib/format.js';

/**
 * The finance sheet. Same rows as the workbook's Payment Schedule, but
 * the status column is computed and the two actions finance actually
 * takes are buttons rather than free-typed cells.
 */
export default function PaymentStages() {
  const lookups = useLookups();
  const [params, setParams] = useSearchParams();
  const [dialog, setDialog] = useState(null);
  // Invoices we emailed that need a person (docs/email-po-plan.md §3.10.5).
  const tab = params.get('tab') === 'invoice-review' ? 'invoice-review' : 'all';
  const toReview = useReviewCount('/payment-stages/invoice-review');
  const [version, setVersion] = useState(0);
  // What the client last said in the portal about each invoice (#198).
  const clientSaid = useClientSaid();

  const refresh = () => {
    setDialog(null);
    setVersion((v) => v + 1);
  };

  const columns = [
    {
      key: 'po_number',
      header: 'PO / stage',
      render: (r) => (
        <>
          <Link className="mono" to={`/purchase-orders/${encodeURIComponent(r.po_number)}`}>{r.po_number}</Link>
          <div className="small muted">{r.stage_no}. {r.stage_name}</div>
        </>
      ),
    },
    { key: 'client_name', header: 'Client', className: 'strong', render: (r) => <>{r.client_name}<div className="small muted mono">{r.project_id}</div></> },
    { key: 'trigger_event', header: 'Trigger', className: 'small' },
    { key: 'stage_percent', header: '%', align: 'right', render: (r) => percent(r.stage_percent) },
    { key: 'stage_amount', header: 'Stage value', align: 'right', render: (r) => money(r.stage_amount, r.currency) },
    { key: 'invoice_no', header: 'Invoice', className: 'mono small', render: (r) => (r.invoice_no ? <>{r.invoice_no}<div className="muted">{date(r.invoice_date)}</div></> : <span className="muted">—</span>) },
    { key: 'document_id', header: 'Document', render: (r) => <DocumentLink id={r.document_id} name={r.document_name} /> },
    { key: 'invoice_due_date', header: 'Due', render: (r) => date(r.invoice_due_date) },
    { key: 'amount_received', header: 'Received', align: 'right', render: (r) => money(r.amount_received, r.currency) },
    { key: 'due_now_amount', header: 'Due now', align: 'right', className: 'strong', render: (r) => money(r.due_now_amount, r.currency) },
    { key: 'to_bill_amount', header: 'To bill', align: 'right', render: (r) => (r.to_bill_amount > 0 ? money(r.to_bill_amount, r.currency) : <span className="muted">—</span>) },
    { key: 'stage_status', header: 'Status', render: (r) => <><Badge>{r.stage_status}</Badge><ClientSaidBadge said={clientSaid.get(r.id)} /></> },
    { key: 'follow_up_action', header: 'Follow-up', className: 'wrap small' },
    {
      key: 'act',
      header: '',
      align: 'right',
      render: (r) => (
        <div className="table__actions">
          {r.stage_status === 'To Invoice' ? (
            <button type="button" className="btn btn--sm" onClick={() => setDialog({ type: 'invoice', row: r })}>Invoice</button>
          ) : r.stage_status === 'Not Due' ? (
            <span className="muted small nowrap">waiting on trigger</span>
          ) : r.stage_status === 'Paid' ? (
            <span className="muted small">—</span>
          ) : (
            <button type="button" className="btn btn--sm" onClick={() => setDialog({ type: 'payment', row: r })}>Payment</button>
          )}
        </div>
      ),
    },
  ];

  const fields = [
    { name: 'po_number', label: 'Purchase order', required: true, type: 'select', options: lookups.purchase_orders.map((p) => ({ value: p.po_number, label: `${p.po_number} — ${p.client_name}` })) },
    { name: 'stage_no', label: 'Stage number', type: 'number', required: true, default: '1' },
    { name: 'stage_name', label: 'Stage name', required: true, hint: 'e.g. Advance (50%)' },
    { name: 'trigger_event', label: 'Trigger', type: 'select', options: lookups.enums?.trigger || [], default: 'On PO Registration', required: true },
    { name: 'stage_percent', label: 'Stage %', type: 'percent', required: true, hint: 'All stages on a PO should total 100' },
    // A stage triggered by a milestone is due once that milestone is
    // reached, and nothing else in the app writes the date. Without these
    // two the trigger could be chosen and the stage could never be
    // invoiced.
    { name: 'milestone_name', label: 'Milestone', hint: 'Only for the On Milestone trigger, e.g. Stage 2 audit complete' },
    { name: 'milestone_reached_on', label: 'Milestone reached on', type: 'date', hint: 'Fill this in when it happens: the stage becomes invoiceable' },
    { name: 'invoice_no', label: 'Invoice number' },
    { name: 'invoice_date', label: 'Invoice date', type: 'date' },
    { name: 'document_id', label: 'Invoice document', type: 'document', owner: 'payment-stages', maxBytes: lookups.limits?.document_max_bytes, span: 2 },
    { name: 'amount_received', label: 'Amount received', type: 'money', default: '0' },
    { name: 'payment_received_date', label: 'Payment date', type: 'date' },
    { name: 'remarks', label: 'Remarks', type: 'textarea', span: 'all' },
  ];

  const pastMail = params.get('from_past_po') === '1';
  const tabs = (
    <Tabs
      active={tab}
      onChange={(key) => setParams(key === 'invoice-review' ? { tab: 'invoice-review' } : {})}
      tabs={[{ key: 'all', label: 'All stages' }, { key: 'invoice-review', label: 'Invoices to review', count: toReview || undefined }]}
    />
  );
  if (tab === 'invoice-review') {
    return (
      <>
        <PageHeader title="Invoicing" subtitle="Invoices we emailed that were not recorded automatically" />
        <div className="page stack">
          {tabs}
          <InvoiceReviewList />
        </div>
      </>
    );
  }

  return (
    <>
      <ListPage
        refreshToken={version}
        title="Invoicing"
        subtitle="Every stage on every PO — status is computed, never typed"
        resource="payment-stages"
        columns={columns}
        fields={fields}
        newLabel="Stage"
        formTitle="payment stage"
        searchPlaceholder="Search PO, client, invoice no…"
        initialFilters={params.get('status') ? { stage_status: params.get('status') } : undefined}
        filters={[
          { name: 'stage_status', label: 'Status', options: ['To Invoice', 'Overdue', 'Due', 'Partially Paid', 'Paid', 'Not Due'] },
          { name: 'trigger_event', label: 'Trigger', options: lookups.enums?.trigger || [] },
          { name: 'invoice_no', label: 'Invoice', options: [{ value: '__any__', label: 'Raised' }, { value: '__none__', label: 'Not raised' }] },
          { name: 'document_id', label: 'Invoice document', options: [{ value: '__none__', label: 'Missing' }, { value: '__any__', label: 'Attached' }] },
          { name: 'from_email', label: 'Source', options: [{ value: '1', label: 'Invoice recorded from email' }] },
          { name: 'from_past_po', label: 'Past mail', options: [{ value: '1', label: 'Past POs and invoices to settle' }] },
        ]}
        banner={
          <>
            {tabs}
            {pastMail ? (
              <Alert tone="warning">
                <span>
                  <strong>Past POs and invoices to settle.</strong> These stages come from POs or invoices read from the past year of email.
                  Their invoices and payments very likely happened outside the tracker: record them here and each stage leaves this list once a payment is recorded.
                  Until then, neither clients nor owners are chased about the invoices read from past mail.
                </span>
              </Alert>
            ) : (
              <Alert>
                <span>
                  <strong>To Invoice</strong> means the trigger has happened and finance should bill now.
                  <strong> Overdue</strong> means the invoice due date has passed — follow up strictly.
                </span>
              </Alert>
            )}
          </>
        }
      />

      {dialog?.type === 'invoice' && <RecordInvoiceDialog stage={dialog.row} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog?.type === 'payment' && <RecordPaymentDialog stage={dialog.row} onClose={() => setDialog(null)} onDone={refresh} />}
    </>
  );
}
