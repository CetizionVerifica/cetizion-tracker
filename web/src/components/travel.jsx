import { Link } from 'react-router-dom';
import { CircleAlert, SearchX } from 'lucide-react';
import { cn } from 'cn';
import { RecordTabs, Tone } from './sales.jsx';
import { shortDate } from './money.jsx';
import { ControlBar } from './shell/Shell.jsx';

/**
 * The Wave 6 (Projects and travel) building blocks: the state words of a
 * trip, a vendor bill and an expense claim in the system's tones and in
 * sentence case, the trip's date range, and the record pages' tabbed panel.
 * The server's own strings ("Invoice OVERDUE from vendor", "Approved - to
 * reimburse") stay the filter values; only what is shown changes.
 */

/** A trip's vendor-bill state (v_travel_logs.vendor_invoice_status). */
export const TRIP_BILL = {
  'Awaiting travel': ['plain', 'Awaiting travel'],
  'Invoice awaited': ['plain', 'Bill awaited'],
  'Invoice OVERDUE from vendor': ['late', 'Bill overdue from vendor'],
  'Vendor to pay': ['wait', 'Vendor to pay'],
  'Vendor partly paid': ['wait', 'Vendor partly paid'],
  'Vendor paid': ['ok', 'Vendor paid'],
};

/** A trip's claims state (v_travel_logs.reimbursement_status). */
export const TRIP_CLAIMS = {
  'No claim': ['plain', 'No claim'],
  'To reimburse': ['wait', 'To reimburse'],
  'Partly reimbursed': ['wait', 'Partly reimbursed'],
  Reimbursed: ['ok', 'Reimbursed'],
};

/** A vendor bill's state (v_travel_vendor_invoices.payment_status). */
export const BILL = {
  Awaited: ['plain', 'Bill awaited'],
  'Enter amount': ['wait', 'Enter amount'],
  'Enter date': ['wait', 'Enter date'],
  'To Pay': ['wait', 'To pay'],
  'Partially Paid': ['wait', 'Partly paid'],
  Overdue: ['late', 'Overdue'],
  Paid: ['ok', 'Paid'],
};

/**
 * An expense claim's state (v_employee_expense_claims.status). The words
 * the e2e suite reads ("Pending approval") are kept as the badge; the
 * plain sentence goes under it.
 */
export const CLAIM = {
  'Pending approval': ['info', 'Pending approval'],
  'Approved - to reimburse': ['wait', 'Approved, to reimburse'],
  'Partly reimbursed': ['wait', 'Partly reimbursed'],
  Reimbursed: ['ok', 'Reimbursed'],
  'On hold': ['wait', 'On hold'],
  Rejected: ['late', 'Rejected'],
};

/** A state badge from one of the maps above; an unknown word shows as it is. */
export function StateBadge({ map, value, className }) {
  if (!value) return null;
  const [tone, word] = map[value] || ['plain', value];
  return <Tone tone={tone} className={className}>{word}</Tone>;
}

/** "24–26 Sep", "30 Sep–1 Oct", "18 Sep": a trip's dates, short. */
export function tripWhen(start, end) {
  if (!start) return 'No dates yet';
  if (!end || String(end).slice(0, 10) === String(start).slice(0, 10)) return shortDate(start);
  const a = shortDate(start).split(' ');
  const b = shortDate(end).split(' ');
  // Same month and year: "24–26 Sep".
  if (a.length === b.length && a.slice(1).join(' ') === b.slice(1).join(' ')) return `${a[0]}–${b.join(' ')}`;
  return `${shortDate(start)}–${shortDate(end)}`;
}

/**
 * A record's sections as tabs inside one strong-glass panel: the caramel
 * tabs on top, the chosen one's body under them (Wave 6 record pages).
 */
export function TabsPanel({ id, label, tabs, active, onChange, children, className }) {
  return (
    <section className={cn('mg-glass mg-glass--strong app-tabpanel', className)} data-a="rise" aria-label={label}>
      <RecordTabs id={id} label={label} tabs={tabs} active={active} onChange={onChange} />
      <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-tab-${active}`} className="app-tabbody">
        {children}
      </div>
    </section>
  );
}

/** A small rail card: a title, its hint, then rows. Glass, never inside glass. */
export function RailCard({ title, hint, children, className }) {
  return (
    <section className={cn('mg-glass app-w6card', className)} data-a="rise" aria-label={title}>
      <div className="app-w6card__head">
        <h2>{title}</h2>
        {hint && <span>{hint}</span>}
      </div>
      {children}
    </section>
  );
}

/** "1 trip", "3 trips". */
export const count = (n, one, many = `${one}s`) => `${Number(n) || 0} ${Number(n) === 1 ? one : many}`;

/**
 * A record page that has not landed: the same breadcrumb bar and the
 * shapes of the header, the figures and the tabs, so nothing jumps when
 * it arrives. `error` / `missing` swap the shapes for the reason.
 */
export function RecordState({ parent, parentTo, crumb, loading, missing, error, onRetry, noun = 'record' }) {
  return (
    <div className="app-page app-rec" aria-busy={loading || undefined} aria-label={loading ? `Loading the ${noun}` : undefined}>
      <div className="app-rec__bar">
        <nav className="mg-crumbs" aria-label="Breadcrumb">
          <Link to={parentTo}>{parent}</Link>
          <span aria-hidden="true">›</span>
          <b aria-current="page">{crumb}</b>
        </nav>
        <ControlBar />
      </div>
      {loading ? (
        <>
          <section className="mg-glass mg-glass--strong app-rec__head" data-a="rise" style={{ padding: 24 }}>
            <div className="flex items-center gap-4">
              <span className="mg-skel" style={{ width: 52, height: 52, borderRadius: 16 }} />
              <div className="flex flex-1 flex-col gap-2"><span className="mg-skel" style={{ height: 10, width: 120 }} /><span className="mg-skel" style={{ height: 28, width: '45%' }} /></div>
            </div>
            <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4">{[0, 1, 2, 3].map((i) => <span key={i} className="mg-skel" style={{ height: 34 }} />)}</div>
          </section>
          <div className="app-rec__stats">{[0, 1, 2, 3].map((i) => <div key={i} className="mg-glass mg-tile"><span className="mg-skel" style={{ height: 10, width: '40%' }} /><span className="mg-skel" style={{ height: 28, width: '60%', marginTop: 10 }} /></div>)}</div>
          <section className="mg-glass mg-glass--strong app-tabpanel" style={{ padding: 22 }}>
            {[0, 1, 2, 3].map((i) => <span key={i} className="mg-skel block" style={{ height: 44, marginTop: i ? 10 : 0 }} />)}
          </section>
        </>
      ) : (
        <section className="mg-glass mg-glass--strong mg-empty" data-a="rise" role={missing ? undefined : 'alert'}>
          <span className={cn('mg-empty__mark', !missing && 'bg-late-soft text-late')}>
            {missing ? <SearchX className="size-6" strokeWidth={1.8} aria-hidden="true" /> : <CircleAlert className="size-6" strokeWidth={1.8} aria-hidden="true" />}
          </span>
          <h1 className="mg-empty__title">{missing ? `There is no ${noun} ${crumb}` : `Couldn’t load ${crumb}`}</h1>
          <p className="mg-empty__text">{missing ? `It may have been deleted, or the link has a typo. ${parent} lists every one there is.` : error}</p>
          <div className="flex flex-wrap justify-center gap-2">
            {!missing && onRetry && <button type="button" className="mg-btn mg-btn--sm" onClick={onRetry}>Try again</button>}
            <Link className={cn('mg-btn mg-btn--sm', missing && 'mg-btn--primary')} to={parentTo}>Back to {parent.toLowerCase()}</Link>
          </div>
        </section>
      )}
    </div>
  );
}

/** A row in a rail card: an icon square, a title and its line, an amount or badge. */
export function RailLink({ to, icon: Icon, title, sub, end, label }) {
  const inner = (
    <>
      <span className="app-raillink__mark" aria-hidden="true">{Icon && <Icon strokeWidth={1.8} />}</span>
      <span className="min-w-0"><span className="app-raillink__title">{title}</span>{sub && <span className="app-raillink__sub">{sub}</span>}</span>
      {end != null ? <span className="app-raillink__end">{end}</span> : <span />}
    </>
  );
  return to ? <Link className="app-raillink" to={to} aria-label={label}>{inner}</Link> : <div className="app-raillink">{inner}</div>;
}

/** "Client visit · chargeable": the trip type, and whether it may be billed (said once). */
export function typeLine(t) {
  const name = t.trip_type || 'Type not set';
  return t.chargeable && !/chargeable/i.test(name) ? `${name} · chargeable` : name;
}

/**
 * The figures a pay or reimburse dialog opens with: a row per figure, the
 * last one the total, then a line in its tone ("Pay by 30 Sep · 7 days
 * overdue"). rows: [label, value, note, isTotal]
 */
export function SumBox({ rows, foot, footTone }) {
  return (
    <div className="app-sum">
      <dl>
        {rows.filter(Boolean).map(([k, v, note, total]) => (
          <div key={k} className={total ? 'is-total' : undefined}>
            <dt>{k}{note && <span> · {note}</span>}</dt>
            <dd className="mg-num">{v}</dd>
          </div>
        ))}
      </dl>
      {foot && <p className={footTone ? `is-${footTone}` : undefined}>{foot}</p>}
    </div>
  );
}
