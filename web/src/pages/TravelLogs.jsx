import { useNavigate } from 'react-router-dom';
import { ListPage } from '../components/ListPage.jsx';
import { Badge, Alert } from '../components/ui.jsx';
import { useLookups } from '../lib/hooks.js';
import { money, date } from '../lib/format.js';

const options = (rows, label) => rows.map((r) => ({ value: String(r.id), label: label(r) }));

/**
 * The trip form, shared by the list and the trip page (#196 §6): the trip
 * facts, the trip type, what it is billed to, and who booked it.
 */
export function tripFields(lookups) {
  return [
    { name: 'travel_id', label: 'Travel ID', required: true, hint: 'e.g. TRV-2026-027 — the key tying the travel records together' },
    { name: 'trip_type_id', label: 'Trip type', type: 'select', options: options(lookups.trip_types, (t) => `${t.name}${t.chargeable ? ' (chargeable)' : ''}`), hint: 'Left blank: Chargeable with a PO or project, Non-chargeable without' },
    { name: 'po_number', label: 'Billed to PO', type: 'select', options: lookups.purchase_orders.map((p) => ({ value: p.po_number, label: `${p.po_number} — ${p.client_name}` })), hint: 'Leave blank for internal travel' },
    { name: 'project_id', label: 'Project (no PO yet)', type: 'select', options: lookups.projects.map((p) => ({ value: p.project_id, label: `${p.project_id} — ${p.client_name}${p.service_request_no ? ` · ${p.service_request_no}` : ''}` })), hint: 'Only when there is no PO; with a PO the project is the PO\'s' },
    { name: 'client_label', label: 'Client or purpose', hint: 'For travel that is not a client\'s: Office audit, a conference' },
    { name: 'staff_id', label: 'Traveller (staff)', type: 'select', options: options(lookups.staff, (s) => s.name) },
    { name: 'employee_name', label: 'Employee', required: true, hint: 'As booked' },
    { name: 'employee_email', label: 'Employee email', type: 'email' },
    { name: 'service_delivered', label: 'Service delivered', type: 'combo', options: lookups.services, span: 2 },
    { name: 'purpose', label: 'Purpose of travel', span: 2 },
    { name: 'origin', label: 'From' },
    { name: 'destination', label: 'Destination' },
    { name: 'booking_date', label: 'Booked on', type: 'date' },
    { name: 'travel_start_date', label: 'Travel start', type: 'date' },
    { name: 'travel_end_date', label: 'Travel end', type: 'date', hint: 'Starts the vendor invoice clock' },
    { name: 'vendor_id', label: 'Booked through (vendor)', type: 'select', options: options(lookups.travel_vendor_list, (v) => v.name) },
    { name: 'cancelled', label: 'Cancelled', type: 'boolean', default: 'false', hint: 'The whole trip did not happen' },
    { name: 'hr_owner', label: 'HR owner', default: 'HR Team' },
    { name: 'hr_owner_email', label: 'HR owner email', type: 'email', default: 'hr@cetizion.com' },
    { name: 'remarks', label: 'Remarks', type: 'textarea', span: 'all' },
  ];
}

export default function TravelLogs() {
  const navigate = useNavigate();
  const lookups = useLookups();

  const columns = [
    { key: 'travel_id', header: 'Trip', className: 'mono strong' },
    { key: 'employee_name', header: 'Employee', className: 'strong', render: (r) => <>{r.employee_name}{r.employee_email && <div className="small muted">{r.employee_email}</div>}</> },
    { key: 'trip_type', header: 'Type', className: 'small', render: (r) => <>{r.trip_type}{r.cancelled && <div className="muted">cancelled</div>}</> },
    { key: 'destination', header: 'Where', render: (r) => <>{r.origin ? `${r.origin} → ` : ''}{r.destination}{r.leg_count > 0 && <div className="small muted">{r.leg_count} leg{r.leg_count === 1 ? '' : 's'}</div>}</> },
    { key: 'travel_start_date', header: 'Dates', className: 'small nowrap', render: (r) => <>{date(r.travel_start_date)}{r.travel_end_date && <div className="muted">to {date(r.travel_end_date)}</div>}</> },
    { key: 'po_number', header: 'Billed to', className: 'small', render: (r) => (r.po_number || r.project_id ? <>{r.po_number || r.project_id}<div className="muted">{r.client_name}</div></> : <span className="muted">{r.client_label || 'internal'}</span>) },
    { key: 'arranged_by', header: 'Vendor' },
    { key: 'vendor_cost', header: 'Vendor cost', align: 'right', render: (r) => money(r.vendor_cost) },
    { key: 'employee_claims', header: 'Claims', align: 'right', render: (r) => money(r.employee_claims) },
    { key: 'total_travel_cost', header: 'Total', align: 'right', className: 'strong', render: (r) => money(r.total_travel_cost) },
    { key: 'vendor_invoice_status', header: 'Vendor invoice', render: (r) => <Badge>{r.vendor_invoice_status}</Badge> },
    { key: 'missing_documents', header: 'Documents', className: 'small', render: (r) => (r.missing_documents?.length ? <span className="text-waiting">needs {r.missing_documents.join(', ')}</span> : <span className="muted">✓ {r.document_count || 0}</span>) },
    { key: 'reimbursement_status', header: 'Reimbursement', render: (r) => <Badge>{r.reimbursement_status}</Badge> },
  ];

  return (
    <ListPage
      title="Trips"
      subtitle="HR logs each trip once — its legs, the vendor's bills and employee claims attach to the travel ID"
      resource="travel-logs"
      columns={columns}
      // The trip is where its legs, vendor bills and employee claims meet, so
      // the row opens the trip rather than a form over the list.
      onRowClick={(row) => navigate(`/travel/${encodeURIComponent(row.travel_id)}`)}
      fields={tripFields(lookups)}
      newLabel="Trip"
      formTitle="trip"
      formIntro="Log the trip facts once here. Its legs, vendor invoices, employee claims and project cost all read back from this record."
      searchPlaceholder="Search trip, employee, destination…"
      filters={[
        { name: 'trip_type_id', label: 'Type', options: lookups.trip_types.map((t) => ({ value: String(t.id), label: t.name })) },
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
