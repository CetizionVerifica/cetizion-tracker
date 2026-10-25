import { Fragment, isValidElement, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Check, CircleAlert, Clock, Info, MoreHorizontal } from 'lucide-react';
import { cn } from 'cn';
import { date } from '../lib/format.js';
import { useMediaQuery } from '../lib/hooks.js';
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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';

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

/** A card on the 12px card radius, with its own padding. */
const PANEL = 'gap-0 rounded-lg border-border py-0 shadow-none';

/**
 * Two letters, for the mark beside the title.
 *
 * Punctuation is stripped before the letters are taken, not after: a
 * person called "Hayyan (Google)" or a company called "·Midal" otherwise
 * gets an initial of "(" or "·", which is how the account page came to
 * show "H(" beside a name it had rendered correctly two inches away.
 */
export function initialsOf(name) {
  const parts = String(name || '')
    .split(/\s+/)
    .map((part) => part.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter(Boolean);
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
        <div className="eyebrow">{label}</div>
        <div className={cn(
          'num mt-2 text-2xl font-semibold tracking-[-0.02em]',
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
      <CardHeader className="flex h-11 flex-row items-center gap-3 space-y-0 border-b border-border px-5 [.border-b]:pb-0">
        {/* The title never shrinks: letting it wrap broke the 44px header
            and pushed it into the hint beside it. The hint truncates instead. */}
        <CardTitle className="shrink-0 font-display text-base font-bold text-foreground">{title}</CardTitle>
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
export function Chip({ tone = 'plain', icon: Icon, className, children }) {
  return (
    <Badge
      variant="outline"
      className={cn('h-[22px] gap-1.5 rounded-full px-2.5 text-[11.5px] font-semibold', CHIP_TONES[tone] || CHIP_TONES.plain, className)}
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

/** A badge's glyph, so its tone is never colour alone (web/CLAUDE.md §1). */
const TONE_GLYPHS = { late: CircleAlert, waiting: Clock, info: Info, settled: Check };

/** What a screen reader hears after a step's name. */
const STEP_WORDS = { done: ', done', current: ', now', exit: ', stopped here', skipped: ', skipped' };

/**
 * Whether a step carries more than a disc and a name. Such a rail lines its
 * steps up by the disc rather than by the middle, because the steps are no
 * longer all the same height.
 */
const isRich = (step) => Boolean(step.to || step.meta || step.badge || step.peek || step.state === 'skipped' || step.state === 'exit');

/**
 * One rung of the flow: a disc, and what that step is called.
 *
 * `state` is handed in by the page and never worked out here. A step is
 * "current" for reasons only the record knows — the order decides it from
 * its stages, the deal from its status and its PO — so the component
 * draws the state it is given and holds no opinion about it.
 *
 * The sales journey asks more of a rung (docs/specs/sales-journey): `to`
 * makes it a link to the step's record, `meta` is a muted line under the
 * name (the record's number and date), `badge` a chip beside the name
 * (days in step, in its tone; `{ label, tone }` or a Chip of your own) and
 * `peek` what shows on hover and focus. Two states join the three: a step
 * the record went past without one is `skipped`, hollow and "Not
 * recorded"; the step a sale stopped at is `exit`. A rung given none of
 * these draws exactly as it always has.
 */
export function FlowStep({ label, state = 'future', since, n, to, meta, badge, peek }) {
  const done = state === 'done';
  const current = state === 'current';
  const exit = state === 'exit';
  const line = meta ?? (state === 'skipped' ? 'Not recorded' : undefined);
  const chip = badge && (isValidElement(badge)
    ? badge
    : <Chip tone={badge.tone} icon={TONE_GLYPHS[badge.tone]}>{badge.label}</Chip>);

  const name = (
    <span className={cn(
      'text-center text-[12px]',
      current ? 'font-semibold text-primary' : exit ? 'font-semibold text-late' : done ? 'font-medium text-foreground' : 'font-medium text-muted-foreground'
    )}>
      {label}
      <span className="sr-only">{STEP_WORDS[state] ?? ', to come'}</span>
    </span>
  );
  const body = (
    <>
      {/* Done is ticked in settled, where the record is now is the action
          colour with a halo, and what has not happened yet is a hollow
          numbered disc: web/CLAUDE.md §4. Where a sale stopped is late
          with a "!", so a lost deal never reads as one still in play. */}
      <span className={cn(
        'num grid size-6 place-items-center rounded-full text-[11px] font-bold',
        done && 'bg-settled text-primary-foreground',
        current && 'bg-primary text-primary-foreground ring-4 ring-primary/20',
        exit && 'bg-late text-late-foreground ring-4 ring-late/20',
        !done && !current && !exit && 'border border-border-strong bg-card text-muted-foreground'
      )}>
        {done ? <Check className="size-3.5" strokeWidth={3} aria-hidden="true" /> : exit ? '!' : n}
      </span>
      {chip ? <span className="flex flex-wrap items-center justify-center gap-1.5">{name}{chip}</span> : name}
      {line && <span className="num text-center text-[11px] text-muted-foreground">{line}</span>}
      {since && <span className="text-center text-[11px] text-muted-foreground">{since}</span>}
    </>
  );

  // The hover surface reaches past the rung by its own padding, pulled back
  // with a negative margin, so a linked step's disc sits exactly where an
  // unlinked one's does and the connectors still meet it.
  const surface = 'flex flex-col items-center gap-2 rounded-md -mx-2 -my-1 px-2 py-1';
  let target = null;
  if (to) {
    target = <Link to={to} className={cn(surface, 'no-underline transition-colors duration-150 hover:bg-accent')}>{body}</Link>;
  } else if (peek) {
    // Focusable without being a link, so the preview is there for a keyboard too.
    target = <span tabIndex={0} className={surface}>{body}</span>;
  }
  if (target && peek) {
    target = (
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>{target}</TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6} className="max-w-[260px] px-3 py-2 text-left">{peek}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return (
    <li
      aria-current={current || exit ? 'step' : undefined}
      className={isRich({ to, meta, badge, peek, state })
        // As wide as what it holds, from the plain rung's width up.
        ? cn('flex max-w-[208px] flex-none flex-col items-center', !target && 'gap-2', current || exit ? 'min-w-[112px]' : 'min-w-[92px]')
        : cn('flex flex-none flex-col items-center gap-2', current ? 'w-[112px]' : 'w-[92px]')}
    >
      {target || body}
    </li>
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

/** One small step: a dot, its name, and its date when one is known. */
function SubStep({ label, state = 'future', date: when }) {
  const done = state === 'done';
  const current = state === 'current';
  return (
    <li aria-current={current ? 'step' : undefined} className="flex items-center gap-1.5 text-[12px]">
      <span className={cn(
        'grid size-3.5 shrink-0 place-items-center rounded-full',
        done && 'bg-settled text-primary-foreground',
        current && 'bg-primary ring-2 ring-primary/25',
        !done && !current && 'border border-border-strong bg-card'
      )}>
        {done && <Check className="size-2.5" strokeWidth={3.5} aria-hidden="true" />}
      </span>
      <span className={current ? 'font-semibold text-primary' : done ? 'font-medium text-foreground' : 'text-muted-foreground'}>
        {label}
        <span className="sr-only">{STEP_WORDS[state] ?? ', to come'}</span>
      </span>
      {when && <span className="num text-[11px] text-muted-foreground">{date(when)}</span>}
    </li>
  );
}

/**
 * The small steps inside the current big one, as a slim row under the rail.
 *
 * On a wide screen it sits under the step it belongs to. `at` is how far
 * along the rail that step is (0 the first, 1 the last); the row is placed
 * that share of the way across and pulled back by the same share of its
 * own width, so it starts under the first step, ends under the last, and
 * is centred under one in the middle, without measuring anything. On a
 * phone it takes the full width and wraps.
 */
function SubSteps({ label, steps, at = 0 }) {
  const wide = useMediaQuery('(min-width: 40rem)');
  const share = `${Math.round(Math.min(1, Math.max(0, at)) * 100)}%`;
  return (
    <div className="mt-4 overflow-hidden">
      <div
        style={wide ? { marginLeft: share, transform: `translateX(-${share})` } : undefined}
        className="rounded-md bg-muted px-3 py-2 sm:w-max sm:max-w-full"
      >
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <span aria-hidden="true" className="eyebrow">{label}</span>
          <ol aria-label={label} className="m-0 flex list-none flex-wrap items-center gap-x-2 gap-y-1.5 p-0">
            {steps.map((step, i) => (
              <Fragment key={step.label}>
                {i > 0 && (
                  <li aria-hidden="true" className={cn('h-px w-3 rounded-full', steps[i - 1].state === 'done' ? 'bg-settled' : 'bg-border-strong')} />
                )}
                <SubStep {...step} />
              </Fragment>
            ))}
          </ol>
        </div>
      </div>
    </div>
  );
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
 *
 * For the sales journey: `substeps` (`{ label, steps: [{ label, state,
 * date }] }`) is the slim row of small steps inside the current one,
 * `nowLabel` replaces the "Now · <step>" eyebrow ("Lost at Quotation"),
 * and `placeholder` is drawn where the steps go while there are none to
 * draw: a skeleton while they load, or a line saying they could not.
 */
export function RecordFlow({ steps = [], verdict, actions, note, substeps, nowLabel, placeholder }) {
  const now = steps.find((step) => step.state === 'current');
  // Where the record is: the current step, or the one a sale stopped at.
  const where = now ?? steps.find((step) => step.state === 'exit');
  const rich = steps.some(isRich);
  // On a phone the rail scrolls sideways; start it with the current step in
  // view, rather than showing the three oldest ticks and hiding where it is.
  const rail = useRef(null);
  useEffect(() => {
    const ol = rail.current;
    const at = ol?.querySelector('[aria-current="step"]');
    if (ol && at && ol.scrollWidth > ol.clientWidth) ol.scrollLeft = at.offsetLeft - ol.offsetLeft - ol.clientWidth / 2 + at.clientWidth / 2;
  }, [where?.label]);
  return (
    <Card className={cn(PANEL, 'mt-6 px-6 py-5')}>
      {placeholder ?? (
        // A rich rail keeps room round its steps for their hover surface and
        // focus ring, which the sideways scroll would otherwise clip. Both are
        // `relative` so the screen-reader words (absolutely placed) scroll
        // with their steps instead of widening the whole page on a phone.
        <ol ref={rail} aria-label="Progress" className={rich ? 'relative m-0 flex list-none items-start overflow-x-auto p-0 px-4 py-2.5' : 'relative m-0 flex list-none items-center overflow-x-auto p-0 px-1'}>
          {steps.map((step, i) => (
            <Fragment key={step.label}>
              {/* The connector is lit when the step behind it is done, so the
                  colour stops exactly where the record stopped. */}
              {i > 0 && (
                <li aria-hidden="true" className={cn(rich ? 'mt-[11px]' : 'mb-[26px]', 'h-0.5 min-w-4 flex-1 rounded-full', steps[i - 1].state === 'done' ? 'bg-settled' : 'bg-border')} />
              )}
              <FlowStep {...step} n={i + 1} />
            </Fragment>
          ))}
        </ol>
      )}

      {!placeholder && substeps?.steps?.length > 0 && (
        <SubSteps {...substeps} at={where && steps.length > 1 ? steps.indexOf(where) / (steps.length - 1) : 0} />
      )}

      {(verdict || actions) && (
        <>
          <Separator className="mt-5" />
          <div className="mt-5 flex flex-wrap items-center gap-5">
            {verdict && (
              <div className="min-w-[min(320px,100%)] max-w-[64ch] flex-1">
                <div className={cn('text-[11px] font-bold uppercase tracking-[0.12em]', where?.state === 'exit' ? 'text-late' : 'text-primary')}>
                  {nowLabel ?? (now ? `Now · ${now.label}` : steps.length ? 'Complete' : 'Now')}
                </div>
                <p className="mt-1 text-[14px]/[1.6] text-foreground">{verdict}</p>
              </div>
            )}
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
          <Avatar className="size-11 shrink-0 rounded-lg">
            <AvatarFallback className={cn(
              'rounded-lg bg-secondary text-[14px] font-semibold',
              markTone === 'late' ? 'text-late' : 'text-primary'
            )}>
              {mark ?? initialsOf(title)}
            </AvatarFallback>
          </Avatar>
        )}
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-display text-2xl/[1.25] font-bold tracking-[-0.02em] text-foreground">{title}</h1>
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
              <Button variant="secondary" size="icon-sm" aria-label="More actions" className="shrink-0 border border-border-strong text-secondary-text hover:text-foreground">
                <MoreHorizontal strokeWidth={2.4} aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-48 rounded-lg p-1.5">
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
