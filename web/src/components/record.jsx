import { Link } from 'react-router-dom';
import { ChevronRight, MoreHorizontal } from 'lucide-react';
import { cn } from 'cn';

/**
 * The record page, as the design draws it — one shape for Company,
 * Project, Trip, Deal and Order.
 *
 * Those five pages each grew their own layout, so the same question
 * ("what is this and what is wrong with it?") was answered in five
 * arrangements. The design gives one: a breadcrumb, a header with the
 * facts on one line, four figures, then the record's own sections beside
 * a 340px rail.
 *
 * The rule that keeps it readable is in the design's note on the company
 * record: the figures in the top row are **the ones somebody asks before
 * they pick up the phone**. Not every number the record has — the four
 * that decide what to say.
 */

const CARD = 'overflow-hidden rounded-[10px] border border-border bg-card';

/** Two letters, for the mark beside the title. */
export function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '—';
  return (parts[0][0] + (parts[1]?.[0] ?? '')).toUpperCase();
}

/**
 * A figure in the top row.
 *
 * `tone` colours the number, and is for money that is late or a state
 * that is wrong — never for decoration. The line underneath says what the
 * figure is made of, which is what stops a bare number being a puzzle.
 */
export function RecordStat({ label, value, detail, tone }) {
  return (
    <div className="rounded-[10px] border border-border bg-card px-5 py-4">
      <div className="text-[10.5px] font-semibold uppercase tracking-[0.09em] text-muted-foreground">{label}</div>
      <div className={cn(
        'num mt-2 text-[22px] font-semibold tracking-[-0.02em]',
        tone === 'late' ? 'text-late' : tone === 'waiting' ? 'text-waiting' : tone === 'settled' ? 'text-settled' : 'text-foreground'
      )}>
        {value}
      </div>
      {detail && <div className="mt-1 text-[12px] text-secondary-text">{detail}</div>}
    </div>
  );
}

/** A card with a 44px header: a title, an optional hint, an optional action. */
export function RecordSection({ title, hint, action, children, className }) {
  return (
    <section className={cn(CARD, className)}>
      <div className="flex h-11 items-center gap-3 border-b border-border px-5">
        <span className="text-[14px] font-semibold text-foreground">{title}</span>
        {hint && <span className="min-w-0 truncate text-[12.5px] text-muted-foreground">{hint}</span>}
        {action && <div className="ml-auto flex items-center gap-2">{action}</div>}
      </div>
      {children}
    </section>
  );
}

/**
 * A 44px row: what it is, what it is waiting on, and how much.
 *
 * The amount is mono, right-aligned and a fixed width, so a column of
 * them reads as a column of money rather than as ragged text.
 */
export function RecordRow({ icon: Icon, to, title, chip, amount, muted, last }) {
  const inner = (
    <>
      {Icon && <Icon className={cn('size-4 shrink-0', muted ? 'text-muted-foreground' : 'text-secondary-text')} strokeWidth={1.75} aria-hidden="true" />}
      <span className={cn('min-w-0 flex-1 truncate text-[13px] font-medium', muted ? 'text-secondary-text' : 'text-foreground')}>
        {title}
      </span>
      {chip}
      {amount !== undefined && (
        <span className={cn('num w-[110px] shrink-0 text-right text-[13px]', muted ? 'text-secondary-text' : 'text-foreground')}>
          {amount}
        </span>
      )}
    </>
  );
  const className = cn(
    'flex h-11 items-center gap-4 px-5 no-underline transition-colors duration-150',
    !last && 'border-b border-border',
    to && 'hover:bg-secondary'
  );
  return to ? <Link to={to} className={className}>{inner}</Link> : <div className={className}>{inner}</div>;
}

/** The states a row can be in, as the design draws them: never hue alone. */
const CHIP_TONES = {
  late: 'border-late/30 bg-late/10 text-late',
  waiting: 'border-waiting/28 bg-waiting/10 text-waiting',
  settled: 'border-settled/28 bg-settled/10 text-settled',
  info: 'border-info/28 bg-info/10 text-info',
  plain: 'border-border bg-secondary text-secondary-text',
};

export function Chip({ tone = 'plain', icon: Icon, children }) {
  return (
    <span className={cn(
      'inline-flex h-[22px] shrink-0 items-center gap-1.5 rounded-[6px] border px-2.5 text-[11.5px] font-semibold',
      CHIP_TONES[tone] || CHIP_TONES.plain
    )}>
      {Icon && <Icon className="size-3" strokeWidth={2.4} aria-hidden="true" />}
      {children}
    </span>
  );
}

/** A person in the rail: initials, name, and what they are to this record. */
export function RailPerson({ name, detail, last }) {
  return (
    <div className={cn('flex items-center gap-3 px-5 py-3', !last && 'border-b border-border')}>
      <span className="grid size-7 shrink-0 place-items-center rounded-full bg-secondary text-[10px] font-semibold text-primary">
        {initialsOf(name)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium text-foreground">{name}</div>
        {detail && <div className="truncate text-[12px] text-muted-foreground">{detail}</div>}
      </div>
    </div>
  );
}

/** Something that happened, in the rail: what, when, and one line of detail. */
export function RailEvent({ what, when, detail, last }) {
  return (
    <div className={cn('px-5 py-3', !last && 'border-b border-border')}>
      <div className="flex gap-2">
        <span className="text-[12.5px] font-medium text-foreground">{what}</span>
        <span className="ml-auto shrink-0 text-[11.5px] text-muted-foreground">{when}</span>
      </div>
      {detail && <div className="mt-0.5 text-[12px] text-secondary-text">{detail}</div>}
    </div>
  );
}

/**
 * The whole page.
 *
 * `facts` is the line under the title — the handful of things that are
 * true about this record whatever else is happening. `stats` is the four
 * figures. `rail` is 340px of reference on the right, and like Today's
 * rail it should not hold the page's primary action.
 */
export function RecordPage({ parent, parentTo, title, mark, markTone, facts = [], action, menu, stats, children, rail }) {
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 px-8 pt-5 text-[12.5px] text-muted-foreground">
        <Link to={parentTo} className="text-secondary-text no-underline hover:text-foreground">{parent}</Link>
        <ChevronRight className="size-3" strokeWidth={2} aria-hidden="true" />
        <span className="min-w-0 truncate text-foreground">{title}</span>
      </div>

      <header className="flex items-start gap-4 px-8 pt-4">
        {/* `false` means this record has no mark at all — the deal and the
            order carry their identity in the title and the facts row, and
            an empty 44px square with a gap beside it is worse than none.
            `undefined` still falls back to the title's initials. */}
        {mark !== false && (
          <span className={cn(
            'grid size-11 shrink-0 place-items-center rounded-[10px] bg-secondary text-[14px] font-semibold',
            markTone === 'late' ? 'text-late' : 'text-primary'
          )}>
            {mark ?? initialsOf(title)}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-2xl/[1.25] font-semibold tracking-[-0.022em] text-foreground">{title}</h1>
          {facts.length > 0 && (
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-secondary-text">
              {facts.filter(Boolean).map((fact, i) => <span key={i} className="min-w-0 truncate">{fact}</span>)}
            </div>
          )}
        </div>
        {action}
        {menu && (
          <details className="relative shrink-0">
            <summary
              aria-label="More actions"
              className="grid size-control cursor-pointer list-none place-items-center rounded-[6px] border border-[#33333a] bg-secondary text-secondary-text marker:content-none hover:text-foreground"
            >
              <MoreHorizontal className="size-4" strokeWidth={2.4} aria-hidden="true" />
            </summary>
            <div className="absolute right-0 z-20 mt-1.5 flex min-w-48 flex-col gap-0.5 rounded-[10px] border border-border bg-popover p-1.5 shadow-lg">
              {menu}
            </div>
          </details>
        )}
      </header>

      {stats && (
        <div className="mt-6 grid gap-4 px-8 sm:grid-cols-2 xl:grid-cols-4">
          {stats}
        </div>
      )}

      {/* The rail is 340px when there is one. Without it the sections take
          the width, rather than leaving a column of nothing beside them. */}
      <div className={cn('grid items-start gap-6 px-8 pt-6 pb-8', rail && 'xl:grid-cols-[minmax(0,1fr)_340px]')}>
        <div className="flex min-w-0 flex-col gap-4">{children}</div>
        {rail && <aside className="flex flex-col gap-4">{rail}</aside>}
      </div>
    </div>
  );
}
