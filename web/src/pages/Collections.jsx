import { Fragment, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ChevronRight, Filter, History } from 'lucide-react';
import { cn } from 'cn';
import { PageHeader } from '../App.jsx';
import { ConfirmDialog, Field, Input, Modal, Select, Textarea, useToast } from '../components/ui.jsx';
import { Button } from '../components/ui/button.tsx';
import { RecordPaymentDialog } from '../components/actions.jsx';
import { FollowUpBanner, useLogParam } from '../components/FollowUpBanner.jsx';
import { PortalAnswers } from '../components/PortalAnswers.jsx';
import { ClientSaidBadge, useClientSaid } from '../components/ClientSaid.jsx';
import { DialogError, Key, MoneyBanner, MoneyHero, shortDate } from '../components/money.jsx';
import { FailedCard, StateCard, plural, useEntrance } from '../components/daily.jsx';
import { SummaryStrip, Tone } from '../components/sales.jsx';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useFetch, useMediaQuery } from '../lib/hooks.js';
import { money, today } from '../lib/format.js';

/**
 * Collections (#27): who owes what and for how long, what was done about
 * it, and the next step. Ageing bands per client, the chasing log,
 * promises to pay, disputes on hold. Since #198, what clients said in the
 * portal: payments they report, and their queries.
 *
 * Wave 5 shape: a hero for what is outstanding beside a "By age" chart
 * whose bands are filters (?bucket=), a four-figure strip, the portal
 * card, then the clients, each opening its invoices right under its row.
 */
const CHANNELS = [
  { value: 'call', label: 'Call' }, { value: 'email', label: 'Email' }, { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'meeting', label: 'Meeting' }, { value: 'note', label: 'Note' },
];
const channelWord = (c) => CHANNELS.find((x) => x.value === c)?.label || c;
const keyOf = (c) => c.company_id ?? c.company;

export default function Collections() {
  const toast = useToast();
  const { isAdmin } = useAuth();
  const wide = useMediaQuery('(min-width: 1000px)');
  const [open, setOpen] = useState(null);           // company key expanded
  const [chase, setChase] = useState(null);         // { stage } | { company }
  const [hold, setHold] = useState(null);           // stage
  const [lift, setLift] = useState(null);           // stage
  const [paying, setPaying] = useState(null);       // { stage, preselect }
  const [logFor, setLogFor] = useState(null);       // stage
  const [version, setVersion] = useState(0);
  const { data, loading, error, refetch } = useFetch(() => api.raw('/collections'), [version]);
  // What the client last said in the portal about each invoice (#198).
  const clientSaid = useClientSaid([version]);
  const refresh = () => { setVersion((v) => v + 1); };
  // Reports links an ageing bar here as ?bucket=31-60; the chart's bands do
  // the same. The list narrows to the clients with money in that band, and
  // the banner says so; the totals and chart keep covering everything.
  const [params, setParams] = useSearchParams();
  const bucket = params.get('bucket');
  const raw = data?.data;
  const band = raw?.buckets.find((b) => b.key === bucket);
  const shown = raw && band
    ? raw.clients.filter((c) => c.buckets[band.key] > 0).map((c) => ({ ...c, stages: c.stages.filter((s) => s.bucket === band.key) }))
    : raw?.clients;
  const setBucket = (key) => {
    const next = new URLSearchParams(params);
    if (!key || key === bucket) next.delete('bucket'); else next.set('bucket', key);
    setParams(next, { replace: true });
  };
  // A follow-up email links here as ?stage=<id>&log=1: open that client's
  // invoices, show the follow-up, and open "Log a chase".
  const stageId = params.get('stage');
  const [chased, setChased] = useState(0);
  const target = stageId && raw
    ? raw.clients.flatMap((c) => c.stages.map((s) => ({ stage: s, key: keyOf(c) }))).find((x) => String(x.stage.id) === stageId)
    : null;
  useEffect(() => { if (target) setOpen(target.key); }, [target?.key]);
  useLogParam(() => setChase({ stage: target.stage }), Boolean(target));
  const page = useEntrance(Boolean(raw) || Boolean(error));

  async function liftHold() {
    try { await api.action(`/collections/stages/${lift.id}/hold`, { on_hold: false }); toast('Hold lifted', 'success'); setLift(null); refresh(); }
    catch (err) { toast(err.message, 'danger'); }
  }

  const acts = {
    isAdmin,
    pay: (s, said) => setPaying({ stage: s, preselect: said?.match ? said.id : undefined }),
    chase: (s) => setChase({ stage: s }),
    hold: setHold,
    lift: setLift,
    log: setLogFor,
  };

  return (
    <>
      <PageHeader title="Collections" subtitle="Invoiced and unpaid, by client and by age. Log every chase: a promise to pay pauses reminders until its date, a hold pauses them until it is lifted." />
      <div className="app-page" ref={page}>
        {error && !raw ? (
          <FailedCard title="Couldn't load collections" text={`The server didn't answer, so no totals are shown. This is not "nothing owed": nothing has changed. (${error})`} onRetry={refetch} />
        ) : loading && !raw ? (
          <Loading />
        ) : (
          <>
            {band && (
              <MoneyBanner icon={Filter} title={`Showing ${band.label} only: ${plural(shown.length, 'client')}.`} action={<button type="button" className="mg-btn mg-btn--sm" onClick={() => setBucket(null)}>Show all</button>}>
                The totals and chart still cover everything outstanding.
              </MoneyBanner>
            )}
            {stageId && <FollowUpBanner entity="payment_stage" id={stageId} version={chased} logLabel="Log a chase" onLog={target ? () => setChase({ stage: target.stage }) : undefined} />}
            {!raw.clients.length ? (
              <>
                <PortalAnswers onPaid={refresh} version={version} />
                <StateCard title="Nothing outstanding" text="Every invoiced stage is paid. New invoices show up here the day they are raised." />
              </>
            ) : (
              <>
                <div className="app-mrow">
                  <Hero d={raw} />
                  <AgeChart d={raw} bucket={bucket} onPick={setBucket} />
                </div>
                <Totals d={raw} />
                <PortalAnswers onPaid={refresh} version={version} />
                <section className="mg-glass mg-glass--strong app-panel" data-a="rise" aria-labelledby="clients-t">
                  <div className="app-panel__head">
                    <h2 className="mg-panel__title" id="clients-t">By client</h2>
                    <span className="mg-panel__hint">Oldest overdue first. Open a client for its invoices.</span>
                    <Tone className="ml-auto">{plural(shown.length, 'client')}</Tone>
                  </div>
                  {!shown.length ? (
                    <StateCard inPanel title="No client in this band" text="Nothing outstanding falls in it right now." tone="plain">
                      <button type="button" className="mg-btn mg-btn--sm" onClick={() => setBucket(null)}>Show every client</button>
                    </StateCard>
                  ) : wide ? (
                    <ClientTable clients={shown} buckets={raw.buckets} open={open} setOpen={setOpen} said={clientSaid} acts={acts} onChaseClient={(c) => setChase({ company: c })} />
                  ) : (
                    <ClientRows clients={shown} open={open} setOpen={setOpen} said={clientSaid} acts={acts} />
                  )}
                </section>
              </>
            )}
          </>
        )}
      </div>

      {chase && <ChaseDialog target={chase} onClose={() => setChase(null)} onSaved={() => { setChase(null); setChased((n) => n + 1); refresh(); }} />}
      {hold && <HoldDialog stage={hold} onClose={() => setHold(null)} onSaved={() => { setHold(null); refresh(); }} />}
      {lift && (
        <ConfirmDialog
          title={`Lift the hold on ${lift.invoice_no}?`}
          message="Reminders about this invoice start again. The reason for the hold stays in its history."
          confirmLabel="Lift hold"
          cancelLabel="Keep it on hold"
          tone="neutral"
          onConfirm={liftHold}
          onClose={() => setLift(null)}
        >
          {lift.hold_reason && <p className="m-0 mt-3 text-[12.5px] text-muted-foreground">On hold: {lift.hold_reason}</p>}
        </ConfirmDialog>
      )}
      {paying && <RecordPaymentDialog stage={paying.stage} preselect={paying.preselect} onClose={() => setPaying(null)} onDone={() => { setPaying(null); refresh(); }} />}
      {logFor && <LogDialog stage={logFor} onClose={() => setLogFor(null)} />}
    </>
  );
}

function Hero({ d }) {
  const { outstanding, overdue } = d.totals;
  const notDue = Math.max(outstanding - overdue, 0);
  const share = (n) => (outstanding > 0 ? (100 * n) / outstanding : 0);
  const half = overdue === 0 ? 'Nothing is overdue yet.'
    : overdue >= outstanding - 0.5 ? 'All of it is overdue.'
    : `${Math.round(share(overdue))}% of it is already overdue.`;
  return (
    <MoneyHero
      label="Outstanding (INR)"
      figure={money(outstanding)}
      count={outstanding}
      sub={`Invoiced and unpaid across ${plural(d.clients.length, 'client')}. ${half}`}
      done={share(overdue)}
      expected={share(notDue)}
      aria={`${money(overdue)} overdue, ${money(notDue)} not yet due`}
      legend={<>
        <Key swatch={{ background: 'var(--on-hero)' }}>Overdue <strong>{money(overdue)}</strong></Key>
        <Key swatch="hatch">Not yet due <strong>{money(notDue)}</strong></Key>
      </>}
    />
  );
}

/** The bands as bars; pressing one narrows the clients to it (and again shows all). */
function AgeChart({ d, bucket, onPick }) {
  const amounts = d.buckets.map((b) => d.totals.buckets[b.key] || 0);
  const max = Math.max(1, ...amounts);
  return (
    <section className="mg-glass mg-panel app-mrow__side" data-a="rise" aria-labelledby="age-t">
      <div className="mg-panel__head flex-wrap">
        <h2 className="mg-panel__title" id="age-t">By age</h2>
        <div className="mg-legend">
          <Key swatch="hatch">Not yet due</Key>
          <Key swatch={{ background: 'var(--figure)' }}>Overdue</Key>
          <Key swatch={{ background: 'var(--late)' }}>Over 90 days</Key>
        </div>
      </div>
      <div className="app-age" role="group" aria-label="Show one age band">
        {d.buckets.map((b, i) => {
          const n = d.clients.filter((c) => c.buckets[b.key] > 0).length;
          const late = b.key === '90+';
          return (
            <button key={b.key} type="button" aria-pressed={bucket === b.key} onClick={() => onPick(b.key)}
              aria-label={`${b.label}: ${money(amounts[i])}, ${plural(n, 'client')}. ${bucket === b.key ? 'Showing only this band; press again for every band' : 'Show only this band'}`}>
              <span className={cn('app-age__fig', late && amounts[i] > 0 ? 'is-late-text' : b.key === 'not-due' ? 'is-wait-text' : '')}>{money(amounts[i], 'INR', { compact: true })}</span>
              <span className="app-age__plot">
                <span className={cn('app-age__bar', b.key === 'not-due' && 'mg-hatch')} data-a="grow"
                  style={{ height: `${Math.max(2, (100 * amounts[i]) / max)}%`, background: b.key === 'not-due' ? undefined : late ? 'var(--late)' : 'var(--figure)' }} />
              </span>
              <span className="app-age__label">{b.label}</span>
              <span className="app-age__n">{plural(n, 'client')}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function Totals({ d }) {
  const stages = d.clients.flatMap((c) => c.stages);
  const late = d.clients.filter((c) => c.overdue > 0).length;
  const promised = stages.filter((s) => s.promise_to_pay_date && s.currency === 'INR').length;
  const held = stages.filter((s) => s.on_hold && s.currency === 'INR').length;
  const foreignBy = {};
  for (const f of d.foreign || []) foreignBy[f.currency] = (foreignBy[f.currency] || 0) + Number(f.amount);
  return (
    <SummaryStrip
      label="Totals"
      tiles={[
        { key: 'overdue', label: 'Overdue', figure: money(d.totals.overdue), tone: d.totals.overdue > 0 ? 'late' : undefined, badge: late ? { tone: 'late', text: `${plural(late, 'client')} late` } : undefined, foot: late ? undefined : 'nothing late' },
        { key: 'promised', label: 'Promised', figure: money(d.totals.promised), tone: 'wait', foot: promised ? `${plural(promised, 'pay-by date')} given` : 'no pay-by dates given' },
        { key: 'hold', label: 'On hold', figure: money(d.totals.on_hold), foot: held ? `${plural(held, 'dispute')}, no reminders` : 'nothing on hold' },
        d.foreign?.length > 0 && {
          key: 'foreign', label: 'Not in these totals', figure: plural(d.foreign.length, 'invoice'),
          badge: { tone: 'wait', text: 'Left out' },
          foot: Object.entries(foreignBy).map(([cur, n]) => `${cur} ${Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 })}`).join(' · '),
        },
      ].filter(Boolean)}
    />
  );
}

/** What an invoice's status column says: its badges and lines. */
function StageState({ s, said, onMatch }) {
  const lines = [
    s.promise_to_pay_date && `Promised ${shortDate(s.promise_to_pay_date)}`,
    s.reminder_level > 0 && `reminder ${s.reminder_level} sent${s.reminder_sent_on ? ` ${shortDate(s.reminder_sent_on)}` : ''}`,
  ].filter(Boolean).join(' · ');
  const promiseLate = s.promise_to_pay_date && s.promise_to_pay_date < today();
  return (
    <span className="app-stack">
      <span className="app-badges">
        <Tone tone={s.days_overdue > 0 ? 'late' : s.stage_status === 'Partially Paid' ? 'wait' : 'info'}>{s.days_overdue > 0 ? 'Overdue' : s.stage_status === 'Partially Paid' ? 'Partly paid' : 'Due'}</Tone>
        {s.on_hold && <Tone tone="wait">{s.hold_reason ? `On hold: ${s.hold_reason}` : 'On hold'}</Tone>}
      </span>
      {lines && <span className={cn('text-[12px]', promiseLate ? 'text-late' : 'text-secondary-text')}>{lines}{promiseLate ? ' (missed)' : ''}</span>}
      <ClientSaidBadge said={said} onMatch={onMatch} />
    </span>
  );
}

function overdueLine(s, buckets) {
  if (!(s.days_overdue > 0)) return null;
  const b = buckets?.find((x) => x.key === s.bucket);
  return `${plural(s.days_overdue, 'day')} overdue${b ? ` · ${b.label}` : ''}`;
}

function ClientTable({ clients, buckets, open, setOpen, said, acts, onChaseClient }) {
  const dash = <span className="mg-muted">—</span>;
  const cell = (n, cls) => (n > 0 ? <span className={cls}>{money(n)}</span> : dash);
  return (
    <div className="mg-tablewrap app-panel__body">
      <table className="mg-table" aria-label="What each client owes, by age">
        <thead>
          <tr>
            <th>Client</th><th className="num">Outstanding</th><th className="num">Overdue</th>
            {buckets.map((b) => <th key={b.key} className="num">{b.key === 'not-due' ? 'Not yet due' : b.label.replace(' days', '')}</th>)}
            <th>Chased</th><th>Promise</th><th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {clients.map((c) => {
            const k = keyOf(c);
            const isOpen = open === k;
            const toggle = () => setOpen(isOpen ? null : k);
            return (
              <Fragment key={k}>
                <tr className={cn('is-clickable', isOpen && 'app-open')} aria-selected={isOpen} onClick={(e) => { if (!e.target.closest('a, button')) toggle(); }}>
                  <td className="py-2 pl-2.5">
                    <span className="app-client">
                      <button type="button" className="mg-iconbtn app-expand" aria-expanded={isOpen} aria-label={`${isOpen ? 'Hide' : 'Show'} ${c.company}'s invoices`} onClick={toggle}>
                        <ChevronRight className="size-4" strokeWidth={2} aria-hidden="true" />
                      </button>
                      <span className="app-client__text">
                        {c.company_id ? <Link to={`/companies/${c.company_id}`}>{c.company}</Link> : <b>{c.company}</b>}
                        {c.contact_name && <span className="app-sub2" title={[c.contact_name, c.contact_email, c.contact_phone].filter(Boolean).join(' · ')}>{[c.contact_name, c.contact_email].filter(Boolean).join(' · ')}</span>}
                      </span>
                    </span>
                  </td>
                  <td className="num font-bold">{money(c.outstanding)}</td>
                  <td className="num font-bold">{c.overdue > 0 ? <><span className="text-late">{money(c.overdue)}</span><span className="app-sub2">oldest {c.oldest_days} d</span></> : dash}</td>
                  {buckets.map((b) => <td key={b.key} className="num">{cell(c.buckets[b.key], b.key === 'not-due' ? 'mg-money--expected' : b.key === '90+' ? 'text-late' : '')}</td>)}
                  <td className={cn('whitespace-nowrap', !c.last_chased_at && 'text-muted-foreground')}>{c.last_chased_at ? shortDate(c.last_chased_at) : 'never'}</td>
                  <td>{c.promise_to_pay_date ? <Tone tone={c.promise_to_pay_date < today() ? 'late' : 'info'}>{c.promise_to_pay_date < today() ? `Missed ${shortDate(c.promise_to_pay_date)}` : `Pay by ${shortDate(c.promise_to_pay_date)}`}</Tone> : dash}</td>
                  <td className="pr-4"><button type="button" className="mg-btn mg-btn--sm" onClick={() => onChaseClient(c)}>Log a chase</button></td>
                </tr>
                {isOpen && (
                  <tr>
                    <td colSpan={buckets.length + 6} className="app-inner">
                      <div className="app-inner__wrap">
                        <div className="app-inner__head"><h3>{c.company}: invoices</h3><span className="mg-panel__hint">Each invoiced stage still open, with what was done about it.</span></div>
                        <table className="mg-table text-[13px]">
                          <thead><tr><th>Invoice</th><th className="num">Outstanding</th><th>Due</th><th>Status</th><th>Last chase</th><th aria-label="Actions" /></tr></thead>
                          <tbody>
                            {c.stages.map((s) => (
                              <tr key={s.id}>
                                <td>
                                  <span className="mg-num font-bold">{s.invoice_no}</span>
                                  <span className="app-sub2">{shortDate(s.invoice_date)} · <Link className="app-link" to={`/purchase-orders/${encodeURIComponent(s.po_number)}`}>PO {s.po_number}</Link></span>
                                  <span className="app-sub2">Stage {s.stage_no}, {s.stage_name}</span>
                                </td>
                                <td className="num"><strong>{money(s.outstanding, s.currency)}</strong><span className="app-sub2">{Number(s.outstanding) >= Number(s.stage_amount) - 0.5 ? 'the whole stage' : `of ${money(s.stage_amount, s.currency)}`}</span></td>
                                <td className="whitespace-nowrap">{shortDate(s.invoice_due_date)}{overdueLine(s, buckets) && <span className="app-sub2 is-late">{overdueLine(s, buckets)}</span>}</td>
                                <td><div style={{ minWidth: 240 }}><StageState s={s} said={said.get(s.id)} onMatch={(w) => acts.pay(s, w)} /></div></td>
                                <td><div style={{ minWidth: 160 }}>
                                  {s.last_chased_at ? <>{shortDate(s.last_chased_at)} · {channelWord(s.last_channel)}<span className="app-sub2 is-wrap">{s.last_summary}</span>{s.next_action_on && <span className="app-sub2">Next: {shortDate(s.next_action_on)}</span>}</> : <span className="text-muted-foreground">Never chased</span>}
                                </div></td>
                                <td><StageButtons s={s} said={said.get(s.id)} acts={acts} /></td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function StageButtons({ s, said, acts, phone }) {
  const matchFirst = said?.match;
  const sz = phone ? '' : ' mg-btn--sm';
  return (
    <span className={phone ? 'app-pinv__btns' : 'app-acts app-acts--w'}>
      <button type="button" className={`mg-btn mg-btn--primary${sz}`} onClick={() => acts.pay(s, said)}>{matchFirst && phone ? 'Match the payment' : 'Record payment'}</button>
      {!phone && <span className="app-acts__break" aria-hidden="true" />}
      <button type="button" className={`mg-btn${sz}${phone ? ' app-grow' : ''}`} onClick={() => acts.chase(s)}>Log a chase</button>
      {acts.isAdmin && (s.on_hold
        ? <button type="button" className={`mg-btn mg-btn--ghost${sz}`} onClick={() => acts.lift(s)}>Lift hold</button>
        : <button type="button" className={`mg-btn mg-btn--ghost${sz}`} onClick={() => acts.hold(s)}>Hold</button>)}
      {phone
        ? <button type="button" className="mg-btn mg-btn--ghost" onClick={() => acts.log(s)}>History</button>
        : <button type="button" className="mg-iconbtn app-iconbtn" aria-label={`History of ${s.invoice_no}`} title="History" onClick={() => acts.log(s)}><History strokeWidth={1.8} aria-hidden="true" /></button>}
    </span>
  );
}

function ClientRows({ clients, open, setOpen, said, acts }) {
  return (
    <div className="mg-rows app-panel__body">
      {clients.map((c) => {
        const k = keyOf(c);
        const isOpen = open === k;
        const meta = [
          c.overdue > 0 ? `Overdue ${money(c.overdue)}` : 'Not yet due',
          c.oldest_days > 0 && `oldest ${c.oldest_days} d`,
          `chased ${c.last_chased_at ? shortDate(c.last_chased_at) : 'never'}`,
        ].filter(Boolean).join(' · ');
        return (
          <Fragment key={k}>
            <button type="button" className="mg-row app-prow" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : k)}>
              <span className="mg-row__title" style={{ whiteSpace: 'normal' }}>{c.company}</span>
              <span className="mg-row__amount mg-num">{money(c.outstanding)}</span>
              <span className="mg-row__meta" style={{ whiteSpace: 'normal' }}>{meta}</span>
              <span className="mg-row__state">{c.oldest_days > 0 ? <Tone tone="late">{c.oldest_days} d late</Tone> : <Tone>Not due yet</Tone>}</span>
            </button>
            {isOpen && (
              <div className="app-pinv">
                {c.stages.map((s) => (
                  <div key={s.id} className="app-pinv__item">
                    <span className="mg-num font-bold">{s.invoice_no}</span>
                    <span className="mg-num text-right font-bold">{money(s.outstanding, s.currency)}</span>
                    <span className="app-pinv__full text-[12.5px] font-semibold text-late">{overdueLine(s) || <span className="font-normal text-secondary-text">Due {shortDate(s.invoice_due_date)}</span>}</span>
                    <span className="app-pinv__full mt-1"><StageState s={s} said={said.get(s.id)} /></span>
                    <StageButtons s={s} said={said.get(s.id)} acts={acts} phone />
                  </div>
                ))}
              </div>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

function Loading() {
  return (
    <div aria-busy="true" aria-label="Loading collections" className="flex flex-col gap-[18px]">
      <div className="app-mrow">
        <section className="mg-glass mg-panel" style={{ flex: '1 1 400px', minHeight: 250 }}>
          <div className="mg-skel" style={{ height: 12, width: '34%' }} /><div className="mg-skel" style={{ height: 56, width: '70%' }} /><div className="mg-skel" style={{ height: 12, width: '60%' }} /><div className="mg-skel" style={{ height: 10, marginTop: 'auto' }} />
        </section>
        <section className="mg-glass mg-panel" style={{ flex: '1.35 1 520px', minHeight: 250, flexDirection: 'row', alignItems: 'flex-end', gap: 18 }}>
          {[150, 80, 60, 40, 70].map((h, i) => <div key={i} className="mg-skel" style={{ flex: 1, height: h }} />)}
        </section>
      </div>
      <section className="mg-glass mg-panel"><div className="mg-skel" style={{ height: 14, width: '24%' }} />{[0, 1, 2].map((i) => <div key={i} className="mg-skel" style={{ height: 44 }} />)}<div className="mg-skel" style={{ height: 44, width: '80%' }} /></section>
    </div>
  );
}

function ChaseDialog({ target, onClose, onSaved }) {
  const toast = useToast();
  const [v, setV] = useState({ channel: 'call', summary: '', promise_to_pay_date: '', next_action_on: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [fields, setFields] = useState({});
  const set = (k, val) => setV((s) => ({ ...s, [k]: val }));
  const s = target.stage;
  const label = s
    ? [s.invoice_no, s.company_name || s.client_name, s.outstanding != null ? `${money(s.outstanding, s.currency)} outstanding` : null].filter(Boolean).join(' · ')
    : [target.company.company, `${money(target.company.outstanding)} outstanding`].join(' · ');
  async function save(e) {
    e.preventDefault(); setBusy(true); setError(null); setFields({});
    try {
      await api.action('/collections/log', { ...v, stage_id: s?.id, company_id: s ? undefined : target.company.company_id });
      toast('Chase logged', 'success'); onSaved();
    } catch (err) { setFields(err.fields || {}); setError(err.message); setBusy(false); }
  }
  const fieldFailure = Object.keys(fields).length > 0;
  return (
    <Modal title="Log a chase" subtitle={label} onClose={onClose} footer={<>
      <Button type="button" variant="ghost" onClick={onClose} disabled={busy} className="max-sm:w-full">Cancel</Button>
      <Button type="submit" form="chase-form" disabled={busy || !v.summary.trim()} className="max-sm:w-full">{busy ? 'Saving…' : error && !fieldFailure ? 'Try again' : 'Log chase'}</Button>
    </>}>
      <form id="chase-form" onSubmit={save} className="flex flex-col gap-4">
        <DialogError error={error} what="the chase" />
        <div className="mg-grid2">
          <Field label="How" error={fields.channel}><Select value={v.channel} placeholder={null} options={CHANNELS} onChange={(e) => set('channel', e.target.value)} /></Field>
          <Field label="Next action on" error={fields.next_action_on}><Input type="date" value={v.next_action_on} onChange={(e) => set('next_action_on', e.target.value)} /></Field>
        </div>
        <Field label="Promised to pay by" hint="Pauses reminders until then." error={fields.promise_to_pay_date}><Input type="date" value={v.promise_to_pay_date} onChange={(e) => set('promise_to_pay_date', e.target.value)} /></Field>
        <Field label="What happened" required error={fields.summary}><Textarea rows={3} value={v.summary} onChange={(e) => set('summary', e.target.value)} autoFocus placeholder="Spoke to accounts; payment run is on the 25th" /></Field>
      </form>
    </Modal>
  );
}

function HoldDialog({ stage, onClose, onSaved }) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function save(e) {
    e.preventDefault(); setBusy(true); setError(null);
    try { await api.action(`/collections/stages/${stage.id}/hold`, { on_hold: true, hold_reason: reason || null }); toast('On hold', 'success'); onSaved(); }
    catch (err) { setError(err.fields ? Object.values(err.fields)[0] : err.message); setBusy(false); }
  }
  return (
    <Modal title="Put on hold" subtitle={`${stage.invoice_no} · ${stage.company_name || stage.client_name} · no reminders until the hold is lifted`} onClose={onClose} size="sm" footer={<>
      <Button type="button" variant="ghost" onClick={onClose} disabled={busy} className="max-sm:w-full">Cancel</Button>
      <Button type="submit" form="hold-form" disabled={busy} className="max-sm:w-full">{busy ? 'Saving…' : error ? 'Try again' : 'Put on hold'}</Button>
    </>}>
      <form id="hold-form" onSubmit={save} className="flex flex-col gap-4">
        <DialogError error={error} what="the hold" />
        <Field label="Why" hint="A dispute, a credit note in progress, a wrong invoice."><Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus /></Field>
      </form>
    </Modal>
  );
}

const MODE = { bank_transfer: 'Bank transfer', cheque: 'Cheque', upi: 'UPI', cash: 'Cash', other: 'Other' };

function LogDialog({ stage, onClose }) {
  const log = useFetch(() => api.raw(`/collections/log?stage_id=${stage.id}`), [stage.id]);
  const pays = useFetch(() => api.raw(`/collections/stages/${stage.id}/payments`), [stage.id]);
  const receipts = pays.data?.data ?? [];
  const entries = log.data?.data ?? [];
  const skel = <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading">{[0, 1].map((i) => <div key={i} className="mg-skel" style={{ height: 36 }} />)}</div>;
  const failed = (what, retry) => <MoneyBanner tone="late" role="alert" title={`Couldn't load the ${what}.`} action={<button type="button" className="mg-btn mg-btn--sm" onClick={retry}>Try again</button>} />;
  return (
    <Modal title={`${stage.invoice_no}: history`} subtitle={`${stage.company_name || stage.client_name} · PO ${stage.po_number} · Stage ${stage.stage_no}, ${stage.stage_name}`} onClose={onClose} size="lg" footer={<Button type="button" variant="ghost" onClick={onClose}>Close</Button>}>
      <div className="app-hist">
        <h3>Receipts</h3>
        {pays.loading && !pays.data ? skel : pays.error ? failed('receipts', pays.refetch) : receipts.length ? (
          <div className="mg-tablewrap">
            <table className="mg-table">
              <thead><tr><th>Received</th><th>How</th><th className="num">Amount</th></tr></thead>
              <tbody>{receipts.map((p) => (
                <tr key={p.id}>
                  <td className="mg-num">{shortDate(p.received_on)}</td>
                  <td>{MODE[p.mode] || p.mode}{p.reference && <span className="app-sub2">{p.reference}</span>}</td>
                  <td className="num font-bold">{money(p.amount, stage.currency)}<span className="app-sub2">{Number(p.tds_amount) > 0 ? `+ TDS ${money(p.tds_amount, stage.currency)}` : 'no TDS'}</span></td>
                </tr>
              ))}</tbody>
              <tfoot><tr><td colSpan={2}>Received so far</td><td className="num">{money(stage.amount_received, stage.currency)} of {money(stage.stage_amount, stage.currency)}</td></tr></tfoot>
            </table>
          </div>
        ) : <p className="m-0 text-[13px] text-muted-foreground">Nothing received yet.</p>}
      </div>
      <div className="app-hist">
        <h3>Chasing log</h3>
        {log.loading && !log.data ? skel : log.error ? failed('chasing log', log.refetch) : entries.length ? (
          <ol className="mg-timeline">
            {entries.map((l) => (
              <li key={l.id}>
                <span className={cn('mg-timeline__dot', l.channel === 'note' ? '' : l.channel === 'email' ? 'mg-timeline__dot--wait' : 'mg-timeline__dot--ok')} aria-hidden="true" />
                <span className="min-w-0">
                  <span className="mg-timeline__what block">{channelWord(l.channel)}{l.by_whom ? ` · ${l.by_whom}` : ''}</span>
                  <span className="mg-timeline__meta block">{l.summary}{l.promise_to_pay_date ? ` Promised to pay by ${shortDate(l.promise_to_pay_date)}.` : ''}</span>
                </span>
                <span className="mg-timeline__when">{new Date(l.happened_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
              </li>
            ))}
          </ol>
        ) : <p className="m-0 text-[13px] text-muted-foreground">Nothing logged yet.</p>}
      </div>
    </Modal>
  );
}
