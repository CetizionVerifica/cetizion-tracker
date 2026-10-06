import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ListPage } from '../components/ListPage.jsx';
import { Badge, Tabs } from '../components/ui.jsx';
import { PayVendorDialog } from '../components/actions.jsx';
import { useLookups } from '../lib/hooks.js';
import { money, date } from '../lib/format.js';

const vendorOptions = (lookups) => lookups.travel_vendor_list.map((v) => ({ value: String(v.id), label: v.name }));

/** A travel agency invoice's header (#196 §4.4): its lines are added on the invoice's own page. */
export function vendorInvoiceFields(lookups) {
  return [
    { name: 'vendor_invoice_id', label: 'Reference', required: true, hint: 'Your internal reference, e.g. VINV-2026-001' },
    { name: 'vendor_id', label: 'Vendor', type: 'select', options: vendorOptions(lookups), hint: 'Left blank: the trip\'s vendor' },
    { name: 'travel_id', label: 'Trip (one trip)', type: 'select', options: lookups.trips.map((t) => ({ value: t.travel_id, label: `${t.travel_id} — ${t.employee_name}${t.destination ? ` (${t.destination})` : ''}` })), hint: 'For a bill covering one trip. A bill for several trips leaves this blank and gets a line per trip on its page' },
    { name: 'vendor_invoice_no', label: "Vendor's invoice number", hint: 'e.g. HT/2627/1877' },
    { name: 'invoice_date', label: 'Invoice date', type: 'date' },
    { name: 'invoice_amount', label: 'Invoice amount', type: 'money', hint: 'With lines, the total follows them' },
    { name: 'payment_terms_days', label: 'Payment terms (days)', type: 'number', default: '30' },
    { name: 'vendor_gstin_on_invoice', label: 'Vendor GSTIN as printed' },
    { name: 'place_of_supply', label: 'Place of supply' },
    { name: 'document_id', label: 'Invoice PDF', type: 'document', owner: 'vendor-invoices', maxBytes: lookups.limits?.document_max_bytes, span: 2 },
    // amount_paid and payment_date are recorded through Pay, which validates
    // the figure and notes who recorded it (#85). Every role may still pay a
    // vendor invoice — only the door changed, not the permission.
    { name: 'remarks', label: 'Remarks', type: 'textarea', span: 'all' },
  ];
}

/** A credit or cancellation note against one of a vendor's invoices (#196 §4.5). */
export function creditNoteFields(lookups, { invoices = [], legs = [] } = {}) {
  return [
    { name: 'vendor_id', label: 'Vendor', type: 'select', required: true, options: vendorOptions(lookups) },
    { name: 'credit_note_no', label: 'Credit note number', required: true, hint: 'e.g. HT/2627/CN/349 or HT/2627/CNT/151' },
    { name: 'kind', label: 'Kind', type: 'select', options: [{ value: 'credit_note', label: 'Credit note' }, { value: 'cancellation_note', label: 'Cancellation note' }], default: 'credit_note' },
    { name: 'credit_note_date', label: 'Date', type: 'date' },
    { name: 'against_invoice_id', label: 'Against invoice', type: 'select', options: invoices.map((i) => ({ value: String(i.id), label: `${i.vendor_invoice_no || i.vendor_invoice_id} · ${i.travel_vendor}` })) },
    { name: 'segment_id', label: 'The leg it cancels or refunds', type: 'select', options: legs.map((l) => ({ value: String(l.id), label: `${l.travel_id}: ${l.mode} ${l.from_place || ''} → ${l.to_place || ''} ${l.start_date || ''}` })), hint: 'Marks the leg cancelled or partly refunded' },
    { name: 'refund_amount', label: 'Refunded to us', type: 'money', default: '0' },
    { name: 'cancellation_charges', label: 'Cancellation charges', type: 'money' },
    { name: 'document_id', label: 'Credit note PDF', type: 'document', owner: 'vendor-credit-notes', maxBytes: lookups.limits?.document_max_bytes, span: 2 },
    { name: 'remarks', label: 'Remarks', type: 'textarea', span: 'all' },
  ];
}

export default function VendorInvoices() {
  const lookups = useLookups();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'credit-notes' ? 'credit-notes' : 'invoices';
  const [paying, setPaying] = useState(null);
  const [version, setVersion] = useState(0);

  const columns = [
    { key: 'vendor_invoice_no', header: 'Invoice', className: 'mono', render: (r) => <>{r.vendor_invoice_no || r.vendor_invoice_id}<div className="small muted">{date(r.invoice_date)}</div></> },
    { key: 'travel_vendor', header: 'Vendor', className: 'strong' },
    { key: 'travel_id', header: 'Trip', className: 'small', render: (r) => (r.trip_count > 1
      ? <>{r.trip_count} trips<div className="muted">{r.employee_name}</div></>
      : <><span className="mono">{r.travel_id}</span><div className="muted">{r.employee_name}</div></>) },
    { key: 'raised_in_time', header: 'Raised', render: (r) => (r.raised_in_time ? <Badge tone={r.raised_in_time === 'On time' ? 'success' : 'warning'}>{r.raised_in_time}</Badge> : <span className="muted">—</span>) },
    { key: 'invoice_amount', header: 'Amount', align: 'right', render: (r) => (r.invoice_amount === null ? <Badge tone="warning">not entered</Badge> : <>{money(r.invoice_amount)}{Number(r.credited) > 0 && <div className="small muted">{money(r.net_payable)} after credit notes</div>}</>) },
    { key: 'amount_paid', header: 'Paid', align: 'right', render: (r) => money(r.amount_paid) },
    { key: 'pay_by', header: 'Pay by', render: (r) => date(r.pay_by) },
    { key: 'payment_status', header: 'Status', render: (r) => <Badge>{r.payment_status}</Badge> },
    { key: 'document_id', header: 'PDF', className: 'small', render: (r) => (r.document_id ? '✓' : <span className="muted">—</span>) },
    { key: 'finance_action', header: 'Finance action', className: 'wrap small' },
    {
      key: 'act',
      header: '',
      align: 'right',
      render: (r) =>
        r.payment_status === 'Paid' ? (
          <span className="muted small">—</span>
        ) : (
          <div className="table__actions">
            <button
              type="button"
              className={`btn btn--sm ${r.payment_status === 'Overdue' ? 'btn--primary' : ''}`}
              onClick={(e) => { e.stopPropagation(); setPaying(r); }}
              disabled={r.invoice_amount === null}
            >
              Pay
            </button>
          </div>
        ),
    },
  ];

  const creditColumns = [
    { key: 'credit_note_no', header: 'Credit note', className: 'mono', render: (r) => <>{r.credit_note_no}<div className="small muted">{date(r.credit_note_date)}</div></> },
    { key: 'kind', header: 'Kind', render: (r) => (r.kind === 'cancellation_note' ? 'Cancellation note' : 'Credit note') },
    { key: 'vendor_id', header: 'Vendor', render: (r) => lookups.travel_vendor_list.find((v) => v.id === r.vendor_id)?.name || '—' },
    { key: 'refund_amount', header: 'Refunded', align: 'right', render: (r) => money(r.refund_amount) },
    { key: 'cancellation_charges', header: 'Charges', align: 'right', render: (r) => (r.cancellation_charges === null ? '—' : money(r.cancellation_charges)) },
    { key: 'against_invoice_id', header: 'Against', className: 'small', render: (r) => (r.against_invoice_id ? <a className="underline" href={`/vendor-invoices/${r.against_invoice_id}`} onClick={(e) => { e.preventDefault(); navigate(`/vendor-invoices/${r.against_invoice_id}`); }}>invoice</a> : <span className="muted">—</span>) },
  ];

  return (
    <>
      <div className="px-4 pt-4 sm:px-8">
        <Tabs
          active={tab}
          onChange={(key) => setParams(key === 'credit-notes' ? { tab: 'credit-notes' } : {})}
          tabs={[{ key: 'invoices', label: 'Invoices' }, { key: 'credit-notes', label: 'Credit notes' }]}
        />
      </div>
      {tab === 'invoices' ? (
        <ListPage
          refreshToken={version}
          title="Travel vendor invoices"
          subtitle="HR records the bill; finance pays by the following month-end. One bill can cover several trips."
          resource="vendor-invoices"
          columns={columns}
          fields={vendorInvoiceFields(lookups)}
          onRowClick={(row) => navigate(`/vendor-invoices/${row.id}`)}
          newLabel="Vendor invoice"
          formTitle="vendor invoice"
          formIntro="Enter only what is on the bill. For one trip, choose it here; for several, save the bill and add a line per trip on its page."
          searchPlaceholder="Search invoice, vendor, trip…"
          filters={[
            { name: 'payment_status', label: 'Status', options: ['Awaited', 'Enter amount', 'Enter date', 'To Pay', 'Partially Paid', 'Overdue', 'Paid'] },
            { name: 'vendor_id', label: 'Vendor', options: vendorOptions(lookups) },
          ]}
        />
      ) : (
        <ListPage
          title="Credit and cancellation notes"
          subtitle="What the travel agency gave back. A note on a leg marks it cancelled or partly refunded."
          resource="vendor-credit-notes"
          columns={creditColumns}
          fields={creditNoteFields(lookups)}
          newLabel="Credit note"
          formTitle="credit note"
          searchPlaceholder="Search credit note…"
          filters={[{ name: 'kind', label: 'Kind', options: [{ value: 'credit_note', label: 'Credit note' }, { value: 'cancellation_note', label: 'Cancellation note' }] }]}
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
