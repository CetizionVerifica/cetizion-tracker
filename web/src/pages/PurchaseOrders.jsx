import { useNavigate, useSearchParams } from 'react-router-dom';
import { ListPage } from '../components/ListPage.jsx';
import { Badge, Alert, DocumentLink } from '../components/ui.jsx';
import { useLookups } from '../lib/hooks.js';
import { money, date, number, percent } from '../lib/format.js';

export default function PurchaseOrders() {
  const navigate = useNavigate();
  const lookups = useLookups();
  const [params] = useSearchParams();

  const columns = [
    { key: 'po_number', header: 'PO', className: 'mono strong', render: (r) => <>{r.po_number}<div className="small muted">{date(r.po_date)}</div></> },
    { key: 'client_name', header: 'Client', className: 'strong', render: (r) => <>{r.client_name}<div className="small muted mono">{r.project_id}{r.quotation_no ? ` · ${r.quotation_no}` : ' · no quotation linked'}</div></> },
    { key: 'po_value', header: 'PO value', align: 'right', render: (r) => money(r.po_value, r.currency) },
    { key: 'service_count', header: 'Services', align: 'right', render: (r) => number(r.service_count) },
    {
      key: 'stage_count',
      header: 'Stages',
      align: 'right',
      render: (r) =>
        r.stage_count === 0 ? (
          <Badge tone="warning">none set</Badge>
        ) : Math.abs(Number(r.stages_percent_total) - 1) > 0.0001 ? (
          <Badge tone="danger">{percent(r.stages_percent_total)}</Badge>
        ) : (
          number(r.stage_count)
        ),
    },
    { key: 'total_invoiced', header: 'Invoiced', align: 'right', render: (r) => money(r.total_invoiced, r.currency) },
    { key: 'total_received', header: 'Received', align: 'right', render: (r) => money(r.total_received, r.currency) },
    { key: 'balance_due_now', header: 'Due now', align: 'right', className: 'strong', render: (r) => money(r.balance_due_now, r.currency) },
    { key: 'balance_to_bill', header: 'To bill', align: 'right', render: (r) => (r.balance_to_bill > 0 ? money(r.balance_to_bill, r.currency) : <span className="muted">—</span>) },
    { key: 'payment_status', header: 'Status', render: (r) => <Badge>{r.payment_status}</Badge> },
    { key: 'actual_delivery_date', header: 'Delivered', render: (r) => (r.actual_delivery_date ? date(r.actual_delivery_date) : <span className="muted">not yet</span>) },
    { key: 'document_id', header: 'Document', render: (r) => <DocumentLink id={r.document_id} name={r.document_name} /> },
  ];

  const fields = [
    { name: 'po_number', label: 'PO number', required: true },
    { name: 'project_id', label: 'Project', required: true, type: 'select', options: lookups.projects.map((p) => ({ value: p.project_id, label: `${p.project_id} — ${p.client_name}` })) },
    {
      name: 'quotation_no',
      label: 'Won quotation',
      type: 'select',
      // The server only accepts a won quotation of this PO's own project, so
      // the list narrows as soon as the project is chosen.
      options: (values) => lookups.won_quotations
        .filter((q) => !values.project_id || q.project_id === values.project_id)
        .map((q) => ({ value: q.quotation_no, label: `${q.quotation_no} — ${q.client_name} (${q.project_id})` })),
      hint: 'The order this PO fulfils, on the same project. Left blank, it is linked when the project has one won quotation',
    },
    { name: 'po_date', label: 'PO date', type: 'date', hint: 'Registering the date makes advance stages invoiceable' },
    { name: 'po_value', label: 'PO value', type: 'money', required: true },
    { name: 'currency', label: 'Currency', type: 'select', options: lookups.enums?.currency || ['INR'], default: 'INR' },
    { name: 'payment_terms_days', label: 'Payment terms (days)', type: 'number', default: '30' },
    { name: 'actual_initiation_date', label: 'Actual initiation', type: 'date' },
    { name: 'actual_delivery_date', label: 'Actual delivery', type: 'date', hint: 'Setting this makes on-delivery stages invoiceable' },
    { name: 'project_manager_email', label: 'Manager email', type: 'email' },
    { name: 'document_id', label: 'PO document', type: 'document', owner: 'purchase-orders', maxBytes: lookups.limits?.document_max_bytes, span: 2 },
    { name: 'remarks', label: 'Remarks', type: 'textarea', span: 'all' },
  ];

  return (
    <ListPage
      title="Purchase orders"
      subtitle="One row per PO — a project can hold several"
      resource="purchase-orders"
      columns={columns}
      fields={fields}
      newLabel="Purchase order"
      formTitle="purchase order"
      formIntro="Register the PO first, then add its service lines and payment stages on the PO's own page."
      searchPlaceholder="Search PO number, client, project…"
      // The sales report's payment status table links here with the status
      // and period behind a row, so the list shows exactly those POs.
      initialFilters={Object.fromEntries(
        ['payment_status', 'from', 'to'].map((key) => [key, params.get(key)]).filter(([, value]) => value)
      )}
      dateFilterLabel="PO date"
      onRowClick={(row) => navigate(`/purchase-orders/${encodeURIComponent(row.po_number)}`)}
      filters={[
        { name: 'payment_status', label: 'Status', options: ['Overdue', 'To Invoice', 'No stages', 'Pending', 'Up to date', 'Fully Paid'] },
      ]}
      banner={
        lookups.projects.length === 0 ? (
          <Alert tone="warning">Register a project before adding purchase orders — every PO belongs to one.</Alert>
        ) : null
      }
    />
  );
}
