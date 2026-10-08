import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowRight, Banknote, FileText, Mail, ReceiptText } from 'lucide-react';
import { PageHeader } from '../App.jsx';
import { ListPage } from '../components/ListPage.jsx';
import { InvoiceReviewList, useReviewCount } from '../components/EmailReview.jsx';
import { RecordInvoiceDialog, RecordPaymentDialog } from '../components/actions.jsx';
import { ClientSaidBadge, useClientSaid } from '../components/ClientSaid.jsx';
import { HeaderTabs, MoneyBanner, STAGE_TONE, STAGE_WORD, TRIGGER_SHORT, shortDate, stageNext } from '../components/money.jsx';
import { SummaryStrip, Tone } from '../components/sales.jsx';
import { plural } from '../components/daily.jsx';
import { api } from '../lib/api.js';
import { useFetch, useLookups } from '../lib/hooks.js';
import { money, percent } from '../lib/format.js';

/**
 * The finance sheet: every stage on every PO. The status is computed, never
 * typed, and the two things finance does on it are buttons. Wave 5 shape:
 * the tabs under the title, the key, a strip of what is billable, due,
 * received and waiting, then seven columns with one actions column.
 */
export default function PaymentStages() {
  const lookups = useLookups();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [dialog, setDialog] = useState(null);
  // Invoices we emailed that need a person (docs/email-po-plan.md §3.10.5).
  const tab = params.get('tab') === 'invoice-review' ? 'invoice-review' : 'all';
  const toReview = useReviewCount('/payment-stages/invoice-review');
  const [version, setVersion] = useState(0);
  // What the client last said in the portal about each invoice (#198).
  const clientSaid = useClientSaid([version]);

  const refresh = () => {
    setDialog(null);
    setVersion((v) => v + 1);
  };

  const tabs = (
    <HeaderTabs
      label="Payment stages"
      active={tab}
      onChange={(key) => setParams(key === 'invoice-review' ? { tab: 'invoice-review' } : {})}
      tabs={[{ key: 'all', label: 'All stages' }, { key: 'invoice-review', label: 'Invoices to review', count: toReview }]}
    />
  );

  if (tab === 'invoice-review') {
    return (
      <>
        <PageHeader title="Payment stages" subtitle="Invoices we emailed that were not recorded automatically. Recording one here does not email the client." nav={tabs} />
        <div className="app-page">
          <InvoiceReviewList />
        </div>
      </>
    );
  }

  const act = (r, phone) => {
    const sz = phone ? '' : ' mg-btn--sm';
    if (r.stage_status === 'To Invoice') return <button type="button" className={`mg-btn mg-btn--primary${sz}`} onClick={(e) => { e.stopPropagation(); setDialog({ type: 'invoice', row: r }); }}>Raise invoice</button>;
    if (['Overdue', 'Due', 'Partially Paid'].includes(r.stage_status)) return <button type="button" className={`mg-btn${sz}`} onClick={(e) => { e.stopPropagation(); setDialog({ type: 'payment', row: r }); }}>Record payment</button>;
    if (phone) return null;
    return <span className="app-quiet">{r.stage_status === 'Paid' ? 'Paid in full' : 'Billable once it happens'}</span>;
  };

  const stageLine = (r) => {
    const name = String(r.stage_name).replace(/\s*\(\d+(\.\d+)?%\)\s*$/, '');
    let trig = TRIGGER_SHORT[r.trigger_event] || r.trigger_event;
    if (r.trigger_event === 'On Delivery' && r.delivery_date) trig += `, recorded ${shortDate(r.delivery_date)}`;
    if (r.trigger_event === 'On Milestone' && r.milestone_reached_on) trig += `, reached ${shortDate(r.milestone_reached_on)}`;
    return `${r.stage_no}. ${name} · ${percent(r.stage_percent)} · ${trig}`;
  };

  const columns = [
    {
      key: 'client_name',
      header: 'Client, PO and stage',
      render: (r) => (
        <div style={{ minWidth: 200, whiteSpace: 'normal' }}>
          <span className="app-lead">{r.client_name}</span>
          <span className="app-sub2"><Link className="app-link" to={`/purchase-orders/${encodeURIComponent(r.po_number)}`}>{r.po_number}</Link>{r.project_id ? ` · ${r.project_id}` : ''}</span>
          <span className="app-sub2 is-wrap">{stageLine(r)}</span>
        </div>
      ),
    },
    {
      key: 'invoice_no',
      header: 'Invoice',
      render: (r) => (r.invoice_no ? (
        <>
          <span className="mg-num font-bold">{r.invoice_no}</span>
          {r.document_id && <a className="app-doc" href={api.documentUrl(r.document_id)} target="_blank" rel="noopener noreferrer" aria-label={`Open ${r.document_name || 'the invoice document'}`} title={r.document_name || 'Invoice document'}><FileText strokeWidth={1.8} aria-hidden="true" /></a>}
          <span className="app-sub2">{shortDate(r.invoice_date)}{r.invoice_due_date ? ` · due ${shortDate(r.invoice_due_date)}` : ''}</span>
          {!r.document_id && <span className="app-sub2 is-wait-text font-semibold">No PDF attached</span>}
        </>
      ) : <span className="text-muted-foreground">Not raised</span>),
    },
    { key: 'stage_amount', header: 'Stage value', align: 'right', render: (r) => <>{money(r.stage_amount, r.currency)}{Number(r.amount_received) > 0 && r.stage_status !== 'Paid' && <span className="app-sub2">{money(r.amount_received, r.currency)} received</span>}{r.stage_status === 'Paid' && <span className="app-sub2">{money(r.amount_received, r.currency)} received</span>}</> },
    { key: 'due_now_amount', header: 'Due now', align: 'right', render: (r) => (Number(r.due_now_amount) > 0 ? <span className={r.stage_status === 'Overdue' ? 'font-bold text-late' : 'font-bold'}>{money(r.due_now_amount, r.currency)}</span> : <span className="mg-muted">—</span>) },
    { key: 'to_bill_amount', header: 'To bill', align: 'right', render: (r) => (Number(r.to_bill_amount) > 0 ? <span className="font-bold is-wait-text">{money(r.to_bill_amount, r.currency)}</span> : <span className="mg-muted">—</span>) },
    {
      key: 'stage_status',
      header: 'Status and next step',
      render: (r) => {
        const next = stageNext(r);
        return (
          <div className="app-statecell">
            <span className="app-badges">
              <Tone tone={STAGE_TONE[r.stage_status]}>{STAGE_WORD[r.stage_status] || r.stage_status}</Tone>
              {next.text && <span className={`app-next is-${next.tone}`}>{r.on_hold ? `On hold${r.hold_reason ? `: ${r.hold_reason}` : ''}, no reminders` : next.text}</span>}
            </span>
            <ClientSaidBadge said={clientSaid.get(r.id)} onMatch={(w) => setDialog({ type: 'payment', row: r, preselect: w.id })} />
          </div>
        );
      },
    },
  ];

  const fields = [
    { name: 'po_number', group: 'The stage', label: 'Purchase order', required: true, type: 'select', options: lookups.purchase_orders.map((p) => ({ value: p.po_number, label: `${p.po_number} — ${p.client_name}` })) },
    { name: 'stage_no', group: 'The stage', label: 'Stage number', type: 'number', required: true, default: '1' },
    { name: 'stage_name', group: 'The stage', label: 'Stage name', required: true, hint: 'e.g. Advance (50%)' },
    { name: 'trigger_event', group: 'The stage', label: 'Trigger', type: 'select', options: lookups.enums?.trigger || [], default: 'On PO Registration', required: true },
    { name: 'stage_percent', group: 'The stage', label: 'Stage %', type: 'percent', required: true, hint: 'All stages on a PO should total 100' },
    // A stage triggered by a milestone is due once that milestone is
    // reached, and nothing else in the app writes the date. Without these
    // two the trigger could be chosen and the stage could never be
    // invoiced.
    { name: 'milestone_name', group: 'The stage', label: 'Milestone', hint: 'Only for the On Milestone trigger, e.g. Stage 2 audit complete' },
    { name: 'milestone_reached_on', group: 'The stage', label: 'Milestone reached on', type: 'date', hint: 'Fill this in when it happens: the stage becomes invoiceable' },
    { name: 'invoice_no', group: 'An invoice or payment made outside the tracker', label: 'Invoice number' },
    { name: 'invoice_date', group: 'An invoice or payment made outside the tracker', label: 'Invoice date', type: 'date' },
    { name: 'document_id', group: 'An invoice or payment made outside the tracker', label: 'Invoice document', type: 'document', owner: 'payment-stages', maxBytes: lookups.limits?.document_max_bytes, span: 2 },
    { name: 'amount_received', group: 'An invoice or payment made outside the tracker', label: 'Amount received', type: 'money', default: '0' },
    { name: 'payment_received_date', group: 'An invoice or payment made outside the tracker', label: 'Payment date', type: 'date' },
    { name: 'remarks', label: 'Remarks', type: 'textarea', span: 'all' },
  ];

  const pastMail = params.get('from_past_po') === '1';

  return (
    <>
      <ListPage
        refreshToken={version}
        title="Payment stages"
        subtitle="Every stage on every PO. Each status is worked out from the order's dates and money, never typed in."
        nav={tabs}
        resource="payment-stages"
        noun="stages"
        allLabel="All stages"
        columns={columns}
        fields={fields}
        newLabel="Stage"
        formTitle="payment stage"
        searchPlaceholder="PO, client or invoice number"
        initialFilters={params.get('status') ? { stage_status: params.get('status') } : undefined}
        filters={[
          { name: 'stage_status', label: 'Status', options: [{ value: 'To Invoice', label: 'To invoice' }, 'Overdue', 'Due', { value: 'Partially Paid', label: 'Partly paid' }, 'Paid', { value: 'Not Due', label: 'Not due' }] },
          { name: 'trigger_event', label: 'Trigger', options: lookups.enums?.trigger || [] },
          { name: 'invoice_no', label: 'Invoice', options: [{ value: '__any__', label: 'Raised' }, { value: '__none__', label: 'Not raised' }] },
          { name: 'document_id', label: 'Invoice document', options: [{ value: '__none__', label: 'Missing' }, { value: '__any__', label: 'Attached' }] },
          { name: 'from_email', label: 'Source', options: [{ value: '1', label: 'Invoice recorded from email' }] },
          { name: 'from_past_po', label: 'Past mail', options: [{ value: '1', label: 'Past POs and invoices to settle' }] },
        ]}
        rowExtras={(r) => act(r)}
        rowMenu={(r) => [
          r.stage_status === 'To Invoice' && { label: 'Raise invoice', icon: ReceiptText, onSelect: () => setDialog({ type: 'invoice', row: r }) },
          ['Overdue', 'Due', 'Partially Paid'].includes(r.stage_status) && { label: 'Record payment', icon: Banknote, onSelect: () => setDialog({ type: 'payment', row: r }) },
          { label: 'Open the PO', icon: ArrowRight, onSelect: () => navigate(`/purchase-orders/${encodeURIComponent(r.po_number)}`) },
        ].filter(Boolean)}
        phone={(r) => {
          const next = stageNext(r);
          return {
            title: `${r.client_name} · ${r.stage_no}. ${String(r.stage_name).replace(/\s*\(\d+(\.\d+)?%\)\s*$/, '')}`,
            amount: money(Number(r.due_now_amount) > 0 ? r.due_now_amount : Number(r.to_bill_amount) > 0 ? r.to_bill_amount : r.stage_amount, r.currency),
            meta: [r.po_number, r.invoice_no || 'not raised', next.text].filter(Boolean).join(' · '),
            state: <Tone tone={STAGE_TONE[r.stage_status]}>{STAGE_WORD[r.stage_status] || r.stage_status}</Tone>,
          };
        }}
        summary={<StagesStrip version={version} />}
        banner={pastMail ? (
          <MoneyBanner tone="wait" icon={Mail} title="Past POs and invoices to settle.">
            These stages come from POs or invoices read from the past year of email. Their invoices and payments very likely happened outside the tracker: record them here and each stage leaves this list once a payment is recorded. Until then, neither clients nor owners are chased about the invoices read from past mail.
          </MoneyBanner>
        ) : (
          <MoneyBanner title="To invoice: the trigger has happened, so bill it now. Overdue: the due date has passed, so follow it up.">
            A stage is Not due until its trigger fires (a PO date, a delivery or a milestone), Due once invoiced, and Paid when the money is in.
          </MoneyBanner>
        )}
      />

      {dialog?.type === 'invoice' && <RecordInvoiceDialog stage={dialog.row} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog?.type === 'payment' && <RecordPaymentDialog stage={dialog.row} preselect={dialog.preselect} onClose={() => setDialog(null)} onDone={refresh} />}
    </>
  );
}

/** What is billable, due, received and waiting, in INR, across every stage. */
function StagesStrip({ version }) {
  const { data, loading, error } = useFetch(() => api.list('payment-stages', { limit: 1000 }), [version]);
  if (error) return null;
  const rows = (data?.data ?? []).filter((s) => s.currency === 'INR');
  const sum = (list, k) => list.reduce((t, s) => t + Number(s[k] || 0), 0);
  const toBill = rows.filter((s) => s.stage_status === 'To Invoice');
  const overdue = rows.filter((s) => s.stage_status === 'Overdue');
  const notDue = rows.filter((s) => s.stage_status === 'Not Due');
  const paidOn = rows.filter((s) => Number(s.amount_received) > 0);
  const ready = !loading || data;
  return (
    <SummaryStrip
      label="What is billable, due and received"
      loading={!ready}
      tiles={[
        {
          key: 'bill', label: 'To bill now', figure: ready ? money(sum(toBill, 'to_bill_amount')) : null, tone: 'wait',
          foot: ready && (
            <span className="flex flex-col items-start gap-2">
              <span>{plural(toBill.length, 'stage')} ready to invoice</span>
              {toBill.length > 0 && <Link to="/money/invoice-run" className="mg-btn mg-btn--primary mg-btn--sm shrink-0 whitespace-nowrap">Raise them one by one<ArrowRight className="size-4" strokeWidth={2} aria-hidden="true" /></Link>}
            </span>
          ),
        },
        {
          key: 'due', label: 'Due now', figure: ready ? money(sum(rows, 'due_now_amount')) : null,
          badge: overdue.length ? { tone: 'late', text: `${money(sum(overdue, 'due_now_amount'))} overdue` } : undefined,
          foot: 'invoiced and unpaid',
        },
        { key: 'received', label: 'Received', figure: ready ? money(sum(rows, 'amount_received')) : null, tone: 'ok', foot: `on ${plural(paidOn.length, 'invoice')}` },
        { key: 'waiting', label: 'Waiting on a trigger', figure: ready ? money(sum(notDue, 'stage_amount')) : null, foot: `${plural(notDue.length, 'stage')} not yet billable` },
      ]}
    />
  );
}

