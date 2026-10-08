import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowRight, FileText } from 'lucide-react';
import { PageHeader } from '../App.jsx';
import { ListPage } from '../components/ListPage.jsx';
import { PoReviewList, useReviewCount } from '../components/EmailReview.jsx';
import { HeaderTabs, MoneyBanner, shortDate } from '../components/money.jsx';
import { Tone } from '../components/sales.jsx';
import { plural } from '../components/daily.jsx';
import { api } from '../lib/api.js';
import { useLookups } from '../lib/hooks.js';
import { money, percent } from '../lib/format.js';
import { poCurrencyFields } from '../lib/poCurrency.js';
import { poRevisionFields } from '../lib/poRevision.js';

/** The order's state in the system's four tones (one map, list and record). */
export const PO_TONE = { Overdue: 'late', 'To Invoice': 'wait', Pending: 'info', 'Partly paid': 'wait', 'Up to date': 'ok', 'Fully Paid': 'ok', 'No stages': 'plain' };
export const PO_WORD = { Overdue: 'Overdue', 'To Invoice': 'To invoice', Pending: 'Pending', 'Up to date': 'Up to date', 'Fully Paid': 'Fully paid', 'No stages': 'No stages' };

/**
 * The purchase order form, the same on the list's New/Edit and on the
 * record's Edit, so one order is never edited through two different sets
 * of fields.
 */
export function poFormFields(lookups, po = null) {
  const poCurrency = poCurrencyFields(lookups.won_quotations);
  return [
    { name: 'po_number', label: 'PO number', required: true, group: 'The order', disabled: Boolean(po) },
    { name: 'project_id', label: 'Project', required: true, group: 'The order', type: 'select', options: lookups.projects.map((p) => ({ value: p.project_id, label: `${p.project_id} — ${p.client_name}` })) },
    {
      name: 'quotation_no',
      label: 'Won quotation',
      group: 'The order',
      type: 'select',
      // The server only accepts a won quotation of this PO's own project, so
      // the list narrows as soon as the project is chosen.
      options: (values) => [
        ...(po?.quotation_no && !lookups.won_quotations.some((q) => q.quotation_no === po.quotation_no) ? [{ value: po.quotation_no, label: po.quotation_no }] : []),
        ...lookups.won_quotations
          .filter((q) => !values.project_id || q.project_id === values.project_id)
          .map((q) => ({ value: q.quotation_no, label: `${q.quotation_no} — ${q.client_name} (${q.project_id})` })),
      ],
      hint: 'The order this PO fulfils, on the same project. Left blank, it is linked when the project has one won quotation',
      ...poCurrency.quotation,
    },
    { name: 'po_date', label: 'PO date', type: 'date', group: 'Money and dates', hint: 'Registering the date makes advance stages invoiceable' },
    { name: 'po_value', label: 'PO value', type: 'money', required: true, group: 'Money and dates' },
    { name: 'currency', label: 'Currency', type: 'select', group: 'Money and dates', options: lookups.enums?.currency || ['INR'], default: 'INR', ...poCurrency.currency },
    { name: 'payment_terms_days', label: 'Payment terms (days)', type: 'number', default: '30', group: 'Money and dates' },
    { name: 'actual_initiation_date', label: 'Actual initiation', type: 'date', group: 'Money and dates' },
    { name: 'actual_delivery_date', label: 'Actual delivery', type: 'date', group: 'Money and dates', hint: 'Setting this makes on-delivery stages invoiceable' },
    { name: 'project_manager_email', label: 'Manager email', type: 'email', group: 'Paperwork' },
    { name: 'client_vendor_code', label: 'Our vendor code', group: 'Paperwork', hint: 'Our supplier code at this client, if its POs print one' },
    { name: 'document_id', label: 'PO document', type: 'document', group: 'Paperwork', owner: 'purchase-orders', maxBytes: lookups.limits?.document_max_bytes, span: 2 },
    ...poRevisionFields(lookups.purchase_orders, po ? { projectId: po.project_id, poNumber: po.po_number } : undefined).map((f) => ({ ...f, group: 'Paperwork' })),
    { name: 'remarks', label: 'Remarks', type: 'textarea', span: 'all', group: 'Paperwork' },
  ];
}

/** Received (solid) and invoiced-but-unpaid (hatched) against the order value. */
function PaidBar({ r }) {
  const value = Number(r.po_value) || 0;
  const invoiced = Number(r.total_invoiced) || 0;
  const received = Number(r.total_received) || 0;
  if (!invoiced) return <span className="text-[12px] text-muted-foreground"><span className="mg-progress app-pobar" aria-hidden="true" />Nothing invoiced yet</span>;
  const pc = (n) => (value > 0 ? Math.min(100, (100 * n) / value) : 0);
  return (
    <span className="block text-[12px] text-secondary-text">
      <span className="mg-progress app-pobar" role="img" aria-label={`${money(received, r.currency)} received of ${money(invoiced, r.currency)} invoiced, on an order of ${money(value, r.currency)}`}>
        <span className="mg-progress__done" style={{ width: `${pc(received)}%` }} />
        <span className="mg-progress__expected" style={{ width: `${Math.max(0, pc(invoiced) - pc(received))}%` }} />
      </span>
      {money(received, r.currency)} received of {money(invoiced, r.currency)} invoiced
    </span>
  );
}

export default function PurchaseOrders() {
  const navigate = useNavigate();
  const lookups = useLookups();
  const [params, setParams] = useSearchParams();
  // POs read from client email that need a person (docs/email-po-plan.md §3.7).
  const tab = params.get('tab') === 'review' ? 'review' : 'all';
  const toReview = useReviewCount('/purchase-orders/review');
  const tabs = (
    <HeaderTabs
      label="Purchase orders"
      active={tab}
      onChange={(key) => setParams(key === 'review' ? { tab: 'review' } : {})}
      tabs={[{ key: 'all', label: 'All POs' }, { key: 'review', label: 'To review', count: toReview }]}
    />
  );
  if (tab === 'review') {
    return (
      <>
        <PageHeader title="Purchase orders" subtitle="POs read from client email that were not registered automatically." nav={tabs} />
        <div className="app-page">
          <PoReviewList />
        </div>
      </>
    );
  }

  const stagesOff = (r) => Number(r.stage_count) > 0 && Math.abs(Number(r.stages_percent_total) - 1) > 0.0001;
  const columns = [
    {
      key: 'po_number',
      header: 'PO',
      render: (r) => (
        <div style={{ minWidth: 130, whiteSpace: 'normal' }}>
          <Link to={`/purchase-orders/${encodeURIComponent(r.po_number)}`} className="app-lead mg-num no-underline">{r.po_number}</Link>
          <span className="app-sub2">{shortDate(r.po_date)}</span>
          {r.replaces_po_number && <span className="app-sub2">Revises {r.replaces_po_number}</span>}
          {r.replaced_by_po_number && <span className="app-sub2">Replaced by {r.replaced_by_po_number}</span>}
          {/* Out of the sales figures; still billed as usual. */}
          {r.cancelled && <span className="mt-1 block"><Tone tone="wait">Cancelled</Tone></span>}
        </div>
      ),
    },
    {
      key: 'client_name',
      header: 'Client',
      render: (r) => (
        <div style={{ minWidth: 160, whiteSpace: 'normal' }}>
          <span className="app-lead">{r.client_name}</span>
          <span className="app-sub2 is-wrap">{r.project_id} · {r.quotation_no || 'no quotation linked'}</span>
        </div>
      ),
    },
    {
      key: 'po_value',
      header: 'Order value',
      align: 'right',
      render: (r) => (
        <>
          <span className="font-bold">{money(r.po_value, r.currency)}</span>
          <span className="app-sub2">{plural(Number(r.service_count), 'service')} · {plural(Number(r.stage_count), 'stage')}</span>
          {Number(r.stage_count) === 0 && <span className="mt-1 block"><Tone tone="wait">No stages set</Tone></span>}
          {stagesOff(r) && <span className="mt-1 block"><Tone tone="late">Stages total {percent(r.stages_percent_total)}</Tone></span>}
        </>
      ),
    },
    { key: 'total_received', header: 'Invoiced and received', render: (r) => <div style={{ minWidth: 190 }}><PaidBar r={r} /></div> },
    {
      key: 'balance_due_now',
      header: 'Due now',
      align: 'right',
      render: (r) => (
        <>
          <span className={r.payment_status === 'Overdue' ? 'font-bold text-late' : 'font-bold'}>{money(r.balance_due_now, r.currency)}</span>
          <span className="app-sub2">{Number(r.balance_to_bill) > 0 ? `+ ${money(r.balance_to_bill, r.currency)} to bill` : 'Nothing to bill'}</span>
        </>
      ),
    },
    {
      key: 'payment_status',
      header: 'Status',
      render: (r) => (
        <>
          <Tone tone={PO_TONE[r.payment_status] || 'plain'}>{PO_WORD[r.payment_status] || r.payment_status}</Tone>
          <span className="app-sub2">{r.actual_delivery_date ? `Delivered ${shortDate(r.actual_delivery_date)}` : 'Not delivered yet'}</span>
        </>
      ),
    },
  ];

  return (
    <ListPage
      title="Purchase orders"
      subtitle="Every purchase order a client has sent, one row per PO; a project can hold several. Open one to see where its money is."
      nav={tabs}
      resource="purchase-orders"
      noun="purchase orders"
      allLabel="All purchase orders"
      columns={columns}
      fields={(record) => poFormFields(lookups, record)}
      formSize="lg"
      newLabel="Purchase order"
      formTitle="purchase order"
      formSubmitLabel="Create and open PO"
      onSaved={(saved, before) => { if (!before && saved?.po_number) navigate(`/purchase-orders/${encodeURIComponent(saved.po_number)}`); }}
      formIntro="Register the PO first, then add its service lines and payment stages on the PO's own page."
      searchPlaceholder="PO number, client, project…"
      // The sales report's payment status table links here with the status
      // and period behind a row, so the list shows exactly those POs.
      initialFilters={Object.fromEntries(
        ['payment_status', 'from', 'to', 'live'].map((key) => [key, params.get(key)]).filter(([, value]) => value)
      )}
      dateFilterLabel="PO date"
      onRowClick={(row) => navigate(`/purchase-orders/${encodeURIComponent(row.po_number)}`)}
      rowExtras={(r) => (r.document_id
        ? <a className="mg-iconbtn" href={api.documentUrl(r.document_id)} target="_blank" rel="noopener noreferrer" aria-label={`Open ${r.document_name || 'the PO document'}`} title={r.document_name || 'PO document'} onClick={(e) => e.stopPropagation()}><FileText strokeWidth={1.8} aria-hidden="true" /></a>
        : null)}
      rowMenu={(r) => [{ label: 'Open the PO', icon: ArrowRight, onSelect: () => navigate(`/purchase-orders/${encodeURIComponent(r.po_number)}`) }]}
      phone={(r) => ({
        title: `PO ${r.po_number} · ${r.client_name}`,
        to: `/purchase-orders/${encodeURIComponent(r.po_number)}`,
        amount: money(r.po_value, r.currency),
        meta: [Number(r.balance_due_now) > 0 ? `${money(r.balance_due_now, r.currency)} due now` : null, Number(r.balance_to_bill) > 0 ? `${money(r.balance_to_bill, r.currency)} to bill` : null, r.actual_delivery_date ? `delivered ${shortDate(r.actual_delivery_date)}` : 'not delivered'].filter(Boolean).join(' · '),
        state: <Tone tone={PO_TONE[r.payment_status] || 'plain'}>{PO_WORD[r.payment_status] || r.payment_status}</Tone>,
      })}
      filters={[
        { name: 'payment_status', label: 'Status', options: ['Overdue', { value: 'To Invoice', label: 'To invoice' }, 'No stages', 'Pending', 'Up to date', { value: 'Fully Paid', label: 'Fully paid' }] },
        { name: 'quotation_no', label: 'Quotation', options: [{ value: '__none__', label: 'Not linked' }, { value: '__any__', label: 'Linked' }] },
        // Insights links its PO bars with ?live=1: cancelled and revised POs left out.
        { name: 'live', label: 'Cancelled or replaced POs', options: [{ value: '1', label: 'Leave them out' }] },
        { name: 'from_email', label: 'Source', options: [{ value: '1', label: 'Registered from email' }] },
      ]}
      banner={lookups.projects.length === 0 && (
        <MoneyBanner tone="wait" title="Register a project before adding purchase orders.">Every PO belongs to one.</MoneyBanner>
      )}
    />
  );
}
