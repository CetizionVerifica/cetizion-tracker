import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { AlertTriangle, Clock, FolderKanban, Plane, Receipt, Wallet } from 'lucide-react';
import { PageHeader } from '../App.jsx';
import { ErrorState, useToast } from '../components/ui.jsx';
import { Chip, RecordPage, RecordRow, RecordSection, RecordStat } from '../components/record.jsx';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/hooks.js';
import { date, money } from '../lib/format.js';

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
  const [busy, setBusy] = useState(false);
  const [amounts, setAmounts] = useState({});

  const { data, loading, error, refetch } = useFetch(() => api.raw(`/travel-logs/${encodeURIComponent(travelId)}/full`), [travelId]);
  const trip = data?.data?.trip;
  const bills = data?.data?.vendor_invoices ?? [];
  const claims = data?.data?.expense_claims ?? [];

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
      facts={[
        <span key="id" className="num text-[12px]">{trip.travel_id}</span>,
        when,
        trip.purpose,
        trip.client_name,
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

      <RecordSection title="Vendor bills" hint="what the travel agent charged us">
        {bills.length === 0 ? (
          <p className="px-5 py-4 text-[12.5px] text-muted-foreground">No bill has been recorded against this trip.</p>
        ) : bills.map((bill, i) => (
          <RecordRow
            key={bill.id}
            icon={Receipt}
            to="/vendor-invoices"
            last={i === bills.length - 1}
            title={<>{bill.travel_vendor || 'Vendor not named'}{bill.vendor_invoice_no && <span className="num text-[12px] text-secondary-text"> · {bill.vendor_invoice_no}</span>}</>}
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

      {/* No timeline here. Notes, tasks and files are constrained to seven
          entity types in the schema and a trip is not one of them, and a
          trip's activity is its bills and its claims — both already on
          this page. Adding it would be three CHECK constraints for a
          section the design does not draw. */}
    </RecordPage>
  );
}
