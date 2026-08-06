import { ListPage } from '../components/ListPage.jsx';
import { Badge, Alert } from '../components/ui.jsx';
import { useLookups } from '../lib/hooks.js';
import { money, date } from '../lib/format.js';

export default function TravelLogs() {
  const lookups = useLookups();

  const columns = [
    { key: 'travel_id', header: 'Trip', className: 'mono strong' },
    { key: 'employee_name', header: 'Employee', className: 'strong', render: (r) => <>{r.employee_name}{r.employee_email && <div className="small muted">{r.employee_email}</div>}</> },
    { key: 'destination', header: 'Destination' },
    { key: 'travel_start_date', header: 'Dates', className: 'small nowrap', render: (r) => <>{date(r.travel_start_date)}{r.travel_end_date && <div className="muted">to {date(r.travel_end_date)}</div>}</> },
    { key: 'po_number', header: 'Billed to', className: 'small', render: (r) => (r.po_number ? <>{r.po_number}<div className="muted">{r.client_name}</div></> : <span className="muted">internal</span>) },
    { key: 'arranged_by', header: 'Arranged by' },
    { key: 'vendor_cost', header: 'Vendor cost', align: 'right', render: (r) => money(r.vendor_cost) },
    { key: 'employee_claims', header: 'Claims', align: 'right', render: (r) => money(r.employee_claims) },
    { key: 'total_travel_cost', header: 'Total', align: 'right', className: 'strong', render: (r) => money(r.total_travel_cost) },
    { key: 'vendor_invoice_status', header: 'Vendor invoice', render: (r) => <Badge>{r.vendor_invoice_status}</Badge> },
    { key: 'reimbursement_status', header: 'Reimbursement', render: (r) => <Badge>{r.reimbursement_status}</Badge> },
  ];

  const fields = [
    { name: 'travel_id', label: 'Travel ID', required: true, hint: 'e.g. TRV-2026-027 — the key tying the three travel records together' },
    { name: 'po_number', label: 'Billed to PO', type: 'select', options: lookups.purchase_orders.map((p) => ({ value: p.po_number, label: `${p.po_number} — ${p.client_name}` })), hint: 'Leave blank for internal travel' },
    { name: 'employee_name', label: 'Employee', required: true },
    { name: 'employee_email', label: 'Employee email', type: 'email' },
    { name: 'service_delivered', label: 'Service delivered', type: 'combo', options: lookups.services, span: 2 },
    { name: 'purpose', label: 'Purpose of travel', span: 2 },
    { name: 'destination', label: 'Destination' },
    { name: 'travel_start_date', label: 'Travel start', type: 'date' },
    { name: 'travel_end_date', label: 'Travel end', type: 'date', hint: 'Starts the vendor invoice clock' },
    { name: 'arranged_by', label: 'Arranged by (vendor)', type: 'combo', options: lookups.travel_vendors },
    { name: 'hr_owner', label: 'HR owner', default: 'HR Team' },
    { name: 'hr_owner_email', label: 'HR owner email', type: 'email', default: 'hr@cetizion.com' },
    { name: 'remarks', label: 'Remarks', type: 'textarea', span: 'all' },
  ];

  return (
    <ListPage
      title="Trips"
      subtitle="HR logs each trip once — vendor bills and employee claims attach to the travel ID"
      resource="travel-logs"
      columns={columns}
      fields={fields}
      newLabel="Trip"
      formTitle="trip"
      formIntro="Log the trip facts once here. Everything downstream — vendor invoices, employee claims, project cost — reads back from this record."
      searchPlaceholder="Search trip, employee, destination…"
      filters={[
        { name: 'vendor_invoice_status', label: 'Vendor invoice', options: ['Awaiting travel', 'Invoice awaited', 'Invoice OVERDUE from vendor', 'Vendor to pay', 'Vendor partly paid', 'Vendor paid'] },
        { name: 'reimbursement_status', label: 'Claims', options: ['No claim', 'To reimburse', 'Partly reimbursed', 'Reimbursed'] },
      ]}
      banner={
        <Alert>
          A vendor must invoice within {lookups.settings?.vendor_invoice_window_days || 15} days of
          the trip ending. Trips past that window are flagged automatically.
        </Alert>
      }
    />
  );
}
