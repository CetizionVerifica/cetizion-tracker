import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowRight, FileText, Receipt } from 'lucide-react';
import { ListPage } from '../components/ListPage.jsx';
import { PayVendorDialog } from '../components/actions.jsx';
import { HeaderTabs, daysTo, shortDate } from '../components/money.jsx';
import { SummaryStrip, Tone, useRows } from '../components/sales.jsx';
import { BILL, StateBadge, count } from '../components/travel.jsx';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useLookups } from '../lib/hooks.js';
import { money } from '../lib/format.js';

const vendorOptions = (lookups) => lookups.travel_vendor_list.map((v) => ({ value: String(v.id), label: v.name }));

/** A travel agency invoice's header (#196 §4.4): its lines are added on the invoice's own page. */
export function vendorInvoiceFields(lookups, record = null) {
  const multi = record && Number(record.line_count) > 1;
  return [
    { name: 'vendor_invoice_id', label: 'Reference', required: true, hint: 'Your internal reference, e.g. VINV-2026-001' },
    { name: 'vendor_id', label: 'Vendor', type: 'select', options: vendorOptions(lookups), hint: 'Left blank: the trip\'s vendor' },
    multi
      ? { name: 'travel_id', label: 'Trip (one trip)', type: 'select', disabled: true, options: [], placeholder: `This bill covers ${record.trip_count} trips`, hint: "Its lines say which trips. Change them on the bill's page." }
      : { name: 'travel_id', label: 'Trip (one trip)', type: 'select', options: lookups.trips.map((t) => ({ value: t.travel_id, label: `${t.travel_id} — ${t.employee_name}${t.destination ? ` (${t.destination})` : ''}` })), hint: 'For a bill covering several trips, leave it blank: its page opens next so you can add a line per trip.' },
    { name: 'vendor_invoice_no', label: "Vendor's invoice number", hint: 'As printed, e.g. HT/2627/1877' },
    { name: 'invoice_date', label: 'Invoice date', type: 'date', hint: 'Sets the pay-by date: the month-end after it' },
    multi
      ? { name: 'invoice_amount', label: 'Invoice amount', type: 'money', disabled: true, hint: `Locked: this bill has ${record.line_count} lines, so its total is their sum. Change a line on the bill's page.` }
      : { name: 'invoice_amount', label: 'Invoice amount', type: 'money', hint: 'With lines, the total follows them' },
    { name: 'payment_terms_days', label: 'Payment terms (days)', type: 'number', default: '30', hint: 'For the record: finance pays by the month-end after the date' },
    { name: 'vendor_gstin_on_invoice', label: 'Vendor GSTIN as printed', hint: '15 characters, from the bill' },
    { name: 'place_of_supply', label: 'Place of supply' },
    { name: 'document_id', label: 'Invoice PDF', type: 'document', owner: 'vendor-invoices', maxBytes: lookups.limits?.document_max_bytes, span: 2 },
    // amount_paid and payment_date are recorded through Pay, which validates
    // the figure and notes who recorded it (#85). Every role may still pay a
    // vendor invoice — only the door changed, not the permission.
    { name: 'remarks', label: 'Remarks', type: 'textarea', span: 'all', placeholder: 'Anything finance should know, e.g. "includes 2 nights at the hotel"' },
  ];
}

/** A credit or cancellation note against one of a vendor's invoices (#196 §4.5). */
export function creditNoteFields(lookups, { invoices = [], legs = [] } = {}) {
  return [
    { name: 'vendor_id', label: 'Vendor', type: 'select', required: true, options: vendorOptions(lookups) },
    { name: 'credit_note_no', label: 'Credit note number', required: true, hint: 'As printed, e.g. HT/2627/CN/349 or HT/2627/CNT/151' },
    { name: 'kind', label: 'Kind', type: 'select', options: [{ value: 'credit_note', label: 'Credit note' }, { value: 'cancellation_note', label: 'Cancellation note' }], default: 'credit_note' },
    { name: 'credit_note_date', label: 'Date', type: 'date' },
    {
      name: 'against_invoice_id', label: 'Against invoice', type: 'select',
      // Only the chosen vendor's bills, once a vendor is chosen.
      options: (values) => invoices
        .filter((i) => !values?.vendor_id || String(i.vendor_id) === String(values.vendor_id))
        .map((i) => ({ value: String(i.id), label: `${i.vendor_invoice_no || i.vendor_invoice_id} · ${i.invoice_date ? shortDate(i.invoice_date) : 'no date'} · ${i.invoice_amount == null ? 'no amount yet' : money(i.invoice_amount)}` })),
      hint: "The vendor's bills only. With no bill it is not taken off anything we owe.",
    },
    { name: 'segment_id', label: 'The leg it cancels or refunds', type: 'select', options: legs.map((l) => ({ value: String(l.id), label: `${l.travel_id}: ${l.mode} ${l.from_place || ''} → ${l.to_place || ''} ${l.start_date ? shortDate(l.start_date) : ''}` })), hint: 'Marks the leg cancelled or partly refunded' },
    { name: 'refund_amount', label: 'Refunded to us', type: 'money', default: '0' },
    { name: 'cancellation_charges', label: 'Cancellation charges', type: 'money' },
    { name: 'document_id', label: 'Credit note PDF', type: 'document', owner: 'vendor-credit-notes', maxBytes: lookups.limits?.document_max_bytes, span: 2 },
    { name: 'remarks', label: 'Remarks', type: 'textarea', span: 'all', placeholder: 'e.g. "Flight cancelled by the client; airline kept ₹1,200"' },
  ];
}

const owed = (r) => (r.invoice_amount == null ? 0 : Math.max(Number(r.net_payable ?? r.invoice_amount) - Number(r.amount_paid || 0), 0));
const billNo = (r) => r.vendor_invoice_no || r.vendor_invoice_id;

/** What to do next with a bill, in words (the view's FINANCE / HR strings, said plainly). */
export function billNext(r) {
  const vendor = r.travel_vendor || 'the vendor';
  switch (r.payment_status) {
    case 'Overdue': return { tone: 'late', text: `Finance: pay ${Number(r.amount_paid) > 0 ? `the remaining ${money(owed(r))} ` : ''}now, ${count(r.days_overdue, 'day')} overdue` };
    case 'To Pay': return { tone: 'plain', text: r.pay_by ? `Finance: pay by ${shortDate(r.pay_by)}` : 'Finance: pay it' };
    case 'Partially Paid': return { tone: 'plain', text: `Finance: pay the remaining ${money(owed(r))}${r.pay_by ? ` by ${shortDate(r.pay_by)}` : ''}` };
    case 'Enter amount': return { tone: 'wait', text: 'HR: enter the amount from the bill' };
    case 'Enter date': return { tone: 'wait', text: 'HR: enter the invoice date; it sets the pay-by date' };
    case 'Awaited': return /overdue/i.test(r.finance_action || '') ? { tone: 'late', text: `The bill is late: ask ${vendor} for it` } : { tone: 'plain', text: `Waiting for ${vendor}'s bill` };
    case 'Paid': return { tone: 'plain', text: `Nothing to do: paid in full${r.payment_date ? ` on ${shortDate(r.payment_date)}` : ''}` };
    default: return { tone: 'plain', text: '' };
  }
}

/** "Raised on time" / "Raised 12 days late" from the view's "On time" / "Late (12d)". */
function raised(r) {
  if (!r.raised_in_time) return null;
  const late = /Late \((\d+)d\)/.exec(r.raised_in_time);
  return late ? { tone: 'wait', text: `Raised ${late[1]} days late` } : { tone: 'ok', text: 'Raised on time' };
}

/**
 * Travel vendor invoices and their credit notes (Wave 6, built on Wave 5's
 * list): one h1, the tabs under it; a strip of what we owe after credit
 * notes; the bills most urgent first with what to do next in words; Pay on
 * the row (disabled with its reason when the bill has no amount). HR is not
 * offered Export, which the server refuses it.
 */
export default function VendorInvoices() {
  const lookups = useLookups();
  const navigate = useNavigate();
  const { isHr } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'credit-notes' ? 'credit-notes' : 'invoices';
  const [paying, setPaying] = useState(null);
  const [version, setVersion] = useState(0);

  // Every bill (rupees throughout), for the strips and the notes' "Against" column.
  const bills = useRows('vendor-invoices', { limit: 500 }, [version]);
  const notes = useRows('vendor-credit-notes', { limit: 500 }, [version]);
  const billById = Object.fromEntries(bills.rows.map((b) => [b.id, b]));
  const vendorName = (id) => lookups.travel_vendor_list.find((v) => v.id === id)?.name || 'Vendor not named';

  const tabs = (
    <HeaderTabs
      label="Vendor invoices"
      active={tab}
      onChange={(key) => setParams(key === 'credit-notes' ? { tab: 'credit-notes' } : {})}
      tabs={[{ key: 'invoices', label: 'Invoices', count: bills.total ?? undefined }, { key: 'credit-notes', label: 'Credit notes', count: notes.total ?? undefined }]}
    />
  );

  const open = bills.rows.filter((r) => ['To Pay', 'Partially Paid', 'Overdue', 'Enter date'].includes(r.payment_status));
  const over = open.filter((r) => r.payment_status === 'Overdue');
  const monthEnd = new Date(); monthEnd.setMonth(monthEnd.getMonth() + 1, 0);
  const dueSoon = open.filter((r) => r.payment_status !== 'Overdue' && r.pay_by && daysTo(r.pay_by) >= 0 && new Date(`${String(r.pay_by).slice(0, 10)}T00:00:00`) <= monthEnd);
  const undated = open.filter((r) => r.payment_status === 'Enter date');
  const noAmount = bills.rows.filter((r) => r.payment_status === 'Enter amount');
  const sum = (rows) => rows.reduce((n, r) => n + owed(r), 0);
  const monthLabel = shortDate(monthEnd.toISOString().slice(0, 10));

  const invoiceStrip = ({ setFilter, filters }) => (
    <SummaryStrip
      label="What we owe travel vendors, after credit notes"
      loading={bills.loading}
      tiles={[
        { key: 'pay', label: 'To pay', figure: bills.loading ? null : money(sum(open)), foot: `${count(open.length, 'bill')}, after credit notes` },
        { key: 'over', label: 'Overdue', tone: over.length ? 'late' : undefined, figure: bills.loading ? null : money(sum(over)), badge: over.length ? { tone: 'late', text: count(over.length, 'bill') } : null, foot: over.length ? 'past their pay-by date' : 'Nothing is overdue', onClick: () => setFilter('payment_status', filters.payment_status === 'Overdue' ? '' : 'Overdue'), pressed: filters.payment_status === 'Overdue' },
        { key: 'soon', label: `Due by ${monthLabel}`, tone: 'wait', figure: bills.loading ? null : money(sum(dueSoon)), foot: `${count(dueSoon.length, 'bill')}${undated.length ? ` · ${money(sum(undated))} more has no date yet` : ''}` },
        { key: 'none', label: 'No amount yet', figure: bills.loading ? null : count(noAmount.length, 'bill'), badge: noAmount.length ? { tone: 'wait', text: 'Not in these totals' } : null, foot: noAmount.length ? null : 'Every bill has its amount', onClick: noAmount.length ? () => setFilter('payment_status', filters.payment_status === 'Enter amount' ? '' : 'Enter amount') : undefined, pressed: filters.payment_status === 'Enter amount' },
      ]}
    />
  );

  const tied = notes.rows.filter((n) => n.against_invoice_id);
  const untied = notes.rows.filter((n) => !n.against_invoice_id);
  const notesStrip = (
    <SummaryStrip
      label="Credit and cancellation notes"
      loading={notes.loading}
      tiles={[
        { key: 'ref', label: 'Refunded to us', figure: notes.loading ? null : money(notes.rows.reduce((n, r) => n + Number(r.refund_amount || 0), 0)), foot: count(notes.rows.length, 'note') },
        { key: 'chg', label: 'Cancellation charges', figure: notes.loading ? null : money(notes.rows.reduce((n, r) => n + Number(r.cancellation_charges || 0), 0)), foot: count(notes.rows.filter((r) => Number(r.cancellation_charges) > 0).length, 'charged note') },
        { key: 'untied', label: 'Not tied to a bill', figure: notes.loading ? null : count(untied.length, 'note'), badge: untied.length ? { tone: 'wait', text: money(untied.reduce((n, r) => n + Number(r.refund_amount || 0), 0)) } : null, foot: untied.length ? 'not taken off anything we owe' : `All ${count(tied.length, 'note')} counted` },
      ]}
    />
  );

  const payButton = (r) => (r.payment_status === 'Paid' ? null : r.invoice_amount === null ? (
    <button type="button" className="mg-btn mg-btn--sm" aria-disabled="true" title="Enter the amount first" aria-label={`Pay ${billNo(r)}: enter the amount first`} onClick={(e) => e.stopPropagation()}>Pay</button>
  ) : (
    <button type="button" className={`mg-btn mg-btn--sm ${r.payment_status === 'Overdue' ? 'mg-btn--primary' : ''}`} aria-label={`Pay ${r.travel_vendor || 'the vendor'}, ${billNo(r)}`} onClick={(e) => { e.stopPropagation(); setPaying(r); }}>Pay</button>
  ));

  const columns = [
    {
      key: 'vendor_invoice_no', header: 'Invoice', className: 'nowrap',
      render: (r) => {
        const rs = raised(r);
        return (
          <>
            <Link className="mg-num font-bold text-foreground no-underline" to={`/vendor-invoices/${r.id}`}>{billNo(r)}</Link>
            <span className="app-sub2">{r.vendor_invoice_no ? `${r.invoice_date ? shortDate(r.invoice_date) : 'No date yet'} · ${r.vendor_invoice_id}` : r.payment_status === 'Awaited' ? 'Bill not received yet' : 'No number yet · our reference'}</span>
            {rs && <span className={`app-sub2 ${rs.tone === 'ok' ? 'text-ok' : 'text-caramel-text'}`}>{rs.text}</span>}
          </>
        );
      },
    },
    { key: 'travel_vendor', header: 'Vendor', min: 110, render: (r) => <b>{r.travel_vendor || 'Not named'}</b> },
    {
      key: 'travel_id', header: 'Trip', className: 'nowrap',
      render: (r) => (r.trip_count > 1
        ? <><b title={r.employee_name}>{count(r.trip_count, 'trip')}</b><span className="app-sub2 is-wrap" style={{ maxWidth: 160 }}>{r.employee_name}</span></>
        : r.travel_id ? <><Link className="app-link mg-num" to={`/travel/${encodeURIComponent(r.travel_id)}`}>{r.travel_id}</Link><span className="app-sub2">{r.employee_name}</span></> : <span className="text-muted-foreground">No trip yet</span>),
    },
    {
      key: 'invoice_amount', header: 'Amount', align: 'right',
      render: (r) => (r.invoice_amount === null
        ? <Tone tone="wait">Not entered</Tone>
        : <>{money(r.invoice_amount)}{Number(r.credited) > 0 && <span className="app-sub2">{money(r.net_payable)} after credit notes</span>}</>),
    },
    { key: 'amount_paid', header: 'Paid', align: 'right', render: (r) => (Number(r.amount_paid) > 0 ? money(r.amount_paid) : <span className="text-muted-foreground">—</span>) },
    { key: 'pay_by', header: 'Pay by', className: 'mg-num nowrap', render: (r) => (r.pay_by ? <span className={r.payment_status === 'Overdue' ? 'text-late font-semibold' : undefined}>{shortDate(r.pay_by)}</span> : <span className="text-muted-foreground">—</span>) },
    {
      key: 'payment_status', header: 'Status', min: 170,
      render: (r) => { const n = billNext(r); return <><StateBadge map={BILL} value={r.payment_status} /><span className={`app-sub2 is-wrap ${n.tone === 'late' ? 'is-late' : ''}`}>{n.text}</span></>; },
    },
    {
      key: 'document_id', header: 'PDF', render: (r) => (r.document_id
        ? <a className="mg-iconbtn" href={api.documentUrl(r.document_id)} target="_blank" rel="noopener noreferrer" aria-label={`Open the PDF of ${billNo(r)}`} title={r.document_name || 'Invoice PDF'} onClick={(e) => e.stopPropagation()}><FileText strokeWidth={1.8} aria-hidden="true" /></a>
        : <span className="text-[12px] text-muted-foreground">None</span>),
    },
  ];

  const creditColumns = [
    { key: 'credit_note_no', header: 'Credit note', className: 'nowrap', render: (r) => <><b className="mg-num">{r.credit_note_no}</b><span className="app-sub2">{r.credit_note_date ? shortDate(r.credit_note_date) : 'No date'}</span></> },
    { key: 'kind', header: 'Kind', render: (r) => (r.kind === 'cancellation_note' ? 'Cancellation note' : 'Credit note') },
    { key: 'vendor_id', header: 'Vendor', render: (r) => <b>{vendorName(r.vendor_id)}</b> },
    { key: 'refund_amount', header: 'Refunded', align: 'right', render: (r) => money(r.refund_amount) },
    { key: 'cancellation_charges', header: 'Charges', align: 'right', render: (r) => (r.cancellation_charges == null || Number(r.cancellation_charges) === 0 ? <span className="text-muted-foreground">—</span> : money(r.cancellation_charges)) },
    {
      key: 'against_invoice_id', header: 'Against', min: 150,
      render: (r) => {
        const b = billById[r.against_invoice_id];
        return r.against_invoice_id
          ? <><Link className="app-link mg-num" to={`/vendor-invoices/${r.against_invoice_id}`}>{b ? billNo(b) : 'Open the bill'}</Link>{b && <span className="app-sub2">{b.trip_count > 1 ? count(b.trip_count, 'trip') : [b.travel_id, b.employee_name].filter(Boolean).join(' · ')}</span>}</>
          : <Tone tone="wait">Not tied to a bill</Tone>;
      },
    },
  ];

  return (
    <>
      {tab === 'invoices' ? (
        <ListPage
          key="invoices"
          refreshToken={version}
          title="Vendor invoices"
          subtitle="HR records the bill; finance pays by the following month-end. One bill can cover several trips."
          nav={tabs}
          resource="vendor-invoices"
          noun="vendor invoices"
          allLabel="All bills"
          columns={columns}
          fields={(record) => vendorInvoiceFields(lookups, record)}
          formSize="lg"
          onRowClick={(row) => navigate(`/vendor-invoices/${row.id}`)}
          onSaved={(saved, before) => { setVersion((v) => v + 1); if (!before && saved?.id && !saved.travel_id) navigate(`/vendor-invoices/${saved.id}`); }}
          newLabel="Vendor invoice"
          formTitle="vendor invoice"
          formSubmitLabel="Add invoice"
          formIntro="Enter only what is on the bill. For one trip, choose it here; for several, leave the trip blank and the bill's page opens so you can add a line per trip."
          deleteTitle={(r) => `Delete ${billNo(r)}?`}
          deleteText={(r) => `${r.travel_vendor || 'Vendor'} · ${r.invoice_amount == null ? 'no amount' : money(r.invoice_amount)}. This cannot be undone. Its lines and credit notes go with it, and ${r.trip_count > 1 ? `its ${r.trip_count} trips` : 'its trip'} no longer count${r.trip_count > 1 ? '' : 's'} this cost.`}
          exportable={!isHr}
          searchPlaceholder="Search invoice, vendor, trip or traveller"
          summary={invoiceStrip}
          phoneBelow={1024}
          rowExtras={payButton}
          rowMenu={(r) => [
            { label: 'Open the bill', icon: ArrowRight, onSelect: () => navigate(`/vendor-invoices/${r.id}`) },
            r.payment_status !== 'Paid' && r.invoice_amount !== null && { label: 'Pay', icon: Receipt, onSelect: () => setPaying(r) },
          ].filter(Boolean)}
          phone={(r) => ({
            title: r.travel_vendor || 'Vendor not named',
            to: `/vendor-invoices/${r.id}`,
            amount: r.invoice_amount === null ? 'No amount' : money(r.payment_status === 'Paid' ? r.net_payable : owed(r)),
            meta: [billNo(r), r.trip_count > 1 ? `${count(r.trip_count, 'trip')}: ${r.employee_name}` : [r.travel_id, r.employee_name].filter(Boolean).join(' '), r.pay_by && `pay by ${shortDate(r.pay_by)}`, Number(r.amount_paid) > 0 && r.payment_status !== 'Paid' && `${money(r.amount_paid)} paid`].filter(Boolean).join(' · '),
            state: <StateBadge map={BILL} value={r.payment_status} />,
          })}
          filters={[
            { name: 'payment_status', label: 'Status', options: Object.entries(BILL).map(([value, [, label]]) => ({ value, label })) },
            { name: 'vendor_id', label: 'Vendor', options: vendorOptions(lookups) },
          ]}
          extraFilterLabels={{ travel_id: 'Trip', project_id: 'Project', travel_vendor: 'Vendor' }}
        />
      ) : (
        <ListPage
          key="credit-notes"
          refreshToken={version}
          title="Vendor invoices"
          subtitle="What the travel agency gave back. A note on a leg marks it cancelled or partly refunded; tied to a bill, it comes off what we owe."
          nav={tabs}
          resource="vendor-credit-notes"
          noun="credit notes"
          allLabel="All notes"
          columns={creditColumns}
          fields={() => creditNoteFields(lookups, { invoices: bills.rows, legs: [] })}
          onSaved={() => setVersion((v) => v + 1)}
          formSize="lg"
          newLabel="Credit note"
          formTitle="credit note"
          formSubmitLabel="Add note"
          deleteTitle={(r) => `Delete ${r.credit_note_no}?`}
          deleteText={(r) => `${vendorName(r.vendor_id)} · ${money(r.refund_amount)} refunded. This cannot be undone.${r.against_invoice_id ? ' The bill it was against owes this much more again.' : ''}`}
          exportable={!isHr}
          searchPlaceholder="Search credit note number or vendor"
          summary={notesStrip}
          phoneBelow={1024}
          phone={(r) => ({
            title: vendorName(r.vendor_id),
            amount: money(r.refund_amount),
            meta: [r.credit_note_no, r.kind === 'cancellation_note' ? 'Cancellation note' : 'Credit note', r.credit_note_date && shortDate(r.credit_note_date), r.against_invoice_id && billById[r.against_invoice_id] && `against ${billNo(billById[r.against_invoice_id])}`].filter(Boolean).join(' · '),
            state: r.against_invoice_id ? <Tone tone="ok">Counted</Tone> : <Tone tone="wait">Not tied to a bill</Tone>,
          })}
          filters={[
            { name: 'kind', label: 'Kind', options: [{ value: 'credit_note', label: 'Credit note' }, { value: 'cancellation_note', label: 'Cancellation note' }] },
            { name: 'vendor_id', label: 'Vendor', options: vendorOptions(lookups) },
          ]}
        />
      )}

      {paying && (
        <PayVendorDialog
          invoice={paying}
          onClose={() => setPaying(null)}
          onDone={() => {
            setPaying(null);
            setVersion((v) => v + 1);
          }}
        />
      )}
    </>
  );
}
