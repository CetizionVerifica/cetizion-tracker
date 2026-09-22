import { Fragment } from 'react';
import { Link } from 'react-router-dom';
import { Check, MoreHorizontal } from 'lucide-react';
import { cn } from 'cn';
import { Avatar, AvatarFallback } from './ui/avatar';
import { Badge } from './ui/badge';
import {
  Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator,
} from './ui/breadcrumb';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { Separator } from './ui/separator';

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
 *
 * Everything here is built on the shadcn primitives in ./ui. Where a
 * shape has no primitive — the flow ladder's discs and connectors, the
 * 44px row — it is drawn by hand against the same tokens, which is the
 * only reason those two are not Card and Button like the rest.
 */

/** A card that keeps the design's 10px radius and its own padding. */
const PANEL = 'gap-0 rounded-[10px] border-border py-0 shadow-none';

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
    <Card className={PANEL}>
      <CardContent className="px-5 py-4">
        <div className="text-[10.5px] font-semibold uppercase tracking-[0.09em] text-muted-foreground">{label}</div>
        <div className={cn(
          'num mt-2 text-[22px] font-semibold tracking-[-0.02em]',
          tone === 'late' ? 'text-late' : tone === 'waiting' ? 'text-waiting' : tone === 'settled' ? 'text-settled' : 'text-foreground'
        )}>
          {value}
        </div>
        {detail && <div className="mt-1 text-[12px] text-secondary-text">{detail}</div>}
      </CardContent>
    </Card>
  );
}

/** A card with a 44px header: a title, an optional hint, an optional action. */
export function RecordSection({ title, hint, action, children, className }) {
  return (
    <Card className={cn(PANEL, 'overflow-hidden', className)}>
      <CardHeader className="flex h-11 flex-row items-center gap-3 space-y-0 border-b border-border px-5 pb-0">
        <CardTitle className="text-[14px] font-semibold text-foreground">{title}</CardTitle>
        {hint && <span className="min-w-0 truncate text-[12.5px] font-normal text-muted-foreground">{hint}</span>}
        {action && <div className="ml-auto flex items-center gap-2">{action}</div>}
      </CardHeader>
      <CardContent className="p-0">{children}</CardContent>
    </Card>
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

/**
 * A state, as a badge.
 *
 * shadcn's own variants are default/secondary/destructive, which are not
 * the four states this business has. `outline` is the neutral base and
 * the tone supplies the colour, so the badge is still a Badge and still
 * says late, waiting, settled or nothing.
 */
export function Chip({ tone = 'plain', icon: Icon, children }) {
  return (
    <Badge
      variant="outline"
      className={cn('h-[22px] gap-1.5 rounded-[6px] px-2.5 text-[11.5px] font-semibold', CHIP_TONES[tone] || CHIP_TONES.plain)}
    >
      {Icon && <Icon strokeWidth={2.4} aria-hidden="true" />}
      {children}
    </Badge>
  );
}

/** A person in the rail: initials, name, and what they are to this record. */
export function RailPerson({ name, detail, last }) {
  return (
    <div className={cn('flex items-center gap-3 px-5 py-3', !last && 'border-b border-border')}>
      <Avatar className="size-7 shrink-0">
        <AvatarFallback className="bg-secondary text-[10px] font-semibold text-primary">{initialsOf(name)}</AvatarFallback>
      </Avatar>
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
 * An entry in a record's ⋯ menu.
 *
 * Pages pass these as `menu`. Being a real DropdownMenuItem is what makes
 * the menu close when one is chosen and what makes the arrow keys work —
 * a plain button inside the menu does neither.
 */
export function RecordMenuItem({ children, ...props }) {
  return (
    <DropdownMenuItem className="px-2.5 py-1.5 text-[13px] text-secondary-text focus:text-foreground" {...props}>
      {children}
    </DropdownMenuItem>
  );
}

/**
 * One rung of the flow: a disc, and what that step is called.
 *
 * `state` is handed in by the page and never worked out here. A step is
 * "current" for reasons only the record knows — the order decides it from
 * its stages, the deal from its status and its PO — so the component
 * draws the state it is given and holds no opinion about it.
 */
export function FlowStep({ label, state = 'future', since }) {
  const done = state === 'done';
  const current = state === 'current';
  return (
    <div className={cn('flex flex-none flex-col items-center gap-2', current ? 'w-[112px]' : 'w-[92px]')}>
      <span className={cn(
        'grid size-[18px] place-items-center rounded-full',
        done && 'border border-settled/40 bg-settled/15',
        current && 'bg-settled ring-4 ring-settled/20',
        !done && !current && 'border border-[#3a3a42]'
      )}>
        {done && <Check className="size-[11px] text-settled" strokeWidth={3.2} aria-hidden="true" />}
      </span>
      <span className={cn(
        'text-center text-[11.5px]',
        current ? 'font-semibold text-foreground' : done ? 'font-medium text-secondary-text' : 'font-medium text-muted-foreground'
      )}>
        {label}
      </span>
      {since && <span className="text-center text-[11px] text-muted-foreground">{since}</span>}
    </div>
  );
}

/**
 * Turn a record's facts into rungs.
 *
 * Each page hands in `[{ label, done }]` — whether a step has happened is
 * the record's business, not this file's. What is shared is which rung
 * glows: the one *after* the furthest thing that has happened, not the
 * earliest gap. A deal that was won and invoiced without an enquiry row
 * ever being created is at "Collected", not back at "Enquiry", and the
 * missing rung stays hollow to say so rather than dragging the marker
 * backwards.
 */
export function flowSteps(reached) {
  const lastDone = reached.reduce((last, step, i) => (step.done ? i : last), -1);
  return reached.map((step, i) => ({
    label: step.label,
    since: step.since,
    state: step.done ? 'done' : i === lastDone + 1 ? 'current' : 'future',
  }));
}

/**
 * Where the record has got to, and the one move that takes it forward.
 *
 * This is what replaced six boxes of prose: the rail is read in a glance
 * and the page's whole opinion about the record is the sentence under it.
 * `actions` holds the primary move and at most one secondary — everything
 * else belongs in the header's menu, which is the point of the shape.
 * `note` is the small print: what the primary button will actually do,
 * and what was moved into the menu.
 */
export function RecordFlow({ steps = [], verdict, actions, note }) {
  return (
    <Card className={cn(PANEL, 'mt-6 px-6 py-5')}>
      <div className="flex items-center overflow-x-auto px-1">
        {steps.map((step, i) => (
          <Fragment key={step.label}>
            {/* The connector is lit when the step behind it is done, so the
                colour stops exactly where the record stopped. */}
            {i > 0 && (
              <span className={cn('mb-[22px] h-px flex-1', steps[i - 1].state === 'done' ? 'bg-settled/30' : 'bg-[#2a2a32]')} />
            )}
            <FlowStep {...step} />
          </Fragment>
        ))}
      </div>

      {(verdict || actions) && (
        <>
          <Separator className="mt-5" />
          <div className="mt-5 flex flex-wrap items-center gap-5">
            {verdict && <p className="min-w-[320px] max-w-[64ch] flex-1 text-[14px]/[1.6] text-foreground">{verdict}</p>}
            {actions && <div className="flex flex-wrap items-center gap-3">{actions}</div>}
          </div>
        </>
      )}
      {note && <p className="mt-3 max-w-[78ch] text-[12.5px]/[1.6] text-muted-foreground">{note}</p>}
    </Card>
  );
}

/**
 * The whole page.
 *
 * `facts` is the line under the title — the handful of things that are
 * true about this record whatever else is happening. `stats` is the four
 * figures, and `flow` is the ladder that replaces them on the records
 * whose question is "how far has this got?" rather than "how much?".
 * `rail` is 340px of reference on the right, and like Today's rail it
 * should not hold the page's primary action.
 */
export function RecordPage({ parent, parentTo, title, mark, markTone, facts = [], action, menu, flow, stats, children, rail }) {
  return (
    <div className="flex flex-col">
      <Breadcrumb className="px-4 pt-5 sm:px-8">
        <BreadcrumbList className="gap-2 text-[12.5px] sm:gap-2">
          <BreadcrumbItem>
            <BreadcrumbLink asChild className="text-secondary-text hover:text-foreground">
              <Link to={parentTo}>{parent}</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem className="min-w-0">
            <BreadcrumbPage className="min-w-0 truncate text-foreground">{title}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <header className="flex items-start gap-4 px-4 pt-4 sm:px-8">
        {/* `false` means this record has no mark at all — the deal and the
            order carry their identity in the title and the facts row, and
            an empty 44px square with a gap beside it is worse than none.
            `undefined` still falls back to the title's initials. */}
        {mark !== false && (
          <Avatar className="size-11 shrink-0 rounded-[10px]">
            <AvatarFallback className={cn(
              'rounded-[10px] bg-secondary text-[14px] font-semibold',
              markTone === 'late' ? 'text-late' : 'text-primary'
            )}>
              {mark ?? initialsOf(title)}
            </AvatarFallback>
          </Avatar>
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
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="secondary" size="icon-sm" aria-label="More actions" className="shrink-0 border border-[#33333a] text-secondary-text hover:text-foreground">
                <MoreHorizontal strokeWidth={2.4} aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-48 rounded-[10px] p-1.5">
              {menu}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </header>

      {flow && <div className="px-4 sm:px-8">{flow}</div>}

      {stats && (
        <div className="mt-6 grid gap-4 px-4 sm:grid-cols-2 sm:px-8 xl:grid-cols-4">
          {stats}
        </div>
      )}

      {/* The rail is 340px when there is one. Without it the sections take
          the width, rather than leaving a column of nothing beside them. */}
      <div className={cn('grid items-start gap-6 px-4 pt-6 pb-8 sm:px-8', rail && 'xl:grid-cols-[minmax(0,1fr)_340px]')}>
        <div className="flex min-w-0 flex-col gap-4">{children}</div>
        {rail && <aside className="flex flex-col gap-4">{rail}</aside>}
      </div>
    </div>
  );
}
