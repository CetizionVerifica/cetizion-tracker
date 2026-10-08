import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { MessageSquare, Phone } from 'lucide-react';
import { PageHeader } from '../App.jsx';
import { useShell } from '../components/shell/Shell.jsx';
import {
  RecordInvoiceDialog, RecordPaymentDialog, PayVendorDialog,
  ClaimDecisionDialog, ReimburseClaimDialog, ConvertQuotationDialog,
} from '../components/actions.jsx';
import {
  FailedCard, ListTable, LoadingPanel, MgTabs, Panel, PhoneRow, RefreshButton, StateCard, plural, statusTone, useEntrance,
} from '../components/daily.jsx';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/hooks.js';
import { money, date } from '../lib/format.js';

/**
 * One screen that answers "what is waiting on us?": the workbook's
 * "filter the Payment Schedule on To Invoice", extended to every queue.
 * Most urgent first; every card links to its full list.
 */
const TAB_KEYS = ['all', 'stages', 'vendors', 'claims', 'delivery', 'sales', 'portal', 'quiet'];

const EMPTY = {
  stages: ['Nothing to invoice or collect', 'Every stage is paid, not yet due, or still waiting on its trigger.'],
  vendors: ['No vendor bills waiting', 'Every travel bill with an amount is paid.'],
  claims: ['No expense claims waiting', 'Every claim is decided and reimbursed.'],
  delivery: ['No deliveries are late', 'Every project is on or before its planned delivery date.'],
  sales: ['Every won deal has a project', 'Nothing signed is sitting outside delivery.'],
  portal: ['Nothing from the client portal', 'No payment advice to match and no query to answer.'],
  quiet: ['Everyone has been contacted recently', 'Every open deal, enquiry and overdue invoice had a touch lately.'],
};

const ref = (to, text) => <Link to={to} className="app-ref">{text}</Link>;
const lateLine = (r) => (r.working_days_overdue == null ? null
  : <span className="sub text-late font-semibold">{plural(r.working_days_overdue, 'working day')} late</span>);

export default function Worklist() {
  const { isAdmin } = useShell();
  const { data, loading, error, refetch } = useFetch(() => api.raw('/dashboard/worklist'));
  const [params, setParams] = useSearchParams();
  const tab = TAB_KEYS.includes(params.get('tab')) ? params.get('tab') : 'all';
  const setTab = (key) => {
    const next = new URLSearchParams(params);
    if (key === 'all') next.delete('tab'); else next.set('tab', key);
    setParams(next, { replace: true });
  };
  const [dialog, setDialog] = useState(null);
  const quiet = useFetch(() => api.raw('/communications/no-contact'));
  const portal = useFetch(() => api.raw('/portal-admin/actions?status=open').catch(() => ({ data: [] })));
  const q = quiet.data?.data;
  const quietRows = q ? [
    ...q.quotations.map((r) => ({ ...r, kind: 'Quotation', to: `/quotations/${encodeURIComponent(r.ref)}` })),
    ...q.enquiries.map((r) => ({ ...r, kind: 'Enquiry', to: `/enquiries?q=${encodeURIComponent(r.ref)}` })),
    ...q.invoices.map((r) => ({ ...r, ref: r.invoice_no, status: `${plural(r.days_overdue, 'day')} overdue`, kind: 'Overdue invoice', to: '/collections' })),
  ] : [];
  const portalRows = portal.data?.data || [];

  const w = data?.data;
  const close = () => setDialog(null);
  const done = () => { close(); refetch(); };
  const pageRef = useEntrance(!loading && Boolean(w));

  const counts = w ? {
    stages: w.payment_stages.length,
    vendors: w.vendor_invoices.length,
    claims: w.expense_claims.length,
    delivery: w.late_deliveries.length,
    sales: w.won_without_project.length,
    portal: portalRows.length,
    quiet: q ? quietRows.length : undefined,
  } : {};
  const five = w ? counts.stages + counts.vendors + counts.claims + counts.delivery + counts.sales : 0;
  const everything = five + (counts.portal || 0) + (counts.quiet || 0);
  const show = (key) => (tab === 'all' || tab === key) && counts[key] > 0;

  const header = (
    <PageHeader
      title="Action list"
      subtitle="Everything waiting on finance, the travel desk or sales, most urgent first."
      actions={<RefreshButton onClick={() => { refetch(); quiet.refetch(); portal.refetch(); }} />}
    />
  );

  if (error) {
    return (
      <>
        {header}
        <div className="app-page">
          <FailedCard title="Couldn’t load the Action list" text="The server didn’t answer, so we can’t say what is waiting. Nothing has changed." onRetry={refetch} />
        </div>
      </>
    );
  }

  return (
    <>
      {header}
      <div className="app-page" ref={pageRef}>
        <MgTabs
          label="What is waiting"
          active={tab}
          onChange={setTab}
          tabs={[
            { key: 'all', label: 'Everything', count: w ? everything : undefined },
            { key: 'stages', label: 'Client invoicing', count: counts.stages },
            { key: 'vendors', label: 'Vendor bills', count: counts.vendors },
            { key: 'claims', label: 'Expense claims', count: counts.claims },
            { key: 'delivery', label: 'Late delivery', count: counts.delivery },
            { key: 'sales', label: 'Unregistered wins', count: counts.sales },
            { key: 'portal', label: 'Client portal', count: counts.portal },
            { key: 'quiet', label: 'No contact', count: counts.quiet },
          ]}
        />

        {loading && <LoadingPanel />}

        {!loading && w && tab === 'all' && everything === 0 && (
          <StateCard title="Nothing needs attention" text="No stages to invoice, no overdue payments, no bills or claims outstanding." />
        )}
        {!loading && w && tab !== 'all' && counts[tab] === 0 && (
          <StateCard title={EMPTY[tab][0]} text={EMPTY[tab][1]}>
            <button type="button" className="mg-btn mg-btn--sm" onClick={() => setTab('all')}>See everything ({everything})</button>
          </StateCard>
        )}

        {!loading && show('stages') && (
          <Panel id="c-inv" title="Client invoicing & collections" hint="Raise the invoice, then record the money when it lands. Overdue first."
            tools={<Link className="mg-btn mg-btn--ghost mg-btn--sm" to="/payment-stages">Open payment schedule</Link>}>
            <ListTable
              label="Client invoicing and collections"
              rows={w.payment_stages}
              columns={[
                { key: 'po', header: 'PO / stage', render: (r) => <>{ref(`/purchase-orders/${encodeURIComponent(r.po_number)}`, r.po_number)}<span className="sub">{r.stage_name}</span></> },
                { key: 'client', header: 'Client', className: 'strong app-wrap--sm', render: (r) => <>{r.client_name}<span className="sub mg-num">{r.project_id}</span></> },
                { key: 'value', header: 'Stage value', num: true, render: (r) => money(r.stage_amount, r.currency) },
                { key: 'due', header: 'Due now', num: true, className: 'strong', render: (r) => money(r.due_now_amount, r.currency) },
                { key: 'bill', header: 'To bill', num: true, render: (r) => (Number(r.to_bill_amount) > 0 ? money(r.to_bill_amount, r.currency) : '—') },
                { key: 'date', header: 'Due date', className: 'mg-num', render: (r) => <>{date(r.invoice_due_date)}{lateLine(r)}</> },
                { key: 'status', header: 'Status', render: (r) => <span className={`mg-badge ${statusTone(r.stage_status)}`}>{r.stage_status === 'Partially Paid' ? 'Partly paid' : r.stage_status}</span> },
                { key: 'todo', header: 'What to do', className: 'app-say', render: (r) => r.follow_up_action },
                {
                  key: 'act', header: '', className: 'actions', render: (r) => (r.stage_status === 'To Invoice'
                    ? <button type="button" className="mg-btn mg-btn--sm mg-btn--primary" onClick={() => setDialog({ type: 'invoice', row: r })}>Invoice</button>
                    : <button type="button" className="mg-btn mg-btn--sm" onClick={() => setDialog({ type: 'payment', row: r })}>Record payment</button>),
                },
              ]}
              phone={(r) => {
                const act = r.stage_status === 'To Invoice' ? 'Invoice' : 'Record payment';
                return (
                  <PhoneRow
                    title={r.client_name} amount={money(r.due_now_amount, r.currency)}
                    meta={`${r.po_number} · ${r.stage_name}${r.invoice_due_date ? ` · due ${date(r.invoice_due_date)}` : ''}`}
                    state={<span className={`mg-badge ${statusTone(r.stage_status)}`}>{r.stage_status === 'Partially Paid' ? 'Partly paid' : r.stage_status}</span>}
                    go={`${act} →`} label={`${r.client_name}, ${r.stage_name}, ${r.stage_status}. ${act}`}
                    onClick={() => setDialog({ type: r.stage_status === 'To Invoice' ? 'invoice' : 'payment', row: r })}
                  />
                );
              }}
            />
          </Panel>
        )}

        {!loading && show('vendors') && (
          <Panel id="c-bills" title="Travel vendor bills" hint="Paid at the month-end after the invoice date."
            tools={<Link className="mg-btn mg-btn--ghost mg-btn--sm" to="/vendor-invoices">Open vendor invoices</Link>}>
            <ListTable
              label="Travel vendor bills"
              rows={w.vendor_invoices}
              columns={[
                { key: 'inv', header: 'Invoice', render: (r) => ref(`/vendor-invoices/${r.id}`, r.vendor_invoice_no || r.vendor_invoice_id) },
                { key: 'vendor', header: 'Vendor', className: 'strong app-wrap--sm', render: (r) => r.travel_vendor },
                { key: 'trip', header: 'Trip', className: 'app-wrap--sm', render: (r) => <>{r.travel_id ? ref(`/travel/${encodeURIComponent(r.travel_id)}`, r.travel_id) : '—'}<span className="sub">{r.employee_name}</span></> },
                { key: 'amt', header: 'Amount', num: true, className: 'strong', render: (r) => (r.invoice_amount == null ? '—' : money(r.invoice_amount)) },
                { key: 'paid', header: 'Paid', num: true, render: (r) => money(r.amount_paid) },
                { key: 'by', header: 'Pay by', className: 'mg-num', render: (r) => <>{r.pay_by ? date(r.pay_by) : '—'}{lateLine(r)}</> },
                { key: 'status', header: 'Status', render: (r) => <span className={`mg-badge ${statusTone(r.payment_status)}`}>{r.payment_status}</span> },
                { key: 'todo', header: 'What to do', className: 'app-say', render: (r) => r.finance_action },
                {
                  key: 'act', header: '', className: 'actions', render: (r) => (
                    <>
                      <button type="button" className={`mg-btn mg-btn--sm ${r.payment_status === 'Overdue' ? 'mg-btn--primary' : ''}`}
                        onClick={() => setDialog({ type: 'vendor', row: r })} disabled={r.invoice_amount === null}
                        aria-describedby={r.invoice_amount === null ? `pay-why-${r.id}` : undefined}>Pay</button>
                      {r.invoice_amount === null && <span className="sub" id={`pay-why-${r.id}`}>Enter the amount first</span>}
                    </>
                  ),
                },
              ]}
              phone={(r) => (
                <PhoneRow
                  title={r.travel_vendor} amount={r.invoice_amount == null ? '—' : money(r.invoice_amount)}
                  meta={`${r.vendor_invoice_no || r.vendor_invoice_id} · ${r.travel_id || 'no trip'}${r.pay_by ? ` · pay by ${date(r.pay_by)}` : ''}`}
                  state={<span className={`mg-badge ${statusTone(r.payment_status)}`}>{r.payment_status}</span>}
                  go={r.invoice_amount === null ? 'Enter the amount first' : 'Pay →'} goOff={r.invoice_amount === null}
                  label={`${r.travel_vendor}, ${r.payment_status}${r.invoice_amount === null ? '. Enter the amount first' : '. Pay'}`}
                  onClick={r.invoice_amount === null ? undefined : () => setDialog({ type: 'vendor', row: r })}
                />
              )}
            />
          </Panel>
        )}

        {!loading && show('claims') && (
          <Panel id="c-claims" title="Employee expense claims"
            hint={isAdmin ? 'An admin approves, then finance reimburses at the month-end run.' : 'Shown so you know what is pending. An admin approves and reimburses.'}
            tools={<Link className="mg-btn mg-btn--ghost mg-btn--sm" to="/expense-claims">Open expense claims</Link>}>
            <ListTable
              label="Employee expense claims"
              rows={w.expense_claims}
              columns={[
                { key: 'claim', header: 'Claim', render: (r) => <span className="mg-num font-bold">{r.claim_id}</span> },
                { key: 'emp', header: 'Employee', className: 'strong', render: (r) => r.employee_name },
                { key: 'cat', header: 'Category', render: (r) => r.expense_category },
                { key: 'month', header: 'Month', className: 'mg-num', render: (r) => r.claim_month },
                { key: 'amt', header: 'Claimed', num: true, className: 'strong', render: (r) => money(r.amount_claimed) },
                { key: 'status', header: 'Status', render: (r) => <span className="mg-badge mg-badge--wait">{r.status}</span> },
                { key: 'todo', header: 'What to do', className: 'app-say', render: (r) => r.follow_up_action },
                {
                  key: 'act', header: '', className: 'actions', render: (r) => (!isAdmin
                    ? <span className="text-[12.5px] text-muted-foreground">An admin decides</span>
                    : r.status === 'Pending approval'
                      ? <button type="button" className="mg-btn mg-btn--sm mg-btn--primary" onClick={() => setDialog({ type: 'decide', row: r })}>Review</button>
                      : <button type="button" className="mg-btn mg-btn--sm" onClick={() => setDialog({ type: 'reimburse', row: r })}>Reimburse</button>),
                },
              ]}
              phone={(r) => {
                const decide = r.status === 'Pending approval';
                return (
                  <PhoneRow
                    title={`${r.employee_name} · ${r.expense_category}`} amount={money(r.amount_claimed)}
                    meta={`${r.claim_id} · ${r.claim_month}`}
                    state={<span className="mg-badge mg-badge--wait">{decide ? 'To decide' : 'To reimburse'}</span>}
                    go={isAdmin ? `${decide ? 'Review' : 'Reimburse'} →` : 'An admin decides'} goOff={!isAdmin}
                    label={`${r.employee_name}, ${r.expense_category}, ${r.status}`}
                    onClick={isAdmin ? () => setDialog({ type: decide ? 'decide' : 'reimburse', row: r }) : undefined}
                  />
                );
              }}
            />
          </Panel>
        )}

        {!loading && show('delivery') && (
          <Panel id="c-late" title="Deliveries past their planned date" hint="Ask the project manager for a new date, and note it on the project."
            tools={<Link className="mg-btn mg-btn--ghost mg-btn--sm" to="/projects">Open projects</Link>}>
            <ListTable
              label="Deliveries past their planned date"
              rows={w.late_deliveries}
              rowKey={(r) => r.project_id}
              columns={[
                { key: 'prj', header: 'Project', render: (r) => ref(`/projects/${encodeURIComponent(r.project_id)}`, r.project_id) },
                { key: 'client', header: 'Client', className: 'strong', render: (r) => r.client_name },
                { key: 'svc', header: 'Service', className: 'app-wrap', render: (r) => r.primary_service },
                { key: 'mgr', header: 'Manager', render: (r) => r.project_manager || '—' },
                { key: 'planned', header: 'Planned', className: 'mg-num', render: (r) => date(r.planned_delivery_date) },
                { key: 'late', header: 'Late by', num: true, render: (r) => <span className="mg-badge mg-badge--late">{plural(Number(r.days_late), 'day')} late</span> },
                { key: 'act', header: '', className: 'actions', render: (r) => <Link to={`/projects/${encodeURIComponent(r.project_id)}`} className="mg-btn mg-btn--sm">Open project</Link> },
              ]}
              phone={(r) => (
                <PhoneRow
                  to={`/projects/${encodeURIComponent(r.project_id)}`} title={r.client_name} amount={date(r.planned_delivery_date)}
                  meta={`${r.project_id} · ${r.primary_service || ''} · ${r.project_manager || 'no manager'}`}
                  state={<span className="mg-badge mg-badge--late">{plural(Number(r.days_late), 'day')} late</span>}
                />
              )}
            />
          </Panel>
        )}

        {!loading && show('sales') && (
          <Panel id="c-wins" title="Won deals not yet registered as projects" hint="Until a project and PO exist, nothing can be invoiced against these."
            tools={<Link className="mg-btn mg-btn--ghost mg-btn--sm" to="/quotations?status=Won+-+PO+Received">Open won deals</Link>}>
            <ListTable
              label="Won deals not yet registered as projects"
              rows={w.won_without_project}
              columns={[
                { key: 'q', header: 'Quotation', render: (r) => ref(`/quotations/${encodeURIComponent(r.quotation_no)}`, r.quotation_no) },
                { key: 'client', header: 'Client', className: 'strong', render: (r) => r.client_name },
                { key: 'svc', header: 'Service', className: 'app-wrap', render: (r) => r.service_quoted },
                { key: 'val', header: 'Value', num: true, className: 'strong', render: (r) => money(r.quotation_value, r.currency) },
                { key: 'act', header: '', className: 'actions', render: (r) => <button type="button" className="mg-btn mg-btn--sm mg-btn--primary" onClick={() => setDialog({ type: 'convert', row: r })}>Register project</button> },
              ]}
              phone={(r) => (
                <PhoneRow
                  title={r.client_name} amount={money(r.quotation_value, r.currency)} meta={`${r.quotation_no} · ${r.service_quoted || ''}`}
                  state={<span className="mg-badge mg-badge--ok">Won</span>} go="Register project →"
                  label={`${r.client_name}, ${r.quotation_no}. Register project`} onClick={() => setDialog({ type: 'convert', row: r })}
                />
              )}
            />
          </Panel>
        )}

        {/* Client portal and No contact: a summary on Everything, the full list on their tabs. */}
        {!loading && tab === 'all' && counts.portal > 0 && (
          <SummaryCard id="c-portal0" icon={MessageSquare} tone="bg-wait-soft text-wait" title="From the client portal"
            text={`${[portalRows.filter((a) => a.kind === 'payment_advice').length && plural(portalRows.filter((a) => a.kind === 'payment_advice').length, 'payment advice') + ' to match', portalRows.filter((a) => a.kind === 'query').length && plural(portalRows.filter((a) => a.kind === 'query').length, 'query', 'queries') + ' to answer'].filter(Boolean).join(', ') || plural(counts.portal, 'message') + ' to look at'}.`}
            action={`See all ${counts.portal}`} onClick={() => setTab('portal')} />
        )}
        {!loading && tab === 'all' && counts.quiet > 0 && (
          <SummaryCard id="c-nc0" icon={Phone} tone="bg-info-soft text-info" title={`No contact in ${q.days} days`}
            text={`${plural(counts.quiet, 'open deal, enquiry or overdue invoice', 'open deals, enquiries and overdue invoices')} nobody has called, messaged or met lately.`}
            action={`See all ${counts.quiet}`} onClick={() => setTab('quiet')} />
        )}

        {!loading && tab === 'portal' && counts.portal > 0 && (
          <Panel id="c-portal" title="From the client portal" hint="Payment advices to match against the bank, and questions to answer. Both are handled in Collections."
            tools={<Link className="mg-btn mg-btn--ghost mg-btn--sm" to="/collections">Open Collections</Link>}>
            <ListTable
              label="From the client portal"
              rows={portalRows}
              columns={[
                { key: 'kind', header: 'What', render: (r) => <span className={`mg-badge ${r.kind === 'query' ? 'mg-badge--info' : 'mg-badge--wait'}`}>{r.kind === 'query' ? 'Query' : r.kind === 'payment_advice' ? 'Payment advice' : 'Confirmed'}</span> },
                { key: 'client', header: 'Client', className: 'strong app-wrap--sm', render: (r) => <>{r.company_name}<span className="sub">{r.contact_name}</span></> },
                { key: 'inv', header: 'Invoices', className: 'mg-num app-wrap--sm', render: (r) => (r.invoices || []).map((i) => i.invoice_no).filter(Boolean).join(', ') || r.po_number || '—' },
                { key: 'amt', header: 'Amount', num: true, render: (r) => (r.amount != null ? money(r.amount, r.invoices?.[0]?.currency || 'INR') : '—') },
                { key: 'note', header: 'Note', className: 'app-say', render: (r) => r.note || '—' },
                { key: 'when', header: 'Sent', className: 'mg-num', render: (r) => date(r.created_at) },
                { key: 'act', header: '', className: 'actions', render: () => <Link to="/collections" className="mg-btn mg-btn--sm">Open</Link> },
              ]}
              phone={(r) => (
                <PhoneRow to="/collections" title={r.company_name} amount={r.amount != null ? money(r.amount, r.invoices?.[0]?.currency || 'INR') : ''}
                  meta={`${(r.invoices || []).map((i) => i.invoice_no).filter(Boolean).join(', ') || r.po_number || ''} · ${date(r.created_at)}`}
                  state={<span className={`mg-badge ${r.kind === 'query' ? 'mg-badge--info' : 'mg-badge--wait'}`}>{r.kind === 'query' ? 'Query' : 'Payment advice'}</span>} />
              )}
            />
          </Panel>
        )}

        {!loading && tab === 'quiet' && q && quietRows.length > 0 && (
          <Panel id="c-nc" title={`No contact in ${q.days} days`} hint={`Open deals, enquiries and overdue invoices nobody has called, messaged or met lately. Log a touch on the record to clear it. The ${q.days} days are set in Settings › Reminders.`}>
            <ListTable
              label={`No contact in ${q.days} days`}
              rows={quietRows}
              rowKey={(r) => `${r.kind}-${r.ref}`}
              columns={[
                { key: 'kind', header: 'What', render: (r) => <span className={`mg-badge ${r.kind === 'Overdue invoice' ? 'mg-badge--late' : 'mg-badge--info'}`}>{r.kind}</span> },
                { key: 'ref', header: 'Reference', render: (r) => ref(r.to, r.ref) },
                { key: 'client', header: 'Client', className: 'strong', render: (r) => r.client_name },
                { key: 'owner', header: 'Owner', render: (r) => r.owner || <span className="text-muted-foreground">No owner</span> },
                { key: 'status', header: 'Status', render: (r) => r.status },
                { key: 'last', header: 'Last touch', className: 'mg-num', render: (r) => (r.last_touch ? date(r.last_touch) : <span className="text-late">never</span>) },
              ]}
              phone={(r) => (
                <PhoneRow to={r.to} title={r.client_name} amount={<span className="text-[12.5px] font-semibold text-secondary-text">{r.last_touch ? `Last ${new Date(r.last_touch).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : 'Never touched'}</span>}
                  meta={`${r.ref} · ${r.status} · ${r.owner || 'No owner'}`}
                  state={<span className={`mg-badge ${r.kind === 'Overdue invoice' ? 'mg-badge--late' : 'mg-badge--info'}`}>{r.kind}</span>} />
              )}
            />
          </Panel>
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

/** A one-line card on Everything that opens its own tab. */
function SummaryCard({ id, icon: Icon, tone, title, text, action, onClick }) {
  return (
    <section className="mg-glass mg-panel" data-a="rise" aria-labelledby={id} style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: '12px 16px' }}>
      <span className={`app-sq ${tone}`}><Icon strokeWidth={1.9} aria-hidden="true" /></span>
      <div className="flex min-w-0 flex-[1_1_260px] flex-col gap-0.5">
        <h2 id={id} className="mg-panel__title">{title}</h2>
        <span className="text-[12.5px] text-secondary-text">{text}</span>
      </div>
      <button type="button" className="mg-btn mg-btn--sm" onClick={onClick}>{action}</button>
    </section>
  );
}
