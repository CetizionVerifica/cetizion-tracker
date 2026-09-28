import { useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader } from '../App.jsx';
import { Card, DataTable, Badge, Empty, ErrorState, Tabs } from '../components/ui.jsx';
import {
  RecordInvoiceDialog, RecordPaymentDialog, PayVendorDialog,
  ClaimDecisionDialog, ReimburseClaimDialog, ConvertQuotationDialog,
} from '../components/actions.jsx';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/hooks.js';
import { money, date } from '../lib/format.js';

/**
 * One screen that answers "what is waiting on us?" — the workbook's
 * "filter the Payment Schedule on To Invoice", extended to every queue.
 */
export default function Worklist() {
  const { data, loading, error, refetch } = useFetch(() => api.raw('/dashboard/worklist'));
  const [tab, setTab] = useState('all');
  const [dialog, setDialog] = useState(null);
  const quiet = useFetch(() => api.raw('/communications/no-contact'));
  const q = quiet.data?.data;
  const quietCount = q ? q.quotations.length + q.enquiries.length + q.invoices.length : undefined;

  const w = data?.data;
  const close = () => setDialog(null);
  const done = () => {
    close();
    refetch();
  };

  if (error) {
    return (
      <>
        <PageHeader title="Action list" />
        <div className="page"><ErrorState message={error} onRetry={refetch} /></div>
      </>
    );
  }

  const counts = w
    ? {
        stages: w.payment_stages.length,
        vendors: w.vendor_invoices.length,
        claims: w.expense_claims.length,
        delivery: w.late_deliveries.length,
        sales: w.won_without_project.length,
      }
    : {};
  const totalCount = Object.values(counts).reduce((a, b) => a + b, 0);

  const show = (key) => tab === 'all' || tab === key;

  return (
    <>
      <PageHeader
        title="Action list"
        subtitle="Everything waiting on finance, HR or sales — in priority order"
        actions={<button type="button" className="btn" onClick={refetch}>Refresh</button>}
      />

      <div className="page stack">
        <Tabs
          active={tab}
          onChange={setTab}
          tabs={[
            { key: 'all', label: 'Everything', count: totalCount },
            { key: 'stages', label: 'Client invoicing', count: counts.stages },
            { key: 'vendors', label: 'Vendor bills', count: counts.vendors },
            { key: 'claims', label: 'Expense claims', count: counts.claims },
            { key: 'delivery', label: 'Late delivery', count: counts.delivery },
            { key: 'sales', label: 'Unregistered wins', count: counts.sales },
            { key: 'quiet', label: 'No contact', count: quietCount },
          ]}
        />

        {!loading && totalCount === 0 && tab !== 'quiet' && (
          <Card>
            <Empty
              icon="✓"
              title="Nothing needs attention"
              text="No stages to invoice, no overdue payments, no bills or claims outstanding."
            />
          </Card>
        )}

        {show('stages') && (counts.stages > 0 || loading) && (
          <Card
            title="Client invoicing & collections"
            hint="Raise the invoice, then record the money when it lands"
            actions={<Link className="btn btn--sm" to="/payment-stages">Open payment schedule</Link>}
          >
            <DataTable
              loading={loading}
              rows={w?.payment_stages || []}
              columns={[
                {
                  key: 'po_number',
                  header: 'PO / stage',
                  render: (r) => (
                    <>
                      <Link to={`/purchase-orders/${encodeURIComponent(r.po_number)}`} className="mono">{r.po_number}</Link>
                      <div className="small muted">{r.stage_name}</div>
                    </>
                  ),
                },
                {
                  key: 'client_name',
                  header: 'Client',
                  className: 'strong',
                  render: (r) => (
                    <>
                      {r.client_name}
                      <div className="small muted mono">{r.project_id}</div>
                    </>
                  ),
                },
                { key: 'stage_amount', header: 'Stage value', align: 'right', render: (r) => money(r.stage_amount, r.currency) },
                { key: 'due_now_amount', header: 'Due now', align: 'right', className: 'strong', render: (r) => money(r.due_now_amount, r.currency) },
                { key: 'to_bill_amount', header: 'To bill', align: 'right', render: (r) => (r.to_bill_amount > 0 ? money(r.to_bill_amount, r.currency) : <span className="muted">—</span>) },
                { key: 'invoice_due_date', header: 'Due date', render: (r) => date(r.invoice_due_date) },
                { key: 'stage_status', header: 'Status', render: (r) => <Badge>{r.stage_status}</Badge> },
                { key: 'follow_up_action', header: 'What to do', className: 'wrap small', render: (r) => r.follow_up_action },
                {
                  key: 'act',
                  header: '',
                  align: 'right',
                  render: (r) => (
                    <div className="table__actions">
                      {r.stage_status === 'To Invoice' ? (
                        <button type="button" className="btn btn--sm btn--primary" onClick={() => setDialog({ type: 'invoice', row: r })}>
                          Invoice
                        </button>
                      ) : (
                        <button type="button" className="btn btn--sm" onClick={() => setDialog({ type: 'payment', row: r })}>
                          Record payment
                        </button>
                      )}
                    </div>
                  ),
                },
              ]}
            />
          </Card>
        )}

        {show('vendors') && counts.vendors > 0 && (
          <Card title="Travel vendor bills" hint="Settled at the month-end following the invoice date">
            <DataTable
              rows={w.vendor_invoices}
              columns={[
                { key: 'vendor_invoice_no', header: 'Invoice', className: 'mono', render: (r) => r.vendor_invoice_no || r.vendor_invoice_id },
                { key: 'travel_vendor', header: 'Vendor', className: 'strong' },
                { key: 'travel_id', header: 'Trip', className: 'mono small', render: (r) => <>{r.travel_id}<div className="muted">{r.employee_name}</div></> },
                { key: 'invoice_amount', header: 'Amount', align: 'right', render: (r) => money(r.invoice_amount) },
                { key: 'amount_paid', header: 'Paid', align: 'right', render: (r) => money(r.amount_paid) },
                { key: 'pay_by', header: 'Pay by', render: (r) => date(r.pay_by) },
                { key: 'payment_status', header: 'Status', render: (r) => <Badge>{r.payment_status}</Badge> },
                { key: 'finance_action', header: 'What to do', className: 'wrap small' },
                {
                  key: 'act',
                  header: '',
                  align: 'right',
                  render: (r) => (
                    <div className="table__actions">
                      <button
                        type="button"
                        className={`btn btn--sm ${r.payment_status === 'Overdue' ? 'btn--primary' : ''}`}
                        onClick={() => setDialog({ type: 'vendor', row: r })}
                        disabled={r.invoice_amount === null}
                      >
                        Pay
                      </button>
                    </div>
                  ),
                },
              ]}
            />
          </Card>
        )}

        {show('claims') && counts.claims > 0 && (
          <Card title="Employee expense claims" hint="HR approves, finance reimburses at month-end">
            <DataTable
              rows={w.expense_claims}
              columns={[
                { key: 'claim_id', header: 'Claim', className: 'mono' },
                { key: 'employee_name', header: 'Employee', className: 'strong' },
                { key: 'expense_category', header: 'Category' },
                { key: 'claim_month', header: 'Month' },
                { key: 'amount_claimed', header: 'Claimed', align: 'right', render: (r) => money(r.amount_claimed) },
                { key: 'status', header: 'Status', render: (r) => <Badge>{r.status}</Badge> },
                { key: 'follow_up_action', header: 'What to do', className: 'wrap small' },
                {
                  key: 'act',
                  header: '',
                  align: 'right',
                  render: (r) => (
                    <div className="table__actions">
                      {r.status === 'Pending approval' ? (
                        <button type="button" className="btn btn--sm btn--primary" onClick={() => setDialog({ type: 'decide', row: r })}>
                          Review
                        </button>
                      ) : (
                        <button type="button" className="btn btn--sm" onClick={() => setDialog({ type: 'reimburse', row: r })}>
                          Reimburse
                        </button>
                      )}
                    </div>
                  ),
                },
              ]}
            />
          </Card>
        )}

        {show('delivery') && counts.delivery > 0 && (
          <Card title="Deliveries past their planned date" hint="Escalate to the project manager">
            <DataTable
              rows={w.late_deliveries}
              columns={[
                { key: 'project_id', header: 'Project', render: (r) => <Link className="mono" to={`/projects/${r.project_id}`}>{r.project_id}</Link> },
                { key: 'client_name', header: 'Client', className: 'strong' },
                { key: 'primary_service', header: 'Service', className: 'wrap' },
                { key: 'project_manager', header: 'Manager' },
                { key: 'planned_delivery_date', header: 'Planned', render: (r) => date(r.planned_delivery_date) },
                { key: 'days_late', header: 'Days late', align: 'right', render: (r) => <Badge tone="danger">{r.days_late}</Badge> },
              ]}
            />
          </Card>
        )}

        {show('sales') && counts.sales > 0 && (
          <Card
            title="Won quotations not yet registered as projects"
            hint="Until a project and PO exist, nothing can be invoiced against these"
          >
            <DataTable
              rows={w.won_without_project}
              columns={[
                { key: 'quotation_no', header: 'Quotation', className: 'mono' },
                { key: 'client_name', header: 'Client', className: 'strong' },
                { key: 'service_quoted', header: 'Service', className: 'wrap' },
                { key: 'quotation_value', header: 'Value', align: 'right', render: (r) => money(r.quotation_value, r.currency) },
                {
                  key: 'act',
                  header: '',
                  align: 'right',
                  render: (r) => (
                    <div className="table__actions">
                      <button type="button" className="btn btn--sm btn--primary" onClick={() => setDialog({ type: 'convert', row: r })}>
                        Register project
                      </button>
                    </div>
                  ),
                },
              ]}
            />
          </Card>
        )}
        {tab === 'quiet' && q && (
          <Card flush title={`No contact in ${q.days} days`} hint="Open deals, leads and overdue invoices nobody has called, messaged or met lately. Log a touch on the record to clear it. The number of days is in Settings (no_contact_days).">
            <DataTable
              rows={[
                ...q.quotations.map((r) => ({ ...r, kind: 'Quotation', to: `/quotations/${encodeURIComponent(r.ref)}` })),
                ...q.enquiries.map((r) => ({ ...r, kind: 'Enquiry', to: `/enquiries?q=${encodeURIComponent(r.ref)}` })),
                ...q.invoices.map((r) => ({ ...r, ref: r.invoice_no, status: `${r.days_overdue} days overdue`, kind: 'Overdue invoice', to: '/collections' })),
              ]}
              empty={<Empty icon="✓" title="Everyone has been contacted recently" />}
              columns={[
                { key: 'kind', header: 'What', render: (r) => <Badge tone={r.kind === 'Overdue invoice' ? 'danger' : 'info'}>{r.kind}</Badge> },
                { key: 'ref', header: 'Reference', className: 'mono', render: (r) => <Link to={r.to}>{r.ref}</Link> },
                { key: 'client_name', header: 'Client', className: 'strong' },
                { key: 'owner', header: 'Owner' },
                { key: 'status', header: 'Status' },
                { key: 'last_touch', header: 'Last touch', render: (r) => (r.last_touch ? date(r.last_touch) : 'never') },
              ]}
            />
          </Card>
        )}
      </div>

      {dialog?.type === 'invoice' && <RecordInvoiceDialog stage={dialog.row} onClose={close} onDone={done} />}
      {dialog?.type === 'payment' && <RecordPaymentDialog stage={dialog.row} onClose={close} onDone={done} />}
      {dialog?.type === 'vendor' && <PayVendorDialog invoice={dialog.row} onClose={close} onDone={done} />}
      {dialog?.type === 'decide' && <ClaimDecisionDialog claim={dialog.row} onClose={close} onDone={done} />}
      {dialog?.type === 'reimburse' && <ReimburseClaimDialog claim={dialog.row} onClose={close} onDone={done} />}
      {dialog?.type === 'convert' && <ConvertQuotationDialog quotation={dialog.row} onClose={close} onDone={done} />}
    </>
  );
}
