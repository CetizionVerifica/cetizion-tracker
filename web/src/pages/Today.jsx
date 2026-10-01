import { Link } from 'react-router-dom';
import {
  AlertTriangle, ArrowRight, Bell, Briefcase, CheckCircle2, CreditCard, FileText, Plane, Plus,
} from 'lucide-react';
import { PageHeader } from '../App.jsx';
import { ErrorState } from '../components/ui.jsx';
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

const CARD = 'rounded-[10px] border border-border bg-card';

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
const EYEBROW = 'text-[11px] font-semibold uppercase tracking-[0.09em] text-muted-foreground';

/** "Tuesday, 22 September" — the date is the title, because the page is a day. */
function todayLabel() {
  const d = new Date();
  const weekday = d.toLocaleDateString('en-GB', { weekday: 'long' });
  return `${weekday}, ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}`;
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
      key: 'to-invoice', icon: CreditCard, tone: 'waiting', to: '/payment-stages', action: 'Raise them',
      lead: <><strong className="font-semibold">{count(toInvoice.length, 'invoice is', 'invoices are')} ready to raise</strong> — <span className="num">{money(sum(toInvoice, 'stage_amount'), 'INR', { compact: true })}</span>.</>,
      detail: 'Every trigger has happened; nothing else is in the way.',
    },
    unregistered.length && {
      key: 'unregistered', icon: Briefcase, tone: 'waiting', to: '/quotations?status=Won+-+PO+Received', action: 'Register',
      lead: <><strong className="font-semibold">{count(unregistered.length, 'won deal has', 'won deals have')} no project</strong>, so none of them can be invoiced.</>,
      detail: <><span className="num">{money(sum(unregistered, 'quotation_value'), 'INR', { compact: true })}</span> of signed work sitting outside delivery.</>,
    },
    noAmount.length && {
      key: 'bills', icon: Plane, tone: 'plain', to: '/vendor-invoices', action: 'Fill in',
      lead: <><strong className="font-semibold">{count(noAmount.length, 'travel bill has', 'travel bills have')} a reference but no amount.</strong></>,
      detail: 'They cannot be paid until a figure is entered.',
    },
    claims.length && {
      key: 'claims', icon: FileText, tone: 'plain', to: '/expense-claims', action: 'Review',
      lead: <><strong className="font-semibold">{count(claims.length, 'expense claim needs', 'expense claims need')} a decision</strong> — <span className="num">{money(sum(claims, 'amount_claimed'), 'INR', { compact: true })}</span>.</>,
      detail: `Across ${new Set(claims.map((c) => c.employee_name)).size} people.`,
    },
    late.length && {
      key: 'late', icon: AlertTriangle, tone: 'plain', to: '/projects', action: 'Open',
      lead: <><strong className="font-semibold">{count(late.length, 'project is', 'projects are')} past the delivery date.</strong></>,
      detail: `The latest by ${Math.max(...late.map((p) => Number(p.days_late || 0)))} days.`,
    },
    // The bell, folded in. A notification nobody opens a page to read is a
    // notification nobody reads, so it queues here with everything else.
    unread > 0 && {
      key: 'unread', icon: Bell, tone: 'plain', to: '/notifications', action: 'Read them',
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
    <section className="overflow-hidden rounded-[10px] border border-late/25 bg-card">
      <div className="flex items-center gap-2 border-b border-late/20 bg-late/[0.07] px-5 py-3">
        <AlertTriangle className="size-3.5 text-late" strokeWidth={2.2} aria-hidden="true" />
        <span className="text-[11px] font-semibold uppercase tracking-[0.09em] text-late">Start here</span>
        <span className="ml-auto text-[12px] text-secondary-text">Most overdue money, oldest first</span>
      </div>
      <div className="p-5">
        <h2 className="max-w-[62ch] text-[19px]/[1.4] font-semibold text-foreground">
          {overdue.length === 1 ? 'One invoice is overdue' : `${overdue.length} invoices are overdue`} — <span className="num">{money(total)}</span> is
          sitting with clients, the oldest for {oldest} {oldest === 1 ? 'day' : 'days'}.
        </h2>
        <div className="mt-4 flex flex-wrap gap-2">
          {named.map((stage) => (
            <span key={stage.id} className="inline-flex h-7 items-center gap-2 rounded-[6px] border border-border bg-secondary px-2.5 text-[12.5px] text-secondary-text">
              <span className="num text-foreground">{stage.client_name}</span>
              {money(stage.due_now_amount, stage.currency, { compact: true })} · {stage.days_overdue}d
            </span>
          ))}
          {overdue.length > named.length && (
            <span className="inline-flex h-7 items-center rounded-[6px] border border-border bg-secondary px-2.5 text-[12.5px] text-secondary-text">
              +{overdue.length - named.length} more
            </span>
          )}
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-3">
          {/* The one primary action on the page. */}
          <Link
            to="/collections"
            className="inline-flex h-control items-center gap-2 rounded-[6px] border border-primary bg-primary px-4 text-[13px] font-semibold text-primary-foreground transition-colors duration-150 hover:bg-primary/90"
          >
            {overdue.length === 1 ? 'Chase it' : `Chase all ${overdue.length}`}
            <ArrowRight className="size-3.5" strokeWidth={2.2} aria-hidden="true" />
          </Link>
          <span className="text-[12.5px] text-secondary-text">
            Opens one client at a time with the history beside it. You decide what to send.
          </span>
        </div>
      </div>
    </section>
  );
}

const TONES = {
  waiting: 'border-waiting/25 bg-waiting/10 text-waiting',
  plain: 'border-border bg-secondary text-secondary-text',
};

function Queue({ item }) {
  return (
    <div className="flex items-center gap-4 border-b border-border px-5 py-4 last:border-b-0 hover:bg-secondary">
      <span className={`grid size-8 shrink-0 place-items-center rounded-[6px] border ${TONES[item.tone]}`}>
        <item.icon className="size-4" strokeWidth={1.75} aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[14px]/[1.45] text-foreground">{item.lead}</div>
        <div className="mt-0.5 text-[12.5px] text-secondary-text">{item.detail}</div>
      </div>
      <Link
        to={item.to}
        className="inline-flex h-control shrink-0 items-center rounded-[6px] border border-border-strong bg-secondary px-3.5 text-[13px] font-medium text-foreground transition-colors duration-150 hover:border-muted-foreground"
      >
        {item.action}
      </Link>
    </div>
  );
}

/** Time, what, who, and what it is waiting on. Reference, not a task. */
function Diary({ visits }) {
  if (!visits.length) return null;
  return (
    <section className="flex flex-col gap-3">
      <div className={EYEBROW}>In the diary today</div>
      <div className={`${CARD} overflow-hidden`}>
        {visits.map((visit) => (
          <div key={visit.id} className="flex items-center gap-4 border-b border-border px-5 py-2 last:border-b-0">
            <span className="num w-14 shrink-0 text-[12.5px] font-medium text-info">
              {visit.all_day ? 'All day' : new Date(visit.starts_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
            </span>
            <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
              {visit.title}{visit.client_name && <> — <strong className="font-semibold">{visit.client_name}</strong></>}
              {visit.city && <span className="text-secondary-text">, {visit.city}</span>}
            </span>
            <span className="hidden shrink-0 text-[12.5px] text-secondary-text sm:block">{visit.assignee_names || '—'}</span>
            <span className={`inline-flex h-[22px] shrink-0 items-center rounded-[6px] border px-2.5 text-[11.5px] font-semibold ${
              visit.status === 'confirmed' ? 'border-settled/28 bg-settled/10 text-settled' : 'border-border bg-secondary text-secondary-text'
            }`}>
              {visit.status === 'confirmed' ? 'Confirmed' : 'Planned'}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Reference only. Nothing here is a task, and nothing here is primary. */
function Rail({ finance, sales, travel }) {
  const collected = finance.invoiced ? Number(finance.received) / Number(finance.invoiced) : 0;
  return (
    <aside className="flex flex-col gap-4">
      <div className={`${CARD} flex flex-col gap-4 p-5`}>
        <div className={EYEBROW}>Collected so far</div>
        <div>
          <div className="num text-[26px]/[1.1] font-semibold tracking-[-0.02em] text-foreground">
            {money(finance.received, 'INR', { compact: true })}
          </div>
          <div className="mt-3 flex h-1.5 overflow-hidden rounded-full bg-secondary">
            <span className="bg-primary" style={{ width: `${Math.min(100, Math.round(collected * 100))}%` }} />
          </div>
          <div className="mt-2 text-[12px] text-secondary-text">
            {Math.round(collected * 100)}% of <span className="num">{money(finance.invoiced, 'INR', { compact: true })}</span> invoiced
            {Number(finance.outstanding) > 0 && <> · <span className="num text-late">{money(finance.outstanding, 'INR', { compact: true })}</span> still out</>}
          </div>
        </div>
        <div className="flex flex-col gap-2.5 border-t border-border pt-4">
          {[
            ['Won', sales.won_value_inr],
            ['Open pipeline', Number(sales.value_inr) - Number(sales.won_value_inr)],
            ['Travel cost', travel.total_cost],
          ].map(([label, value]) => (
            <div key={label} className="flex justify-between gap-3 text-[12.5px] text-secondary-text">
              {label}<span className="num text-foreground">{money(value, 'INR', { compact: true })}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-[10px] border border-primary/20 bg-primary/[0.06] p-5">
        <div className="text-[11px] font-semibold uppercase tracking-[0.09em] text-primary">How do I…</div>
        {[
          '…raise an invoice for a stage?',
          '…register a PO on a won deal?',
          '…record a payment that came in?',
        ].map((question) => (
          <button
            key={question}
            type="button"
            onClick={() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))}
            className="text-left text-[12.5px] text-secondary-text hover:text-foreground"
          >
            {question}
          </button>
        ))}
        <p className="mt-1 text-[11.5px]/[1.6] text-muted-foreground">Each one opens the palette, where the step runs.</p>
      </div>
    </aside>
  );
}

export default function Today() {
  const { data, loading, error, refetch } = useFetch(() => api.raw('/dashboard/overview'));
  const work = useFetch(() => api.raw('/dashboard/worklist'));
  const diary = useFetch(() => api.raw('/visits/today'));
  const bell = useFetch(() => api.raw('/notifications/summary'));

  const d = data?.data;
  const w = work.data?.data;
  const overdue = (w?.payment_stages || []).filter((s) => s.stage_status === 'Overdue');
  const list = queues(w, bell.data?.data?.unread ?? 0);
  const waiting = (overdue.length ? 1 : 0) + list.length;

  if (error) {
    return (
      <>
        <PageHeader title={todayLabel()} />
        <div className="page"><ErrorState message={error} onRetry={refetch} /></div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={todayLabel()}
        subtitle={
          loading ? 'Working out what needs a person…'
            : waiting === 0 ? 'Nothing is waiting on anybody. Everything raised is either paid or not yet due.'
            : `${waiting} ${waiting === 1 ? 'thing needs' : 'things need'} a person today. Work down the list — it empties as you go.`
        }
        actions={
          <button
            type="button"
            onClick={() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))}
            className="inline-flex h-control items-center gap-2 rounded-[6px] border border-border-strong bg-secondary px-3.5 text-[13px] font-medium text-foreground hover:border-muted-foreground"
          >
            <Plus className="size-3.5" strokeWidth={2} aria-hidden="true" />
            New
            <span className="num text-[10.5px] text-muted-foreground">⌘K</span>
          </button>
        }
      />

      <div className="grid items-start gap-6 p-6 xl:grid-cols-[minmax(0,1fr)_300px]">
        <div className="flex min-w-0 flex-col gap-6">
          {/* While the day is being worked out, the column shows the shape it
              is about to have. It used to render nothing at all — every
              branch below is gated on data, so the busiest page in the app
              looked empty rather than busy on a slow connection, and the
              only sign of life was one line of header text. */}
          {loading && <TodaySkeleton />}

          {!loading && overdue.length > 0 && <StartHere overdue={overdue} />}

          {!loading && list.length > 0 && (
            <section className="flex min-w-0 flex-col gap-3">
              <div className={EYEBROW}>{overdue.length ? 'Then, in order' : 'Waiting on somebody'}</div>
              <div className={`${CARD} overflow-hidden`}>
                {list.map((item) => <Queue key={item.key} item={item} />)}
              </div>
            </section>
          )}

          {!loading && waiting === 0 && (
            <div className="flex items-center gap-2.5 rounded-[10px] border border-dashed border-border px-4 py-3">
              <CheckCircle2 className="size-4 text-settled" strokeWidth={2.2} aria-hidden="true" />
              <span className="text-[13px] text-secondary-text">
                Nothing is waiting. Anything raised is either paid or not yet due.
              </span>
            </div>
          )}

          <Diary visits={diary.data?.data || []} />
        </div>

        {d && <Rail finance={d.finance} sales={d.sales} travel={d.travel} />}
      </div>
    </>
  );
}
