import { useState } from 'react';
import { ListPage } from '../components/ListPage.jsx';
import { Badge } from '../components/ui.jsx';
import { PayVendorDialog } from '../components/actions.jsx';
import { useLookups } from '../lib/hooks.js';
import { money, date } from '../lib/format.js';

export default function VendorInvoices() {
  const lookups = useLookups();
  const [paying, setPaying] = useState(null);
  const [version, setVersion] = useState(0);

  const columns = [
    { key: 'vendor_invoice_no', header: 'Invoice', className: 'mono', render: (r) => <>{r.vendor_invoice_no || r.vendor_invoice_id}<div className="small muted">{date(r.invoice_date)}</div></> },
    { key: 'travel_vendor', header: 'Vendor', className: 'strong' },
    { key: 'travel_id', header: 'Trip', className: 'small', render: (r) => <><span className="mono">{r.travel_id}</span><div className="muted">{r.employee_name}</div></> },
    { key: 'raised_in_time', header: 'Raised', render: (r) => (r.raised_in_time ? <Badge tone={r.raised_in_time === 'On time' ? 'success' : 'warning'}>{r.raised_in_time}</Badge> : <span className="muted">—</span>) },
    { key: 'invoice_amount', header: 'Amount', align: 'right', render: (r) => (r.invoice_amount === null ? <Badge tone="warning">not entered</Badge> : money(r.invoice_amount)) },
    { key: 'amount_paid', header: 'Paid', align: 'right', render: (r) => money(r.amount_paid) },
    { key: 'pay_by', header: 'Pay by', render: (r) => date(r.pay_by) },
    { key: 'payment_status', header: 'Status', render: (r) => <Badge>{r.payment_status}</Badge> },
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
              onClick={() => setPaying(r)}
              disabled={r.invoice_amount === null}
            >
              Pay
            </button>
          </div>
        ),
    },
  ];

  const fields = [
    { name: 'vendor_invoice_id', label: 'Reference', required: true, hint: 'Your internal reference, e.g. VINV-2026-001' },
    { name: 'travel_id', label: 'Trip', required: true, type: 'select', options: lookups.trips.map((t) => ({ value: t.travel_id, label: `${t.travel_id} — ${t.employee_name}${t.destination ? ` (${t.destination})` : ''}` })) },
    { name: 'vendor_invoice_no', label: "Vendor's invoice number" },
    { name: 'invoice_date', label: 'Invoice date', type: 'date' },
    { name: 'invoice_amount', label: 'Invoice amount', type: 'money' },
    { name: 'payment_terms_days', label: 'Payment terms (days)', type: 'number', default: '30' },
    { name: 'amount_paid', label: 'Amount paid', type: 'money', default: '0' },
    { name: 'payment_date', label: 'Payment date', type: 'date' },
    { name: 'remarks', label: 'Remarks', type: 'textarea', span: 'all' },
  ];

  return (
    <>
      <ListPage
        refreshToken={version}
        title="Travel vendor invoices"
        subtitle="HR records the bill; finance pays by the following month-end"
        resource="vendor-invoices"
        columns={columns}
        fields={fields}
        newLabel="Vendor invoice"
        formTitle="vendor invoice"
        formIntro="Enter only what is on the bill — trip, employee, project and client are read back from the travel log."
        searchPlaceholder="Search invoice, vendor, trip…"
        filters={[
          { name: 'payment_status', label: 'Status', options: ['Awaited', 'Enter amount', 'Enter date', 'To Pay', 'Partially Paid', 'Overdue', 'Paid'] },
        ]}
      />

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
