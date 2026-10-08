import { Link } from 'react-router-dom';
import {
  AlertTriangle, ArrowRight, Bell, Briefcase, CreditCard, FileText, MessageSquare, Plane, Receipt,
} from 'lucide-react';
import { PageHeader } from '../App.jsx';
import { useShell } from '../components/shell/Shell.jsx';
import { DailyMisNotice, MyDailyMis, useMyDailyMis } from '../components/MyDailyMis.jsx';
import { FailedCard, StateCard, plural, useEntrance } from '../components/daily.jsx';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/hooks.js';
import { money, today } from '../lib/format.js';

/**
 * Today: one next action, then a short list.
 *
 * The Glass 2 home: the money collected so far as the hero, the one
 * promoted action (the money owed longest) beside it, then the queue in the
 * order somebody should work it, the diary and the "How do I…" prompts.
 * **One primary action exists on the page** (Chase), and the figures are
 * reference only. HR never sees this page; it is redirected.
 */

const TZ = 'Asia/Kolkata';
const dayOf = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(iso));

/** "Tuesday, 22 September": the date heads the page, because the page is a day. */
function todayLabel() {
  const d = new Date();
  return `${d.toLocaleDateString('en-GB', { weekday: 'long' })}, ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}`;
}
function partOfDay() {
  const h = new Date().getHours();
  return h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
}
/** Monday to Sunday of this week, as YYYY-MM-DD. */
function thisWeek() {
  const t = new Date(`${today()}T00:00:00Z`);
  const monday = new Date(t); monday.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7));
  return Array.from({ length: 7 }, (_, i) => { const d = new Date(monday); d.setUTCDate(monday.getUTCDate() + i); return d.toISOString().slice(0, 10); });
}

const sum = (rows, key) => rows.reduce((total, row) => total + Number(row[key] || 0), 0);
/** Amounts in each currency, never added across currencies: [['INR', 318600], ['USD', 4200]]. */
function byCurrency(rows, key) {
  const m = new Map();
  rows.forEach((r) => m.set(r.currency || 'INR', (m.get(r.currency || 'INR') || 0) + Number(r[key] || 0)));
  return [...m.entries()].sort((a, b) => (a[0] === 'INR' ? -1 : b[0] === 'INR' ? 1 : 0));
}
const TONE = {
  wait: 'bg-wait-soft text-wait',
  late: 'bg-late-soft text-late',
  info: 'bg-info-soft text-info',
  plain: 'bg-track text-secondary-text',
};

/**
 * The queue, in the order somebody should work it. Each bucket of the
 * worklist becomes a sentence, and each button goes to exactly what it
 * counts. Sales don't get the org-wide bills and claims rows.
 */
function queues(w, unread, portal, isAdmin) {
  if (!w) return [];
  const stages = w.payment_stages || [];
  const partly = stages.filter((s) => s.stage_status === 'Partially Paid');
  const bills = w.vendor_invoices || [];
  const noAmount = bills.filter((b) => /enter amount/i.test(b.payment_status || ''));
  const toPay = bills.filter((b) => b.invoice_amount != null && /overdue|to pay|partially/i.test(b.payment_status || ''));
  const claims = w.expense_claims || [];
  const toDecide = claims.filter((c) => c.status === 'Pending approval');
  const unregistered = w.won_without_project || [];
  const late = w.late_deliveries || [];
  const advices = portal.filter((a) => a.kind === 'payment_advice');
  const asks = portal.filter((a) => a.kind === 'query');

  return [
    unregistered.length && {
      key: 'unregistered', icon: Briefcase, tone: 'wait', to: '/worklist?tab=sales', action: 'Register project',
      lead: `${plural(unregistered.length, 'won deal has', 'won deals have')} no project, so ${unregistered.length === 1 ? 'it can’t' : 'none of them can'} be invoiced.`,
      detail: <><span className="mg-num">{money(sum(unregistered, 'quotation_value'), 'INR', { compact: true })}</span> of signed work is sitting outside delivery.</>,
    },
    (advices.length || asks.length) && {
      key: 'portal', icon: MessageSquare, tone: 'wait', to: '/collections', action: 'Open',
      lead: `Client portal: ${[advices.length && plural(advices.length, 'payment advice') + ' to match', asks.length && `${plural(asks.length, 'query', 'queries')} to answer`].filter(Boolean).join(', ')}.`,
      detail: advices[0]
        ? <>{advices[0].company_name} reported <span className="mg-num">{money(advices[0].amount, advices[0].invoices?.[0]?.currency || 'INR')}</span> paid.</>
        : `${asks[0].company_name} asked about an invoice.`,
    },
    partly.length && {
      key: 'partly', icon: CreditCard, tone: 'wait', to: '/worklist?tab=stages', action: 'Open',
      lead: `${plural(partly.length, 'invoice is', 'invoices are')} partly paid.`,
      detail: 'Record the rest when it lands; they wait on the Action list.',
    },
    isAdmin && noAmount.length && {
      key: 'bills', icon: Plane, tone: 'plain', to: '/vendor-invoices', action: 'Fill in',
      lead: `${plural(noAmount.length, 'travel bill has', 'travel bills have')} a reference but no amount.`,
      detail: 'It can’t be paid until a figure is entered.',
    },
    isAdmin && toPay.length && {
      key: 'to-pay', icon: Receipt, tone: toPay.some((b) => b.payment_status === 'Overdue') ? 'late' : 'plain', to: '/worklist?tab=vendors', action: 'Pay',
      lead: `${plural(toPay.length, 'travel bill', 'travel bills')} to pay.`,
      detail: <><span className="mg-num">{money(sum(toPay, 'invoice_amount') - sum(toPay, 'amount_paid'), 'INR', { compact: true })}</span> still owed to travel vendors{toPay.some((b) => b.payment_status === 'Overdue') ? ', some of it overdue' : ''}.</>,
    },
    isAdmin && claims.length && {
      key: 'claims', icon: FileText, tone: 'plain', to: '/expense-claims', action: 'Review',
      lead: `${plural(claims.length, 'expense claim is', 'expense claims are')} waiting on you: ${[toDecide.length && `${toDecide.length} to decide`, claims.length - toDecide.length && `${claims.length - toDecide.length} to reimburse`].filter(Boolean).join(', ')}.`,
      detail: <><span className="mg-num">{money(sum(claims, 'amount_claimed'), 'INR', { compact: true })}</span> across {plural(new Set(claims.map((c) => c.employee_name)).size, 'person', 'people')}.</>,
    },
    late.length && {
      key: 'late', icon: AlertTriangle, tone: 'plain', to: '/worklist?tab=delivery', action: 'Open',
      lead: `${plural(late.length, 'project is', 'projects are')} past the delivery date.`,
      detail: (() => { const n = Math.max(...late.map((p) => Number(p.days_late || 0))); return `${late.length === 1 ? 'Late' : 'The latest'} by ${plural(n, 'day')}.`; })(),
    },
    // The bell, folded in: a notification nobody opens a page to read is one nobody reads.
    unread > 0 && {
      key: 'unread', icon: Bell, tone: 'plain', to: '/notifications', action: 'Read them',
      lead: `${plural(unread, 'alert')} you haven’t seen.`,
      detail: 'Expiring quotations, overdue stages and anything a rule raised.',
    },
  ].filter(Boolean);
}

/** The one thing promoted above everything else: money owed longest. */
function StartHere({ overdue }) {
  const totals = byCurrency(overdue, 'due_now_amount');
  const oldest = Math.max(...overdue.map((s) => Number(s.days_overdue || 0)));
  const named = [...overdue].sort((a, b) => Number(b.days_overdue || 0) - Number(a.days_overdue || 0)).slice(0, 3);
  const [main, ...rest] = totals;
  return (
    <section className="mg-glass mg-tile" data-a="rise" aria-labelledby="start-t" style={{ borderColor: 'var(--late)' }}>
      <div className="flex items-center gap-2.5">
        <span className={`app-sq app-sq--sm ${TONE.late}`}><AlertTriangle aria-hidden="true" /></span>
        <span className="mg-label text-late">Start here</span>
        <span className="ml-auto text-right text-[11.5px] text-muted-foreground">Oldest first</span>
      </div>
      <h2 id="start-t" className="mg-panel__title">{overdue.length === 1 ? 'One invoice is overdue' : `${overdue.length} invoices are overdue`}</h2>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span key={main[1]} className="mg-tile__figure mg-num">{money(main[1], main[0])}</span>
        {rest.map(([cur, amount]) => <span key={cur} className="mg-num text-[14px] font-bold text-secondary-text">+ {money(amount, cur)}</span>)}
      </div>
      <span className="mg-tile__foot">Sitting with clients, the oldest for {plural(oldest, 'day')}.</span>
      <div className="app-dots" aria-hidden="true">{Array.from({ length: 15 }, (_, i) => <span key={i} className={i < Math.min(15, oldest) ? 'is-on' : ''} />)}</div>
      <div className="flex flex-wrap gap-1.5">
        {named.map((stage) => (
          <Link key={stage.id} to={`/collections?stage=${stage.id}`} className="mg-chip h-[30px] no-underline" aria-label={`${stage.client_name}: ${money(stage.due_now_amount, stage.currency)}, ${plural(Number(stage.days_overdue), 'day')} overdue. Open in Collections`}>
            {stage.client_name} · {money(stage.due_now_amount, stage.currency, { compact: true })} · {stage.days_overdue}d
          </Link>
        ))}
        {overdue.length > named.length && <Link to="/collections" className="mg-chip h-[30px] no-underline">+{overdue.length - named.length} more</Link>}
      </div>
      {/* The one primary action on the page. */}
      <Link to="/collections" className="mg-btn mg-btn--primary mt-auto">
        {overdue.length === 1 ? 'Chase it' : `Chase all ${overdue.length}`}
        <ArrowRight className="size-4" strokeWidth={2.2} aria-hidden="true" />
      </Link>
      <span className="text-[12px] text-muted-foreground">Opens Collections one client at a time, with the history beside it. You decide what to send.</span>
    </section>
  );
}

/** The queue's first row, kept as its own tile: invoices ready to raise. */
function ReadyToInvoice({ stages }) {
  const totals = byCurrency(stages, 'stage_amount');
  const [main, ...rest] = totals;
  const bars = [...stages].sort((a, b) => Number(a.stage_amount) - Number(b.stage_amount)).slice(-7);
  const top = Math.max(...bars.map((s) => Number(s.stage_amount || 0)), 1);
  return (
    <section className="mg-glass mg-tile" data-a="rise" aria-labelledby="ready-t">
      <div className="flex items-center gap-2.5">
        <span className={`app-sq app-sq--sm ${TONE.wait}`}><CreditCard aria-hidden="true" /></span>
        <h2 id="ready-t" className="mg-panel__title text-[13.5px]">Ready to invoice</h2>
      </div>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span key={main[1]} className="mg-tile__figure mg-num">{money(main[1], main[0])}</span>
        {rest.map(([cur, amount]) => <span key={cur} className="mg-num text-[14px] font-bold text-secondary-text">+ {money(amount, cur)}</span>)}
      </div>
      <span className="mg-tile__foot"><b className="text-foreground">{plural(stages.length, 'invoice is', 'invoices are')} ready to raise.</b> Every trigger has happened; nothing else is in the way.</span>
      <div className="app-bars" role="img" aria-label={`${plural(stages.length, 'stage')} ready to raise, by value`}>
        {bars.map((s) => <span key={s.id} className="is-ready" data-a="grow" style={{ height: `${Math.max(18, (Number(s.stage_amount || 0) / top) * 100)}%` }} />)}
      </div>
      <div className="mt-auto flex flex-wrap items-center justify-between gap-2">
        <span className="mg-legend"><span><i style={{ background: 'var(--caramel)' }} />Ready, by value</span></span>
        <Link to="/money/invoice-run" className="mg-btn mg-btn--sm">Raise them</Link>
      </div>
    </section>
  );
}

/** Collected so far (was the rail card). Reference, never a task. */
function Hero({ finance, sales, travel }) {
  const invoiced = Number(finance.invoiced || 0);
  const received = Number(finance.received || 0);
  const out = Number(finance.outstanding || 0);
  const done = invoiced ? Math.min(100, (received / invoiced) * 100) : 0;
  const expected = invoiced ? Math.min(100 - done, (out / invoiced) * 100) : 0;
  return (
    <section className="mg-hero flex flex-col gap-3.5" data-a="rise" aria-labelledby="hero-t" style={{ minWidth: 0, padding: '26px 28px' }}>
      <h2 id="hero-t" className="mg-hero__label relative m-0">Collected so far</h2>
      <div className="relative flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span key={received} className="mg-hero__figure mg-num m-0" data-count={Math.round(received)} data-format="inr">{money(received)}</span>
        <span className="mg-hero__sub">of {money(invoiced)} invoiced</span>
      </div>
      <div className="mg-progress relative" role="img" aria-label={`${Math.round(done)}% collected, ${money(out)} still out`}>
        <span className="mg-progress__done relative overflow-hidden" style={{ width: `${done}%` }}><span className="mg-shimmer" /></span>
        <span className="mg-progress__expected" style={{ width: `${expected}%` }} />
      </div>
      <span className="mg-hero__sub relative -mt-1">
        {Math.round(done)}% collected
        {out > 0 && <> · <b style={{ color: 'var(--on-hero)' }}>{money(out)} still out</b>{Number(finance.overdue_amount) > 0 && <>, {money(finance.overdue_amount)} of it overdue</>}</>}
      </span>
      <div className="relative flex flex-wrap gap-2.5">
        {[
          ['Won', sales.won_value_inr],
          ['Open pipeline', Number(sales.value_inr) - Number(sales.won_value_inr)],
          ['Travel cost', travel.total_cost],
        ].map(([label, value]) => (
          <div key={label} className="app-hero__fact"><b>{money(value, 'INR', { compact: true })}</b><span>{label}</span></div>
        ))}
      </div>
      <div className="relative mt-auto flex flex-wrap gap-2.5 pt-0.5">
        <Link to="/insights" className="mg-btn" style={{ background: 'var(--latte)', color: 'var(--on-caramel)', borderColor: 'transparent' }}>
          See all insights<ArrowRight className="size-4" aria-hidden="true" />
        </Link>
        <Link to="/worklist" className="mg-btn mg-btn--ghost" style={{ color: 'var(--on-hero)', borderColor: 'var(--hero-hi)' }}>Open the Action list</Link>
      </div>
    </section>
  );
}

function Queue({ list }) {
  return (
    <section className="mg-glass mg-panel" data-a="rise" aria-labelledby="queue-t" style={{ flex: '2 1 520px', minWidth: 0, gap: 2, padding: '20px 20px 12px' }}>
      <div className="mg-panel__head" style={{ padding: '0 4px 10px' }}>
        <h2 id="queue-t" className="mg-panel__title">Then, in order</h2>
        <span className="mg-badge mg-badge--plain">{list.length}</span>
        <Link to="/worklist" className="mg-btn mg-btn--ghost mg-btn--sm">Action list<ArrowRight className="size-4" aria-hidden="true" /></Link>
      </div>
      {list.map((q) => (
        <div key={q.key} className="app-queue__item">
          <span className={`app-sq ${TONE[q.tone]}`}><q.icon strokeWidth={1.9} aria-hidden="true" /></span>
          <div className="app-queue__text"><span className="app-queue__lead">{q.lead}</span><span className="app-queue__detail">{q.detail}</span></div>
          <Link to={q.to} className="mg-btn mg-btn--sm" aria-label={`${q.action}: ${typeof q.lead === 'string' ? q.lead : ''}`}>{q.action}</Link>
        </div>
      ))}
    </section>
  );
}

const time = (iso) => new Date(iso).toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });

/** Time, what, who, and whether it is confirmed. Each row opens the visit. */
function Diary({ visits, week, loading }) {
  const days = thisWeek();
  const t = today();
  const busy = new Set();
  (week || []).forEach((v) => days.forEach((d) => { if (dayOf(v.starts_at) <= d && dayOf(v.ends_at) >= d) busy.add(d); }));
  const busyNames = days.filter((d) => busy.has(d)).map((d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' }));
  return (
    <section className="mg-glass mg-panel" data-a="rise" aria-labelledby="diary-t" style={{ gap: 12, padding: '20px 20px 12px' }}>
      <div className="mg-panel__head" style={{ padding: '0 4px' }}>
        <h2 id="diary-t" className="mg-panel__title">In the diary today</h2>
        <Link to="/schedule" className="mg-btn mg-btn--ghost mg-btn--sm">Schedule<ArrowRight className="size-4" aria-hidden="true" /></Link>
      </div>
      <div className="app-week" role="img" aria-label={busyNames.length ? `This week: visits on ${busyNames.join(', ')}` : 'This week: no visits planned'}>
        {days.map((d) => {
          const dt = new Date(`${d}T00:00:00Z`);
          return (
            <span key={d} className={`app-week__day ${d === t ? 'is-today' : ''} ${busy.has(d) ? 'has-visits' : ''}`}>
              <small>{dt.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' })}</small>
              <b>{dt.getUTCDate()}</b>
              <i />
            </span>
          );
        })}
      </div>
      <div className="flex flex-col">
        {loading && <div className="mg-skel" style={{ height: 44 }} />}
        {!loading && !visits.length && (
          <p className="m-0 border-t border-line px-1.5 py-3 text-[13px] text-muted-foreground">Nothing in the diary today. Plan a visit from the Schedule.</p>
        )}
        {visits.map((v) => {
          const who = (v.assignees || []).map((a) => `${a.name}${a.role === 'lead' ? ' (lead)' : ''}`).join(', ');
          const status = v.status === 'confirmed' ? 'Confirmed' : 'Planned';
          return (
            <Link key={v.id} to={`/schedule?visit=${v.id}`} className="app-diary__row" aria-label={`${v.all_day ? 'All day' : time(v.starts_at)}: ${v.title}${v.client_name ? `, ${v.client_name}` : ''}. ${status}. Open the visit`}>
              <span className="app-diary__time">{v.all_day ? 'All day' : time(v.starts_at)}</span>
              <span className="app-diary__what">
                <span>{v.title}{v.client_name && <> · <b>{v.client_name}</b></>}{v.city && `, ${v.city}`}</span>
                <small>{who || 'Nobody assigned yet'}</small>
              </span>
              <span className={`mg-badge ${v.status === 'confirmed' ? 'mg-badge--ok' : 'mg-badge--info'}`}>{status}</span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

/** The three prompts, each opening its step. */
function HowDoI({ openPalette }) {
  return (
    <section className="mg-glass mg-panel" data-a="rise" aria-labelledby="how-t" style={{ gap: 10, padding: '18px 20px' }}>
      <h2 id="how-t" className="mg-label m-0 text-caramel-text">How do I…</h2>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="mg-btn mg-btn--sm" onClick={() => openPalette?.({ step: 'raise-invoice' })}>…raise an invoice for a stage?</button>
        <Link to="/worklist?tab=sales" className="mg-btn mg-btn--sm">…register a won deal as a project?</Link>
        <button type="button" className="mg-btn mg-btn--sm" onClick={() => openPalette?.({ step: 'record-payment' })}>…record a payment that came in?</button>
      </div>
      <span className="text-[12px] text-muted-foreground">Each opens that step with its form ready to fill.</span>
    </section>
  );
}

export default function Today() {
  const shell = useShell();
  const { data, loading, error, refetch } = useFetch(() => api.raw('/dashboard/overview'));
  const work = useFetch(() => api.raw('/dashboard/worklist'));
  const portalActs = useFetch(() => api.raw('/portal-admin/actions?status=open').catch(() => ({ data: [] })));
  const diary = useFetch(() => api.raw('/visits/today'));
  const days = thisWeek();
  const week = useFetch(() => api.raw(`/visits?from=${days[0]}&to=${days[6]}`).catch(() => ({ data: [] })));
  const bell = useFetch(() => api.raw('/notifications/summary'));
  const mine = useMyDailyMis();

  const d = data?.data;
  const w = work.data?.data;
  const stages = w?.payment_stages || [];
  const overdue = stages.filter((s) => s.stage_status === 'Overdue');
  const toInvoice = stages.filter((s) => s.stage_status === 'To Invoice');
  const list = queues(w, bell.data?.data?.unread ?? 0, portalActs.data?.data || [], shell.isAdmin);
  const waiting = (overdue.length ? 1 : 0) + (toInvoice.length ? 1 : 0) + list.length;
  const busy = loading || (work.loading && !w);
  const ref = useEntrance(!busy);
  const first = (shell.who || '').split(/\s+/)[0];

  const title = (
    <>
      <span className="mg-eyebrow mb-2 block font-sans tracking-[.12em]">{todayLabel()}</span>
      Good <em>{partOfDay()}<svg viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true"><path d="M1 5 C 30 1, 70 8, 99 3" /></svg></em>{first ? `, ${first}` : ''}
    </>
  );
  const subtitle = busy ? 'Working out what needs a person…'
    : work.error ? 'Part of today didn’t load, so this isn’t the whole list.'
      : waiting === 0 ? 'Nothing is waiting on anybody. Everything raised is either paid or not yet due.'
        : `${plural(waiting, 'thing needs', 'things need')} a person today. Work down the list; it empties as you go.`;

  return (
    <>
      <PageHeader eyebrow="" titleClassName="mg-greeting" title={title} subtitle={subtitle} />
      <div className="app-page" ref={ref}>
        <DailyMisNotice mine={mine} />

        {busy ? (
          <div aria-busy="true" aria-label="Loading today" className="app-today__row">
            <section className="mg-glass mg-panel" style={{ flex: '2 1 520px', minHeight: 300 }}>
              <div className="mg-skel" style={{ height: 12, width: '32%' }} /><div className="mg-skel" style={{ height: 56, width: '56%' }} /><div className="mg-skel" style={{ height: 10 }} /><div className="mg-skel" style={{ height: 60 }} />
            </section>
            <section className="mg-glass mg-panel" style={{ flex: '2 1 520px' }}>
              <div className="mg-skel" style={{ height: 14, width: '30%' }} />{[0, 1, 2].map((i) => <div key={i} className="mg-skel" style={{ height: 44 }} />)}<div className="mg-skel" style={{ height: 44, width: '80%' }} />
            </section>
          </div>
        ) : (
          <>
            <div className="app-today__row app-today__row--top">
              {error ? (
                <div style={{ flex: '2 1 520px', minWidth: 0 }}>
                  <FailedCard title="Couldn’t load today’s figures" text="The server didn’t answer, so the money collected can’t be shown yet. Nothing has been lost." onRetry={refetch} />
                </div>
              ) : d && <Hero finance={d.finance} sales={d.sales} travel={d.travel} />}
              {overdue.length > 0 && <StartHere overdue={overdue} />}
              {toInvoice.length > 0 && <ReadyToInvoice stages={toInvoice} />}
              {!work.error && waiting === 0 && (
                <div style={{ flex: '1 1 300px', minWidth: 0 }}>
                  <StateCard dashed title="Nothing is waiting" text="Anything raised is either paid or not yet due. New work shows up here as soon as it needs a person." />
                </div>
              )}
            </div>

            <div className="app-today__row items-start">
              {work.error ? (
                <div style={{ flex: '2 1 520px', minWidth: 0 }}>
                  <FailedCard title="The rest of the queue didn’t load" text="This isn’t an all-clear: deals, bills and alerts may still be waiting. Try again, or open the Action list." onRetry={work.refetch}>
                    <Link to="/worklist" className="mg-btn mg-btn--sm mg-btn--ghost">Open the Action list</Link>
                  </FailedCard>
                </div>
              ) : list.length > 0 && <Queue list={list} />}
              <div className="app-today__col">
                <Diary visits={diary.data?.data || []} week={week.data?.data} loading={diary.loading && !diary.data} />
                <HowDoI openPalette={shell.openPalette} />
              </div>
            </div>
          </>
        )}

        <MyDailyMis mine={mine} />
      </div>
    </>
  );
}

