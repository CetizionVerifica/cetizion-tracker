import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { cn } from 'cn';
import { ErrorState, useToast } from '../components/ui.jsx';
import { RecordSection } from '../components/record.jsx';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Progress } from '../components/ui/progress';
import { api } from '../lib/api.js';
import { useDocumentUploads, useFetch } from '../lib/hooks.js';
import { date, money, number, percent, today } from '../lib/format.js';

/**
 * Raising invoices, as C5 draws it.
 *
 * The thirteen-column payment schedule stays — it is the right shape for
 * auditing, and it is still there as a list. What it was wrong for is the
 * job people actually do on it, which is not reading thirteen columns but
 * answering the same question five times: raise this one, yes or no. So
 * the default path is a queue of one decision, with the stage on the left
 * and two fields on the right, and "What this will change" naming every
 * derived value before the click — which is the point, because nobody
 * should have to learn views.sql to trust the number it will produce.
 *
 * The invoice number is NOT sent unless somebody types over it. It is a
 * statutory GST series and it has to be unbroken, so the server claims it
 * inside the same transaction that writes the stage. Two people in this
 * queue at once would otherwise both be shown the same next number and
 * both succeed in using it.
 */

const MS_PER_DAY = 86_400_000;
const FLOW_BUTTON = 'h-8 px-4 text-[13px]';
const LABEL = 'text-[10.5px] font-semibold uppercase tracking-[0.09em] text-muted-foreground';

function addDays(iso, days) {
  if (!iso || !days) return iso || null;
  const from = new Date(String(iso).slice(0, 10));
  if (Number.isNaN(from.getTime())) return null;
  return new Date(from.getTime() + Number(days) * MS_PER_DAY).toISOString().slice(0, 10);
}

/** The day a stage became billable — the day its trigger fired. */
function billableSince(stage) {
  if (stage.trigger_event === 'On PO Registration') return stage.po_date;
  if (stage.trigger_event === 'On Delivery') return stage.delivery_date;
  if (stage.trigger_event === 'On Milestone') return stage.milestone_reached_on;
  return null;
}

const TRIGGER_BECAUSE = {
  'On PO Registration': 'when the PO date was recorded',
  'On Delivery': 'when the delivery date was recorded',
  'On Milestone': 'when its milestone was reached',
};

/** The run's header, the same in every state of the queue. */
function RunHeader({ line, children }) {
  return (
    <header className="flex flex-wrap items-center gap-4 px-4 pt-6 sm:px-8">
      <div className="min-w-0 flex-1">
        <h1 className="text-[20px] font-semibold tracking-[-0.018em] text-foreground">Raising invoices</h1>
        {line && <p className="mt-1.5 text-[12.5px] text-secondary-text">{line}</p>}
      </div>
      {children}
    </header>
  );
}

/** A labelled fact in the three-column strip. */
function Fact({ label, children }) {
  return (
    <div className="min-w-0">
      <div className={LABEL}>{label}</div>
      {children}
    </div>
  );
}

/** A line in "What this will change". */
function Change({ label, children }) {
  return (
    <div className="flex justify-between gap-3 text-[12.5px] text-secondary-text">
      {label}
      <span className="min-w-0 text-right text-foreground">{children}</span>
    </div>
  );
}

export default function InvoiceRun() {
  const navigate = useNavigate();
  const toast = useToast();
  const uploadDocument = useDocumentUploads();

  const [index, setIndex] = useState(0);
  const [invoiceNo, setInvoiceNo] = useState('');
  const [invoiceDate, setInvoiceDate] = useState(today());
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [raised, setRaised] = useState([]);   // ids done in this run

  // The queue is read once. Raising a stage takes it out of "To Invoice",
  // so refetching after every save would renumber the queue under the
  // person working it — the run keeps its own order and marks off as it goes.
  const { data, loading, error, refetch } = useFetch(
    () => api.list('payment-stages', { stage_status: 'To Invoice', limit: 100 }),
    []
  );
  const queue = (data?.data ?? []).filter((s) => !raised.includes(s.id));
  const stage = queue[index] ?? null;

  /**
   * The next number in the series, for display only.
   *
   * Asked for the invoice's own date, not today's: the series runs April
   * to March, so an invoice dated 28 March takes a number from the year
   * that is ending. Re-asked whenever the date changes, because that is
   * exactly when somebody cannot guess it.
   */
  const { data: series } = useFetch(
    () => api.raw(`/lookups/next-id/invoice?on=${encodeURIComponent(invoiceDate)}`).catch(() => null),
    [invoiceDate]
  );
  const nextInSeries = series?.data?.next ?? null;

  // Context the invoice needs but the stage row does not carry: what the
  // order actually covers, and who the bill goes to.
  const { data: context } = useFetch(
    async () => {
      if (!stage) return null;
      const po = await api.raw(`/purchase-orders/${encodeURIComponent(stage.po_number)}/full`);
      const companyId = po.data?.purchase_order?.company_id;
      const company = companyId ? await api.raw(`/companies/${companyId}/full`).catch(() => null) : null;
      return { po: po.data, company: company?.data ?? null };
    },
    [stage?.po_number]
  );

  // A fresh stage starts on today's date and an untouched number.
  useEffect(() => { setInvoiceNo(''); setInvoiceDate(today()); setFile(null); }, [stage?.id]);

  if (error) {
    return <><RunHeader /><div className="px-4 pt-6 sm:px-8"><ErrorState message={error} onRetry={refetch} /></div></>;
  }
  if (loading || !data) {
    return <><RunHeader /><div className="px-4 pt-6 sm:px-8"><div className="skeleton" style={{ height: 240 }} /></div></>;
  }

  const total = (data.data ?? []).length;
  const doneCount = raised.length;
  const toBill = queue.reduce((sum, s) => sum + Number(s.to_bill_amount || s.stage_amount || 0), 0);

  if (!stage) {
    return (
      <>
        <RunHeader line={doneCount ? `${number(doneCount)} raised in this run` : 'nothing billable today'} />
        <div className="px-4 pt-6 sm:px-8">
          <RecordSection title={doneCount ? 'The queue is clear' : 'Nothing to raise'}>
            <p className="px-5 py-6 text-[13px]/[1.7] text-secondary-text">
              {doneCount
                ? `${number(doneCount)} invoice${doneCount === 1 ? '' : 's'} raised in this run. Nothing else on the books is billable today.`
                : 'No payment stage is billable right now. A stage becomes billable when its trigger fires — a PO date recorded, a delivery date set, or a milestone reached.'}
            </p>
            <div className="border-t border-border px-5 py-4">
              <Button variant="secondary" size="sm" className={FLOW_BUTTON} onClick={() => navigate('/payment-stages')}>
                Back to the schedule
              </Button>
            </div>
          </RecordSection>
        </div>
      </>
    );
  }

  const po = context?.po?.purchase_order ?? null;
  const services = context?.po?.services ?? [];
  const billTo = context?.company?.contacts?.find((c) => c.is_billing) ?? context?.company?.contacts?.[0] ?? null;
  const since = billableSince(stage);
  const dueDate = addDays(invoiceDate, stage.terms_days ?? stage.credit_days);
  const position = doneCount + 1;

  const invoicedNow = Number(po?.total_invoiced ?? 0);
  const invoicedAfter = invoicedNow + Number(stage.stage_amount || 0);

  function reset() {
    setInvoiceNo('');
    setInvoiceDate(today());
    setFile(null);
  }

  async function raise(andNext) {
    setBusy(true);
    try {
      const documentId = file ? await uploadDocument(file, 'payment-stages') : null;
      const body = { invoice_date: invoiceDate, document_id: documentId };
      // Only a number somebody typed is sent. Left alone, the server takes
      // the next one in the series inside its own transaction, which is
      // the only way the series stays unbroken with two people in here.
      if (invoiceNo.trim()) body.invoice_no = invoiceNo.trim();

      const saved = await api.action(`/payment-stages/${stage.id}/invoice`, body);
      toast(`Invoice ${saved.data?.invoice_no ?? ''} raised`.trim(), 'success');
      setRaised((done) => [...done, stage.id]);
      reset();
      // The filtered queue closes up, so the index stays where it is.
      if (!andNext) navigate(`/purchase-orders/${encodeURIComponent(stage.po_number)}`);
    } catch (err) {
      toast(err.fields ? Object.values(err.fields)[0] : err.message, 'danger');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <RunHeader
        line={<>{total === 1 ? 'One to raise' : `One of ${number(total)}`} · <span className="mono">{money(toBill, stage.currency)}</span> to bill</>}
      >
        <Button
          variant="ghost"
          size="sm"
          className={FLOW_BUTTON}
          disabled={queue.length < 2}
          onClick={() => setIndex((i) => (i + 1) % queue.length)}
        >
          Skip this one
        </Button>
        <Button variant="secondary" size="sm" className={FLOW_BUTTON} onClick={() => navigate('/payment-stages')}>
          Leave the queue
        </Button>
      </RunHeader>

      <div className="flex items-center gap-3 px-4 pt-4 sm:px-8">
        <Progress value={total ? (doneCount / total) * 100 : 0} className="h-1 flex-1 bg-secondary" />
        <span className="mono text-[12px] text-muted-foreground">{number(position)} / {number(total)}</span>
      </div>

      <div className="grid items-start gap-6 px-4 pt-6 pb-8 sm:px-8 xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="flex min-w-0 flex-col gap-4">
          <div className="rounded-[10px] border border-border bg-card p-6">
            <div className="flex flex-wrap items-baseline gap-3">
              <span className="text-[18px] font-semibold text-foreground">{stage.client_name}</span>
              <Link to={`/purchase-orders/${encodeURIComponent(stage.po_number)}`} className="mono text-[12.5px] text-secondary-text no-underline hover:text-foreground">
                {stage.po_number}
              </Link>
              {stage.project_id && (
                <Link to={`/projects/${encodeURIComponent(stage.project_id)}`} className="mono text-[12.5px] text-secondary-text no-underline hover:text-foreground">
                  {stage.project_id}
                </Link>
              )}
              <span className="mono ml-auto text-[24px] font-semibold tracking-[-0.02em] text-foreground">
                {money(stage.stage_amount, stage.currency)}
              </span>
            </div>

            <p className="mt-3 max-w-[66ch] text-[14px]/[1.7] text-secondary-text">
              Stage {number(stage.stage_no)}, <strong className="font-semibold text-foreground">{stage.stage_name}{/%/.test(stage.stage_name) ? '' : ` ${percent(stage.stage_percent)}`}</strong>,
              {since
                ? <> became billable on <strong className="font-semibold text-foreground">{date(since)}</strong> {TRIGGER_BECAUSE[stage.trigger_event] || ''}.</>
                : <> is billable.</>}
              {stage.terms_days
                ? <> Terms are {number(stage.terms_days)} days, so an invoice dated {date(invoiceDate)} falls due <strong className="font-semibold text-foreground">{date(dueDate)}</strong>.</>
                : <> No payment terms are recorded on this order, so the invoice has no due date.</>}
            </p>

            <div className="mt-5 grid grid-cols-1 gap-5 border-t border-border pt-5 sm:grid-cols-3">
              <Fact label="Bill to">
                <div className="mt-1.5 text-[13px] text-foreground">{context?.company?.name || stage.client_name}</div>
                {billTo?.email
                  ? <div className="text-[12px] break-words text-secondary-text">{billTo.email}</div>
                  : <div className="text-[12px] text-muted-foreground">no billing contact recorded</div>}
              </Fact>
              {/* The design's third column is "Place of supply". Nothing on a
                  purchase order records one — companies hold a city, not a
                  state — so this says what is actually known about the tax
                  instead of inventing a state code. */}
              <Fact label="Tax">
                <div className="mt-1.5 text-[13px] text-foreground">
                  {context?.company?.gstin || <span className="text-muted-foreground">no GSTIN on file</span>}
                </div>
                <div className="text-[12px] text-secondary-text">{stage.currency === 'INR' ? 'GST as per the order' : `Billed in ${stage.currency}`}</div>
              </Fact>
              <Fact label={services.length > 1 ? 'Services' : 'Service'}>
                <div className="mt-1.5 text-[13px] text-foreground">
                  {services.length
                    ? services.map((s) => s.service).join(' · ')
                    : <span className="text-muted-foreground">not itemised on this order</span>}
                </div>
              </Fact>
            </div>
          </div>

          {queue.length > 1 && (
            <RecordSection title="After this one">
              {queue.filter((_, i) => i !== index).slice(0, 6).map((next, i, shown) => (
                <div
                  key={next.id}
                  className={cn('flex h-9 items-center gap-4 px-5', i < shown.length - 1 && 'border-b border-border')}
                >
                  <span className="mono w-[84px] flex-none truncate text-[12.5px] text-foreground">{next.po_number}</span>
                  <span className="min-w-0 flex-1 truncate text-[13px] text-secondary-text">
                    {next.client_name} · stage {number(next.stage_no)}, {next.stage_name.toLowerCase()}
                  </span>
                  <span className="mono text-[13px] text-foreground">{money(next.stage_amount, next.currency)}</span>
                </div>
              ))}
            </RecordSection>
          )}
        </div>

        <div className="overflow-hidden rounded-[10px] border border-border-strong bg-card">
          <div className="border-b border-border px-6 py-5">
            <div className="text-[15px] font-semibold text-foreground">Raise the invoice</div>
            <p className="mt-1 text-[12.5px] text-secondary-text">
              {nextInSeries ? 'Two fields. Everything else is computed.' : 'The number and the date. Everything else is computed.'}
            </p>
          </div>

          <div className="flex flex-col gap-5 p-6">
            <div>
              <Label htmlFor="invoice-no" className="mb-2 text-[12.5px] font-medium text-secondary-text">Invoice number</Label>
              <div className="relative">
                <Input
                  id="invoice-no"
                  value={invoiceNo}
                  placeholder={nextInSeries ?? ''}
                  onChange={(e) => setInvoiceNo(e.target.value)}
                  className={cn('mono h-8 pr-24 text-[13px]', nextInSeries && !invoiceNo && 'border-primary ring-[3px] ring-primary/20')}
                />
                <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-[11.5px] text-muted-foreground">
                  {invoiceNo ? 'typed over' : nextInSeries ? 'next in series' : 'required'}
                </span>
              </div>
              {nextInSeries && !invoiceNo && (
                <p className="mt-1.5 text-[11.5px] text-muted-foreground">
                  Left alone, the server takes this number as it saves, so the series cannot break.
                </p>
              )}
            </div>

            <div>
              <Label htmlFor="invoice-date" className="mb-2 text-[12.5px] font-medium text-secondary-text">Invoice date</Label>
              <div className="relative">
                <Input
                  id="invoice-date"
                  type="date"
                  value={invoiceDate}
                  onChange={(e) => setInvoiceDate(e.target.value)}
                  className="h-8 text-[13px]"
                />
              </div>
            </div>

            <div>
              <Label htmlFor="invoice-pdf" className="mb-2 text-[12.5px] font-medium text-secondary-text">
                Invoice PDF <span className="font-normal text-muted-foreground">optional</span>
              </Label>
              <label
                htmlFor="invoice-pdf"
                className="block cursor-pointer rounded-[6px] border border-dashed border-border-strong p-4 text-center text-[12.5px] text-muted-foreground hover:border-primary hover:text-secondary-text"
              >
                {file ? file.name : 'Drop a file, or browse'}
              </label>
              <input
                id="invoice-pdf"
                type="file"
                className="sr-only"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </div>

            {/* Naming each derived value before the click is the whole point:
                the figures come out of views.sql, and nobody should have to
                read it to believe them. Only what is arithmetic is promised
                here — the recomputed statuses are left to the server. */}
            <div className="flex flex-col gap-2.5 rounded-[6px] border border-border bg-background p-4">
              <div className={LABEL}>What this will change</div>
              <Change label="Stage">To invoice → <strong className="font-semibold">Due</strong></Change>
              <Change label="Due date"><span className="mono">{dueDate ? date(dueDate) : '—'}</span></Change>
              <Change label={`${stage.po_number} invoiced`}>
                <span className="mono">{money(invoicedNow, stage.currency)} → {money(invoicedAfter, stage.currency)}</span>
              </Change>
              <Change label="Left to bill on it">
                <span className="mono">{money(Math.max(Number(po?.balance_to_bill ?? 0) - Number(stage.stage_amount || 0), 0), stage.currency)}</span>
              </Change>
            </div>

            <div className="flex gap-2">
              <Button
                size="sm"
                className={cn(FLOW_BUTTON, 'flex-1')}
                disabled={busy || !invoiceDate || (!nextInSeries && !invoiceNo.trim())}
                onClick={() => raise(true)}
              >
                {busy ? 'Raising…' : 'Raise and go to next'}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                className={FLOW_BUTTON}
                disabled={busy || !invoiceDate || (!nextInSeries && !invoiceNo.trim())}
                onClick={() => raise(false)}
              >
                Raise and stop
              </Button>
            </div>

            <p className="text-[11.5px]/[1.6] text-muted-foreground">
              Status, due date and every rollup are computed in <code className="mono">views.sql</code> from these two facts.
              <span className="mono"> POST /api/payment-stages/{stage.id}/invoice</span>
            </p>
          </div>
        </div>
      </div>
    </>
  );
}
