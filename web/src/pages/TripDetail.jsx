import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  BedDouble, Bus, Car, ClipboardList, FileText, FolderKanban, Paperclip, Pencil, Plane, Plus, Receipt, TrainFront, Trash2, Wallet,
} from 'lucide-react';
import { ConfirmDialog, FileDrop, useToast } from '../components/ui.jsx';
import { RailPerson, RecordMenuItem, RecordPage, RecordStat } from '../components/record.jsx';
import { RecordForm } from '../components/RecordForm.jsx';
import { Sec, Tone, useTab } from '../components/sales.jsx';
import { StateCard } from '../components/daily.jsx';
import { MoneyBanner, shortDate } from '../components/money.jsx';
import { BILL, CLAIM, typeLine, RailCard, RailLink, RecordState, StateBadge, TabsPanel, count, tripWhen } from '../components/travel.jsx';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useFetch, useLookups } from '../lib/hooks.js';
import { money } from '../lib/format.js';
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
const time = (t) => (t ? String(t).slice(0, 5) : '');

/** One leg's form: a flight, a train, a bus, a cab or a hotel stay. Departs and Arrives are time fields. */
const legFields = [
  { name: 'mode', label: 'Mode', type: 'select', required: true, options: MODES.map((m) => ({ value: m, label: m[0].toUpperCase() + m.slice(1) })) },
  { name: 'seq', label: 'Order', type: 'number', default: '1', hint: 'Its place in the trip' },
  { name: 'from_place', label: 'From', hint: 'Blank for a hotel' },
  { name: 'to_place', label: 'To', hint: 'For a hotel, the city' },
  { name: 'start_date', label: 'Date', type: 'date', hint: 'For a hotel, check-in' },
  { name: 'end_date', label: 'Until', type: 'date', hint: 'For a hotel, check-out' },
  { name: 'start_time', label: 'Departs', type: 'time' },
  { name: 'end_time', label: 'Arrives', type: 'time' },
  { name: 'provider', label: 'Airline, railway, cab company or hotel' },
  { name: 'service_no', label: 'Flight, train or vehicle no.' },
  { name: 'travel_class', label: 'Class or room' },
  { name: 'pnr_or_ref', label: 'PNR or booking ref' },
  { name: 'rooms', label: 'Rooms', type: 'number' },
  { name: 'guests', label: 'Guests', type: 'number' },
  { name: 'status', label: 'Status', type: 'select', span: 2, options: [{ value: 'booked', label: 'Booked' }, { value: 'cancelled', label: 'Cancelled' }, { value: 'partly_refunded', label: 'Partly refunded' }], default: 'booked', hint: 'A credit note against this leg sets it for you.' },
  { name: 'remarks', label: 'Remarks', type: 'textarea', span: 'all' },
];

/** "Mumbai → Bengaluru · IndiGo 6E 6127" / "Hotel Chamundi View · Mysuru · 2 nights" */
function legTitle(leg) {
  if (leg.mode === 'hotel') return { title: leg.provider || 'Hotel', provider: [leg.to_place, leg.nights != null && count(leg.nights, 'night')].filter(Boolean).join(' · ') };
  return { title: `${leg.from_place || '?'} → ${leg.to_place || '?'}`, provider: [leg.provider, leg.service_no].filter(Boolean).join(' ') };
}
function legMeta(leg) {
  const dates = leg.mode === 'hotel' && leg.end_date ? tripWhen(leg.start_date, leg.end_date) : shortDate(leg.start_date);
  const times = [time(leg.start_time), time(leg.end_time)].filter(Boolean).join('–');
  const rooms = leg.mode === 'hotel' && (leg.rooms || leg.guests) ? [leg.rooms && count(leg.rooms, 'room'), leg.guests && count(leg.guests, 'guest')].filter(Boolean).join(', ') : null;
  return [dates, times, rooms, leg.pnr_or_ref && (leg.mode === 'hotel' ? `booking ${leg.pnr_or_ref}` : `PNR ${leg.pnr_or_ref}`)].filter(Boolean).join(' · ');
}

/**
 * One trip, and both sides of what it cost (Wave 6 shape).
 *
 * The trip is where its legs, the vendor's bills and the traveller's
 * claims meet. A bill with no amount is the real blocker — it cannot be
 * paid, chased or counted against the project — so it sits above the tabs
 * with the field that fixes it; a missing file says how to add it. The
 * rest is tabs: Legs, Costs, Documents and (for admin and sales) Billed to
 * the client, beside a rail of what the trip was for, the people and the
 * remarks. The travel desk sees what it was for as text, not links that
 * would only bounce it.
 */
export default function TripDetail() {
  const { travelId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const lookups = useLookups();
  const { isHr } = useAuth();
  const [busy, setBusy] = useState(false);
  const [amounts, setAmounts] = useState({});
  const [dialog, setDialog] = useState(null);
  const [upload, setUpload] = useState({ file: null, doc_type: 'ticket', label: '', key: 0 });
  const tabKeys = ['legs', 'costs', 'docs', ...(isHr ? [] : ['billing'])];
  const [tab, setTab] = useTab(tabKeys);

  const { data, loading, error, errorStatus, refetch } = useFetch(() => api.raw(`/travel-logs/${encodeURIComponent(travelId)}/full`), [travelId]);
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
      setUpload((u) => ({ file: null, doc_type: u.doc_type, label: '', key: u.key + 1 }));
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
      if (dialog.resource === 'travel-logs') { navigate('/travel'); return; }
      changed();
    } catch (err) {
      toast(err.message, 'danger');
    } finally {
      setBusy(false);
    }
  }

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

  if (error || loading || !trip) {
    return <RecordState parent="Trips" parentTo="/travel" crumb={travelId} noun="trip" loading={!error} missing={errorStatus === 404} error={error} onRetry={refetch} />;
  }

  /** A bill with no figure is the one thing blocking this trip's costs. */
  const blocked = bills.filter((b) => b.invoice_amount === null || Number(b.invoice_amount) === 0);
  const missingInvoice = trip.missing_documents?.includes('vendor invoice');
  const share = (bill) => lines.filter((l) => l.vendor_invoice_id === bill.id).reduce((n, l) => n + Number(l.net_cost || 0), 0);
  const billedTo = trip.po_number ? `PO ${trip.po_number}` : trip.project_id || null;
  const pendingClaims = claims.filter((c) => c.status === 'Pending approval');

  const tabs = [
    { key: 'legs', label: 'Legs', count: legs.length || undefined },
    { key: 'costs', label: 'Costs', count: bills.length + claims.length || undefined },
    { key: 'docs', label: 'Documents', count: files.length || undefined },
    ...(isHr ? [] : [{ key: 'billing', label: 'Billed to the client' }]),
  ];

  const blockedPanel = blocked.length > 0 && (
    <section className="mg-glass mg-glass--strong app-blocked" data-a="rise" aria-labelledby="trip-blocked">
      <div className="app-blocked__head">
        <h2 id="trip-blocked">{blocked.length === 1 ? '1 bill is waiting on an amount' : `${blocked.length} bills are waiting on an amount`}</h2>
        <span>It can't be paid, chased or counted until the figure from the bill is entered.</span>
      </div>
      {blocked.map((bill) => (
        <form key={bill.id} className="app-blocked__row" onSubmit={(e) => { e.preventDefault(); saveAmount(bill); }}>
          <span className="app-line__mark is-wait"><Receipt strokeWidth={1.8} aria-hidden="true" /></span>
          <span className="min-w-0">
            <Link className="app-line__title" to={`/vendor-invoices/${bill.id}`}>{bill.travel_vendor || 'Vendor not named'}{bill.vendor_invoice_no && ` · ${bill.vendor_invoice_no}`}</Link>
            <span className="app-line__meta">{[bill.invoice_date ? `Dated ${shortDate(bill.invoice_date)}` : 'No date yet', bill.pay_by && `pay by ${shortDate(bill.pay_by)}`, bill.document_id ? 'PDF on file' : 'no PDF on file yet'].filter(Boolean).join(' · ')}</span>
          </span>
          <label className="mg-field app-blocked__amt">
            <span className="mg-field__label">Amount on the bill</span>
            <input
              className="mg-input mg-input--money"
              type="number" min="0" step="0.01" inputMode="decimal" placeholder="0"
              aria-label={`Amount on the bill from ${bill.travel_vendor || 'this vendor'}`}
              value={amounts[bill.id] ?? ''}
              onChange={(e) => setAmounts((c) => ({ ...c, [bill.id]: e.target.value }))}
            />
          </label>
          <button type="submit" className="mg-btn mg-btn--primary" disabled={busy || !amounts[bill.id]}>Save the amount</button>
        </form>
      ))}
    </section>
  );

  const missingBanner = trip.missing_documents?.length > 0 && (
    <MoneyBanner
      tone="wait"
      icon={Paperclip}
      title={`This trip still needs ${trip.missing_documents.map((d) => (d === 'vendor invoice' ? "the vendor's invoice" : `a ${d}`)).join(' and ')} on file.`}
      action={<button type="button" className="mg-btn mg-btn--sm" onClick={() => setTab('docs')}>Add the file</button>}
    >
      Add the PDF under Documents{blocked[0]?.vendor_invoice_no ? `, or upload it from Trips named ${blocked[0].vendor_invoice_no.replace(/\//g, '-')}.pdf and it files itself` : ', or upload it from Trips named by its invoice number and it files itself'}.
    </MoneyBanner>
  );

  return (
    <>
      <RecordPage
        parent="Trips"
        parentTo="/travel"
        crumb={trip.travel_id}
        eyebrow={`Trip · ${trip.travel_id}`}
        title={`${trip.employee_name || 'Somebody'} → ${trip.destination || 'somewhere'}`}
        mark={<Plane className="size-5" strokeWidth={1.75} aria-hidden="true" />}
        markTone={blocked.length ? 'late' : undefined}
        badges={(
          <>
            <Tone>{typeLine(trip)}</Tone>
            {trip.cancelled && <Tone tone="late">Cancelled</Tone>}
            {blocked.length > 0 && <Tone tone="late">{blocked.length === 1 ? 'A bill has no amount' : `${blocked.length} bills have no amount`}</Tone>}
            {trip.missing_documents?.length > 0 && <Tone tone="wait">Needs {trip.missing_documents.join(' and ')}</Tone>}
          </>
        )}
        action={<button type="button" className="mg-btn" onClick={() => setDialog({ type: 'trip' })}><Pencil className="size-4" strokeWidth={1.8} aria-hidden="true" />Edit trip</button>}
        menu={(
          <>
            <RecordMenuItem onSelect={() => setDialog({ type: 'leg', row: { travel_id: trip.travel_id, seq: legs.length + 1 } })}>Add a leg</RecordMenuItem>
            <RecordMenuItem onSelect={() => setTab('docs')}>Add a file</RecordMenuItem>
            <RecordMenuItem danger onSelect={() => setDialog({ type: 'delete', resource: 'travel-logs', row: trip, title: `Delete trip ${trip.travel_id}?`, text: `${trip.employee_name} · ${[trip.origin, trip.destination].filter(Boolean).join(' → ')} · ${tripWhen(trip.travel_start_date, trip.travel_end_date)}. This cannot be undone. Its ${count(legs.length, 'leg')} and ${count(files.length, 'file')} go with it.${bills.length || claims.length ? ` ${[bills.length && count(bills.length, 'bill'), claims.length && count(claims.length, 'claim')].filter(Boolean).join(' and ')} stay, but no longer count towards any trip or project.` : ''}`, confirm: 'Delete trip', done: 'Trip deleted.' })}>Delete this trip</RecordMenuItem>
          </>
        )}
        factsGrid={[
          { label: 'Travel ID', value: trip.travel_id },
          { label: 'Dates', value: `${tripWhen(trip.travel_start_date, trip.travel_end_date)}${trip.cancelled ? ', cancelled' : ''}` },
          { label: 'Route', value: [trip.origin, trip.destination].filter(Boolean).join(' → ') || null },
          { label: 'Purpose', value: trip.purpose },
          { label: 'Client', value: trip.client_name || trip.client_label },
          { label: 'Booked', value: trip.booking_date ? shortDate(trip.booking_date) : null },
          { label: 'Arranged by', value: trip.arranged_by },
        ]}
        stats={(
          <>
            <RecordStat
              label="What it cost"
              value={money(trip.total_travel_cost)}
              detail={blocked.length
                ? `So far: ${money(trip.employee_claims)} claimed. The vendor's bill has no amount yet.`
                : `${money(trip.vendor_cost)} to vendors · ${money(trip.employee_claims)} claimed`}
            />
            <RecordStat
              label="Vendor bills"
              value={count(trip.vendor_invoice_count ?? bills.length, 'bill')}
              tone={blocked.length ? 'waiting' : undefined}
              detail={blocked.length
                ? `${blocked.length} with no amount on ${blocked.length === 1 ? 'it' : 'them'}`
                : bills.length ? `${money(trip.vendor_paid)} paid` : 'No bill yet'}
            />
            <RecordStat
              label="Employee claims"
              value={count(trip.claim_count ?? claims.length, 'claim')}
              detail={claims.length
                ? pendingClaims.length ? `${money(pendingClaims.reduce((n, c) => n + Number(c.amount_claimed || 0), 0))} waiting for a decision` : `${money(trip.employee_reimbursed)} reimbursed`
                : 'Nothing claimed'}
            />
            <RecordStat
              label="Billed to"
              value={<span className={(billedTo || '').length > 12 ? 'app-statword' : undefined}>{billedTo || 'Overheads'}</span>}
              tone={billedTo ? undefined : 'waiting'}
              detail={billedTo
                ? trip.po_number ? trip.service_delivered || trip.client_name || 'On this order' : `${trip.client_name || 'On this project'}, no PO yet`
                : 'This trip is not against any order, so it lands in overheads'}
            />
          </>
        )}
        notice={(blockedPanel || missingBanner) && <>{blockedPanel}{missingBanner}</>}
        bodyClassName="app-w6"
        rail={(
          <>
            <RailCard title="What this trip was for">
              {trip.project_id || trip.po_number ? (
                <div className="pb-2">
                  {trip.project_id && (
                    <RailLink to={isHr ? null : `/projects/${encodeURIComponent(trip.project_id)}`} icon={FolderKanban} title={`${trip.project_id} · ${trip.client_name || ''}`} sub={trip.po_number ? `The project${trip.service_delivered ? ` · ${trip.service_delivered}` : ''}` : 'The project · no PO yet'} />
                  )}
                  {trip.po_number && (
                    <RailLink to={isHr ? null : `/purchase-orders/${encodeURIComponent(trip.po_number)}`} icon={ClipboardList} title={`PO ${trip.po_number}`} sub="The order this is billed to" />
                  )}
                  {isHr && <p className="app-w6card__note">Projects and POs open for admin and sales; the travel desk sees what the trip is billed to.</p>}
                </div>
              ) : (
                <p className="app-w6card__note">{trip.client_label ? `${trip.client_label}: internal travel.` : 'Internal travel.'} It is not against any order, so its cost lands in overheads.</p>
              )}
            </RailCard>
            <RailCard title="People">
              <div className="pb-2">
                <RailPerson name={trip.employee_name || 'Not named'} detail={['Traveller', trip.employee_email].filter(Boolean).join(' · ')} />
                <RailPerson name={trip.hr_owner || 'HR'} detail={['HR owner', trip.hr_owner_email].filter(Boolean).join(' · ')} last />
              </div>
            </RailCard>
            {trip.remarks && (
              <RailCard title="Remarks"><p className="app-w6card__text">{trip.remarks}</p></RailCard>
            )}
          </>
        )}
      >
        <TabsPanel id="trip" label={`${trip.travel_id}: legs, costs and documents`} tabs={tabs} active={tab} onChange={setTab}>
          {tab === 'legs' && (
            <Sec id="trip-legs" title="Legs" hint="Flights, trains, cabs and hotel stays, in order"
              tools={<button type="button" className="mg-btn mg-btn--sm" onClick={() => setDialog({ type: 'leg', row: { travel_id: trip.travel_id, seq: legs.length + 1 } })}><Plus className="size-4" strokeWidth={2} aria-hidden="true" />Add a leg</button>}>
              {legs.length === 0 ? (
                <p className="app-tabnote">No legs recorded. The import adds them from the travel workbook, or add one here.</p>
              ) : (
                <div>
                  {legs.map((leg, i) => {
                    const Icon = MODE_ICON[leg.mode] || Plane;
                    const { title, provider } = legTitle(leg);
                    return (
                      <div key={leg.id} className={`app-line ${leg.status === 'cancelled' ? 'is-dim' : ''}`}>
                        <span className="app-line__mark"><Icon strokeWidth={1.8} aria-hidden="true" /></span>
                        <div className="app-line__text">
                          <span className="app-line__title">{title}{provider && <small> · {provider}</small>}</span>
                          <span className="app-line__meta">{legMeta(leg)}</span>
                        </div>
                        <div className="app-line__end">
                          {leg.status !== 'booked' && <Tone tone="late">{leg.status === 'cancelled' ? 'Cancelled' : 'Partly refunded'}</Tone>}
                          <button type="button" className="mg-iconbtn" aria-label={`Edit leg ${i + 1}, ${title}`} title="Edit" onClick={() => setDialog({ type: 'leg', row: leg })}><Pencil strokeWidth={1.8} aria-hidden="true" /></button>
                          <button type="button" className="mg-iconbtn" aria-label={`Remove leg ${i + 1}, ${title}`} title="Remove" onClick={() => setDialog({ type: 'delete', resource: 'travel-segments', row: leg, title: 'Remove this leg?', text: `Leg ${i + 1} of ${trip.travel_id} · ${title}. This cannot be undone. Any bill line that named this leg keeps its amount but no longer says which leg it was.`, confirm: 'Remove leg', done: 'Leg removed.' })}><Trash2 strokeWidth={1.8} aria-hidden="true" /></button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </Sec>
          )}

          {tab === 'costs' && (
            <>
              <Sec id="trip-bills" title="Vendor bills" hint="What the travel agent charged; a bill can cover several trips">
                {bills.length === 0 ? (
                  <p className="app-tabnote">No bill has been recorded against this trip.{trip.vendor_invoice_status === 'Invoice OVERDUE from vendor' ? ` ${trip.arranged_by || 'The vendor'}'s bill is overdue.` : ''}</p>
                ) : (
                  <div>
                    {bills.map((bill) => {
                      const [tone] = BILL[bill.payment_status] || ['plain'];
                      const tripShare = bill.trip_count > 1 ? share(bill) : null;
                      return (
                        <div key={bill.id} className="app-line">
                          <span className={`app-line__mark ${tone === 'late' ? 'is-late' : tone === 'wait' ? 'is-wait' : ''}`}><Receipt strokeWidth={1.8} aria-hidden="true" /></span>
                          <div className="app-line__text">
                            <Link className="app-line__title" to={`/vendor-invoices/${bill.id}`}>{bill.travel_vendor || 'Vendor not named'}{bill.vendor_invoice_no ? ` · ${bill.vendor_invoice_no}` : ` · ${bill.vendor_invoice_id}`}</Link>
                            <span className="app-line__meta">{[bill.invoice_date ? `Dated ${shortDate(bill.invoice_date)}` : 'No date yet', bill.pay_by && `pay by ${shortDate(bill.pay_by)}`, Number(bill.amount_paid) > 0 && `${money(bill.amount_paid)} paid${bill.trip_count > 1 ? ' on the whole bill' : ''}`].filter(Boolean).join(' · ')}</span>
                            {tripShare != null && <span className="app-line__meta is-text">This trip's share: {money(tripShare)} of a bill covering {bill.trip_count} trips{bill.invoice_amount != null ? ` (${money(bill.invoice_amount)})` : ''}.</span>}
                            {credits.filter((c) => c.against_invoice_id === bill.id).map((c) => (
                              <span key={c.id} className="app-line__meta is-ok">{c.kind === 'cancellation_note' ? 'Cancellation note' : 'Credit note'} {c.credit_note_no}: {money(c.refund_amount)} back{c.cancellation_charges ? `, ${money(c.cancellation_charges)} charged` : ''}.</span>
                            ))}
                          </div>
                          <div className="app-line__end">
                            <span className={`app-line__amount ${bill.invoice_amount === null ? 'text-caramel-text' : ''}`}>{bill.invoice_amount === null ? 'No amount' : money(tripShare ?? bill.invoice_amount)}</span>
                            <StateBadge map={BILL} value={bill.payment_status} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </Sec>
              <Sec id="trip-claims" title="Employee claims" hint="What the traveller paid and wants back">
                {claims.length === 0 ? (
                  <p className="app-tabnote">Nothing claimed for this trip.</p>
                ) : (
                  <div>
                    {claims.map((claim) => (
                      <div key={claim.id} className="app-line">
                        <span className="app-line__mark"><Wallet strokeWidth={1.8} aria-hidden="true" /></span>
                        <div className="app-line__text">
                          {isHr
                            ? <span className="app-line__title">{claim.claim_id} · {claim.expense_category || 'Uncategorised'}</span>
                            : <Link className="app-line__title" to={`/expense-claims?q=${encodeURIComponent(claim.claim_id)}`}>{claim.claim_id} · {claim.expense_category || 'Uncategorised'}</Link>}
                          <span className="app-line__meta">{[claim.submission_date && `Submitted ${shortDate(claim.submission_date)}`, claim.claim_month].filter(Boolean).join(' · ')}</span>
                        </div>
                        <div className="app-line__end">
                          <span className="app-line__amount">{money(claim.amount_claimed)}</span>
                          <StateBadge map={CLAIM} value={claim.status} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Sec>
            </>
          )}

          {tab === 'docs' && (
            <Sec id="trip-docs" title="Documents" hint="Tickets, boarding passes, the vendor's invoice, hotel bills">
              <div>
                {missingInvoice && (
                  <div className="app-line">
                    <span className="app-line__mark is-gap"><FileText strokeWidth={1.8} aria-hidden="true" /></span>
                    <div className="app-line__text">
                      <span className="app-line__title">Vendor's invoice: not on file yet</span>
                      <span className="app-line__meta">{blocked[0]?.vendor_invoice_no ? `The PDF of ${blocked[0].vendor_invoice_no}` : 'The PDF of the vendor\'s bill'}</span>
                    </div>
                    <div className="app-line__end"><Tone tone="wait">Needed</Tone></div>
                  </div>
                )}
                {files.map((file) => (
                  <div key={file.id} className="app-line">
                    <span className="app-line__mark"><FileText strokeWidth={1.8} aria-hidden="true" /></span>
                    <div className="app-line__text">
                      <a className="app-line__title" href={api.documentUrl(file.document_id)} target="_blank" rel="noreferrer" aria-label={`Open ${file.label || file.file_name} in a new tab`}>{file.label || file.file_name}</a>
                      <span className="app-line__meta">Added {shortDate(file.created_at)}{file.created_by_name ? ` by ${file.created_by_name}` : ''}</span>
                    </div>
                    <div className="app-line__end">
                      <Tone>{docLabel(file.doc_type)}</Tone>
                      <button type="button" className="mg-iconbtn" aria-label={`Remove ${file.label || file.file_name} from the trip`} title="Remove" onClick={() => setDialog({ type: 'delete', resource: 'attachments', row: file, title: 'Remove this file from the trip?', text: `${file.label || file.file_name} · ${docLabel(file.doc_type).toLowerCase()}. This cannot be undone. The file is deleted from the trip; upload it again if you need it back.`, confirm: 'Remove file', done: 'File removed.' })}><Trash2 strokeWidth={1.8} aria-hidden="true" /></button>
                    </div>
                  </div>
                ))}
                {files.length === 0 && !missingInvoice && <p className="app-tabnote">Nothing on file yet.</p>}
              </div>
              <form className="app-attach" onSubmit={attach} aria-label="Add a file to this trip">
                <FileDrop key={upload.key} label="File to add" text={upload.file ? upload.file.name : 'Drop a ticket, boarding pass or bill here'} onFile={(file) => setUpload((u) => ({ ...u, file }))} />
                <label className="mg-field">
                  <span className="mg-field__label">What it is</span>
                  <span className="mg-select-wrap"><select className="mg-select" value={upload.doc_type} onChange={(e) => setUpload((u) => ({ ...u, doc_type: e.target.value }))}>
                    {DOC_TYPES.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
                  </select></span>
                </label>
                <label className="mg-field">
                  <span className="mg-field__label">Label (optional)</span>
                  <input className="mg-input" placeholder="e.g. Return ticket" value={upload.label} onChange={(e) => setUpload((u) => ({ ...u, label: e.target.value }))} />
                </label>
                <button type="submit" className="mg-btn mg-btn--primary" disabled={busy || !upload.file}>{busy ? 'Adding…' : 'Add file'}</button>
              </form>
            </Sec>
          )}

          {tab === 'billing' && !isHr && <BilledStage trip={trip} onChanged={refetch} />}
        </TabsPanel>
      </RecordPage>

      {dialog?.type === 'trip' && (
        <RecordForm title="Edit trip" subtitle={`${trip.travel_id} · ${trip.employee_name} · ${[trip.origin, trip.destination].filter(Boolean).join(' → ')}`} size="lg" resource="travel-logs" record={trip} fields={tripFields(lookups, trip)} onClose={close} onSaved={changed} />
      )}
      {dialog?.type === 'leg' && (
        <RecordForm
          title={dialog.row.id ? 'Edit leg' : 'Add a leg'}
          subtitle={dialog.row.id ? `Leg ${dialog.row.seq} of ${trip.travel_id} · ${legTitle(dialog.row).title}` : `${trip.travel_id} · ${trip.employee_name} · becomes leg ${legs.length + 1}`}
          submitLabel={dialog.row.id ? undefined : 'Add leg'}
          size="lg"
          resource="travel-segments"
          record={dialog.row}
          fields={[{ name: 'travel_id', label: 'Trip', type: 'hidden' }, ...legFields]}
          onClose={close}
          onSaved={changed}
        />
      )}
      {dialog?.type === 'delete' && (
        <ConfirmDialog title={dialog.title} message={dialog.text} confirmLabel={dialog.confirm} busy={busy} onConfirm={remove} onClose={close} />
      )}
    </>
  );
}

/** The payment stage whose invoice billed this trip to the client (G1-10: only with a PO). */
function BilledStage({ trip, onChanged }) {
  const toast = useToast();
  const { data, loading } = useFetch(() => (trip.po_number ? api.list('payment-stages', { po_number: trip.po_number }) : Promise.resolve(null)), [trip.po_number]);
  const stages = (data?.data ?? []).filter((s) => s.invoice_no);
  async function set(value) {
    try {
      await api.update('travel-logs', trip.id, { billed_stage_id: value ? Number(value) : null });
      toast(value ? 'Recorded as billed.' : 'No longer marked as billed.', 'success');
      onChanged();
    } catch (err) {
      toast(err.message, 'danger');
    }
  }
  if (!trip.chargeable || !trip.po_number) {
    return (
      <StateCard inPanel bordered={false} tone="plain" icon={Receipt}
        title={trip.chargeable ? 'Billed once it has a PO' : 'Not billed to a client'}
        text={trip.chargeable
          ? `A chargeable trip is billed on one of its PO's invoices. ${trip.project_id ? `${trip.project_id} has no PO yet;` : 'This trip has no PO;'} once it does, pick the invoice here.`
          : 'This trip type is not chargeable, so its cost stays with us.'} />
    );
  }
  return (
    <Sec id="trip-billed" title="Billed to the client" hint="The invoice that carried this trip's cost">
      <label className="mg-field" style={{ maxWidth: 420 }}>
        <span className="mg-field__label">Invoice that billed this trip</span>
        <span className="mg-select-wrap">
          <select className="mg-select" value={trip.billed_stage_id ?? ''} onChange={(e) => set(e.target.value)} disabled={loading}>
            <option value="">Not billed yet</option>
            {stages.map((s) => <option key={s.id} value={s.id}>{s.invoice_no} · {s.stage_name}</option>)}
          </select>
        </span>
        <span className="mg-field__hint">{!loading && !stages.length ? `No invoice has been raised on PO ${trip.po_number} yet.` : trip.billed_invoice_no ? `Billed on ${trip.billed_invoice_no}.` : 'Pick the invoice once it has gone to the client.'}</span>
      </label>
    </Sec>
  );
}
