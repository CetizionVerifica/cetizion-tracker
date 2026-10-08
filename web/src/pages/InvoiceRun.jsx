import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, Mail, SkipForward } from 'lucide-react';
import { cn } from 'cn';
import { PageHeader } from '../App.jsx';
import { Field, FileDrop, Input, useToast } from '../components/ui.jsx';
import { DialogError, Key, shortDate } from '../components/money.jsx';
import { FailedCard, StateCard, plural } from '../components/daily.jsx';
import { Tone } from '../components/sales.jsx';
import { api } from '../lib/api.js';
import { useDocumentUploads, useFetch } from '../lib/hooks.js';
import { money, number, percent, today } from '../lib/format.js';

/**
 * Raising invoices: a queue of one decision. The stage on the left, the
 * number and the date on the right, and "What this will change" naming
 * every derived value before the click.
 *
 * The invoice number is NOT sent unless somebody types over it. It is a
 * statutory GST series and it has to be unbroken, so the server claims it
 * inside the same transaction that writes the stage. Two people in this
 * queue at once would otherwise both be shown the same next number and
 * both succeed in using it.
 */

const MS_PER_DAY = 86_400_000;

function addDays(iso, days) {
  if (!iso || !days) return iso || null;
  const from = new Date(String(iso).slice(0, 10));
  if (Number.isNaN(from.getTime())) return null;
  return new Date(from.getTime() + Number(days) * MS_PER_DAY).toISOString().slice(0, 10);
}

/** The day a stage became billable: the day its trigger fired. */
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

const stageName = (s) => String(s.stage_name || '').replace(/\s*\(\d+(\.\d+)?%\)\s*$/, '');

export default function InvoiceRun() {
  const navigate = useNavigate();
  const toast = useToast();
  const uploadDocument = useDocumentUploads();

  const [index, setIndex] = useState(0);
  const [invoiceNo, setInvoiceNo] = useState('');
  const [invoiceDate, setInvoiceDate] = useState(today());
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState(null);
  const [fields, setFields] = useState({});
  const [raised, setRaised] = useState([]);   // { id, amount } done in this run

  // The queue is read once. Raising a stage takes it out of "To Invoice",
  // so refetching after every save would renumber the queue under the
  // person working it: the run keeps its own order and marks off as it goes.
  const { data, loading, error, refetch } = useFetch(
    () => api.list('payment-stages', { stage_status: 'To Invoice', limit: 100 }),
    []
  );
  const all = data?.data ?? [];
  const queue = all.filter((s) => !raised.some((r) => r.id === s.id));
  const stage = queue[Math.min(index, Math.max(queue.length - 1, 0))] ?? null;

  /** The next number in the series for the invoice's own date (display only). */
  const { data: series } = useFetch(
    () => api.raw(`/lookups/next-id/invoice?on=${encodeURIComponent(invoiceDate)}`).catch(() => null),
    [invoiceDate]
  );
  const nextInSeries = series?.data?.next ?? null;

  // What the invoice needs that the stage row does not carry: what the
  // order covers, and who the bill goes to.
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
  useEffect(() => { setInvoiceNo(''); setInvoiceDate(today()); setFile(null); setFailure(null); setFields({}); }, [stage?.id]);

  const leave = <Link to="/payment-stages" className="mg-btn">Leave the queue</Link>;

  if (error) {
    return (
      <>
        <PageHeader title="Raising invoices" actions={leave} />
        <div className="app-page"><FailedCard title="Couldn't load the queue" text={`Nothing was raised. (${error})`} onRetry={refetch} /></div>
      </>
    );
  }
  if (loading || !data) {
    return (
      <>
        <PageHeader title="Raising invoices" actions={leave} />
        <div className="app-page" aria-busy="true" aria-label="Loading the queue">
          <div className="mg-glass mg-panel"><div className="mg-skel" style={{ height: 14, width: '20%' }} /><div className="mg-skel" style={{ height: 10 }} /></div>
          <div className="app-run">
            <div className="mg-glass mg-panel" style={{ minHeight: 260 }}><div className="mg-skel" style={{ height: 30, width: '50%' }} /><div className="mg-skel" style={{ height: 60 }} /></div>
            <div className="mg-glass mg-panel" style={{ minHeight: 360 }}><div className="mg-skel" style={{ height: 44 }} /><div className="mg-skel" style={{ height: 44 }} /><div className="mg-skel" style={{ height: 120 }} /></div>
          </div>
        </div>
      </>
    );
  }

  const total = all.length;
  const raisedSum = raised.reduce((t, r) => t + r.amount, 0);
  const toBill = queue.reduce((sum, s) => sum + Number(s.to_bill_amount || s.stage_amount || 0), 0);

  if (!stage) {
    return (
      <>
        <PageHeader title="Raising invoices" subtitle={raised.length ? `${plural(raised.length, 'invoice')} raised in this run` : 'Nothing billable today'} actions={leave} />
        <div className="app-page">
          {raised.length ? (
            <StateCard title="The queue is clear" text={`${plural(raised.length, 'invoice')} raised in this run, ${money(raisedSum)} in all. Nothing else on the books is billable today.`}>
              <Link to="/payment-stages" className="mg-btn mg-btn--sm">Back to Payment stages</Link>
              <Link to="/collections" className="mg-btn mg-btn--sm">Open Collections</Link>
            </StateCard>
          ) : (
            <StateCard tone="plain" title="Nothing to raise" text="No payment stage is billable right now. A stage becomes billable when its trigger fires: a PO date recorded, a delivery date set, or a milestone reached.">
              <Link to="/payment-stages" className="mg-btn mg-btn--sm">Back to Payment stages</Link>
            </StateCard>
          )}
        </div>
      </>
    );
  }

  const po = context?.po?.purchase_order ?? null;
  const services = context?.po?.services ?? [];
  const company = context?.company ?? null;
  const billTo = company?.contacts?.find((c) => c.is_billing) ?? company?.contacts?.[0] ?? null;
  const since = billableSince(stage);
  const terms = stage.terms_days ?? stage.credit_days;
  const dueDate = addDays(invoiceDate, terms);
  const backDated = dueDate && dueDate < today();
  const position = raised.length + Math.min(index, queue.length - 1) + 1;
  const invoicedNow = Number(po?.total_invoiced ?? 0);
  const invoicedAfter = invoicedNow + Number(stage.stage_amount || 0);
  const portalOn = company?.portal_enabled && (company?.portal_sections || []).includes('invoices');
  const after = queue.filter((s) => s.id !== stage.id);

  async function raise(andNext) {
    setBusy(true); setFailure(null); setFields({});
    try {
      const documentId = file ? await uploadDocument(file, 'payment-stages') : null;
      const body = { invoice_date: invoiceDate, document_id: documentId };
      // Only a number somebody typed is sent; left alone, the server takes
      // the next one in the series inside its own transaction.
      if (invoiceNo.trim()) body.invoice_no = invoiceNo.trim();
      const saved = await api.action(`/payment-stages/${stage.id}/invoice`, body);
      toast(`Invoice ${saved.data?.invoice_no ?? ''} raised`.trim(), 'success');
      setRaised((done) => [...done, { id: stage.id, amount: Number(stage.stage_amount || 0) }]);
      if (!andNext) navigate(`/purchase-orders/${encodeURIComponent(stage.po_number)}`);
    } catch (err) {
      setFields(err.fields || {});
      setFailure(err.message);
    } finally {
      setBusy(false);
    }
  }

  const blocked = busy || !invoiceDate || (!nextInSeries && !invoiceNo.trim());

  return (
    <>
      <PageHeader
        title="Raising invoices"
        subtitle={<>{number(position)} of {number(total)} · <span className="mg-num">{money(toBill, stage.currency)}</span> to bill</>}
        actions={<>
          <button type="button" className="mg-btn mg-btn--ghost" disabled={queue.length < 2} title={queue.length < 2 ? 'Nothing else is waiting' : undefined} onClick={() => setIndex((i) => (i + 1) % queue.length)}>
            <SkipForward className="size-4" strokeWidth={1.8} aria-hidden="true" />Skip this one
          </button>
          {leave}
        </>}
      />
      <div className="app-page">
        <section className="mg-glass app-runbar" data-a="rise" aria-label="The run">
          <div className="app-runbar__head">
            <strong>Stage {number(position)} of {number(total)}</strong>
            <span className="mg-legend"><Key swatch={{ background: 'var(--figure)' }}>Raised <b className="mg-num">{money(raisedSum)}</b></Key><Key swatch="hatch">Still to raise <b className="mg-num">{money(toBill)}</b></Key></span>
          </div>
          <div className="app-runbar__segs" role="img" aria-label={`${raised.length} raised, ${queue.length} still to raise`}>
            {all.map((s) => {
              const done = raised.some((r) => r.id === s.id);
              return <span key={s.id} className={cn(done ? 'is-done' : s.id === stage.id ? 'is-current' : 'mg-hatch')} style={{ flexGrow: Math.max(1, Number(s.stage_amount) || 1) }} />;
            })}
          </div>
        </section>

        <div className="app-run">
          <div className="app-run__left">
            <section className="mg-glass mg-glass--strong app-runcard" data-a="rise" aria-labelledby="run-client">
              <div className="app-runcard__top">
                <div className="min-w-0">
                  <h2 id="run-client" className="m-0 text-[20px] font-bold">{stage.client_name}</h2>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[13px]">
                    <Link to={`/purchase-orders/${encodeURIComponent(stage.po_number)}`} className="app-link">PO {stage.po_number}</Link>
                    {stage.project_id && <Link to={`/projects/${encodeURIComponent(stage.project_id)}`} className="app-link">{stage.project_id}</Link>}
                    <Tone tone="wait">To invoice</Tone>
                  </div>
                </div>
                <div className="text-right">
                  <span className="mg-label">Stage value</span>
                  <div className="mg-num text-[30px] font-bold tracking-[-0.02em]">{money(stage.stage_amount, stage.currency)}</div>
                </div>
              </div>
              <p className="app-runcard__say">
                Stage {number(stage.stage_no)}, <strong>{stageName(stage)} {percent(stage.stage_percent)}</strong>,
                {since ? <> became billable on <strong>{shortDate(since)}</strong> {TRIGGER_BECAUSE[stage.trigger_event] || ''}.</> : <> is billable.</>}
              </p>
              <p className="app-runcard__say">
                {terms
                  ? <>Terms are {number(terms)} days, so an invoice dated {invoiceDate === today() ? 'today' : shortDate(invoiceDate)} falls due <strong className={backDated ? 'text-late' : undefined}>{shortDate(dueDate)}</strong>{backDated ? ', which has already passed' : ''}.</>
                  : <>No payment terms are recorded on this order, so the invoice has no due date.</>}
              </p>
              <dl className="app-runcard__facts">
                <div>
                  <dt>Bill to</dt>
                  <dd><b>{company?.name || stage.client_name}</b>{billTo?.name && <span>{billTo.name}</span>}{billTo?.email ? <span className="break-words">{billTo.email}</span> : <span className="text-muted-foreground">no billing contact recorded</span>}</dd>
                </div>
                {/* Nothing on a PO records a place of supply, so this says what is known about the tax. */}
                <div>
                  <dt>Tax</dt>
                  <dd><b>{company?.gstin || <span className="font-normal text-muted-foreground">no GSTIN on file</span>}</b><span>{stage.currency === 'INR' ? 'GST as per the order' : `Billed in ${stage.currency}, no GST`}</span></dd>
                </div>
                <div>
                  <dt>{services.length > 1 ? 'Services' : 'Service'}</dt>
                  <dd><b>{services.length ? services.map((s) => s.service).join(' · ') : <span className="font-normal text-muted-foreground">not itemised on this order</span>}</b></dd>
                </div>
              </dl>
            </section>

            {after.length > 0 && (
              <section className="mg-glass mg-glass--strong app-panel" data-a="rise" aria-labelledby="after-t">
                <div className="app-panel__head"><h2 className="mg-panel__title" id="after-t">After this one</h2><span className="mg-panel__hint ml-auto">{plural(after.length, 'more')} in the queue</span></div>
                <div className="mg-rows app-panel__body">
                  {after.slice(0, 6).map((next) => (
                    <div key={next.id} className="mg-row">
                      <span className="mg-row__title">{next.client_name}</span>
                      <span className="mg-row__amount mg-num">{money(next.stage_amount, next.currency)}</span>
                      <span className="mg-row__meta">PO {next.po_number} · stage {number(next.stage_no)}, {stageName(next)} {percent(next.stage_percent)}</span>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>

          <section className="mg-glass mg-glass--strong app-raise" data-a="rise" aria-labelledby="raise-t">
            <div className="app-raise__head">
              <h2 id="raise-t" className="mg-panel__title">Raise the invoice</h2>
              <span className="mg-panel__hint">Two fields. Everything else is worked out from them.</span>
            </div>
            <form className="app-raise__body" onSubmit={(e) => { e.preventDefault(); if (!blocked) raise(true); }}>
              <DialogError error={failure} what="the invoice" />
              <div className="mg-grid2">
                <Field label="Invoice number" required={!nextInSeries} error={fields.invoice_no}>
                  <span className="app-affix">
                    <Input value={invoiceNo} placeholder={nextInSeries ?? ''} onChange={(e) => setInvoiceNo(e.target.value)} className="mg-num" />
                    <span className="mg-badge mg-badge--plain app-affix__tag">{invoiceNo ? 'typed over' : nextInSeries ? 'next in series' : 'required'}</span>
                  </span>
                </Field>
                <Field label="Invoice date" required error={fields.invoice_date}>
                  <Input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
                </Field>
              </div>
              {nextInSeries && !invoiceNo && <p className="m-0 -mt-2 text-[12px] text-muted-foreground">Leave the number alone and it is taken as the invoice saves, so the series cannot break. Type over it only to use a different one.</p>}
              <Field as="div" label="Invoice PDF (optional)" error={fields.document_id}>
                <FileDrop label="Invoice PDF" text={file ? file.name : 'Drop the PDF here, or choose a file'} onFile={setFile} error={fields.document_id} />
              </Field>
              {/* Naming each derived value before the click: only what is arithmetic is promised here. */}
              <div className="app-change">
                <span className="mg-label">What this will change</span>
                <div className="app-fact">Stage<b>To invoice → {backDated ? <span className="text-late">Overdue</span> : 'Due'}</b></div>
                <div className="app-fact">Due date<b className={backDated ? 'text-late' : undefined}>{dueDate ? shortDate(dueDate) : '—'}</b></div>
                <div className="app-fact">PO {stage.po_number} invoiced<b className="mg-num">{money(invoicedNow, stage.currency)} → {money(invoicedAfter, stage.currency)}</b></div>
                <div className="app-fact">Left to bill on it<b className="mg-num">{money(Math.max(Number(po?.balance_to_bill ?? 0) - Number(stage.stage_amount || 0), 0), stage.currency)}</b></div>
                {portalOn && (
                  <p className="app-change__mail"><Mail aria-hidden="true" />The client&apos;s portal shows the invoice{billTo?.email ? `; if the portal's new-invoice email is on in Settings, ${billTo.name || billTo.email} (${billTo.email}) is told it is there` : ''}.</p>
                )}
              </div>
              <div className="app-raise__btns">
                <button type="submit" className="mg-btn mg-btn--primary" disabled={blocked}>
                  {busy ? 'Raising…' : failure && !Object.keys(fields).length ? 'Try again' : <>Raise and go to next<ArrowRight className="size-4" strokeWidth={2} aria-hidden="true" /></>}
                </button>
                <button type="button" className="mg-btn" disabled={blocked} onClick={() => raise(false)}>Raise and stop</button>
              </div>
            </form>
          </section>
        </div>
      </div>
    </>
  );
}


