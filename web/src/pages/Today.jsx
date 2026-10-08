import { Link } from 'react-router-dom';
import { ArrowRight, CheckCircle2, Plus } from 'lucide-react';
import { PageHeader } from '../App.jsx';
import { Chip } from '../components/record.jsx';
import { Button } from '../components/ui/button';
import { ErrorState } from '../components/ui.jsx';
import { useAuth } from '../lib/auth.jsx';
import { DailyMisNotice, MyDailyMis, useMyDailyMis } from '../components/MyDailyMis.jsx';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/hooks.js';
import { money } from '../lib/format.js';

/**
 * Today — one next action, then a short list.
 *
 * This replaces the dashboard, the action list and the notifications page.
 * The dashboard gave five cards equal weight, which is five decisions at
 * once and therefore no decision at all. Here one thing is promoted — the
 * money that has been owed longest — and everything else is a 36px row
 * with a secondary button.
 *
 * Two rules the design is firm about, and they are what keep it honest as
 * things get added: **one primary action exists on the page**, and **the
 * right column is reference only and never contains a task**.
 */

const CARD = 'rounded-lg border border-border bg-card';

/**
 * The shape of the day, before the day is known.
 *
 * Deliberately the same geometry as what replaces it — one wide card for
 * "Start here", then a run of 44px queue rows — so the page settles rather
 * than rearranges when the data lands.
 */
function TodaySkeleton() {
  return (
    <div className="flex min-w-0 flex-col gap-6" aria-hidden="true">
      <div className={`${CARD} p-5`}>
        <div className="skeleton h-3 w-24 rounded" />
        <div className="skeleton mt-3 h-6 w-2/3 rounded" />
        <div className="skeleton mt-3 h-9 w-40 rounded" />
      </div>
      <section className="flex min-w-0 flex-col gap-3">
        <div className="skeleton h-3 w-28 rounded" />
        <div className={`${CARD} overflow-hidden`}>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex h-11 items-center gap-3 border-b border-border px-5 last:border-b-0">
              <div className="skeleton size-4 shrink-0 rounded-full" />
              <div className="skeleton h-3 flex-1 rounded" />
              <div className="skeleton h-3 w-20 shrink-0 rounded" />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
const EYEBROW = 'text-[11px] font-bold uppercase tracking-[0.12em] text-muted-foreground';
const SECTION = 'font-display text-base font-bold text-foreground';

/** "Tuesday 7 October", the eyebrow over the greeting. */
function todayLabel() {
  const d = new Date();
  return `${d.toLocaleDateString('en-GB', { weekday: 'long' })} ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}`;
}

/** "Good afternoon, Shyam": the first name only, and nothing when there is none. */
function greeting(name) {
  const hour = new Date().getHours();
  const part = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const first = String(name || '').trim().split(/\s+/)[0];
  return first && !first.includes('@') ? `${part}, ${first}` : part;
}

/**
 * The queues, in the order somebody should work them.
 *
 * Each one turns a bucket of the worklist into a sentence. Saying "five
 * invoices are ready to raise" rather than showing a tile marked 5 is the
 * difference between a number and a thing to do.
 */
function queues(w, unread) {
  if (!w) return [];
  const stages = w.payment_stages || [];
  const toInvoice = stages.filter((s) => s.stage_status === 'To Invoice');
  const bills = (w.vendor_invoices || []);
  const noAmount = bills.filter((b) => /enter amount/i.test(b.payment_status || ''));
  const claims = w.expense_claims || [];
  const unregistered = w.won_without_project || [];
  const late = w.late_deliveries || [];

  const sum = (rows, key) => rows.reduce((total, row) => total + Number(row[key] || 0), 0);
  const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  return [
    toInvoice.length && {
      key: 'to-invoice', chip: 'Ready to invoice', tone: 'waiting', to: '/payment-stages', action: 'Raise them',
      lead: <><strong className="font-semibold">{count(toInvoice.length, 'invoice is', 'invoices are')} ready to raise</strong> — <span className="num">{money(sum(toInvoice, 'stage_amount'), 'INR', { compact: true })}</span>.</>,
      detail: 'Every trigger has happened; nothing else is in the way.',
    },
    unregistered.length && {
      key: 'unregistered', chip: 'Won, not registered', tone: 'info', to: '/quotations?status=Won+-+PO+Received', action: 'Register',
      lead: <><strong className="font-semibold">{count(unregistered.length, 'won deal has', 'won deals have')} no project</strong>, so none of them can be invoiced.</>,
      detail: <><span className="num">{money(sum(unregistered, 'quotation_value'), 'INR', { compact: true })}</span> of signed work sitting outside delivery.</>,
    },
    noAmount.length && {
      key: 'bills', chip: 'Amount missing', tone: 'waiting', to: '/vendor-invoices', action: 'Fill in',
      lead: <><strong className="font-semibold">{count(noAmount.length, 'travel bill has', 'travel bills have')} a reference but no amount.</strong></>,
      detail: 'They cannot be paid until a figure is entered.',
    },
    claims.length && {
      key: 'claims', chip: 'Approval', tone: 'info', to: '/expense-claims', action: 'Review',
      lead: <><strong className="font-semibold">{count(claims.length, 'expense claim needs', 'expense claims need')} a decision</strong> — <span className="num">{money(sum(claims, 'amount_claimed'), 'INR', { compact: true })}</span>.</>,
      detail: `Across ${new Set(claims.map((c) => c.employee_name)).size} people.`,
    },
    late.length && {
      key: 'late', chip: 'Late delivery', tone: 'late', to: '/projects', action: 'Open',
      lead: <><strong className="font-semibold">{count(late.length, 'project is', 'projects are')} past the delivery date.</strong></>,
      detail: `The latest by ${Math.max(...late.map((p) => Number(p.days_late || 0)))} days.`,
    },
    // The bell, folded in. A notification nobody opens a page to read is a
    // notification nobody reads, so it queues here with everything else.
    unread > 0 && {
      key: 'unread', chip: 'Alerts', tone: 'info', to: '/notifications', action: 'Read them',
      lead: <><strong className="font-semibold">{count(unread, 'alert', 'alerts')} you have not seen.</strong></>,
      detail: 'Expiring quotations, overdue stages and anything a rule raised.',
    },
  ].filter(Boolean);
}

/** The one thing promoted above everything else: money owed longest. */
function StartHere({ overdue }) {
  const total = overdue.reduce((sum, s) => sum + Number(s.due_now_amount || 0), 0);
  const oldest = Math.max(...overdue.map((s) => Number(s.days_overdue || 0)));
  const named = [...overdue]
    .sort((a, b) => Number(b.days_overdue || 0) - Number(a.days_overdue || 0))
    .slice(0, 3);

  return (
    <article className={`${CARD} overflow-hidden border-l-4 border-l-late shadow-sm`}>
      <div className="flex flex-wrap items-center gap-3 px-6 pt-5">
        <Chip tone="late">! {oldest} {oldest === 1 ? 'day' : 'days'} overdue</Chip>
        <span className="text-[12.5px] text-muted-foreground">Start here: the money owed longest comes first</span>
      </div>
      <div className="px-6 pt-3">
        <h2 className="max-w-[62ch] font-display text-xl/[1.35] font-bold text-foreground">
          {overdue.length === 1 ? 'One invoice is overdue' : `${overdue.length} invoices are overdue`}, and <span className="num">{money(total)}</span> is sitting with clients.
        </h2>
        <div className="mt-3 flex flex-wrap gap-2">
          {named.map((stage) => (
            <span key={stage.id} className="inline-flex h-7 items-center gap-2 rounded-sm border border-border bg-secondary px-2.5 text-[12.5px] text-secondary-text">
              <span className="text-foreground">{stage.client_name}</span>
              <span className="num">{money(stage.due_now_amount, stage.currency, { compact: true })} · {stage.days_overdue}d</span>
            </span>
          ))}
          {overdue.length > named.length && (
            <span className="inline-flex h-7 items-center rounded-sm border border-border bg-secondary px-2.5 text-[12.5px] text-secondary-text">
              +{overdue.length - named.length} more
            </span>
          )}
        </div>
      </div>
      <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-border bg-secondary/50 px-6 py-4">
        {/* The one primary action on the page. */}
        <Button asChild size="sm">
          <Link to="/collections">
            {overdue.length === 1 ? 'Chase it' : `Chase all ${overdue.length}`}
            <ArrowRight strokeWidth={2.2} aria-hidden="true" />
          </Link>
        </Button>
        <span className="text-[12.5px] text-secondary-text">
          Opens one client at a time with the history beside it. You decide what to send.
        </span>
      </div>
    </article>
  );
}

/** A row of the queue: the state as a chip, the sentence, and its one move. */
function Queue({ item }) {
  return (
    <div className="flex flex-col gap-3 border-b border-border px-5 py-3.5 last:border-b-0 hover:bg-secondary/60 sm:flex-row sm:items-center sm:gap-4">
      <Chip tone={item.tone} className="w-fit shrink-0 sm:min-w-[136px] sm:justify-center">{item.chip}</Chip>
      <div className="min-w-0 flex-1">
        <div className="text-[14px]/[1.45] text-foreground">{item.lead}</div>
        <div className="mt-0.5 text-[12.5px] text-muted-foreground">{item.detail}</div>
      </div>
      <Button asChild variant="outline" size="sm" className="w-fit shrink-0">
        <Link to={item.to}>{item.action}</Link>
      </Button>
    </div>
  );
}

/**
 * From quote to cash, as four steps a person can open.
 *
 * The same journey the process rail shows on one deal, summed over all of
 * them. Each bar is its step's share of what was quoted, so the drop from
 * one step to the next is the thing the eye lands on. The figures are the
 * overview's own (rupee records), and each opens the list behind it.
 */
function QuoteToCash({ finance, sales }) {
  const quoted = Number(sales.value_inr) || 0;
  const won = Number(sales.won_value_inr) || 0;
  const invoiced = Number(finance.invoiced) || 0;
  const received = Number(finance.received) || 0;
  const share = (value) => (quoted ? Math.max(2, Math.min(100, Math.round((value / quoted) * 100))) : 0);
  const decided = Number(sales.won) + Number(sales.lost);
  const steps = [
    { step: 'Quoted', value: quoted, note: `${sales.quotations} quotations`, to: '/quotations', tone: 'bg-info' },
    { step: 'Won', value: won, note: decided ? `${sales.won} deals · ${Math.round((Number(sales.won) / decided) * 100)}% of decided` : `${sales.won} deals`, to: '/quotations?status=Won+-+PO+Received', tone: 'bg-settled' },
    { step: 'Invoiced', value: invoiced, note: `${money(finance.to_invoice_amount, 'INR', { compact: true })} ready to raise`, to: '/payment-stages', tone: 'bg-settled' },
    { step: 'Received', value: received, note: `${money(Math.max(0, invoiced - received), 'INR', { compact: true })} still due`, to: '/collections', tone: 'bg-settled' },
  ];
  return (
    <section aria-label="From quote to cash" className={`${CARD} p-5`}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className={SECTION}>From quote to cash</h2>
        <span className="hidden text-[12.5px] text-muted-foreground sm:inline">All records in rupees</span>
        <Link to="/insights" className="ml-auto text-[13px] font-semibold text-primary hover:underline">Open insights</Link>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
        {steps.map((s) => (
          <Link key={s.step} to={s.to} className="group flex flex-col gap-1 rounded-md border border-border p-3 no-underline transition-colors duration-150 hover:border-primary/40 hover:bg-secondary/60">
            <span className={EYEBROW}>{s.step}</span>
            <span className="num font-display text-xl font-bold text-foreground sm:text-2xl">{money(s.value, 'INR', { compact: true })}</span>
            <span className="text-[12px] text-muted-foreground">{s.note}</span>
            <span className="mt-2 h-1.5 overflow-hidden rounded-full bg-secondary">
              <span className={`block h-full rounded-full ${s.tone}`} style={{ width: `${share(s.value)}%` }} />
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}

/** Time, what, who, and whether it is confirmed. Reference, not a task. */
function Diary({ visits }) {
  return (
    <div className={`${CARD} p-5`}>
      <h3 className={SECTION}>In the diary today</h3>
      {visits.length === 0 ? (
        <p className="mt-2 text-[12.5px] text-muted-foreground">No visits or audits today. Planned ones show here on the day.</p>
      ) : (
        <div className="mt-3 flex flex-col">
          {visits.map((visit) => (
            <div key={visit.id} className="flex gap-3 border-b border-border py-2.5 last:border-b-0">
              <span className="num w-12 shrink-0 pt-0.5 text-[12px] font-semibold text-primary">
                {visit.all_day ? 'All day' : new Date(visit.starts_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-foreground">{visit.title}</span>
                <span className="block truncate text-[12px] text-muted-foreground">
                  {[visit.client_name, visit.city, visit.assignee_names].filter(Boolean).join(' · ')}
                </span>
              </span>
              <Chip tone={visit.status === 'confirmed' ? 'settled' : 'plain'} className="shrink-0">
                {visit.status === 'confirmed' ? 'Confirmed' : 'Planned'}
              </Chip>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Reference only. Nothing here is a task, and nothing here is primary. */
function Rail({ finance, sales, travel, visits }) {
  return (
    <aside aria-label="For reference" className="flex flex-col gap-4">
      <Diary visits={visits} />

      {finance && (
        <div className={`${CARD} flex flex-col gap-2.5 p-5`}>
          <h3 className={SECTION}>At a glance</h3>
          {[
            ['Left to collect', finance.outstanding, Number(finance.outstanding) > 0 ? 'text-late' : 'text-foreground'],
            ['Open pipeline', Number(sales.value_inr) - Number(sales.won_value_inr), 'text-foreground'],
            ['Travel cost', travel.total_cost, 'text-foreground'],
          ].map(([label, value, tone]) => (
            <div key={label} className="flex justify-between gap-3 text-[13px] text-secondary-text">
              {label}<span className={`num font-semibold ${tone}`}>{money(value, 'INR', { compact: true })}</span>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-2.5 rounded-lg border border-primary/20 bg-primary/[0.06] p-5">
        <h3 className="font-display text-base font-bold text-primary">How do I…</h3>
        {[
          '…raise an invoice for a stage?',
          '…register a PO on a won deal?',
          '…record a payment that came in?',
        ].map((question) => (
          <button
            key={question}
            type="button"
            onClick={() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))}
            className="text-left text-[13px] text-secondary-text hover:text-foreground"
          >
            {question}
          </button>
        ))}
        <p className="mt-1 text-[12px]/[1.6] text-muted-foreground">Each one opens the palette, where the step runs.</p>
      </div>
    </aside>
  );
}

export default function Today() {
  const { displayName } = useAuth() ?? {};
  const { data, loading, error, refetch } = useFetch(() => api.raw('/dashboard/overview'));
  const work = useFetch(() => api.raw('/dashboard/worklist'));
  const diary = useFetch(() => api.raw('/visits/today'));
  const bell = useFetch(() => api.raw('/notifications/summary'));
  const mine = useMyDailyMis();

  const d = data?.data;
  const w = work.data?.data;
  const overdue = (w?.payment_stages || []).filter((s) => s.stage_status === 'Overdue');
  const list = queues(w, bell.data?.data?.unread ?? 0);
  const waiting = (overdue.length ? 1 : 0) + list.length;

  if (error) {
    return (
      <>
        <PageHeader eyebrow={todayLabel()} title={greeting(displayName)} />
        <div className="page"><ErrorState message={error} onRetry={refetch} /></div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        eyebrow={todayLabel()}
        title={greeting(displayName)}
        subtitle={
          loading ? 'Working out what needs a person…'
            : waiting === 0 ? 'Nothing is waiting on anybody. Everything raised is either paid or not yet due.'
            : `${waiting} ${waiting === 1 ? 'thing needs' : 'things need'} a person today. The money owed longest is first, and the list empties as you go.`
        }
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))}
          >
            <Plus strokeWidth={2} aria-hidden="true" />
            New
            <span className="num text-[11px] text-muted-foreground">⌘K</span>
          </Button>
        }
      />

      <div className="flex flex-col gap-6 p-4 sm:p-6">
        {d && <QuoteToCash finance={d.finance} sales={d.sales} />}

        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
          <section aria-label="Needs you" className="flex min-w-0 flex-col gap-6">
            {/* While the day is being worked out, the column shows the shape it
                is about to have. It used to render nothing at all — every
                branch below is gated on data, so the busiest page in the app
                looked empty rather than busy on a slow connection, and the
                only sign of life was one line of header text. */}
            {loading && <TodaySkeleton />}

            <DailyMisNotice mine={mine} />

            {!loading && overdue.length > 0 && <StartHere overdue={overdue} />}

            {!loading && list.length > 0 && (
              <div className="flex min-w-0 flex-col gap-3">
                <div className="flex items-baseline gap-3">
                  <h2 className={SECTION}>{overdue.length ? 'Then, in order' : 'Waiting on somebody'}</h2>
                  <span className="text-[12.5px] text-muted-foreground">{list.length} left</span>
                </div>
                <div className={`${CARD} overflow-hidden`}>
                  {list.map((item) => <Queue key={item.key} item={item} />)}
                </div>
              </div>
            )}

            {!loading && waiting === 0 && (
              <div className="flex items-center gap-2.5 rounded-lg border border-dashed border-border px-4 py-3">
                <CheckCircle2 className="size-4 text-settled" strokeWidth={2.2} aria-hidden="true" />
                <span className="text-[13px] text-secondary-text">
                  Nothing is waiting. Anything raised is either paid or not yet due.
                </span>
              </div>
            )}

            <MyDailyMis mine={mine} />
          </section>

          <Rail finance={d?.finance} sales={d?.sales} travel={d?.travel} visits={diary.data?.data || []} />
        </div>
      </div>
    </>
  );
}
