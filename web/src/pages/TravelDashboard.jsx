import { Link } from 'react-router-dom';
import {
  BedDouble, Bus, CalendarX, Car, Check, CircleHelp, Clock, FileSpreadsheet, IndianRupee, Paperclip, Plane, ReceiptText,
  Send, Store, Tag, TrainFront, Upload, Wallet, X,
} from 'lucide-react';
import { cn } from 'cn';
import { PageHeader } from '../App.jsx';
import { FailedCard, StateCard, useEntrance } from '../components/daily.jsx';
import { MoneyHero, Key, SkelPanel, shortDate } from '../components/money.jsx';
import { Tone, useRows } from '../components/sales.jsx';
import { count } from '../components/travel.jsx';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useFetch, useLookups } from '../lib/hooks.js';
import { money, sentence } from '../lib/format.js';

const OVERDUE = 'Invoice OVERDUE from vendor';
const MODE = { flight: ['Flights', Plane], hotel: ['Hotels', BedDouble], train: ['Trains', TrainFront], cab: ['Cabs', Car], bus: ['Buses', Bus], other: ['Other', Plane], 'no leg named': ['No leg named', CircleHelp] };
/** Vendor bills by where they sit, in reading order, with the list filter each opens. */
const BILL_ROWS = [
  ['Paid', 'Paid', Check, 'ok'], ['Partially Paid', 'Partly paid', IndianRupee], ['To Pay', 'To pay', IndianRupee], ['Overdue', 'Overdue', Clock, 'late'],
  ['Enter date', 'No invoice date', CalendarX, 'wait'], ['Enter amount', 'No amount', IndianRupee, 'wait'], ['Awaited', 'Bill not in yet', ReceiptText],
];
const CLAIM_ROWS = [
  ['Reimbursed', 'Reimbursed', Check, 'ok'], ['Partly reimbursed', 'Partly reimbursed', Wallet], ['Approved - to reimburse', 'Approved, to reimburse', Wallet],
  ['Pending approval', 'Waiting for a decision', Clock, 'info'], ['On hold', 'On hold', Clock], ['Rejected', 'Rejected', X, 'late'],
];
const BAR = { ok: 'var(--ok)', late: 'var(--late)', wait: 'var(--latte)', info: 'var(--info)' };

/**
 * The Travel dashboard — HR's home (Wave 6). The travel desk's to-dos come
 * first, each one click from done (a late vendor bill, a bill with no
 * amount, bills with no date, missing documents, an import to review,
 * chargeable trips not billed), beside the all-time total; then the spend
 * strip, and six cards whose every row opens the filtered list. Admin and
 * sales get the two desk figures in place of the to-dos. All-time, as the
 * og dashboard is (no period switch: that needs the server).
 */
export default function TravelDashboard() {
  const { isHr, isAdmin } = useAuth();
  const lookups = useLookups();
  const desk = isHr || isAdmin;
  const { data, loading, error, refetch } = useFetch(() => api.raw('/dashboard/travel'));
  const trips = useRows('travel-logs', { limit: 500 });
  const lateTrips = useRows('travel-logs', { vendor_invoice_status: OVERDUE, limit: 20 });
  const noAmount = useRows('vendor-invoices', { payment_status: 'Enter amount', limit: 20 });
  const noDate = useRows('vendor-invoices', { payment_status: 'Enter date', limit: 20 });
  const imports = useFetch(() => (desk ? api.raw('/import/travel') : Promise.resolve(null)), [desk]);
  const d = data?.data;
  const ref = useEntrance(Boolean(d));
  const windowDays = lookups.settings?.vendor_invoice_window_days || 15;

  const header = (sub) => (
    <PageHeader
      title="Travel dashboard"
      eyebrow={isHr ? 'Travel desk' : 'Travel'}
      subtitle={sub}
      actions={desk ? <Link className="mg-btn" to="/settings/import-travel"><Upload className="size-4" strokeWidth={1.8} aria-hidden="true" />Import a workbook</Link> : null}
    />
  );

  if (error) {
    return (
      <>
        {header("The figures didn't load.")}
        <div className="app-page"><FailedCard title="Couldn't load the travel dashboard" text={`${sentence(error)} Nothing has changed; try again.`} onRetry={refetch} /></div>
      </>
    );
  }
  if (!d) {
    return (
      <>
        {header('Loading the travel figures…')}
        <div className="app-page" aria-busy="true" aria-label="Loading the travel dashboard">
          <div className="app-mrow"><SkelPanel rows={5} className="flex-1" /><SkelPanel rows={3} className="flex-1" /></div>
          <SkelPanel rows={1} />
          <div className="app-tdcards">{[0, 1, 2].map((i) => <SkelPanel key={i} rows={4} />)}</div>
        </div>
      </>
    );
  }

  const s = d.snapshot;
  if (!Number(s.trips)) {
    return (
      <>
        {header('Nothing to show until the first trip is logged.')}
        <div className="app-page">
          <StateCard tone="plain" icon={Plane} title="No trips yet" text="Log a trip, or import a travel agency's workbook, and its cost, bills and claims show here.">
            <Link className="mg-btn mg-btn--primary mg-btn--sm" to="/travel?new=travel-logs">New trip</Link>
            {desk && <Link className="mg-btn mg-btn--sm" to="/settings/import-travel">Import a workbook</Link>}
          </StateCard>
        </div>
      </>
    );
  }

  // ── The travel desk's to-dos ──
  const missing = trips.rows.filter((t) => t.missing_documents?.length);
  const unbilled = trips.rows.filter((t) => t.chargeable && !t.billed_stage_id && !t.cancelled);
  const drafts = (imports.data?.data ?? []).filter((b) => b.status !== 'committed' && b.status !== 'failed');
  const ids = (rows, n = 3) => `${rows.slice(0, n).map((r) => r.travel_id).join(', ')}${rows.length > n ? ` and ${rows.length - n} more` : ''}`;
  const tripLink = (rows) => (rows.length === 1 ? `/travel/${encodeURIComponent(rows[0].travel_id)}` : '/travel');
  const todos = [
    lateTrips.rows.length > 0 && {
      key: 'late', icon: Clock, tone: 'late',
      lead: lateTrips.rows.length === 1 ? "1 vendor's bill is overdue." : `${lateTrips.rows.length} vendors' bills are overdue.`,
      text: lateTrips.rows.length === 1
        ? `${lateTrips.rows[0].arranged_by || 'The vendor'} hasn't billed ${lateTrips.rows[0].travel_id} (${lateTrips.rows[0].employee_name}, ${lateTrips.rows[0].destination || 'no destination'}). Bills are due within ${windowDays} days of the trip ending.`
        : `${ids(lateTrips.rows)} haven't been billed. Bills are due within ${windowDays} days of the trip ending.`,
      btn: lateTrips.rows.length === 1 ? 'Open the trip' : 'Show the trips', to: lateTrips.rows.length === 1 ? tripLink(lateTrips.rows) : `/travel?vendor_invoice_status=${encodeURIComponent(OVERDUE)}`,
    },
    noAmount.rows.length > 0 && {
      key: 'amount', icon: IndianRupee, tone: 'wait',
      lead: `${count(noAmount.rows.length, 'vendor bill')} ${noAmount.rows.length === 1 ? 'has' : 'have'} no amount.`,
      text: `${noAmount.rows.slice(0, 2).map((b) => `${b.vendor_invoice_no || b.vendor_invoice_id} from ${b.travel_vendor || 'the vendor'}${b.invoice_date ? `, dated ${shortDate(b.invoice_date)}` : ''}`).join('; ')}. ${noAmount.rows.length === 1 ? "It can't be paid or counted until the amount is in." : "They can't be paid or counted until the amounts are in."}`,
      btn: 'Enter the amount', to: noAmount.rows.length === 1 ? `/vendor-invoices/${noAmount.rows[0].id}` : '/vendor-invoices?payment_status=Enter%20amount',
    },
    noDate.rows.length > 0 && {
      key: 'date', icon: CalendarX, tone: 'wait',
      lead: `${count(noDate.rows.length, 'vendor bill')} ${noDate.rows.length === 1 ? 'has' : 'have'} no invoice date.`,
      text: `${noDate.rows.slice(0, 3).map((b) => `${b.travel_vendor || 'A vendor'} for ${b.travel_id || 'several trips'}`).join(' and ')}. The date sets when each one has to be paid.`,
      btn: noDate.rows.length === 1 ? 'Add the date' : 'Add the dates', to: noDate.rows.length === 1 ? `/vendor-invoices/${noDate.rows[0].id}` : '/vendor-invoices?payment_status=Enter%20date',
    },
    missing.length > 0 && {
      key: 'docs', icon: Paperclip, tone: 'wait',
      lead: `${count(missing.length, 'trip is', 'trips are')} missing documents.`,
      text: `${ids(missing)} ${missing.length === 1 ? 'needs' : 'need'} a ticket or the vendor's invoice on file. Upload the PDFs from Trips and they file themselves by number.`,
      btn: missing.length === 1 ? 'Open the trip' : 'Show the trips', to: tripLink(missing),
    },
    desk && drafts.length > 0 && {
      key: 'import', icon: FileSpreadsheet, tone: 'info',
      lead: `${count(drafts.length, 'workbook import is', 'workbook imports are')} waiting for review.`,
      text: `${drafts[0].filename}${drafts[0].summary?.trips != null ? `: ${count(drafts[0].summary.trips, 'trip')} and ${count(drafts[0].summary.invoices, 'bill')} read` : ''}${drafts[0].summary?.red ? `, ${count(drafts[0].summary.red, 'row')} to fix before it can be committed` : ''}.`,
      btn: 'Review the import', to: `/import-travel/${drafts[0].id}`,
    },
    unbilled.length > 0 && {
      key: 'unbilled', icon: Send, tone: 'plain',
      lead: `${count(unbilled.length, 'chargeable trip')} ${unbilled.length === 1 ? "isn't" : "aren't"} billed to the client yet.`,
      text: `${ids(unbilled)}, ${money(d.attention.unbilled_value)} in all. The account owner marks them billed on the client's invoice; this is for your information.`,
      btn: unbilled.length === 1 ? 'Open the trip' : 'Show the trips', to: tripLink(unbilled),
    },
  ].filter(Boolean);
  const todosLoading = trips.loading || lateTrips.loading || noAmount.loading || noDate.loading;

  // ── Figures ──
  const vendorOwed = Number(s.vendor_cost) - Number(s.vendor_paid);
  const staffOwed = Number(s.employee_claims) - Number(s.employee_reimbursed);
  const overdueBills = d.vendor_invoice_status.find((r) => r.label === 'Overdue');
  const rejected = d.claim_status.find((r) => r.label === 'Rejected');
  const toReimburse = d.claim_status.filter((r) => !['Reimbursed', 'Rejected'].includes(r.label)).reduce((n, r) => n + r.count, 0);
  const thisMonth = new Date().toISOString().slice(0, 7);
  const startedNow = trips.rows.filter((t) => String(t.travel_start_date || '').slice(0, 7) === thisMonth).length;
  const total = Number(s.total_cost);
  const paidAll = Number(s.vendor_paid) + Number(s.employee_reimbursed);
  const claimsTo = isHr ? '/travel' : '/expense-claims';

  const strip = [
    { label: 'Trips logged', figure: String(s.trips), foot: startedNow ? `${startedNow} started this month` : 'None started this month', to: '/travel' },
    { label: 'Vendor invoiced', figure: money(s.vendor_cost), foot: `${money(s.vendor_paid)} paid · net of credit notes`, to: '/vendor-invoices' },
    { label: 'Employee claims', figure: money(s.employee_claims), foot: `${money(s.employee_reimbursed)} reimbursed`, to: claimsTo },
    { label: 'Unpaid vendor balance', figure: money(vendorOwed), tone: vendorOwed > 0 ? 'late' : 'ok', foot: overdueBills?.value > 0 ? `${money(overdueBills.value)} is past its pay-by date` : 'Nothing past its pay-by date', to: '/payables' },
    { label: 'Unreimbursed to staff', figure: money(staffOwed), tone: staffOwed > 0 ? 'wait' : 'ok', foot: `${count(toReimburse, 'claim')} still open${rejected ? ` · ${money(rejected.value)} rejected isn't owed` : ''}`, to: claimsTo },
  ];

  const typeChargeable = Object.fromEntries((lookups.trip_types || []).map((t) => [t.name, t.chargeable]));
  const modeRows = d.by_mode.map((m) => { const [label, icon] = MODE[m.label] || [m.label[0].toUpperCase() + m.label.slice(1), Plane]; return { key: m.label, label, icon, value: Number(m.value), foot: count(m.count, 'line'), muted: m.label === 'no leg named', to: '/vendor-invoices' }; });
  const typeRows = d.by_trip_type.map((t) => ({ key: t.label, label: t.label === 'Not set' ? 'Type not set' : t.label, icon: Tag, value: Number(t.value), foot: count(t.count, 'trip'), tag: typeChargeable[t.label] && !/chargeable/i.test(t.label) ? 'Chargeable' : null, muted: t.label === 'Not set', to: '/travel' }));
  const vendorRows = d.by_vendor.map((v) => ({ key: v.label, label: v.label === 'Not recorded' ? 'Vendor not recorded' : v.label, icon: v.label === 'Not recorded' ? CircleHelp : Store, value: Number(v.value), foot: count(v.count, 'trip'), muted: v.label === 'Not recorded', to: '/travel' }));
  const byStatus = (rows, defs, list, filter) => defs
    .map(([key, label, icon, tone]) => { const r = rows.find((x) => x.label === key); return r ? { key, label, icon, tone, value: Number(r.value), foot: count(r.count, list === 'bill' ? 'bill' : 'claim'), to: filter(key) } : null; })
    .filter(Boolean);
  const billRows = byStatus(d.vendor_invoice_status, BILL_ROWS, 'bill', (k) => `/vendor-invoices?payment_status=${encodeURIComponent(k)}`);
  const claimRows = byStatus(d.claim_status, CLAIM_ROWS, 'claim', (k) => (isHr ? '/travel' : `/expense-claims?status=${encodeURIComponent(k)}`));
  const months = d.by_month.slice(-8);
  const monthMax = Math.max(1, ...months.map((m) => Number(m.value)));
  const nowLabel = new Date().toLocaleString('en-GB', { month: 'short', year: 'numeric' });

  return (
    <>
      {header(isHr
        ? `${todos.length ? `${count(todos.length, 'travel job')} ${todos.length === 1 ? 'needs' : 'need'} you.` : 'Nothing needs you right now.'} Spend below covers every trip, net of credit notes.`
        : 'What travel has cost, and where each bill and claim sits in the pay cycle.')}

      <div className="app-page" ref={ref}>
        <div className="app-mrow">
          {isHr ? (
            <section className="mg-glass mg-glass--strong app-panel app-mrow__side app-todos" data-a="rise" aria-labelledby="todo-t">
              <div className="app-panel__head">
                <div className="app-panel__titles"><h2 className="mg-panel__title" id="todo-t">Travel desk to-dos {todos.length > 0 && <span className="mg-count">{todos.length}</span>}</h2></div>
                <span className="mg-panel__hint">Each one goes when it's done</span>
              </div>
              {todosLoading ? <div className="app-panel__body flex flex-col gap-2.5 p-5">{[0, 1, 2].map((i) => <div key={i} className="mg-skel" style={{ height: 48 }} />)}</div>
                : todos.length === 0 ? (
                  // G2-3: the all-clear says what was checked.
                  <StateCard inPanel tone="ok" title="All caught up" text="No late vendor bill, no bill without an amount or a date, no trip missing documents and no import waiting. New jobs show here as they come in." />
                ) : (
                  <ol className="app-todo-list">
                    {todos.map((t) => {
                      const Icon = t.icon;
                      return (
                        <li key={t.key} className="app-todo">
                          <span className={cn('app-line__mark', t.tone !== 'plain' && `is-${t.tone}`)} aria-hidden="true"><Icon strokeWidth={1.8} /></span>
                          <span className="min-w-0"><b>{t.lead}</b><span>{t.text}</span></span>
                          <Link className="mg-btn mg-btn--sm" to={t.to}>{t.btn}</Link>
                        </li>
                      );
                    })}
                  </ol>
                )}
            </section>
          ) : (
            <div className="app-mrow__side app-desktiles">
              <Link className="mg-glass mg-tile app-desktile" to={tripLink(missing)} data-a="rise" aria-label={`${count(Number(d.attention.missing_documents), 'trip')} missing documents. Show them`}>
                <span className="mg-label">Trips missing documents</span>
                <span className={cn('mg-tile__figure mg-num', d.attention.missing_documents > 0 && 'text-caramel-text')}>{d.attention.missing_documents}</span>
                <span className="mg-tile__foot"><span>A ticket or the vendor's invoice is not on file.</span>{missing.length > 0 && <Tone tone="wait" className="max-w-full whitespace-normal [overflow-wrap:anywhere]">{ids(missing)}</Tone>}</span>
              </Link>
              <Link className="mg-glass mg-tile app-desktile" to={tripLink(unbilled)} data-a="rise" aria-label={`${count(Number(d.attention.unbilled_chargeable), 'chargeable trip')} not yet billed, ${money(d.attention.unbilled_value)}. Show them`}>
                <span className="mg-label">Chargeable, not yet billed</span>
                <span className={cn('mg-tile__figure mg-num', d.attention.unbilled_chargeable > 0 && 'text-caramel-text')}>{d.attention.unbilled_chargeable}</span>
                <span className="mg-tile__foot"><span>{money(d.attention.unbilled_value)} to bill to clients on their next invoice.</span>{unbilled.length > 0 && <Tone tone="wait" className="max-w-full whitespace-normal [overflow-wrap:anywhere]">{ids(unbilled)}</Tone>}</span>
              </Link>
            </div>
          )}

          <MoneyHero
            label="Total travel cost · all time"
            figure={money(total)}
            count={total}
            sub={`Vendor bills ${money(s.vendor_cost)}, net of credit notes, plus employee claims ${money(s.employee_claims)}, across ${count(s.trips, 'trip')}.`}
            done={total > 0 ? (100 * paidAll) / total : 0}
            expected={total > 0 ? (100 * (total - paidAll)) / total : 0}
            aria={`${money(paidAll)} paid out, ${money(total - paidAll)} still to pay`}
            legend={(
              <>
                <Key>Paid out <strong className="mg-num">{money(paidAll)}</strong></Key>
                <Key swatch="hatch">Still to pay <strong className="mg-num">{money(total - paidAll)}</strong></Key>
              </>
            )}
          />
        </div>

        <section className="mg-glass mg-strip app-strip app-tdstrip" aria-label="Travel spend" data-a="rise">
          {strip.map((t) => (
            <Link key={t.label} to={t.to} aria-label={`${t.label}: ${t.figure}. ${t.foot}`}>
              <span className="mg-label">{t.label}</span>
              <span className={cn('mg-tile__figure mg-num', t.tone === 'late' && 'is-late', t.tone === 'wait' && 'is-wait')}>{t.figure}</span>
              <span className="mg-tile__foot"><span>{t.foot}</span></span>
            </Link>
          ))}
        </section>

        <div className="app-tdcards">
          <BarCard title="Spend by mode" hint="The agency's bills, net of credit notes, by what was booked" rows={modeRows} />
          <BarCard title="Spend by trip type" hint="Total trip cost, chargeable and not" rows={typeRows} />
          <BarCard title="Spend by travel vendor" hint="Total trip cost booked through each vendor" rows={vendorRows} />

          <section className="mg-glass mg-panel app-tdcard" data-a="rise" aria-labelledby="td-month">
            <div className="app-tdcard__head"><h2 className="mg-panel__title" id="td-month">Trips by month</h2><span className="mg-panel__hint">Count and cost of trips starting each month</span></div>
            {months.length === 0 ? <p className="app-tabnote">No trip has dates yet.</p> : (
              <>
                <div className="app-tdmonths" role="list">
                  {months.map((m) => {
                    const now = m.label === nowLabel;
                    return (
                      <Link key={m.label} role="listitem" to="/travel" className="app-tdmonth" aria-label={`${m.label}${now ? ' so far' : ''}: ${count(m.count, 'trip')}, ${money(m.value)}`}>
                        <span className="app-tdmonth__n">{count(m.count, 'trip')}</span>
                        <span className="app-tdmonth__plot"><span className={cn('app-tdmonth__bar', now && 'mg-hatch')} data-a="grow" style={{ height: `${Math.max(4, (100 * Number(m.value)) / monthMax)}%` }} /></span>
                        <span className="app-tdmonth__label">{m.label.split(' ')[0]}</span>
                        <span className="app-tdmonth__amt">{money(m.value, 'INR', { compact: true })}</span>
                      </Link>
                    );
                  })}
                </div>
                {months.some((m) => m.label === nowLabel) && <p className="app-tabnote mt-3">{nowLabel.split(' ')[0]} so far, hatched: the month isn't over.</p>}
              </>
            )}
          </section>

          <BarCard title="Vendor bills, by where they are" hint="Where each bill sits in the pay cycle, net of credit notes" rows={billRows} stack />
          <BarCard title="Employee claims, by where they are" hint="What staff claimed, and what is still to reimburse" rows={claimRows} stack />
        </div>
      </div>
    </>
  );
}

/** A card of bars: an icon, the label (and a tag), the amount, the bar, its count; each row opens its list. */
function BarCard({ title, hint, rows, stack = false }) {
  const max = Math.max(1, ...rows.map((r) => r.value || 0));
  const sum = rows.reduce((n, r) => n + (r.value || 0), 0);
  const id = `td-${title.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <section className="mg-glass mg-panel app-tdcard" data-a="rise" aria-labelledby={id}>
      <div className="app-tdcard__head"><h2 className="mg-panel__title" id={id}>{title}</h2><span className="mg-panel__hint">{hint}</span></div>
      {stack && sum > 0 && (
        <span className="app-tdstack" role="img" aria-label={rows.filter((r) => r.value).map((r) => `${money(r.value)} ${r.label.toLowerCase()}`).join(', ')}>
          {rows.filter((r) => r.value).map((r) => <span key={r.key} data-a="growx" style={{ width: `${(100 * r.value) / sum}%`, background: BAR[r.tone] || 'var(--figure)' }} />)}
        </span>
      )}
      {rows.length === 0 ? <p className="app-tabnote">Nothing yet.</p> : (
        <ul className="app-tdbars">
          {rows.map((r) => {
            const Icon = r.icon || Tag;
            return (
              <li key={r.key}>
                <Link to={r.to} className="app-tdbar" aria-label={`${r.label}: ${r.value ? money(r.value) : 'no amount yet'}, ${r.foot}. Show them`}>
                  <span className={cn('app-tdbar__mark', r.tone && `is-${r.tone}`)} aria-hidden="true"><Icon strokeWidth={1.8} /></span>
                  <span className="app-tdbar__label">{r.label}{r.tag && <Tone>{r.tag}</Tone>}</span>
                  <span className={cn('app-tdbar__amt', !r.value && 'text-muted-foreground')}>{r.value ? money(r.value) : 'no amount'}</span>
                  <span className="app-tdbar__track"><span data-a="growx" style={{ width: r.value ? `${Math.max(3, (100 * r.value) / max)}%` : 0, background: r.muted ? 'var(--latte)' : BAR[r.tone] || 'var(--figure)' }} /></span>
                  <span className="app-tdbar__foot">{r.foot}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
