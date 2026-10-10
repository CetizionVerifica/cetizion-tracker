import { Link } from 'react-router-dom';
import { PageHeader } from '../App.jsx';
import { Alert, Badge, Card, DataTable, Empty, ErrorState, Stat } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/hooks.js';
import { money, date } from '../lib/format.js';

const BUCKET_TONE = {
  'not due': 'success',
  '0-30': 'warning',
  '31-60': 'danger',
  '61-90': 'danger',
  '90+': 'danger',
  'date missing': 'warning',
  'amount missing': 'warning',
};

/**
 * What Cetizion owes travel vendors, aged (#76) — the other side of
 * Collections. Rupees throughout: vendor bills carry no other currency.
 * A bill with no amount is shown as a gap to fill, never as zero.
 */
export default function Payables() {
  const { data, loading, error, refetch } = useFetch(() => api.raw('/dashboard/payables'));
  const p = data?.data;

  return (
    <>
      <PageHeader
        title="Payables"
        subtitle="What we owe travel vendors, and how long they have been waiting"
        actions={(
          <>
            <a className="btn" href={api.exportUrl('payables')} download title="The rows below, as a spreadsheet">Export CSV</a>
            <button type="button" className="btn" onClick={refetch}>Refresh</button>
          </>
        )}
      />

      <div className="page stack">
        {error && <ErrorState message={error} onRetry={refetch} />}

        {p && (
          <>
            <div className="auto-grid--stats">
              <Stat
                label="Total outstanding"
                value={money(p.total_outstanding)}
                meta={`${p.rows.length - p.amount_missing} bill${p.rows.length - p.amount_missing === 1 ? '' : 's'} with an amount`}
              />
              {p.buckets.filter((b) => b.bucket !== 'amount missing').map((b) => (
                <Stat
                  key={b.bucket}
                  label={b.bucket === 'not due' || b.bucket === 'date missing' ? b.bucket : `${b.bucket} days overdue`}
                  value={money(b.outstanding)}
                  meta={`${b.invoices} bill${b.invoices === 1 ? '' : 's'}`}
                  tone={b.invoices > 0 ? BUCKET_TONE[b.bucket] : ''}
                />
              ))}
            </div>

            {p.amount_missing > 0 && (
              <Alert tone="warning">
                <span>
                  <strong>{p.amount_missing}</strong> vendor bill{p.amount_missing === 1 ? ' has' : 's have'} no amount,
                  so {p.amount_missing === 1 ? 'it is' : 'they are'} not in the totals above.{' '}
                  <Link to="/vendor-invoices?payment_status=Enter%20amount">Enter the amounts</Link>.
                </span>
              </Alert>
            )}
          </>
        )}

        <Card flush>
          <DataTable
            loading={loading}
            rows={p?.rows || []}
            columns={[
              { key: 'vendor_invoice_no', header: 'Invoice', className: 'mono', render: (r) => <>{r.vendor_invoice_no || r.vendor_invoice_id}<div className="small muted">{date(r.invoice_date)}</div></> },
              { key: 'travel_vendor', header: 'Vendor', className: 'strong' },
              { key: 'travel_id', header: 'Trip', className: 'small', render: (r) => <><span className="mono">{r.travel_id}</span><div className="muted">{r.employee_name}</div></> },
              { key: 'invoice_amount', header: 'Amount', align: 'right', render: (r) => (r.invoice_amount === null ? <Badge tone="warning">not entered</Badge> : money(r.invoice_amount)) },
              { key: 'amount_paid', header: 'Paid', align: 'right', render: (r) => money(r.amount_paid) },
              { key: 'outstanding', header: 'Outstanding', align: 'right', className: 'strong', render: (r) => (r.outstanding === null ? <span className="muted">—</span> : money(r.outstanding)) },
              { key: 'pay_by', header: 'Pay by', render: (r) => date(r.pay_by) },
              { key: 'days_overdue', header: 'Days overdue', align: 'right', render: (r) => (r.days_overdue > 0 ? r.days_overdue : <span className="muted">—</span>) },
              { key: 'bucket', header: 'Ageing', render: (r) => <Badge tone={BUCKET_TONE[r.bucket]}>{r.bucket}</Badge> },
            ]}
            // A failed load leaves rows empty, and "nothing owed" is not
            // what an empty list means then. The commonest way this fires
            // is an expired session, so somebody comes back from lunch and
            // reads that every vendor bill is paid — on the page whose
            // whole job is to say what is not.
            empty={error ? null : <Empty icon="✓" title="Nothing owed" text="Every vendor bill with an invoice number is paid." />}
          />
        </Card>
      </div>
    </>
  );
}
