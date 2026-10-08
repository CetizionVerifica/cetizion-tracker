import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { AlertTriangle, BedDouble, Bus, Car, Clock, FileText, FolderKanban, Plane, Receipt, TrainFront, Wallet } from 'lucide-react';
import { PageHeader } from '../App.jsx';
import { Alert, ConfirmDialog, ErrorState, useToast } from '../components/ui.jsx';
import { Chip, RecordPage, RecordRow, RecordSection, RecordStat } from '../components/record.jsx';
import { RecordForm } from '../components/RecordForm.jsx';
import { Button } from '../components/ui/button';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useFetch, useLookups } from '../lib/hooks.js';
import { date, money } from '../lib/format.js';
import { tripFields } from './TravelLogs.jsx';

/** A leg's mark, by how it travelled (#196). */
const MODE_ICON = { flight: Plane, train: TrainFront, bus: Bus, cab: Car, hotel: BedDouble, other: Plane };
const MODES = ['flight', 'train', 'bus', 'cab', 'hotel', 'other'];
const DOC_TYPES = [
  { value: 'ticket', label: 'Ticket' }, { value: 'boarding_pass', label: 'Boarding pass' }, { value: 'vendor_invoice', label: 'Vendor invoice' },
  { value: 'credit_note', label: 'Credit note' }, { value: 'hotel_bill', label: 'Hotel bill' }, { value: 'visa', label: 'Visa' },
  { value: 'travel_approval', label: 'Travel approval' }, { value: 'other', label: 'Other' },
];
const docLabel = (v) => DOC_TYPES.find((d) => d.value === v)?.label || 'File';

/** One leg's form: a flight, a train, a bus, a cab or a hotel stay. */
const legFields = [
  { name: 'mode', label: 'Mode', type: 'select', required: true, options: MODES.map((m) => ({ value: m, label: m[0].toUpperCase() + m.slice(1) })) },
  { name: 'seq', label: 'Order', type: 'number', default: '1' },
  { name: 'from_place', label: 'From', hint: 'Blank for a hotel' },
  { name: 'to_place', label: 'To', hint: 'For a hotel, the city' },
  { name: 'start_date', label: 'Date', type: 'date', hint: 'For a hotel, check-in' },
  { name: 'end_date', label: 'Until', type: 'date', hint: 'For a hotel, check-out' },
  { name: 'start_time', label: 'Departs', hint: 'e.g. 14:30' },
  { name: 'end_time', label: 'Arrives', hint: 'e.g. 16:45' },
  { name: 'provider', label: 'Airline, railway, cab company or hotel' },
  { name: 'service_no', label: 'Flight, train or vehicle no.' },
  { name: 'travel_class', label: 'Class or room' },
  { name: 'pnr_or_ref', label: 'PNR or booking ref' },
  { name: 'rooms', label: 'Rooms', type: 'number' },
  { name: 'guests', label: 'Guests', type: 'number' },
  { name: 'status', label: 'Status', type: 'select', options: [{ value: 'booked', label: 'Booked' }, { value: 'cancelled', label: 'Cancelled' }, { value: 'partly_refunded', label: 'Partly refunded' }], default: 'booked' },
  { name: 'remarks', label: 'Remarks', type: 'textarea', span: 'all' },
];

/**
 * One trip, and both sides of what it cost.
 *
 * Trips, vendor invoices and expense claims were three sidebar items and
 * three queues to learn, which is why eighteen bills have been sitting
 * without an amount on them: the queue that knows is not the queue you
 * were looking at. They stay three objects — they are billed and approved
 * differently — but the trip is where they meet, because the trip is the
 * thing that actually happened.
 *
 * The amount-less bills get the page's one primary action, because that
 * is the real blocker: a bill with no figure cannot be paid, chased or
 * counted against the project.
 */

/** The shape of a vendor bill's state, for the chip beside it. */
function billTone(status) {
  if (/overdue/i.test(status)) return 'late';
  if (/enter (amount|date)|to pay|partial/i.test(status)) return 'waiting';
  if (/paid/i.test(status)) return 'settled';
  return 'plain';
}

function claimTone(status) {
  if (/rejected/i.test(status)) return 'late';
  if (/pending|submitted|to reimburse|partly/i.test(status)) return 'waiting';
  if (/reimbursed|approved/i.test(status)) return 'settled';
  return 'plain';
}

export default function TripDetail() {
  const { travelId } = useParams();
  const toast = useToast();
  const lookups = useLookups();
  const { isHr } = useAuth();
  const [busy, setBusy] = useState(false);
  const [amounts, setAmounts] = useState({});
  const [dialog, setDialog] = useState(null);
  const [upload, setUpload] = useState({ file: null, doc_type: 'ticket', label: '' });

  const { data, loading, error, refetch } = useFetch(() => api.raw(`/travel-logs/${encodeURIComponent(travelId)}/full`), [travelId]);
  const trip = data?.data?.trip;
  const bills = data?.data?.vendor_invoices ?? [];
  const claims = data?.data?.expense_claims ?? [];
  const legs = data?.data?.legs ?? [];
  const lines = data?.data?.invoice_lines ?? [];
  const credits = data?.data?.credit_notes ?? [];
  const files = data?.data?.documents ?? [];
  const close = () => setDialog(null);
  const changed = () => { close(); refetch(); };

  /** A file for this trip: stored, then filed against it with its kind. */
  async function attach(event) {
    event.preventDefault();
    if (!upload.file) return;
    setBusy(true);
    try {
      const doc = await api.uploadDocument(upload.file, 'attachments');
      await api.create('attachments', { entity: 'travel_log', entity_id: trip.travel_id, document_id: doc.data.id, doc_type: upload.doc_type, label: upload.label || null });
      toast('File added.', 'success');
      setUpload({ file: null, doc_type: upload.doc_type, label: '' });
      event.target.reset();
      refetch();
    } catch (err) {
      toast(err.message, 'danger');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await api.remove(dialog.resource, dialog.row.id);
      toast(dialog.done, 'success');
      changed();
    } catch (err) {
      toast(err.message, 'danger');
    } finally {
      setBusy(false);
    }
  }

  /** A bill with no figure is the one thing blocking this trip's costs. */
  const blocked = bills.filter((b) => b.invoice_amount === null || Number(b.invoice_amount) === 0);

  async function saveAmount(bill) {
    const value = amounts[bill.id];
    if (!value) return;
    setBusy(true);
    try {
      await api.update('vendor-invoices', bill.id, { invoice_amount: Number(value) });
      toast('Amount recorded.', 'success');
      setAmounts((current) => ({ ...current, [bill.id]: '' }));
      refetch();
    } catch (err) {
      toast(err.message, 'danger');
    } finally {
      setBusy(false);
    }
  }

  if (error) return <><PageHeader title="Trip" /><div className="page"><ErrorState message={error} onRetry={refetch} /></div></>;
  if (loading || !trip) return <><PageHeader title="Trip" /><div className="page"><div className="skeleton" style={{ height: 200 }} /></div></>;

  const when = !trip.travel_end_date || trip.travel_start_date === trip.travel_end_date
    ? date(trip.travel_start_date)
    : `${date(trip.travel_start_date)} – ${date(trip.travel_end_date)}`;

  return (
    <RecordPage
      parent="Trips"
      parentTo="/travel"
      title={`${trip.employee_name || 'Somebody'} → ${trip.destination || 'somewhere'}`}
      mark={<Plane className="size-5" strokeWidth={1.75} aria-hidden="true" />}
      markTone={blocked.length ? 'late' : undefined}
      action={<Button size="sm" variant="outline" className="h-8 px-4 text-[13px]" onClick={() => setDialog({ type: 'trip' })}>Edit trip</Button>}
      facts={[
        <span key="id" className="num text-[12px]">{trip.travel_id}</span>,
        trip.trip_type && <Chip key="type" tone={trip.chargeable ? 'waiting' : 'plain'}>{trip.trip_type}</Chip>,
        trip.cancelled && <Chip key="cancelled" tone="late">Cancelled</Chip>,
        when,
        trip.origin && trip.destination && `${trip.origin} → ${trip.destination}`,
        trip.purpose,
        trip.client_name,
        trip.booking_date && `Booked ${date(trip.booking_date)}`,
        trip.arranged_by && `Arranged by ${trip.arranged_by}`,
      ]}
      stats={
        <>
          <RecordStat
            label="What it cost"
            value={money(trip.total_travel_cost, 'INR', { compact: true })}
            detail={`${money(trip.vendor_cost, 'INR', { compact: true })} to vendors · ${money(trip.employee_claims, 'INR', { compact: true })} claimed`}
          />
          <RecordStat
            label="Vendor bills"
            value={String(trip.vendor_invoice_count ?? bills.length)}
            tone={blocked.length ? 'waiting' : undefined}
            detail={blocked.length
              ? `${blocked.length} with no amount on ${blocked.length === 1 ? 'it' : 'them'}`
              : `${money(trip.vendor_paid, 'INR', { compact: true })} paid`}
          />
          <RecordStat
            label="Employee claims"
            value={String(trip.claim_count ?? claims.length)}
            detail={claims.length ? `${money(trip.employee_reimbursed, 'INR', { compact: true })} reimbursed` : 'Nothing claimed'}
          />
          <RecordStat
            label="Billed to"
            value={trip.po_number || trip.project_id || 'Nothing'}
            tone={trip.po_number || trip.project_id ? undefined : 'waiting'}
            detail={trip.po_number || trip.project_id
              ? trip.service_delivered || 'On this project'
              : 'This trip is not against any order, so it lands in overheads'}
          />
        </>
      }
    >
      {/* The page's one primary action, and it is a form rather than a
          link: the blocker is a missing number, so the place to fix it is
          where the missing number is. */}
      {trip.missing_documents?.length > 0 && (
        <Alert tone="warning">This trip still needs {trip.missing_documents.join(' and ')} on file.</Alert>
      )}

      {blocked.length > 0 && (
        <RecordSection
          title="Bills waiting on an amount"
          hint="they cannot be paid, chased or counted until a figure is entered"
          className="border-waiting/25"
        >
          {blocked.map((bill, i) => (
            <div
              key={bill.id}
              className={`flex flex-wrap items-center gap-3 px-5 py-3 ${i < blocked.length - 1 ? 'border-b border-border' : ''}`}
            >
              <Receipt className="size-4 shrink-0 text-waiting" strokeWidth={1.75} aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                {bill.travel_vendor || 'Vendor not named'}
                {bill.vendor_invoice_no && <span className="num text-[12px] text-secondary-text"> · {bill.vendor_invoice_no}</span>}
              </span>
              {bill.pay_by && (
                <span className="shrink-0 text-[12px] text-muted-foreground">due {date(bill.pay_by)}</span>
              )}
              <form
                className="flex shrink-0 items-center gap-2"
                onSubmit={(event) => { event.preventDefault(); saveAmount(bill); }}
              >
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  inputMode="decimal"
                  placeholder="Amount"
                  aria-label={`Amount on the bill from ${bill.travel_vendor || 'this vendor'}`}
                  value={amounts[bill.id] ?? ''}
                  onChange={(e) => setAmounts((c) => ({ ...c, [bill.id]: e.target.value }))}
                  className="h-control w-32 rounded-[6px] border border-input bg-muted px-2.5 text-right text-[13px] text-foreground"
                />
                <button
                  type="submit"
                  disabled={busy || !amounts[bill.id]}
                  className="inline-flex h-control items-center rounded-[6px] border border-primary bg-primary px-3 text-[13px] font-semibold text-primary-foreground disabled:opacity-50"
                >
                  Save
                </button>
              </form>
            </div>
          ))}
        </RecordSection>
      )}

      <RecordSection
        title="Legs"
        hint="flights, trains, cabs and hotel stays"
        action={<Button size="sm" variant="outline" className="h-7 px-3 text-[12.5px]" onClick={() => setDialog({ type: 'leg', row: { travel_id: trip.travel_id, seq: legs.length + 1 } })}>Add a leg</Button>}
      >
        {legs.length === 0 ? (
          <p className="px-5 py-4 text-[12.5px] text-muted-foreground">No legs recorded. The import adds them from the travel workbook, or add one here.</p>
        ) : legs.map((leg, i) => {
          const Icon = MODE_ICON[leg.mode] || Plane;
          return (
            <div key={leg.id} className={`flex flex-wrap items-center gap-3 px-5 py-3 ${i < legs.length - 1 ? 'border-b border-border' : ''}`}>
              <Icon className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />
              <span className="min-w-0 flex-1 text-[13px] text-foreground">
                {leg.mode === 'hotel'
                  ? <>{leg.provider || 'Hotel'}{leg.to_place && ` · ${leg.to_place}`} · {leg.nights} night{leg.nights === 1 ? '' : 's'}</>
                  : <>{leg.from_place || '?'} → {leg.to_place || '?'}{leg.provider && <span className="text-secondary-text"> · {leg.provider}{leg.service_no && ` ${leg.service_no}`}</span>}</>}
                <span className="block text-[12px] text-muted-foreground">
                  {date(leg.start_date)}{leg.end_date && leg.end_date !== leg.start_date ? ` – ${date(leg.end_date)}` : ''}
                  {leg.pnr_or_ref && <> · <span className="num">{leg.pnr_or_ref}</span></>}
                </span>
              </span>
              {leg.status !== 'booked' && <Chip tone="late">{leg.status === 'cancelled' ? 'Cancelled' : 'Partly refunded'}</Chip>}
              <Button size="sm" variant="ghost" className="h-7 px-2 text-[12px]" onClick={() => setDialog({ type: 'leg', row: leg })}>Edit</Button>
              <Button size="sm" variant="ghost" className="h-7 px-2 text-[12px]" onClick={() => setDialog({ type: 'delete', resource: 'travel-segments', row: leg, title: 'Remove this leg?', done: 'Leg removed.' })}>Remove</Button>
            </div>
          );
        })}
      </RecordSection>

      <RecordSection title="Vendor bills" hint="what the travel agent charged us; a bill can cover several trips">
        {bills.length === 0 ? (
          <p className="px-5 py-4 text-[12.5px] text-muted-foreground">No bill has been recorded against this trip.</p>
        ) : bills.map((bill, i) => (
          <RecordRow
            key={bill.id}
            icon={Receipt}
            to={`/vendor-invoices/${bill.id}`}
            last={i === bills.length - 1}
            title={<>
              {bill.travel_vendor || 'Vendor not named'}{bill.vendor_invoice_no && <span className="num text-[12px] text-secondary-text"> · {bill.vendor_invoice_no}</span>}
              {bill.trip_count > 1 && <span className="block text-[12px] text-muted-foreground">
                This trip&apos;s share {money(lines.filter((l) => l.vendor_invoice_id === bill.id).reduce((n, l) => n + Number(l.net_cost || 0), 0))} of a bill covering {bill.trip_count} trips
              </span>}
              {credits.filter((c) => c.against_invoice_id === bill.id).map((c) => (
                <span key={c.id} className="block text-[12px] text-muted-foreground">
                  {c.kind === 'cancellation_note' ? 'Cancellation note' : 'Credit note'} <span className="num">{c.credit_note_no}</span>: {money(c.refund_amount)} back{c.cancellation_charges ? `, ${money(c.cancellation_charges)} charged` : ''}
                </span>
              ))}
            </>}
            amount={bill.invoice_amount === null ? '—' : money(bill.invoice_amount)}
            chip={
              <Chip
                tone={billTone(bill.payment_status || '')}
                icon={/overdue/i.test(bill.payment_status || '') ? AlertTriangle : /enter/i.test(bill.payment_status || '') ? Clock : undefined}
              >
                {bill.payment_status}
              </Chip>
            }
          />
        ))}
      </RecordSection>

      <RecordSection title="Employee claims" hint="what the traveller paid and wants back">
        {claims.length === 0 ? (
          <p className="px-5 py-4 text-[12.5px] text-muted-foreground">Nothing claimed for this trip.</p>
        ) : claims.map((claim, i) => (
          <RecordRow
            key={claim.id}
            icon={Wallet}
            to="/expense-claims"
            last={i === claims.length - 1}
            title={<><span className="num text-[12px]">{claim.claim_id}</span> · {claim.expense_category || 'Uncategorised'}</>}
            amount={money(claim.amount_claimed)}
            chip={<Chip tone={claimTone(claim.status || claim.approval_status || '')}>{claim.status || claim.approval_status}</Chip>}
          />
        ))}
      </RecordSection>

      <RecordSection title="Documents" hint="tickets, boarding passes, the vendor's invoice, hotel bills">
        {files.length === 0 && <p className="px-5 py-3 text-[12.5px] text-muted-foreground">Nothing on file yet.</p>}
        {files.map((file) => (
          <div key={file.id} className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-2.5">
            <FileText className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />
            <a className="min-w-0 flex-1 truncate text-[13px] text-foreground underline underline-offset-2" href={api.documentUrl(file.document_id)} target="_blank" rel="noreferrer">
              {file.label || file.file_name}
            </a>
            <Chip>{docLabel(file.doc_type)}</Chip>
            <Button size="sm" variant="ghost" className="h-7 px-2 text-[12px]" onClick={() => setDialog({ type: 'delete', resource: 'attachments', row: file, title: 'Remove this file from the trip?', done: 'File removed.' })}>Remove</Button>
          </div>
        ))}
        <form className="flex flex-wrap items-center gap-2 px-5 py-3" onSubmit={attach}>
          <input type="file" aria-label="File to add" className="text-[12.5px]" onChange={(e) => setUpload((u) => ({ ...u, file: e.target.files?.[0] || null }))} />
          <select aria-label="What the file is" className="h-control rounded-[6px] border border-input bg-muted px-2 text-[12.5px]" value={upload.doc_type} onChange={(e) => setUpload((u) => ({ ...u, doc_type: e.target.value }))}>
            {DOC_TYPES.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
          </select>
          <input aria-label="Label" placeholder="Label (optional)" className="h-control w-44 rounded-[6px] border border-input bg-muted px-2.5 text-[12.5px]" value={upload.label} onChange={(e) => setUpload((u) => ({ ...u, label: e.target.value }))} />
          <Button size="sm" className="h-8 px-4 text-[13px]" type="submit" disabled={busy || !upload.file}>Add file</Button>
        </form>
      </RecordSection>

      {/* Billed to the client: a chargeable trip names the payment stage whose
          invoice carried it (#196 §4.2). The stages are sales records, so the
          travel desk does not see this. */}
      {!isHr && trip.chargeable && trip.po_number && (
        <BilledStage trip={trip} onChanged={refetch} />
      )}

      {(trip.project_id || trip.po_number) && (
        <RecordSection title="What this trip was for">
          {trip.project_id && (
            <RecordRow
              icon={FolderKanban}
              to={`/projects/${encodeURIComponent(trip.project_id)}`}
              title={<><span className="num text-[12px]">{trip.project_id}</span> · {trip.client_name}</>}
              last={!trip.po_number}
            />
          )}
          {trip.po_number && (
            <RecordRow
              icon={Receipt}
              to={`/purchase-orders/${encodeURIComponent(trip.po_number)}`}
              title={<><span className="num text-[12px]">{trip.po_number}</span> · {trip.service_delivered || 'the order this is billed to'}</>}
              last
            />
          )}
        </RecordSection>
      )}

      {dialog?.type === 'trip' && (
        <RecordForm title="Edit trip" resource="travel-logs" record={trip} fields={tripFields(lookups)} onClose={close} onSaved={changed} />
      )}
      {dialog?.type === 'leg' && (
        <RecordForm title={dialog.row.id ? 'Edit leg' : 'Add a leg'} resource="travel-segments" record={dialog.row} fields={[{ name: 'travel_id', label: 'Trip', type: 'hidden' }, ...legFields]} onClose={close} onSaved={changed} />
      )}
      {dialog?.type === 'delete' && (
        <ConfirmDialog title={dialog.title} message="This cannot be undone." confirmLabel="Remove" busy={busy} onConfirm={remove} onClose={close} />
      )}
    </RecordPage>
  );
}

/**
 * The payment stage whose invoice billed this trip to the client.
 *
 * Through its own route, not the trip's edit form: billed_stage_id is a
 * protected field on the travel-logs resource, so a PATCH naming it is
 * refused whoever sends it (#214). The route is addressed by travel_id, as
 * the trip's other workflow route is.
 */
function BilledStage({ trip, onChanged }) {
  const toast = useToast();
  const { data } = useFetch(() => api.list('payment-stages', { po_number: trip.po_number }), [trip.po_number]);
  const stages = (data?.data ?? []).filter((s) => s.invoice_no);
  async function set(value) {
    try {
      await api.action(`/travel-logs/${encodeURIComponent(trip.travel_id)}/billed-stage`, { billed_stage_id: value ? Number(value) : null });
      toast(value ? 'Recorded as billed.' : 'No longer marked as billed.', 'success');
      onChanged();
    } catch (err) {
      toast(err.message, 'danger');
    }
  }
  return (
    <RecordSection title="Billed to the client" hint="the invoice that carried this trip's cost">
      <div className="flex flex-wrap items-center gap-3 px-5 py-3">
        <select aria-label="Invoice that billed this trip" className="h-control rounded-[6px] border border-input bg-muted px-2 text-[13px]" value={trip.billed_stage_id ?? ''} onChange={(e) => set(e.target.value)}>
          <option value="">Not billed yet</option>
          {stages.map((s) => <option key={s.id} value={s.id}>{s.invoice_no} · {s.stage_name}</option>)}
        </select>
        {!stages.length && <span className="text-[12.5px] text-muted-foreground">No invoice has been raised on {trip.po_number} yet.</span>}
      </div>
    </RecordSection>
  );
}
