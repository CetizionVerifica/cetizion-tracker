import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { FileText, MailCheck, MoreHorizontal, Pencil, Plus, X } from 'lucide-react';
import { cn } from 'cn';
import { ConfirmDialog, useToast } from '../components/ui.jsx';
import { flowSteps, RecordFlow } from '../components/record.jsx';
import { RaiseTravelInvoiceDialog, RecordInvoiceDialog, RecordPaymentDialog, PaymentSplitDialog } from '../components/actions.jsx';
import { TravelInvoicesSection } from '../components/travelInvoices.jsx';
import { mayRaiseTravelInvoice } from '../lib/travelInvoices.js';
import { RecordForm } from '../components/RecordForm.jsx';
import { Timeline } from '../components/Timeline.jsx';
import { EmailOrigin } from '../components/EmailOrigin.jsx';
import { ClientSaidBadge, clientWord } from '../components/ClientSaid.jsx';
import { ControlBar } from '../components/shell/Shell.jsx';
import { Key, MoneyBanner, MoneyHero, STAGE_TONE, STAGE_WORD, shortDate } from '../components/money.jsx';
import { plural } from '../components/daily.jsx';
import { RecordState } from '../components/travel.jsx';
import { Tone } from '../components/sales.jsx';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../components/ui/dropdown-menu';
import { PO_TONE, PO_WORD, poFormFields } from './PurchaseOrders.jsx';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { mayDeleteResource } from '../lib/permissions.js';
import { useFetch, useLookups } from '../lib/hooks.js';
import { money, percent, today } from '../lib/format.js';

/**
 * One purchase order, as Wave 5 draws it: the order's facts under its
 * title, what is left to receive beside where the order is, then each
 * payment stage as a rung that says in a sentence why it is where it is,
 * with only the moves that rung allows. The four money figures sit at the
 * foot of the stages so "due now" is never read as "to bill".
 */

const MS_PER_DAY = 86_400_000;
const CHASEABLE = ['Overdue', 'Due', 'Partially Paid'];
const TRIGGER_WORDS = {
  'On PO Registration': 'triggered on PO registration',
  'On Delivery': 'triggered on delivery',
  'On Milestone': 'triggered on a milestone',
  Manual: 'raised by hand',
};

function daysSince(value) {
  if (!value) return null;
  const then = new Date(String(value).slice(0, 10));
  if (Number.isNaN(then.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - then.getTime()) / MS_PER_DAY));
}

/** The day a stage became billable: the day its trigger fired (the date views.sql uses). */
function billableSince(stage) {
  if (stage.trigger_event === 'On PO Registration') return stage.po_date;
  if (stage.trigger_event === 'On Delivery') return stage.delivery_date;
  if (stage.trigger_event === 'On Milestone') return stage.milestone_reached_on;
  return null;
}

/** Why this stage is where it is, in one sentence, with its tone. */
function explain(stage) {
  const since = billableSince(stage);
  const days = daysSince(since);
  switch (stage.stage_status) {
    case 'Not Due':
      if (stage.trigger_event === 'On Delivery') return ['', 'Not due. Recording the delivery date on this order is the only thing that makes it billable.'];
      if (stage.trigger_event === 'On Milestone') return ['', stage.milestone_name ? `Not due until “${stage.milestone_name}” is marked as reached.` : 'Not due until its milestone is marked as reached.'];
      if (stage.trigger_event === 'On PO Registration') return ['', 'Not due. The PO date is not recorded, so this order does not count as registered yet.'];
      return ['', 'Not due yet. It is raised by hand when it is due.'];
    case 'To Invoice':
      return ['wait', since ? `Billable since ${shortDate(since)}. No invoice raised: ${plural(days, 'day')}.` : 'Billable now. No invoice has been raised.'];
    case 'Overdue':
      return ['late', `Invoice ${stage.invoice_no} was due ${shortDate(stage.invoice_due_date)}: ${plural(stage.days_overdue, 'day')} overdue.`];
    case 'Partially Paid':
      return ['wait', `${money(stage.amount_received, stage.currency)} of ${money(stage.stage_amount, stage.currency)} received against ${stage.invoice_no}${stage.invoice_due_date ? `; the balance is due ${shortDate(stage.invoice_due_date)}` : ''}.`];
    case 'Paid':
      return ['', `Paid${stage.payment_received_date ? ` on ${shortDate(stage.payment_received_date)}` : ''} against ${stage.invoice_no}.`];
    case 'Due':
      return ['', `Invoiced as ${stage.invoice_no}, due ${shortDate(stage.invoice_due_date)}.`];
    default:
      return ['', null];
  }
}

function StageRung({ stage, client, onChanged, buttons }) {
  const [tone, say] = explain(stage);
  const statusTone = STAGE_TONE[stage.stage_status];
  const name = String(stage.stage_name || '').replace(/\s*\(\d+(\.\d+)?%\)\s*$/, '');
  return (
    <div className={cn('app-rung', stage.stage_status === 'To Invoice' && 'is-bill', stage.stage_status === 'Not Due' && 'is-dim')}>
      <span className={cn('app-rung__disc', statusTone === 'late' && 'is-late', statusTone === 'wait' && 'is-wait', statusTone === 'ok' && 'is-ok')} aria-hidden="true">{stage.stage_no}</span>
      <span className="app-rung__title">{name}<Tone tone={statusTone}>{STAGE_WORD[stage.stage_status] || stage.stage_status}</Tone></span>
      <span className="app-rung__amount">{money(stage.stage_amount, stage.currency)}</span>
      <div className="app-rung__body">
        <span className="app-rung__meta">Stage {stage.stage_no} · {percent(stage.stage_percent)} · {TRIGGER_WORDS[stage.trigger_event] || stage.trigger_event}</span>
        {say && <p className={cn('app-rung__say', tone && `is-${tone}`)}>{say}</p>}
        {Number(stage.amount_received) > 0 && stage.stage_status === 'Overdue' && <span className="app-rung__meta">{money(stage.amount_received, stage.currency)} of {money(stage.stage_amount, stage.currency)} received{stage.payment_received_date ? `, on ${shortDate(stage.payment_received_date)}` : ''}.</span>}
        {client && <ClientSaidBadge said={client} onMatch={buttons.match} />}
        {/* An invoice read from our email: where from, and Undo for an admin (docs/email-auto-entry-plan.md §3.10). */}
        {stage.invoice_no && <EmailOrigin entity="payment_stage" id={stage.id} className="m-0 text-[12px] text-muted-foreground" onUndone={onChanged} />}
        {buttons.node}
      </div>
    </div>
  );
}

function Fact({ label, children, tone }) {
  return <div className="app-fact">{label}<b className={tone === 'wait' ? 'is-wait' : undefined}>{children}</b></div>;
}

export default function PurchaseOrderDetail() {
  const { poNumber } = useParams();
  const toast = useToast();
  const lookups = useLookups();
  const navigate = useNavigate();
  // A service line is what the PO value is checked against and what the
  // invoicing figures are computed from, so po-services is adminOnlyDeletes
  // on the server (#85). Entering and correcting one stays open.
  const { isAdmin, isHr } = useAuth();
  const mayDeleteService = mayDeleteResource('po-services', isAdmin);
  const [dialog, setDialog] = useState(null);

  const { data, loading, fresh, error, errorStatus, refetch } = useFetch(() => api.raw(`/purchase-orders/${encodeURIComponent(poNumber)}/full`), [poNumber]);
  // The client's confirmations, queries and payment advice on this PO (#198), newest first.
  const portal = useFetch(() => api.raw(`/portal-admin/actions?status=all&po_number=${encodeURIComponent(poNumber)}`).catch(() => ({ data: [] })), [poNumber]);

  const crumbs = (title) => (
    <div className="app-rec__bar">
      <nav className="mg-crumbs" aria-label="Breadcrumb">
        <Link to="/purchase-orders">Orders</Link><span aria-hidden="true">›</span><b aria-current="page">{title}</b>
      </nav>
      <ControlBar />
    </div>
  );

  if (error) {
    return <RecordState parent="Orders" parentTo="/purchase-orders" crumb={`PO ${poNumber}`} noun="order" missing={errorStatus === 404} error={error} onRetry={refetch} />;
  }
  if ((loading && !fresh) || !data) {
    return (
      <div className="app-page app-rec" aria-busy="true" aria-label="Loading the purchase order">
        {crumbs(`PO ${poNumber}`)}
        <div className="mg-skel" style={{ height: 40, width: '40%' }} />
        <div className="app-mrow">
          <section className="mg-glass mg-panel" style={{ flex: '1 1 400px', minHeight: 220 }}><div className="mg-skel" style={{ height: 56, width: '70%' }} /><div className="mg-skel" style={{ height: 10, marginTop: 'auto' }} /></section>
          <section className="mg-glass mg-panel" style={{ flex: '1.35 1 520px', minHeight: 220 }}><div className="mg-skel" style={{ height: 40 }} /><div className="mg-skel" style={{ height: 40, width: '70%' }} /></section>
        </div>
        <section className="mg-glass mg-panel">{[0, 1, 2].map((i) => <div key={i} className="mg-skel" style={{ height: 60 }} />)}</section>
      </div>
    );
  }

  const { purchase_order: po, services, payment_stages: stages, travel, from_email: fromEmail,
    travel_invoices: travelInvoices = [] } = data.data;
  // Admin's and sales' (#214 §9.3); the travel desk never raises a client invoice.
  const mayRaiseTravel = mayRaiseTravelInvoice({ isAdmin, isHr });
  const close = () => setDialog(null);
  const done = () => { close(); refetch(); portal.refetch(); };
  const markChecked = async () => {
    try {
      await api.action(`/purchase-orders/${encodeURIComponent(po.po_number)}/email-read-checked`);
      toast('Marked checked', 'success');
      refetch();
    } catch (err) { toast(err.message, 'danger'); }
  };

  const clientSaid = new Map();
  for (const a of portal.data?.data ?? []) for (const i of a.invoices) if (!clientSaid.has(i.id)) clientSaid.set(i.id, clientWord(a));
  const stagesOff = po.stage_count > 0 && Math.abs(Number(po.stages_percent_total) - 1) > 0.0001;
  const serviceTotal = services.reduce((sum, s) => sum + Number(s.service_value || 0), 0);
  const amount = (v) => money(v, po.currency);
  const value = Number(po.po_value) || 0;
  const received = Number(po.total_received) || 0;
  const invoiced = Number(po.total_invoiced) || 0;
  const leftToReceive = Math.max(value - received, 0);
  const unpaidInvoiced = Math.max(invoiced - received, 0);
  const notBilled = Math.max(value - invoiced, 0);
  const share = (n) => (value > 0 ? (100 * n) / value : 0);

  const toRaise = stages.find((s) => s.stage_status === 'To Invoice');
  const overdue = stages.filter((s) => s.stage_status === 'Overdue');
  const toChase = stages.find((s) => CHASEABLE.includes(s.stage_status));
  const lockedOnDelivery = stages.find((s) => s.stage_status === 'Not Due' && s.trigger_event === 'On Delivery');
  const firstInvoice = [...stages].filter((s) => s.invoice_no).sort((a, b) => String(a.invoice_date).localeCompare(String(b.invoice_date)))[0];

  const steps = flowSteps([
    { label: 'Registered', done: Boolean(po.po_date), since: po.po_date ? shortDate(po.po_date) : 'no PO date' },
    { label: 'Stages set', done: po.stage_count > 0 && !stagesOff, since: po.stage_count ? stages.map((s) => Math.round(Number(s.stage_percent) * 100)).join(' / ') : 'none yet' },
    { label: 'First invoice', done: Boolean(firstInvoice), since: firstInvoice ? `${firstInvoice.invoice_no} · ${shortDate(firstInvoice.invoice_date)}` : undefined },
    { label: 'Delivered', done: Boolean(po.actual_delivery_date), since: po.actual_delivery_date ? shortDate(po.actual_delivery_date) : undefined },
    { label: 'Fully paid', done: po.stage_count > 0 && stages.every((s) => s.stage_status === 'Paid'), since: `${amount(received)} of ${amount(value)}` },
  ]);

  function verdict() {
    if (!stages.length) return { lead: 'No payment stages are set, so nothing on this order can be invoiced.' };
    // A wrong stage total is said once, here.
    if (stagesOff) return { lead: `The stages on this order total ${percent(po.stages_percent_total, 1)} rather than 100%.`, sub: 'What can be billed does not add up to the order. Set the stages again, or edit the one that is off.', late: true };
    const said = [];
    let lead = null;
    let late = false;
    if (overdue.length) {
      late = true;
      lead = overdue.length === 1
        ? `${overdue[0].invoice_no} is ${plural(overdue[0].days_overdue, 'day')} overdue.`
        : `${overdue.map((s) => `${s.invoice_no} is ${plural(s.days_overdue, 'day')}`).join(', and ')} overdue.`;
      said.push(`${amount(Number(po.balance_due_now))} is invoiced and waiting to be paid.`);
    } else if (toRaise) {
      const since = billableSince(toRaise);
      lead = since
        ? `Stage ${toRaise.stage_no} became billable on ${shortDate(since)}, ${plural(daysSince(since), 'day')} ago, and no invoice has been raised.`
        : `Stage ${toRaise.stage_no} is billable and no invoice has been raised.`;
    } else if (toChase) {
      lead = `${amount(Number(po.balance_due_now))} is invoiced and waiting to be paid.`;
    }
    if (lockedOnDelivery && !po.actual_delivery_date) said.push(`The delivery date is not recorded, so stage ${lockedOnDelivery.stage_no} is still locked.`);
    if (!lead) lead = said.shift() || 'Every stage on this order is invoiced and paid.';
    return { lead, sub: said.join(' '), late };
  }
  const v = verdict();

  /** One move, chosen in the order money actually gets stuck. */
  function primary() {
    if (!stages.length) return <button type="button" className="mg-btn mg-btn--primary" onClick={() => setDialog({ type: 'split' })}>Set the stages</button>;
    if (stagesOff) return <button type="button" className="mg-btn mg-btn--primary" onClick={() => setDialog({ type: 'split' })}>Set the stages again</button>;
    if (overdue.length || (!toRaise && toChase)) return <button type="button" className="mg-btn mg-btn--primary" onClick={() => setDialog({ type: 'payment', row: overdue[0] || toChase })}>Record a payment</button>;
    if (toRaise) return <button type="button" className="mg-btn mg-btn--primary" onClick={() => setDialog({ type: 'invoice', row: toRaise })}>Raise the {String(toRaise.stage_name).replace(/\s*\(\d+(\.\d+)?%\)\s*$/, '').toLowerCase()} invoice</button>;
    if (lockedOnDelivery && !po.actual_delivery_date) return <button type="button" className="mg-btn mg-btn--primary" onClick={() => setDialog({ type: 'delivery' })}>Record the delivery date</button>;
    return null;
  }

  /** The moves a rung allows; Edit stage is on every rung. */
  function rungButtons(stage) {
    const said = clientSaid.get(stage.id);
    const match = (w) => setDialog({ type: 'payment', row: stage, preselect: w.id });
    const edit = <button type="button" className="mg-btn mg-btn--ghost mg-btn--sm" onClick={() => setDialog({ type: 'editStage', row: stage })}>Edit stage</button>;
    let first = null;
    if (stage.stage_status === 'To Invoice') first = <button type="button" className="mg-btn mg-btn--primary mg-btn--sm" onClick={() => setDialog({ type: 'invoice', row: stage })}>Raise invoice</button>;
    else if (CHASEABLE.includes(stage.stage_status)) first = <button type="button" className="mg-btn mg-btn--sm" onClick={() => setDialog({ type: 'payment', row: stage, preselect: said?.match ? said.id : undefined })}>Record payment</button>;
    else if (stage.stage_status === 'Not Due' && stage.trigger_event === 'On Milestone') first = <button type="button" className="mg-btn mg-btn--sm" onClick={() => setDialog({ type: 'milestone', row: stage })}>Mark milestone reached</button>;
    else if (stage.stage_status === 'Not Due' && stage.trigger_event === 'On Delivery' && !po.actual_delivery_date) first = <button type="button" className="mg-btn mg-btn--sm" onClick={() => setDialog({ type: 'delivery' })}>Record the delivery date</button>;
    return { match, node: <div className="app-rung__btns">{first}{edit}</div> };
  }

  async function deleteService() {
    try {
      await api.remove('po-services', dialog.row.id);
      toast('Service line removed', 'success');
      close(); refetch();
    } catch (err) {
      toast(err.message, 'danger');
    }
  }

  const title = `PO ${po.po_number} · ${po.client_name}`;
  const facts = [
    { label: 'Project', value: <Link className="app-link" to={`/projects/${po.project_id}`}>{po.project_id}</Link> },
    { label: 'Order value', value: amount(po.po_value) },
    { label: 'Terms', value: `${po.payment_terms_days} days` },
    { label: 'Quotation', value: po.quotation_no ? <Link className="app-link" to={`/quotations?q=${encodeURIComponent(po.quotation_no)}`}>{po.quotation_no}</Link> : <span className="font-normal text-muted-foreground">not linked</span> },
    { label: 'Status', value: <Tone tone={PO_TONE[po.payment_status] || 'plain'}>{PO_WORD[po.payment_status] || po.payment_status}</Tone> },
    // Addressed to a partner company: the invoice is raised from the partner's GSTIN.
    po.addressed_gstin && { label: 'Addressed to GSTIN', value: po.addressed_gstin },
    po.partner_name && { label: 'Through', value: po.partner_name },
  ].filter(Boolean);

  const menu = [
    { label: 'Edit the purchase order', on: () => setDialog({ type: 'edit' }) },
    { label: 'Record the delivery date', on: () => setDialog({ type: 'delivery' }) },
    { label: po.stage_count ? 'Set the stages again' : 'Set the stages', on: () => setDialog({ type: 'split' }) },
    { label: 'Add a payment stage', on: () => setDialog({ type: 'newStage' }) },
    { label: 'Add a service line', on: () => setDialog({ type: 'newService' }) },
  ];

  return (
    <>
      <div className="app-page app-rec">
        {crumbs(title)}
        <header className="app-po__head" data-a="rise">
          <div className="app-po__titles">
            <h1 className="mg-display">{title}</h1>
            <dl className="app-po__facts">
              {facts.map((f) => <div key={f.label}><dt>{f.label}</dt><dd>{f.value}</dd></div>)}
            </dl>
          </div>
          <div className="app-po__acts">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" className="mg-btn"><MoreHorizontal className="size-[18px]" strokeWidth={2} aria-hidden="true" />More actions</button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-56">
                {menu.map((m) => <DropdownMenuItem key={m.label} onSelect={m.on}>{m.label}</DropdownMenuItem>)}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        {/* Registered automatically from the client's email (docs/email-po-plan.md):
            a person checks it against the PO once, and says so. One banner. */}
        {fromEmail && !fromEmail.checked && (
          <MoneyBanner tone="wait" icon={MailCheck} title={`Registered automatically from the client's PO emailed on ${shortDate(fromEmail.received_at)}.`}
            action={<button type="button" className="mg-btn mg-btn--sm" onClick={markChecked}>Mark checked</button>}>
            Check the value, the terms and the payment stages against it{po.document_id ? '' : ' (the PDF itself could not be stored)'}.
            {fromEmail.stages_source === 'template' && ' Its terms could not be read, so the stages are the default.'}
            {fromEmail.mode === 'history' && ' It came from past mail: record the invoices and payments that already happened.'}
            {fromEmail.created_quotation && ' No quotation was on file, so one was made from the PO.'}
          </MoneyBanner>
        )}
        <EmailOrigin entity="purchase_order" id={po.po_number} onUndone={() => navigate('/purchase-orders')} />
        {/* Out of the sales figures, but still billed: say so where the PO is read. */}
        {(po.cancelled || po.replaced_by_po_number) && (
          <MoneyBanner tone="wait" title={po.cancelled ? 'This purchase order is cancelled.' : <>This purchase order is replaced by <Link className="app-link" to={`/purchase-orders/${encodeURIComponent(po.replaced_by_po_number)}`}>PO {po.replaced_by_po_number}</Link>.</>}>
            It is left out of the sales figures. Its payment stages, invoices and receipts are unchanged.
          </MoneyBanner>
        )}
        {po.replaces_po_number && (
          <MoneyBanner title={<>This purchase order revises <Link className="app-link" to={`/purchase-orders/${encodeURIComponent(po.replaces_po_number)}`}>PO {po.replaces_po_number}</Link>.</>}>
            The earlier PO is left out of the sales figures in its favour.
          </MoneyBanner>
        )}

        <div className="app-mrow">
          <MoneyHero
            label={`Left to receive on this order (${po.currency})`}
            figure={amount(leftToReceive)}
            count={po.currency === 'INR' ? leftToReceive : undefined}
            sub={`Of ${amount(value)} ordered, ${amount(received)} is in. ${unpaidInvoiced > 0 ? `${amount(unpaidInvoiced)} is invoiced${overdue.length ? ' and overdue' : ' and not paid yet'}; ` : ''}${notBilled > 0 ? `${amount(notBilled)} is not billed yet.` : 'everything is billed.'}`}
            done={share(received)}
            expected={share(unpaidInvoiced)}
            aria={`${amount(received)} received, ${amount(unpaidInvoiced)} invoiced and not paid, ${amount(notBilled)} not billed yet`}
            legend={<>
              <Key swatch={{ background: 'var(--on-hero)' }}>Received <strong>{amount(received)}</strong></Key>
              <Key swatch="hatch">Invoiced, not paid <strong>{amount(unpaidInvoiced)}</strong></Key>
              <Key swatch="empty">Not billed yet <strong>{amount(notBilled)}</strong></Key>
            </>}
          />
          <RecordFlow
            title="Where this order is"
            steps={steps}
            badge={<Tone tone={PO_TONE[po.payment_status] || 'plain'}>{PO_WORD[po.payment_status] || po.payment_status}</Tone>}
            verdict={<><span className={v.late ? 'app-verdict-late' : 'font-semibold'}>{v.lead}</span>{v.sub && <span className="app-verdict-sub">{v.sub}</span>}</>}
            actions={primary()}
          />
        </div>

        <div className="app-rec__body has-rail">
          <div className="app-rec__main">
            <section className="mg-glass mg-glass--strong app-panel" data-a="rise" aria-labelledby="stages-t">
              <div className="app-panel__head">
                <h2 className="mg-panel__title" id="stages-t">Payment stages</h2>
                <span className="mg-panel__hint">{stages.length ? `${stages.map((s) => Math.round(Number(s.stage_percent) * 100)).join(' / ')} · totals ${percent(po.stages_percent_total)}` : 'none set'}</span>
                <div className="app-panel__tools"><button type="button" className="mg-btn mg-btn--sm" onClick={() => setDialog({ type: 'newStage' })}><Plus className="size-4" strokeWidth={2} aria-hidden="true" />Stage</button></div>
              </div>
              {stages.length === 0 ? (
                <div className="mg-empty app-panel__body" style={{ padding: '28px 24px' }}>
                  <h3 className="mg-empty__title">No stages yet</h3>
                  <p className="mg-empty__text">Nothing can be invoiced against this order until its stages exist. Set the split that was agreed: 50/50, 30/70, or anything else.</p>
                  <button type="button" className="mg-btn mg-btn--primary mg-btn--sm" onClick={() => setDialog({ type: 'split' })}>Set the stages</button>
                </div>
              ) : (
                <>
                  {stages.map((stage) => (
                    <StageRung key={stage.id} stage={stage} client={clientSaid.get(stage.id)} onChanged={refetch} buttons={rungButtons(stage)} />
                  ))}
                  {/* Four figures in one strip: four different questions. */}
                  <div className="app-figs">
                    <div><span className="mg-label">Invoiced</span><span className="mg-tile__figure mg-num">{amount(invoiced)}</span><span className="mg-tile__foot">{stages.filter((s) => s.invoice_no).length} of {plural(stages.length, 'stage')}</span></div>
                    <div><span className="mg-label">Received</span><span className="mg-tile__figure mg-num">{amount(received)}</span><span className="mg-tile__foot">{invoiced > 0 ? `${Math.round((100 * received) / invoiced)}% of what is invoiced` : 'nothing invoiced yet'}</span></div>
                    <div><span className="mg-label">Outstanding</span><span className={cn('mg-tile__figure mg-num', overdue.length && 'text-late')}>{amount(unpaidInvoiced)}</span><span className="mg-tile__foot">{overdue.length ? <Tone tone="late">{overdue.length === 1 ? '1 invoice overdue' : `${overdue.length} invoices overdue`}</Tone> : 'invoiced, not paid'}</span></div>
                    <div><span className="mg-label">To bill now</span><span className={cn('mg-tile__figure mg-num', Number(po.balance_to_bill) > 0 && 'is-wait-text')}>{amount(po.balance_to_bill)}</span><span className="mg-tile__foot">{toRaise ? `Stage ${toRaise.stage_no} is billable` : lockedOnDelivery && !po.actual_delivery_date ? `Stage ${lockedOnDelivery.stage_no} waits for delivery` : 'nothing billable now'}</span></div>
                  </div>
                </>
              )}
            </section>

            {/* Beside the split and never inside it: travel billed against
                this order carries its own printed amount, takes no stage
                number, and is left out of all four figures above (097,
                #214 §5.4). */}
            <TravelInvoicesSection
              invoices={travelInvoices}
              action={mayRaiseTravel ? (
                <button type="button" className="mg-btn mg-btn--sm" onClick={() => setDialog({ type: 'travel-invoice' })}>
                  <Plus className="size-4" strokeWidth={2} aria-hidden="true" />Travel invoice
                </button>
              ) : undefined}
            />

            <section className="mg-glass mg-glass--strong app-panel" data-a="rise" aria-labelledby="covers-t">
              <div className="app-panel__head">
                <h2 className="mg-panel__title" id="covers-t">What this order covers</h2>
                <div className="app-panel__tools"><button type="button" className="mg-btn mg-btn--sm" onClick={() => setDialog({ type: 'newService' })}><Plus className="size-4" strokeWidth={2} aria-hidden="true" />Add service</button></div>
              </div>
              {services.length === 0 ? (
                <p className="app-panel__note">No service lines yet. Add what this order actually covers.</p>
              ) : (
                <div className="mg-tablewrap app-panel__body">
                  <table className="mg-table" aria-label="Service lines">
                    <thead><tr><th>Service</th><th className="num">Value</th><th aria-label="Actions" /></tr></thead>
                    <tbody>
                      {services.map((row) => (
                        <tr key={row.id}>
                          <td style={{ whiteSpace: 'normal' }}><span className="app-lead">{row.service}</span>{row.remarks && <span className="app-sub2 is-wrap">{row.remarks}</span>}</td>
                          <td className="num">{row.service_value == null ? <span className="mg-muted">—</span> : money(row.service_value, po.currency)}</td>
                          <td>
                            <span className="app-rowacts">
                              <button type="button" className="mg-btn mg-btn--sm" onClick={() => setDialog({ type: 'editService', row })}><Pencil className="size-3.5" strokeWidth={1.8} aria-hidden="true" />Edit</button>
                              {/* Removing a service line asks first; po-services deletes are admin-only (#85). */}
                              {mayDeleteService && <button type="button" className="mg-iconbtn" aria-label={`Remove ${row.service}`} title="Remove" onClick={() => setDialog({ type: 'removeService', row })}><X strokeWidth={1.8} aria-hidden="true" /></button>}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td className="font-bold">Lines total · {Math.abs(serviceTotal - value) <= 0.5 ? 'matches the order value' : <span className="is-wait-text">{amount(serviceTotal)} of lines against {amount(value)} ordered</span>}</td>
                        <td className="num font-bold">{amount(serviceTotal)}</td>
                        <td />
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </section>

            <Timeline entity="purchase_order" id={po.po_number} />
          </div>

          <aside className="app-rec__rail" aria-label="On this order">
            <section className="mg-glass app-railcard" data-a="rise">
              <h2>Order facts</h2>
              <Fact label="PO date" tone={po.po_date ? undefined : 'wait'}>{po.po_date ? shortDate(po.po_date) : 'not recorded'}</Fact>
              <Fact label="Terms">{po.payment_terms_days} days</Fact>
              <Fact label="Initiated">{po.actual_initiation_date ? shortDate(po.actual_initiation_date) : '—'}</Fact>
              <Fact label="Delivered" tone={po.actual_delivery_date ? undefined : 'wait'}>{po.actual_delivery_date ? shortDate(po.actual_delivery_date) : 'not recorded'}</Fact>
              <Fact label="Manager">{po.project_manager_email || '—'}</Fact>
              <Fact label="Document">{po.document_id ? <a className="app-link inline-flex items-center gap-1" href={api.documentUrl(po.document_id)} target="_blank" rel="noopener noreferrer"><FileText className="size-3.5" strokeWidth={1.8} aria-hidden="true" />{po.document_name || 'Open'}</a> : '—'}</Fact>
              {po.client_vendor_code && <Fact label="Our vendor code">{po.client_vendor_code}</Fact>}
            </section>
            {travel.length > 0 && (
              <section className="mg-glass app-railcard" data-a="rise">
                <h2>Travel billed here</h2>
                {travel.map((trip) => (
                  <div key={trip.travel_id} className="flex flex-col gap-0.5 text-[12.5px]">
                    <span className="flex justify-between gap-3"><Link to={`/travel/${encodeURIComponent(trip.travel_id)}`} className="app-link">{trip.travel_id}</Link><b className="mg-num">{money(trip.total_travel_cost)}</b></span>
                    <span className="text-muted-foreground">{trip.employee_name}</span>
                  </div>
                ))}
                {/* The ratio is the point of this card: travel is the cost that quietly eats a project's margin. */}
                {value > 0 && (
                  <>
                    <span className="mg-progress" style={{ height: 6 }} aria-hidden="true"><span className="mg-progress__done" style={{ width: `${Math.min(100, (100 * Number(po.total_travel_cost)) / value)}%` }} /></span>
                    <p className="m-0 text-[12px] text-muted-foreground">{money(po.total_travel_cost)} of travel against {amount(value)} of work: {percent(Number(po.total_travel_cost) / value, 1)}.</p>
                  </>
                )}
              </section>
            )}
          </aside>
        </div>
      </div>

      {dialog?.type === 'travel-invoice' && (
        <RaiseTravelInvoiceDialog
          scope={{ projectId: po.project_id, poNumber: po.po_number, trips: travel }}
          onClose={close}
          onDone={done}
        />
      )}

      {dialog?.type === 'invoice' && <RecordInvoiceDialog stage={dialog.row} onClose={close} onDone={done} />}
      {dialog?.type === 'payment' && <RecordPaymentDialog stage={dialog.row} preselect={dialog.preselect} onClose={close} onDone={done} />}
      {dialog?.type === 'split' && (
        <PaymentSplitDialog
          po={po}
          // Invoiced or paid stages are never replaced, so only what is left
          // can be re-split. The dialog needs to know before the user types.
          lockedPercent={stages.filter((s) => s.invoice_no || Number(s.amount_received) > 0).reduce((sum, s) => sum + Number(s.stage_percent || 0), 0)}
          onClose={close}
          onDone={done}
        />
      )}

      {dialog?.type === 'edit' && (
        <RecordForm title="Edit purchase order" resource="purchase-orders" record={po} size="lg" onClose={close} onSaved={refetch} fields={poFormFields(lookups, po)} />
      )}
      {/* One field: the date that makes on-delivery stages billable. */}
      {dialog?.type === 'delivery' && (
        <RecordForm title="Record the delivery date" subtitle={title} resource="purchase-orders" record={{ ...po, actual_delivery_date: po.actual_delivery_date || today() }} onClose={close} onSaved={refetch} submitLabel="Save the date"
          fields={[{ name: 'actual_delivery_date', label: 'Delivered on', type: 'date', required: true, hint: 'Stages triggered on delivery become billable from this date.' }]} />
      )}
      {dialog?.type === 'milestone' && (
        <RecordForm title="Mark the milestone reached" subtitle={`${dialog.row.stage_name}${dialog.row.milestone_name ? ` · ${dialog.row.milestone_name}` : ''}`} resource="payment-stages" record={dialog.row} onClose={close} onSaved={refetch} submitLabel="Save"
          fields={[{ name: 'milestone_reached_on', label: 'Reached on', type: 'date', required: true, hint: 'The stage becomes billable from this date.' }]} />
      )}

      {(dialog?.type === 'newService' || dialog?.type === 'editService') && (
        <RecordForm
          title={dialog.type === 'newService' ? 'Add a service line' : 'Edit the service line'}
          resource="po-services"
          record={dialog.type === 'newService' ? { po_number: po.po_number } : dialog.row}
          onClose={close}
          onSaved={refetch}
          fields={[
            { name: 'po_number', label: 'PO number', required: true, disabled: true },
            { name: 'service', label: 'Service', required: true, type: 'combo', options: lookups.services, span: 2 },
            { name: 'service_value', label: 'Service value', type: 'money', hint: 'Optional; the lines should add up to the PO value' },
            { name: 'remarks', label: 'Remarks', type: 'textarea', span: 'all' },
          ]}
        />
      )}
      {dialog?.type === 'removeService' && (
        <ConfirmDialog
          title={`Remove ${dialog.row.service}?`}
          message={`It comes off what PO ${po.po_number} covers${dialog.row.service_value != null ? `, and the lines total drops by ${amount(dialog.row.service_value)}` : ''}. The order value and its stages stay as they are.`}
          confirmLabel="Remove line"
          onConfirm={deleteService}
          onClose={close}
        />
      )}

      {(dialog?.type === 'newStage' || dialog?.type === 'editStage') && (
        <RecordForm
          title={dialog.type === 'newStage' ? 'Add a payment stage' : 'Edit the payment stage'}
          resource="payment-stages"
          record={dialog.type === 'newStage'
            ? { po_number: po.po_number, stage_no: po.stage_count + 1, trigger_event: 'On Delivery', amount_received: 0 }
            : dialog.row}
          onClose={close}
          onSaved={refetch}
          fields={[
            { name: 'po_number', label: 'PO number', required: true, disabled: true },
            { name: 'stage_no', label: 'Stage number', type: 'number', required: true },
            { name: 'stage_name', label: 'Stage name', required: true },
            { name: 'trigger_event', label: 'Trigger', type: 'select', options: lookups.enums?.trigger || [], required: true },
            { name: 'stage_percent', label: 'Stage %', type: 'percent', required: true },
            { name: 'milestone_name', label: 'Milestone', hint: 'Only for the On Milestone trigger' },
            { name: 'milestone_reached_on', label: 'Milestone reached on', type: 'date', hint: 'The stage becomes billable from this date' },
            { name: 'remarks', label: 'Remarks', type: 'textarea', span: 'all' },
          ]}
        />
      )}
    </>
  );
}
