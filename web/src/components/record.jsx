import { Link } from 'react-router-dom';
import { Check, MoreHorizontal } from 'lucide-react';
import { cn } from 'cn';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { ControlBar } from './shell/Shell.jsx';

/**
 * The record page, as the Mocha Glass RecordHeader draws it — one shape for
 * Company, Project, Trip, Deal and Order.
 *
 * Those five pages each grew their own layout, so the same question
 * ("what is this and what is wrong with it?") was answered in five
 * arrangements. The design gives one: breadcrumbs beside the control bar,
 * a strong-glass header card (eyebrow, Fraunces title that wraps, its
 * state badges, at most one primary action and a ⋯ menu, then the key
 * facts as a `mg-facts` grid), the flow ladder or four figures, then the
 * record's own sections beside a rail.
 *
 * The rule that keeps it readable is in the design's note on the company
 * record: the figures in the top row are **the ones somebody asks before
 * they pick up the phone**. Not every number the record has — the four
 * that decide what to say.
 */

/** A card that keeps the system's glass radius and its own padding. */
const PANEL = 'gap-0 py-0';

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

const FIGURE_TONE = { late: 'text-late', waiting: 'text-caramel-text', settled: 'text-ok', info: 'text-info' };

/**
 * A figure in the top row: a glass stat tile.
 *
 * `tone` colours the number, and is for money that is late or a state
 * that is wrong — never for decoration. The line underneath says what the
 * figure is made of, which is what stops a bare number being a puzzle.
 * `badge` is a state said in words under the figure ("1 invoice, 9 days late").
 */
export function RecordStat({ label, value, detail, tone, badge }) {
  return (
    <div className="mg-glass mg-tile" data-a="rise">
      <span className="mg-label">{label}</span>
      <span className={cn('mg-tile__figure mg-num', FIGURE_TONE[tone])}>{value}</span>
      {(badge || detail) && (
        <span className="mg-tile__foot">
          {badge}
          {detail && <span>{detail}</span>}
        </span>
      )}
    </div>
  );
}

/** A card with a header: a title, an optional hint, an optional action. */
export function RecordSection({ title, hint, action, children, className }) {
  return (
    <Card className={cn(PANEL, 'overflow-hidden', className)}>
      <CardHeader className="flex min-h-12 flex-row flex-wrap items-center gap-x-3 gap-y-1 space-y-0 border-b border-border px-5 py-2.5">
        {/* The title never shrinks: letting it wrap broke the header and
            pushed it into the hint beside it. The hint wraps instead. */}
        <CardTitle className="shrink-0 text-[14.5px] font-bold text-foreground">{title}</CardTitle>
        {hint && <span className="min-w-0 flex-[1_1_160px] text-[12.5px] font-normal text-muted-foreground">{hint}</span>}
        {action && <div className="ml-auto flex items-center gap-2">{action}</div>}
      </CardHeader>
      <CardContent className="p-0">{children}</CardContent>
    </Card>
  );
}

/**
 * A row: an icon square, what it is and its meta line, then how much with
 * its state under it. The amount is right-aligned in tabular figures, so a
 * column of them reads as a column of money rather than as ragged text.
 */
export function RecordRow({ icon: Icon, to, title, meta, chip, amount, muted, last }) {
  const inner = (
    <>
      {Icon && <span className="app-recrow__icon"><Icon strokeWidth={1.75} aria-hidden="true" /></span>}
      <span className="app-recrow__text">
        <b>{title}</b>
        {meta && <span>{meta}</span>}
      </span>
      {(amount !== undefined || chip) && (
        <span className="app-recrow__end">
          {amount !== undefined && <b>{amount}</b>}
          {chip}
        </span>
      )}
    </>
  );
  const className = cn('app-recrow', muted && 'is-muted', last && 'is-last');
  return to ? <Link to={to} className={className}>{inner}</Link> : <div className={className}>{inner}</div>;
}

/** The states a row can be in, as the system's badges: never hue alone. */
const CHIP_TONES = {
  late: 'mg-badge--late',
  waiting: 'mg-badge--wait',
  settled: 'mg-badge--ok',
  info: 'mg-badge--info',
  plain: 'mg-badge--plain',
};

/**
 * A state, as a badge: late, waiting, settled, info or nothing. The word
 * is the state; the dot and the hue only agree with it.
 */
export function Chip({ tone = 'plain', icon: Icon, className, children }) {
  return (
    <span className={cn('mg-badge', CHIP_TONES[tone] || CHIP_TONES.plain, className)}>
      {Icon && <Icon className="size-3" strokeWidth={2.4} aria-hidden="true" />}
      {children}
    </span>
  );
}

/** A person in the rail: initials, name, and what they are to this record. */
export function RailPerson({ name, detail, last, badge }) {
  return (
    <div className={cn('flex items-center gap-3 px-5 py-3', !last && 'border-b border-border')}>
      <span className="mg-avatar size-[34px] shrink-0 text-[11.5px]">{initialsOf(name)}</span>
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] font-bold text-foreground [overflow-wrap:anywhere]">{name}</div>
        {detail && <div className="text-[12px] text-muted-foreground">{detail}</div>}
      </div>
      {badge}
    </div>
  );
}

/** Something that happened, in the rail: what, when, and one line of detail. */
export function RailEvent({ what, when, detail, last }) {
  return (
    <div className={cn('px-5 py-3', !last && 'border-b border-border')}>
      <div className="flex gap-2">
        <span className="text-[12.5px] font-semibold text-foreground">{what}</span>
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
export function RecordMenuItem({ children, danger, ...props }) {
  return (
    <DropdownMenuItem variant={danger ? 'destructive' : undefined} {...props}>
      {children}
    </DropdownMenuItem>
  );
}

/**
 * One rung of the FlowLadder: a disc, what that step is called, and a note
 * (a date, who, or what is missing).
 *
 * `state` is handed in by the page and never worked out here. A step is
 * "current" for reasons only the record knows — the order decides it from
 * its stages, the deal from its status and its PO — so the component
 * draws the state it is given and holds no opinion about it.
 */
export function FlowStep({ label, state = 'future', since, index }) {
  return (
    <li className={cn('mg-ladder__step', state === 'done' && 'is-done', state === 'current' && 'is-current', state === 'blocked' && 'is-blocked')} aria-current={state === 'current' ? 'step' : undefined}>
      <span className="mg-ladder__disc">
        {state === 'done' ? <Check strokeWidth={3} aria-hidden="true" /> : state === 'blocked' ? '!' : index + 1}
      </span>
      <span className="mg-ladder__text">
        <span className="mg-ladder__label">{label}</span>
        {since && <span className="mg-ladder__note">{since}</span>}
        <span className="sr-only">{state === 'done' ? ', done' : state === 'current' ? ', next' : state === 'blocked' ? ', blocked' : ''}</span>
      </span>
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
 * backwards. A step may say `blocked` (the discount was rejected).
 */
export function flowSteps(reached) {
  const lastDone = reached.reduce((last, step, i) => (step.done ? i : last), -1);
  return reached.map((step, i) => ({
    label: step.label,
    since: step.since,
    state: step.done ? 'done' : i === lastDone + 1 ? (step.blocked ? 'blocked' : 'current') : 'future',
  }));
}

/**
 * Where the record has got to, and the one move that takes it forward.
 *
 * A strong-glass panel: an optional banner (the discount's verdict), the
 * ladder, the sentence that is the page's whole opinion about the record,
 * the primary move and at most one secondary — everything else belongs in
 * the header's menu, which is the point of the shape. `note` is the small
 * print: what the primary button will actually do, and what is in the menu.
 */
export function RecordFlow({ steps = [], verdict, actions, note, banner, title = 'Where it stands' }) {
  const at = steps.findIndex((s) => s.state === 'current' || s.state === 'blocked');
  const next = at >= 0 ? steps[at] : null;
  return (
    <section className="mg-glass mg-glass--strong app-flow" data-a="rise" aria-label={title}>
      {banner}
      <div className="app-flow__head">
        <h2>{title}</h2>
        {steps.length > 0 && (
          <span>{next ? `step ${at + 1} of ${steps.length} · next: ${next.label}` : steps.every((s) => s.state === 'done') ? 'every step done' : `${steps.length} steps`}</span>
        )}
      </div>
      {steps.length > 0 && (
        <ol className="mg-ladder">
          {steps.map((step, i) => <FlowStep key={step.label} {...step} index={i} />)}
        </ol>
      )}
      {(verdict || actions) && (
        <div className="app-flow__say">
          {verdict && <p>{verdict}</p>}
          {actions && <div className="app-flow__acts">{actions}</div>}
        </div>
      )}
      {note && <p className="app-flow__note">{note}</p>}
    </section>
  );
}

/**
 * The whole page.
 *
 * `facts` is the line under the title — the handful of things that are
 * true about this record whatever else is happening. `factsGrid` is the
 * header's labelled facts (`[{ label, value }]`), `badges` its state, and
 * `headExtra` anything that belongs inside the header card (a banner).
 * `stats` is the four figures, and `flow` is the ladder that replaces them
 * on the records whose question is "how far has this got?". `rail` is
 * reference on the right (above the sections on narrow screens when
 * `railFirst`), and like Today's rail it should not hold the primary action.
 */
export function RecordPage({
  parent, parentTo, title, crumb, mark, markTone, eyebrow, badges, facts = [], factsGrid, headExtra,
  action, menu, flow, stats, children, rail, railFirst = false,
}) {
  return (
    <div className="app-page app-rec">
      <div className="app-rec__bar">
        <nav className="mg-crumbs" aria-label="Breadcrumb">
          <Link to={parentTo}>{parent}</Link>
          <span aria-hidden="true">›</span>
          <b aria-current="page">{crumb || title}</b>
        </nav>
        <ControlBar />
      </div>

      <section className="mg-glass mg-glass--strong mg-record app-rec__head" data-a="rise">
        <div className="app-rec__top">
          {/* `false` means this record has no mark at all — the deal and the
              order carry their identity in the title and the facts row.
              `undefined` still falls back to the title's initials. */}
          {mark !== false && (
            <span className={cn('app-rec__mark', markTone === 'late' && 'text-late')} aria-hidden="true">
              {mark ?? initialsOf(title)}
            </span>
          )}
          <div className="app-rec__titles">
            {eyebrow && <span className="mg-eyebrow">{eyebrow}</span>}
            <h1 className="mg-record__title">{title}</h1>
            {badges && <div className="app-rec__badges">{badges}</div>}
            {facts.filter(Boolean).length > 0 && (
              <div className="app-rec__line">
                {facts.filter(Boolean).map((fact, i) => <span key={i}>{fact}</span>)}
              </div>
            )}
          </div>
          {(action || menu) && (
            <div className="mg-record__actions">
              {action}
              {menu && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button type="button" className="mg-btn mg-btn--icon" aria-label="More actions">
                      <MoreHorizontal className="size-[18px]" strokeWidth={2.2} aria-hidden="true" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-56">
                    {menu}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          )}
        </div>
        {factsGrid?.length > 0 && (
          <dl className="mg-facts">
            {factsGrid.filter(Boolean).map((f) => (
              <div key={f.label} className="min-w-0">
                <dt>{f.label}</dt>
                <dd>{f.value ?? <span className="font-normal text-muted-foreground">—</span>}</dd>
              </div>
            ))}
          </dl>
        )}
        {headExtra}
      </section>

      {flow}

      {stats && <div className="app-rec__stats">{stats}</div>}

      <div className={cn('app-rec__body', rail && 'has-rail', rail && railFirst && 'rail-first')}>
        <div className="app-rec__main">{children}</div>
        {rail && <aside className="app-rec__rail" aria-label="On this record">{rail}</aside>}
      </div>
    </div>
  );
}
