import { useNavigate } from 'react-router-dom';
import { ArrowRight, Clock } from 'lucide-react';
import { ListPage } from '../components/ListPage.jsx';
import { useLookups } from '../lib/hooks.js';
import { useAuth } from '../lib/auth.jsx';
import { TravelDocumentsUpload } from '../components/TravelDocumentsUpload.jsx';
import { MoneyBanner, shortDate } from '../components/money.jsx';
import { Tone, useRows, useTotal } from '../components/sales.jsx';
import { StateBadge, TRIP_BILL, TRIP_CLAIMS, count, tripWhen, typeLine } from '../components/travel.jsx';
import { money } from '../lib/format.js';

const options = (rows, label) => rows.map((r) => ({ value: String(r.id), label: label(r) }));
const OVERDUE = 'Invoice OVERDUE from vendor';

/**
 * The trip form, shared by the list and the trip page (#196 §6): the trip
 * facts, the trip type, what it is billed to, and who booked it — grouped
 * so twenty fields read as five short steps (Wave 6). The Travel ID is
 * locked once the trip exists: bills, legs and claims point at it.
 */
export function tripFields(lookups, record = null) {
  return [
    { name: 'travel_id', label: 'Travel ID', required: true, group: 'The trip', disabled: Boolean(record), hint: record ? "Set when the trip was created: bills, legs and claims point at it, so it can't change." : 'e.g. TRV-2026-027: the key tying the travel records together' },
    { name: 'trip_type_id', label: 'Trip type', type: 'select', group: 'The trip', options: options(lookups.trip_types, (t) => `${t.name}${t.chargeable ? ' (chargeable)' : ''}`), hint: 'Not set: chargeable when it has a PO or project, non-chargeable without.' },
    { name: 'cancelled', label: 'Cancelled', type: 'boolean', default: 'false', group: 'The trip', falseLabel: 'No, it went ahead', trueLabel: 'Yes, the whole trip was cancelled', hint: 'A cancelled leg is marked on the leg, by a credit note.' },
    { name: 'vendor_id', label: 'Booked through (vendor)', type: 'select', group: 'The trip', options: options(lookups.travel_vendor_list, (v) => v.name) },
    { name: 'po_number', label: 'Billed to PO', type: 'select', group: 'What it was for', options: lookups.purchase_orders.map((p) => ({ value: p.po_number, label: `${p.po_number} — ${p.client_name}` })), hint: 'Leave it blank for internal travel.' },
    { name: 'project_id', label: 'Project (no PO yet)', type: 'select', group: 'What it was for', options: lookups.projects.map((p) => ({ value: p.project_id, label: `${p.project_id} — ${p.client_name}${p.service_request_no ? ` · ${p.service_request_no}` : ''}` })), hint: 'Only when there is no PO yet; with a PO the project is the PO\'s. The service request no. helps you find it.' },
    { name: 'client_label', label: 'Client or purpose', group: 'What it was for', placeholder: 'e.g. Office audit, a conference', hint: 'For travel that is not a client\'s.' },
    // A combobox: the travel desk may type what the booking says (G2-13).
    { name: 'service_delivered', label: 'Service delivered', type: 'combo', options: lookups.services, group: 'What it was for' },
    { name: 'purpose', label: 'Purpose of travel', span: 2, group: 'What it was for', placeholder: 'e.g. Stage 2 audit at the Mysuru plant' },
    { name: 'staff_id', label: 'Traveller (staff)', type: 'select', group: 'Who travelled', options: options(lookups.staff, (s) => s.name) },
    { name: 'employee_name', label: 'Employee', required: true, group: 'Who travelled', hint: 'As booked, if different' },
    { name: 'employee_email', label: 'Employee email', type: 'email', span: 2, group: 'Who travelled' },
    { name: 'origin', label: 'From', group: 'Where and when' },
    { name: 'destination', label: 'Destination', group: 'Where and when', placeholder: 'City' },
    { name: 'booking_date', label: 'Booked on', type: 'date', group: 'Where and when' },
    { name: 'travel_start_date', label: 'Travel start', type: 'date', group: 'Where and when' },
    { name: 'travel_end_date', label: 'Travel end', type: 'date', group: 'Where and when', hint: `Starts the vendor's ${lookups.settings?.vendor_invoice_window_days || 15} days to send the bill.` },
    { name: 'hr_owner', label: 'HR owner', default: 'HR Team', group: 'Travel desk' },
    { name: 'hr_owner_email', label: 'HR owner email', type: 'email', default: 'hr@cetizion.com', group: 'Travel desk' },
    { name: 'remarks', label: 'Remarks', type: 'textarea', span: 'all', group: 'Travel desk', placeholder: 'Anything the next person should know' },
  ];
}

/** "Mumbai → Pune" */
const route = (r) => [r.origin, r.destination].filter(Boolean).join(' → ') || 'No route yet';
/** What a trip still needs on file, in words. */
const needs = (r) => (r.missing_documents?.length ? `Needs ${r.missing_documents.join(' and ')}` : null);
const notBilled = (r) => r.chargeable && !r.billed_stage_id && !r.cancelled && (r.po_number || r.project_id);

export default function TravelLogs() {
  const navigate = useNavigate();
  const lookups = useLookups();
  const { isAdmin, isHr } = useAuth();
  const windowDays = lookups.settings?.vendor_invoice_window_days || 15;

  // The quick filters' counts, and the overdue trips the banner names.
  const all = useTotal('travel-logs', {});
  const cancelled = useTotal('travel-logs', { cancelled: 'true' });
  const late = useRows('travel-logs', { vendor_invoice_status: OVERDUE, limit: 20 });

  const columns = [
    {
      key: 'travel_id', header: 'Trip and traveller', className: 'nowrap',
      render: (r) => (
        <>
          <b className="mg-num">{r.travel_id}</b> · <b>{r.employee_name}</b>
          <span className="app-sub2">{typeLine(r)}</span>
          {r.cancelled && <span className="app-sub2 is-late">Cancelled</span>}
        </>
      ),
    },
    { key: 'destination', header: 'Where and when', className: 'nowrap', render: (r) => <>{route(r)}<span className="app-sub2">{tripWhen(r.travel_start_date, r.travel_end_date)}{Number(r.leg_count) > 0 ? ` · ${count(r.leg_count, 'leg')}` : ''}</span></> },
    {
      key: 'po_number', header: 'Billed to', min: 130,
      render: (r) => (r.po_number || r.project_id
        ? <><b className="mg-num">{r.po_number ? `PO ${r.po_number}` : r.project_id}</b><span className="app-sub2 is-wrap">{[r.client_name, !r.po_number && 'no PO', notBilled(r) && 'not billed yet'].filter(Boolean).join(' · ')}</span></>
        : <><b>Internal</b><span className="app-sub2 is-wrap">{r.client_label || 'Not a client\'s'}</span></>),
    },
    {
      key: 'total_travel_cost', header: 'Cost', align: 'right',
      render: (r) => (
        <>
          <b className={Number(r.total_travel_cost) ? undefined : 'text-muted-foreground'}>{Number(r.total_travel_cost) ? money(r.total_travel_cost) : '—'}</b>
          <span className="app-sub2">{Number(r.vendor_invoice_count) === 0 ? 'nothing billed yet' : `vendor ${money(r.vendor_cost)}${Number(r.employee_claims) ? ` · claims ${money(r.employee_claims)}` : ''}`}</span>
        </>
      ),
    },
    { key: 'vendor_invoice_status', header: "Vendor's bill", className: 'nowrap', render: (r) => <><StateBadge map={TRIP_BILL} value={r.vendor_invoice_status} /><span className="app-sub2">{r.arranged_by || 'Vendor not recorded'}</span></> },
    {
      key: 'missing_documents', header: 'Documents', min: 120,
      render: (r) => (needs(r)
        ? <Tone tone="wait" className="app-badge-wrap">{needs(r)}</Tone>
        : <span className="text-[12.5px] font-semibold text-ok">{count(r.document_count, 'file')}, none missing</span>),
    },
    { key: 'reimbursement_status', header: 'Claims', render: (r) => <StateBadge map={TRIP_CLAIMS} value={r.reimbursement_status} /> },
  ];

  const lateRows = late.rows;
  const banner = lateRows.length ? (
    (rows, { filters, setFilter }) => (
      <MoneyBanner
        tone="wait"
        icon={Clock}
        title={`${count(late.total ?? lateRows.length, "trip's bill", "trips' bills")} ${(late.total ?? lateRows.length) === 1 ? 'is' : 'are'} overdue from the vendor.`}
        action={filters.vendor_invoice_status === OVERDUE ? null : (
          <button type="button" className="mg-btn mg-btn--sm" onClick={() => setFilter('vendor_invoice_status', OVERDUE)}>{lateRows.length === 1 ? 'Show it' : 'Show them'}</button>
        )}
      >
        A vendor must invoice within {windowDays} days of the trip ending
        {lateRows.length === 1 ? `: ${lateRows[0].travel_id} ended ${shortDate(lateRows[0].travel_end_date)} and ${lateRows[0].arranged_by || 'its vendor'} hasn't billed it.` : `: ${lateRows.slice(0, 4).map((t) => t.travel_id).join(', ')}${lateRows.length > 4 ? ' and more' : ''} haven't been billed.`}
      </MoneyBanner>
    )
  ) : (
    // G1-11: the standing rule, when nothing is late.
    <MoneyBanner tone="info" icon={Clock} title="No vendor bill is overdue.">
      A vendor must invoice within {windowDays} days of the trip ending. Trips past that window are flagged here automatically.
    </MoneyBanner>
  );

  return (
    <ListPage
      title="Trips"
      subtitle="Log each trip once. Its legs, the vendor's bills and employee claims all attach to its Travel ID."
      resource="travel-logs"
      noun="trips"
      allLabel="All trips"
      columns={columns}
      // The trip is where its legs, vendor bills and employee claims meet, so
      // the row opens the trip rather than a form over the list.
      onRowClick={(row) => navigate(`/travel/${encodeURIComponent(row.travel_id)}`)}
      rowMenu={(r) => [{ label: 'Open the trip', icon: ArrowRight, onSelect: () => navigate(`/travel/${encodeURIComponent(r.travel_id)}`) }]}
      fields={(record) => tripFields(lookups, record)}
      formSize="lg"
      newLabel="Trip"
      formTitle="trip"
      formSubmitLabel="Create trip"
      formIntro="Log the trip once. Legs, vendor bills, claims and project cost all read back from it."
      deleteTitle={(r) => `Delete trip ${r.travel_id}?`}
      deleteText={(r) => `${r.employee_name} · ${route(r)} · ${tripWhen(r.travel_start_date, r.travel_end_date)}. This cannot be undone. Its ${count(r.leg_count, 'leg')} and ${count(r.document_count, 'file')} go with it; its vendor bills and claims stay, but no longer count towards any trip or project.`}
      // HR's exports are refused by the server, so HR isn't offered them.
      exportable={!isHr}
      // Tickets and invoice PDFs by the hundred, filed by their names (#196 §5.4).
      extraActions={isAdmin || isHr ? <TravelDocumentsUpload /> : null}
      searchPlaceholder="Search trip, traveller, place, PO or project"
      phoneBelow={1024}
      chips={({ filters, setFilters }) => {
        const on = (key, value) => filters[key] === value;
        const only = (key, value) => setFilters(on(key, value) ? {} : { [key]: value });
        return (
          <>
            <button type="button" className="mg-chip" aria-pressed={Object.keys(filters).length === 0} onClick={() => setFilters({})}>All trips{all.total != null && <span className="mg-count">{all.total}</span>}</button>
            <button type="button" className={`mg-chip ${late.total ? 'is-late' : ''}`} aria-pressed={on('vendor_invoice_status', OVERDUE)} onClick={() => only('vendor_invoice_status', OVERDUE)}>Bill overdue from vendor{late.total != null && <span className="mg-count">{late.total}</span>}</button>
            <button type="button" className="mg-chip" aria-pressed={on('cancelled', 'true')} onClick={() => only('cancelled', 'true')}>Cancelled{cancelled.total != null && <span className="mg-count">{cancelled.total}</span>}</button>
          </>
        );
      }}
      phone={(r) => ({
        title: `${r.travel_id} · ${r.employee_name}`,
        to: `/travel/${encodeURIComponent(r.travel_id)}`,
        amount: Number(r.total_travel_cost) ? money(r.total_travel_cost) : '—',
        meta: [route(r), tripWhen(r.travel_start_date, r.travel_end_date), r.client_name || r.client_label || 'Internal', r.trip_type, r.cancelled && 'cancelled', needs(r)].filter(Boolean).join(' · '),
        state: <StateBadge map={TRIP_BILL} value={r.vendor_invoice_status} />,
      })}
      filters={[
        { name: 'trip_type_id', label: 'Type', options: lookups.trip_types.map((t) => ({ value: String(t.id), label: t.name })) },
        { name: 'vendor_invoice_status', label: "Vendor's bill", options: Object.entries(TRIP_BILL).map(([value, [, label]]) => ({ value, label })) },
        { name: 'reimbursement_status', label: 'Claims', options: Object.entries(TRIP_CLAIMS).map(([value, [, label]]) => ({ value, label })) },
        { name: 'vendor_id', label: 'Vendor', options: lookups.travel_vendor_list.map((v) => ({ value: String(v.id), label: v.name })) },
        { name: 'chargeable', label: 'Chargeable', options: [{ value: 'true', label: 'Chargeable' }, { value: 'false', label: 'Not chargeable' }] },
        { name: 'cancelled', label: 'Cancelled', options: [{ value: 'true', label: 'Cancelled' }, { value: 'false', label: 'Went ahead' }] },
      ]}
      extraFilterLabels={{ po_number: 'PO', project_id: 'Project', employee_name: 'Traveller', staff_id: 'Traveller' }}
      banner={banner}
    />
  );
}
