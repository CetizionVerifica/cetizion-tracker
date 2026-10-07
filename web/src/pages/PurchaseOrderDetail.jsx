import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Clock } from 'lucide-react';
import { cn } from 'cn';
import { PageHeader } from '../App.jsx';
import { Alert, Badge, DocumentLink, ErrorState, useToast } from '../components/ui.jsx';
import { Chip, flowSteps, RecordFlow, RecordMenuItem, RecordPage, RecordSection } from '../components/record.jsx';
import { Button } from '../components/ui/button';
import { RecordInvoiceDialog, RecordPaymentDialog, PaymentSplitDialog } from '../components/actions.jsx';
import { RecordForm } from '../components/RecordForm.jsx';
import { Timeline } from '../components/Timeline.jsx';
import { EmailOrigin } from '../components/EmailOrigin.jsx';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { mayDeleteResource } from '../lib/permissions.js';
import { useFetch, useLookups } from '../lib/hooks.js';
import { money, date, localDate, percent, number } from '../lib/format.js';
import { poCurrencyFields } from '../lib/poCurrency.js';
import { poRevisionFields } from '../lib/poRevision.js';

/**
 * One purchase order, as C6 draws it.
 *
 * The ten-column stage table this replaces never said why a stage was
 * locked — it showed "Not Due" and left you to work out that the missing
 * delivery date was the reason. Here every rung explains itself in a
 * sentence, and only the rung you can actually act on carries buttons.
 * The four money figures sit in one strip at the foot of the ladder so
 * that "due now" is never read as "to bill": they are different numbers
 * and the old layout put them in separate boxes as though they were the
 * same kind of thing.
 *
 * The header keeps one overflow menu and no primary button, because the
 * primary button belongs to the flow panel, next to the sentence that
 * explains why it is the thing to press.
 */

const MS_PER_DAY = 86_400_000;

/** The design's two button heights: 32px in the flow, 28px in a row. */
const FLOW_BUTTON = 'h-8 px-4 text-[13px]';
const ROW_BUTTON = 'h-7 px-3 text-[12.5px]';

/** Stages that are waiting on money rather than on an invoice. */
const CHASEABLE = ['Overdue', 'Due', 'Partially Paid'];

const TRIGGER_WORDS = {
  'On PO Registration': 'triggered on PO registration',
  'On Delivery': 'triggered on delivery',
  'On Milestone': 'triggered on a milestone',
  Manual: 'raised by hand',
};

function plural(n, word) {
  return `${number(n)} ${word}${Number(n) === 1 ? '' : 's'}`;
}

function daysSince(value) {
  if (!value) return null;
  const then = new Date(String(value).slice(0, 10));
  if (Number.isNaN(then.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - then.getTime()) / MS_PER_DAY));
}

/**
 * The day a stage became billable — which is the day its trigger fired.
 *
 * The view decides `due_to_invoice` from exactly these three dates
 * (`db/views.sql`), so reading the same ones back is the date the server
 * already used, not a second opinion about when a stage went live.
 */
function billableSince(stage) {
  if (stage.trigger_event === 'On PO Registration') return stage.po_date;
  if (stage.trigger_event === 'On Delivery') return stage.delivery_date;
  if (stage.trigger_event === 'On Milestone') return stage.milestone_reached_on;
  return null;
}

/** Why this stage is where it is, in one sentence. */
function explain(stage) {
  const since = billableSince(stage);
  const days = daysSince(since);

  switch (stage.stage_status) {
    case 'Not Due':
      if (stage.trigger_event === 'On Delivery') {
        return 'Not due. Recording the delivery date on this order is the only thing that makes it billable.';
      }
      if (stage.trigger_event === 'On Milestone') {
        return stage.milestone_name
          ? `Not due until ${stage.milestone_name} is marked as reached.`
          : 'Not due until its milestone is marked as reached.';
      }
      if (stage.trigger_event === 'On PO Registration') {
        return 'Not due. The PO date is not recorded, so this order does not count as registered yet.';
      }
      return 'Not due yet.';
    case 'To Invoice':
      return since
        ? `Billable since ${date(since)}. No invoice raised — ${plural(days, 'day')}.`
        : 'Billable now. No invoice has been raised.';
    case 'Overdue':
      return `Invoice ${stage.invoice_no} was due ${date(stage.invoice_due_date)} — ${plural(stage.days_overdue, 'day')} overdue.`;
    case 'Partially Paid':
      return `${money(stage.amount_received, stage.currency)} of ${money(stage.stage_amount, stage.currency)} received against ${stage.invoice_no}.`;
    case 'Paid':
      return `Paid${stage.payment_received_date ? ` on ${date(stage.payment_received_date)}` : ''} against ${stage.invoice_no}.`;
    case 'Due':
      return `Invoiced as ${stage.invoice_no}, due ${date(stage.invoice_due_date)}.`;
    default:
      return null;
  }
}

/** The order's state, for the chip in the header. */
function poTone(status) {
  if (/overdue/i.test(status)) return 'late';
  if (/to invoice|pending|partly|partially/i.test(status)) return 'waiting';
  if (/up to date|paid/i.test(status)) return 'settled';
  return 'plain';
}

/**
 * One rung of the ladder.
 *
 * `action` is only ever passed for the stage that can actually be moved,
 * which is what stops a column of ten identical buttons from hiding the
 * one that matters.
 */
/** What the client last said about a stage in the portal (#198 §4), in staff words. */
function clientWord(a) {
  const on = localDate(a.created_at);
  if (a.kind === 'confirmed') return { tone: 'success', text: `Client confirmed ${on}` };
  if (a.kind === 'query') return a.status === 'open' ? { tone: 'warning', text: 'Client query open', note: a.note } : { tone: 'neutral', text: `Client query ${a.status} ${localDate(a.resolved_at)}` };
  if (a.status === 'open') return { tone: 'info', text: `Client reports paying ${money(a.amount)} on ${date(a.paid_on)}: to check in Collections` };
  return { tone: a.status === 'matched' ? 'success' : 'neutral', text: `Client's payment advice ${a.status}` };
}

function StageRung({ stage, action, last, onChanged, client }) {
  // Amber is "you can bill this and have not"; red is "this is late".
  // The header chip uses the same two, so a rung never disagrees with it.
  const tone = stage.stage_status === 'Overdue' ? 'late'
    : stage.stage_status === 'To Invoice' ? 'waiting'
    : null;
  const dim = stage.stage_status === 'Not Due';

  return (
    <div className={cn(
      'flex gap-4 p-5',
      !last && 'border-b border-border',
      stage.stage_status === 'To Invoice' && 'bg-settled/[0.04]'
    )}>
      <span className={cn(
        'mono grid size-7 flex-none place-items-center rounded-full text-[12px] font-semibold',
        tone === 'late' ? 'border border-late/30 bg-late/12 text-late'
          : tone === 'waiting' ? 'border border-waiting/30 bg-waiting/12 text-waiting'
          : 'border border-border-strong bg-secondary text-muted-foreground'
      )}>
        {stage.stage_no}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-3">
          <span className={cn('text-[14px] font-semibold', dim ? 'text-secondary-text' : 'text-foreground')}>
            {stage.stage_name}
          </span>
          <span className={cn('text-[12.5px]', dim ? 'text-muted-foreground' : 'text-secondary-text')}>
            {percent(stage.stage_percent)} · {TRIGGER_WORDS[stage.trigger_event] || stage.trigger_event}
          </span>
          <span className={cn('mono ml-auto text-[16px] font-semibold', dim ? 'text-secondary-text' : 'text-foreground')}>
            {money(stage.stage_amount, stage.currency)}
          </span>
        </div>

        <p className={cn(
          'mt-2 max-w-[64ch] text-[12.5px]/[1.6]',
          tone === 'late' ? 'text-late' : tone === 'waiting' ? 'text-waiting' : 'text-secondary-text'
        )}>
          {explain(stage)}
        </p>
        {/* An invoice read from our email: where from, and Undo for an admin (docs/email-auto-entry-plan.md §3.10). */}
        {stage.invoice_no && <EmailOrigin entity="payment_stage" id={stage.id} className="m-0 mt-1 text-[12px] text-muted-foreground" onUndone={onChanged} />}
        {client && (
          <p className="m-0 mt-1.5 flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
            <Badge tone={client.tone}>{client.text}</Badge>{client.note && <span className="max-w-[56ch] truncate" title={client.note}>“{client.note}”</span>}
          </p>
        )}

        {action && <div className="mt-3 flex gap-2">{action}</div>}
      </div>
    </div>
  );
}

/** A label and its value, in the rail. */
function Fact({ label, value, tone }) {
  return (
    <div className="flex justify-between gap-3 text-[12.5px] text-secondary-text">
      {label}
      <span className={cn('min-w-0 text-right', tone === 'waiting' ? 'text-waiting' : 'text-foreground')}>{value}</span>
    </div>
  );
}

/** A card in the rail: a small caps label over a short list. */
function RailCard({ title, children }) {
  return (
    <div className="flex flex-col gap-3 rounded-[10px] border border-border bg-card p-5">
      <div className="text-[10.5px] font-semibold uppercase tracking-[0.09em] text-muted-foreground">{title}</div>
      {children}
    </div>
  );
}

export default function PurchaseOrderDetail() {
  const { poNumber } = useParams();
  const toast = useToast();
  const lookups = useLookups();
  // A service line is what the PO value is checked against and what the
  // invoicing figures are computed from, so po-services is adminOnlyDeletes
  // on the server (#85). Entering and correcting one stays open.
  const { isAdmin } = useAuth();
  const mayDeleteService = mayDeleteResource('po-services', isAdmin);
  const [dialog, setDialog] = useState(null);

  const navigate = useNavigate();
  const { data, loading, error, refetch } = useFetch(
    () => api.raw(`/purchase-orders/${encodeURIComponent(poNumber)}/full`),
    [poNumber]
  );
  // The client's confirmations, queries and payment advice on this PO (#198), newest first.
  const portal = useFetch(() => api.raw(`/portal-admin/actions?status=all&po_number=${encodeURIComponent(poNumber)}`), [poNumber]);

  if (error) {
    return (
      <>
        <PageHeader title={poNumber} />
        <div className="page"><ErrorState message={error} onRetry={refetch} /></div>
      </>
    );
  }
  if (loading || !data) {
    return (
      <>
        <PageHeader title={poNumber} />
        <div className="page"><div className="skeleton" style={{ height: 200 }} /></div>
      </>
    );
  }

  const { purchase_order: po, services, payment_stages: stages, travel, from_email: fromEmail } = data.data;
  const close = () => setDialog(null);
  const done = () => { close(); refetch(); };
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

  const toRaise = stages.find((s) => s.stage_status === 'To Invoice');
  const toChase = stages.find((s) => CHASEABLE.includes(s.stage_status));
  const lockedOnDelivery = stages.find((s) => s.stage_status === 'Not Due' && s.trigger_event === 'On Delivery');

  // Each rung's state is worked out here and handed to the flow, because
  // what "current" means is the order's business, not the component's.
  const reached = [
    { label: 'Registered', done: Boolean(po.po_date) },
    { label: 'Split set', done: po.stage_count > 0 && !stagesOff },
    {
      label: stages.some((s) => s.trigger_event === 'On PO Registration') ? 'Advance billable' : 'Billable',
      done: stages.some((s) => s.invoice_no),
    },
    { label: 'Delivered', done: Boolean(po.actual_delivery_date) },
    { label: 'Fully paid', done: po.stage_count > 0 && stages.every((s) => s.stage_status === 'Paid') },
  ];
  const steps = flowSteps(reached);

  function verdict() {
    if (!stages.length) return 'No payment stages are set, so nothing on this order can be invoiced.';
    if (stagesOff) {
      return `The stages on this order total ${percent(po.stages_percent_total, 1)} rather than 100%, so what can be billed does not add up to the order.`;
    }

    const said = [];
    if (toRaise) {
      const since = billableSince(toRaise);
      const days = daysSince(since);
      said.push(since
        ? `Stage ${toRaise.stage_no} became billable on ${date(since)}, ${plural(days, 'day')} ago, and no invoice has been raised.`
        : `Stage ${toRaise.stage_no} is billable and no invoice has been raised.`);
    } else if (toChase) {
      said.push(toChase.stage_status === 'Overdue'
        ? `Invoice ${toChase.invoice_no} is ${plural(toChase.days_overdue, 'day')} overdue.`
        : `${amount(po.balance_due_now)} is invoiced and waiting to be paid.`);
    }
    if (lockedOnDelivery && !po.actual_delivery_date) {
      said.push(`The delivery date is not recorded, so stage ${lockedOnDelivery.stage_no} is still locked.`);
    }
    if (!said.length) said.push('Every stage on this order is invoiced and paid.');
    return said.join(' ');
  }

  /** One move, chosen in the order money actually gets stuck. */
  function primary() {
    if (!stages.length) {
      return <Button size="sm" className={FLOW_BUTTON} onClick={() => setDialog({ type: 'split' })}>Set payment stages</Button>;
    }
    if (toRaise) {
      return (
        <Button size="sm" className={FLOW_BUTTON} onClick={() => setDialog({ type: 'invoice', row: toRaise })}>
          Raise the {toRaise.stage_name.toLowerCase()} invoice
        </Button>
      );
    }
    if (toChase) {
      return <Button size="sm" className={FLOW_BUTTON} onClick={() => setDialog({ type: 'payment', row: toChase })}>Record a payment</Button>;
    }
    if (lockedOnDelivery && !po.actual_delivery_date) {
      return <Button size="sm" className={FLOW_BUTTON} onClick={() => setDialog({ type: 'edit' })}>Record the delivery date</Button>;
    }
    return null;
  }

  async function deleteService(row) {
    try {
      await api.remove('po-services', row.id);
      toast('Service line removed', 'success');
      refetch();
    } catch (err) {
      toast(err.message, 'danger');
    }
  }

  /** Buttons belong to the one rung that can be moved, and to no other. */
  function actionsFor(stage) {
    if (stage.stage_status === 'To Invoice') {
      return (
        <>
          <Button size="sm" className={ROW_BUTTON} onClick={() => setDialog({ type: 'invoice', row: stage })}>Raise invoice</Button>
          <Button variant="secondary" size="sm" className={ROW_BUTTON} onClick={() => setDialog({ type: 'editStage', row: stage })}>Edit stage</Button>
        </>
      );
    }
    if (CHASEABLE.includes(stage.stage_status)) {
      return <Button variant="secondary" size="sm" className={ROW_BUTTON} onClick={() => setDialog({ type: 'payment', row: stage })}>Record payment</Button>;
    }
    return null;
  }

  return (
    <>
      <RecordPage
        parent="Orders"
        parentTo="/purchase-orders"
        title={`${po.po_number} · ${po.client_name}`}
        mark={false}
        facts={[
          <Link to={`/projects/${po.project_id}`} className="mono text-[12.5px] text-secondary-text no-underline hover:text-foreground">{po.project_id}</Link>,
          <span className="mono text-[12.5px] text-foreground">{amount(po.po_value)}</span>,
          `${po.payment_terms_days}-day terms`,
          po.quotation_no && (
            <Link to={`/quotations?q=${encodeURIComponent(po.quotation_no)}`} className="mono text-[12.5px] text-secondary-text no-underline hover:text-foreground">{po.quotation_no}</Link>
          ),
          <Chip tone={poTone(po.payment_status)} icon={/overdue|to invoice/i.test(po.payment_status) ? Clock : undefined}>
            {po.payment_status}
          </Chip>,
          // Addressed to a partner company: the invoice is raised from the partner's GSTIN.
          po.partner_name && <Chip key="partner">Through {po.partner_name}</Chip>,
          po.addressed_gstin && <span key="gstin" className="mono text-[12.5px] text-secondary-text">To GSTIN {po.addressed_gstin}</span>,
        ]}
        menu={
          <>
            <RecordMenuItem onSelect={() => setDialog({ type: 'edit' })}>Edit the purchase order</RecordMenuItem>
            <RecordMenuItem onSelect={() => setDialog({ type: 'split' })}>
              {po.stage_count ? 'Reset payment stages' : 'Set payment stages'}
            </RecordMenuItem>
            <RecordMenuItem onSelect={() => setDialog({ type: 'newStage' })}>Add a payment stage</RecordMenuItem>
            <RecordMenuItem onSelect={() => setDialog({ type: 'newService' })}>Add a service line</RecordMenuItem>
          </>
        }
        flow={
          <RecordFlow
            steps={steps}
            verdict={verdict()}
            actions={primary()}
          />
        }
        rail={
          <>
            <RailCard title="Order facts">
              <Fact label="PO date" value={po.po_date ? date(po.po_date) : 'not recorded'} tone={po.po_date ? undefined : 'waiting'} />
              <Fact label="Terms" value={`${po.payment_terms_days} days`} />
              <Fact label="Initiated" value={po.actual_initiation_date ? date(po.actual_initiation_date) : '—'} />
              <Fact
                label="Delivered"
                value={po.actual_delivery_date ? date(po.actual_delivery_date) : 'not recorded'}
                tone={po.actual_delivery_date ? undefined : 'waiting'}
              />
              <Fact label="Manager" value={po.project_manager_email || '—'} />
              <Fact label="Document" value={<DocumentLink id={po.document_id} name={po.document_name} />} />
            </RailCard>

            {travel.length > 0 && (
              <RailCard title="Travel billed here">
                {travel.map((trip) => (
                  <div key={trip.travel_id} className="flex justify-between gap-3 text-[12.5px] text-secondary-text">
                    <Link to={`/travel/${encodeURIComponent(trip.travel_id)}`} className="mono text-[12px] text-foreground no-underline hover:text-primary">
                      {trip.travel_id}
                    </Link>
                    <span className="min-w-0 truncate">{trip.employee_name} · {money(trip.total_travel_cost)}</span>
                  </div>
                ))}
                {/* The ratio is the point of this card: travel is the cost
                    that quietly eats a project's margin. */}
                {Number(po.po_value) > 0 && (
                  <p className="text-[11.5px]/[1.6] text-muted-foreground">
                    {money(po.total_travel_cost)} of travel against {amount(po.po_value)} of work — {percent(Number(po.total_travel_cost) / Number(po.po_value), 1)}.
                  </p>
                )}
              </RailCard>
            )}
          </>
        }
      >
        {/* Registered automatically from the client's email (docs/email-po-plan.md):
            a person checks it against the PO once, and says so. */}
        {fromEmail && !fromEmail.checked && (
          <Alert tone="warning">
            <span className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <span>
                <strong>Registered automatically from the client's PO emailed on {date(fromEmail.received_at)}.</strong>{' '}
                Check the value, the terms and the payment stages against it{po.document_id ? '' : ' (the PDF itself could not be stored)'}.
                {fromEmail.stages_source === 'template' && ' Its terms could not be read, so the stages are the default.'}
                {fromEmail.mode === 'history' && ' It came from past mail: record the invoices and payments that already happened.'}
                {fromEmail.created_quotation && ' No quotation was on file, so one was made from the PO.'}
              </span>
              <Button variant="secondary" size="sm" className={ROW_BUTTON} onClick={markChecked}>Mark checked</Button>
            </span>
          </Alert>
        )}
        <EmailOrigin entity="purchase_order" id={po.po_number} onUndone={() => navigate('/purchase-orders')} />
        {/* Out of the sales figures, but still billed: say so where the PO is read. */}
        {(po.cancelled || po.replaced_by_po_number) && (
          <Alert tone="warning">
            {po.cancelled ? 'This purchase order is cancelled' : <>This purchase order is replaced by <Link className="mono" to={`/purchase-orders/${encodeURIComponent(po.replaced_by_po_number)}`}>{po.replaced_by_po_number}</Link></>}
            , so it is left out of the sales figures. Its payment stages, invoices and receipts are unchanged.
          </Alert>
        )}
        {po.replaces_po_number && (
          <Alert>
            This purchase order is a revision of <Link className="mono" to={`/purchase-orders/${encodeURIComponent(po.replaces_po_number)}`}>{po.replaces_po_number}</Link>, which is left out of the sales figures in its favour.
          </Alert>
        )}
        {stagesOff && (
          <Alert tone="danger">
            The stages on this PO total {percent(po.stages_percent_total, 1)} — they should total 100%.
          </Alert>
        )}

        <RecordSection
          title="Payment stages"
          hint={stages.length
            ? `${stages.map((s) => Math.round(Number(s.stage_percent) * 100)).join(' / ')} — totals ${percent(po.stages_percent_total)}`
            : 'none set'}
          action={<Button variant="secondary" size="sm" className={ROW_BUTTON} onClick={() => setDialog({ type: 'newStage' })}>+ Stage</Button>}
        >
          {stages.length === 0 ? (
            <p className="px-5 py-4 text-[12.5px] text-muted-foreground">
              Nothing can be invoiced against this order until its stages exist. Set the split that was agreed — 50/50, 30/70, or anything else.
            </p>
          ) : (
            stages.map((stage, i) => (
              <StageRung key={stage.id} stage={stage} action={actionsFor(stage)} last={i === stages.length - 1} onChanged={refetch} client={clientSaid.get(stage.id)} />
            ))
          )}

          {/* Four figures in one strip, because they are four different
              questions and separate boxes made them look interchangeable. */}
          {stages.length > 0 && (
            <div className="flex h-11 flex-wrap items-center gap-6 border-t border-border bg-secondary px-5 text-[12.5px] text-secondary-text">
              <span>Invoiced <strong className="mono font-medium text-foreground">{amount(po.total_invoiced)}</strong></span>
              <span>Received <strong className="mono font-medium text-foreground">{amount(po.total_received)}</strong></span>
              <span>To bill now <strong className={cn('mono font-medium', Number(po.balance_to_bill) > 0 ? 'text-waiting' : 'text-foreground')}>{amount(po.balance_to_bill)}</strong></span>
              <span>Outstanding <strong className="mono font-medium text-foreground">{amount(Number(po.po_value) - Number(po.total_received))}</strong></span>
            </div>
          )}
        </RecordSection>

        <RecordSection
          title="What this order covers"
          hint={serviceTotal && Math.abs(serviceTotal - Number(po.po_value)) > 0.5
            ? `${amount(serviceTotal)} of lines against ${amount(po.po_value)} ordered`
            : undefined}
          action={<Button variant="secondary" size="sm" className={ROW_BUTTON} onClick={() => setDialog({ type: 'newService' })}>Add service</Button>}
        >
          {services.length === 0 ? (
            <p className="px-5 py-4 text-[12.5px] text-muted-foreground">No service lines yet. Add what this order actually covers.</p>
          ) : (
            services.map((row, i) => (
              /* The design draws a bare row; edit and remove stay on it
                 because nothing else in the app can reach a service line. */
              <div
                key={row.id}
                className={cn('flex h-9 items-center gap-4 px-5 text-[13px] text-foreground', i < services.length - 1 && 'border-b border-border')}
              >
                <span className="min-w-0 flex-1 truncate">{row.service}</span>
                {row.remarks && <span className="min-w-0 max-w-[30%] truncate text-[12px] text-muted-foreground">{row.remarks}</span>}
                <span className="mono">{money(row.service_value, po.currency)}</span>
                <Button variant="ghost" size="sm" className={ROW_BUTTON} onClick={() => setDialog({ type: 'editService', row })}>Edit</Button>
                {/* A service line is what the PO value is checked against and what
                    the invoicing figures are computed from, so po-services is
                    adminOnlyDeletes on the server (#85). Entering and correcting
                    one stays open to everyone. */}
                {mayDeleteService && (
                  <Button variant="ghost" size="icon-sm" className="size-7" aria-label={`Remove ${row.service}`} onClick={() => deleteService(row)}>✕</Button>
                )}
              </div>
            ))
          )}
        </RecordSection>

        <Timeline entity="purchase_order" id={po.po_number} />
      </RecordPage>

      {dialog?.type === 'invoice' && <RecordInvoiceDialog stage={dialog.row} onClose={close} onDone={done} />}
      {dialog?.type === 'payment' && <RecordPaymentDialog stage={dialog.row} onClose={close} onDone={done} />}
      {dialog?.type === 'split' && (
        <PaymentSplitDialog
          po={po}
          // Invoiced or paid stages are never replaced, so only what is left
          // can be re-split. The dialog needs to know before the user types.
          lockedPercent={stages
            .filter((s) => s.invoice_no || Number(s.amount_received) > 0)
            .reduce((sum, s) => sum + Number(s.stage_percent || 0), 0)}
          onClose={close}
          onDone={done}
        />
      )}

      {dialog?.type === 'edit' && (
        <RecordForm
          title="Edit purchase order"
          resource="purchase-orders"
          record={po}
          onClose={close}
          onSaved={refetch}
          fields={[
            {
              name: 'quotation_no',
              label: 'Won quotation',
              type: 'select',
              span: 2,
              hint: 'The order this PO fulfils; revenue counts the PO against it',
              options: [
                ...(po.quotation_no && !lookups.won_quotations.some((q) => q.quotation_no === po.quotation_no)
                  ? [{ value: po.quotation_no, label: po.quotation_no }]
                  : []),
                ...lookups.won_quotations
                  .filter((q) => q.project_id === po.project_id)
                  .map((q) => ({ value: q.quotation_no, label: `${q.quotation_no} — ${q.client_name}` })),
              ],
              ...poCurrencyFields(lookups.won_quotations).quotation,
            },
            { name: 'po_date', label: 'PO date', type: 'date', hint: 'Makes advance stages invoiceable' },
            { name: 'po_value', label: 'PO value', type: 'money', required: true },
            { name: 'currency', label: 'Currency', type: 'select', options: lookups.enums?.currency || ['INR'], ...poCurrencyFields(lookups.won_quotations).currency },
            { name: 'payment_terms_days', label: 'Payment terms (days)', type: 'number' },
            { name: 'actual_initiation_date', label: 'Actual initiation', type: 'date' },
            { name: 'actual_delivery_date', label: 'Actual delivery', type: 'date', hint: 'Makes on-delivery stages invoiceable' },
            { name: 'project_manager_email', label: 'Manager email', type: 'email' },
            { name: 'document_id', label: 'PO document', type: 'document', owner: 'purchase-orders', maxBytes: lookups.limits?.document_max_bytes, span: 2 },
            ...poRevisionFields(lookups.purchase_orders, { projectId: po.project_id, poNumber: po.po_number }),
            { name: 'remarks', label: 'Remarks', type: 'textarea', span: 'all' },
          ]}
        />
      )}

      {(dialog?.type === 'newService' || dialog?.type === 'editService') && (
        <RecordForm
          title={dialog.type === 'newService' ? 'Add a service line' : 'Edit service line'}
          resource="po-services"
          record={dialog.type === 'newService' ? { po_number: po.po_number } : dialog.row}
          onClose={close}
          onSaved={refetch}
          fields={[
            { name: 'po_number', label: 'PO number', required: true, disabled: true },
            { name: 'service', label: 'Service', required: true, type: 'combo', options: lookups.services, span: 2 },
            { name: 'service_value', label: 'Service value', type: 'money', hint: 'Optional — should add up to the PO value' },
            { name: 'remarks', label: 'Remarks', type: 'textarea', span: 'all' },
          ]}
        />
      )}

      {(dialog?.type === 'newStage' || dialog?.type === 'editStage') && (
        <RecordForm
          title={dialog.type === 'newStage' ? 'Add a payment stage' : 'Edit payment stage'}
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
            { name: 'remarks', label: 'Remarks', type: 'textarea', span: 'all' },
          ]}
        />
      )}
    </>
  );
}
