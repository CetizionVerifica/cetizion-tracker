import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, CircleAlert, Clock, Info } from 'lucide-react';
import { cn } from 'cn';
import { Chip } from '../record.jsx';
import { Timeline } from '../Timeline.jsx';
import { ErrorState } from '../ui.jsx';
import { Button } from '../ui/button';
import {
  Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle,
} from '../ui/sheet.tsx';
import { Skeleton } from '../ui/skeleton.tsx';
import { useFetch } from '../../lib/hooks.js';
import { date } from '../../lib/format.js';
import { currentRecordPath, factValue, journeyOf } from '../../lib/journey.js';
import {
  STATE_WORDS, cardValue, drawerView, exitChip, journeyLookup, openingStep, stepAfter, timelineOf,
} from './boardModel.js';

/**
 * One sale from the Journey board, opened beside it
 * (docs/specs/sales-journey §4 B; web layer §2, JourneyDrawer).
 *
 * The card says where a sale is; this says how it got there without
 * leaving the board. Its three steps run down the side as buttons, the
 * one the sale is on open first, and each shows what its record holds:
 * the facts, the small steps, and the record's own timeline. The arrow
 * keys walk the steps, Esc closes, and focus goes back to the card that
 * opened it, so a keyboard can work down a column one sale at a time.
 *
 * Nothing moves a sale here. The one button is the card's next action,
 * and like the card's it opens the record where that action lives (spec
 * C4); **Open full page** opens the step's record as it is.
 */
export function JourneyDrawer({ card, open, onOpenChange }) {
  return (
    <Sheet open={Boolean(open && card)} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full gap-0 border-border bg-background p-0 sm:max-w-[460px]"
        // The drawer puts focus on the step it opens at itself (DrawerBody),
        // which is where the arrow keys work, rather than on the first button.
        onOpenAutoFocus={(e) => e.preventDefault()}
        // Opened from a card rather than a Radix trigger, so Radix has nowhere
        // to send focus back to; the card is found by its key and given it.
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          if (card) document.querySelector(`[data-journey-card="${CSS.escape(card.key)}"]`)?.focus();
        }}
      >
        {/* Mounted only while the sheet is, so every opening reads the
            journey afresh and a closing sheet keeps what it showed. */}
        {card && <DrawerBody card={card} />}
      </SheetContent>
    </Sheet>
  );
}

export default JourneyDrawer;

/** A tone's glyph, so a chip is never colour alone (web/CLAUDE.md §1). */
const TONE_GLYPHS = { late: CircleAlert, waiting: Clock, info: Info, settled: Check };

const toneChip = ({ label, tone }) => <Chip tone={tone} icon={TONE_GLYPHS[tone]}>{label}</Chip>;

function DrawerBody({ card }) {
  const of = journeyLookup(card);
  const journey = useFetch(() => (of ? journeyOf(of) : Promise.reject(new Error('This sale has no record to open.'))), [JSON.stringify(of)]);
  const detail = journey.data;
  const { steps, nowLabel, badge } = drawerView(card, detail);
  const sale = detail ?? card;

  const [at, setAt] = useState(() => openingStep(card));
  const buttons = useRef({});
  const panelId = useId();
  // Opening lands on the step the sale is on, so ↑ and ↓ work straight away.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { buttons.current[at]?.focus(); }, []);

  function onKeyDown(e) {
    const moves = { ArrowDown: 1, ArrowUp: -1, Home: -steps.length, End: steps.length };
    if (!(e.key in moves)) return;
    e.preventDefault();
    const next = stepAfter(at, moves[e.key]);
    setAt(next);
    buttons.current[next]?.focus();
  }

  const step = steps.find((s) => s.key === at) ?? steps[0];
  // A step's record is read off the sale's numbers, so both buttons are
  // there before the journey arrives; a step with no record has neither.
  const pagePath = currentRecordPath({ step: step.key, records: sale.records });
  const nextPath = currentRecordPath(sale);
  const showNext = Boolean(step.state === 'current' && sale.next && nextPath);

  return (
    <>
      <SheetHeader className="gap-1 border-b border-border px-5 py-4 pr-12">
        {nowLabel && (
          <div className={cn('text-[11px] font-bold uppercase tracking-[0.12em]', card.exit && card.exit !== 'paid' ? 'text-late' : 'text-primary')}>
            {nowLabel}
          </div>
        )}
        <SheetTitle className="font-display text-base font-bold">{card.client_name || 'No client named'}</SheetTitle>
        <SheetDescription className="text-[13px] text-secondary-text">
          {card.service || 'No service named'} · <span className="num">{cardValue(card)}</span>
        </SheetDescription>
      </SheetHeader>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-4 px-5 py-4 sm:grid-cols-[148px_minmax(0,1fr)]">
          <nav aria-label="Steps of this sale">
            <ol className="m-0 flex list-none flex-col p-0" onKeyDown={onKeyDown}>
              {steps.map((s, i) => (
                <li key={s.key} className="relative">
                  {/* The connector is lit when the step above it is done,
                      as on the record rail, so the colour stops where the
                      sale did. */}
                  {i < steps.length - 1 && (
                    <span aria-hidden="true" className={cn('absolute top-9 bottom-0 left-[17px] w-0.5 rounded-full', s.state === 'done' ? 'bg-settled' : 'bg-border')} />
                  )}
                  <button
                    type="button"
                    ref={(el) => { buttons.current[s.key] = el; }}
                    aria-pressed={s.key === at}
                    aria-controls={panelId}
                    onClick={() => setAt(s.key)}
                    className="relative flex w-full items-start gap-2.5 rounded-md px-1.5 py-2 text-left transition-colors duration-150 hover:bg-accent aria-pressed:bg-accent"
                  >
                    <StepDisc state={s.state} n={i + 1} />
                    <span className="min-w-0 pt-0.5">
                      <span className={cn(
                        'block text-[13px]',
                        s.state === 'current' ? 'font-semibold text-primary' : s.state === 'exit' ? 'font-semibold text-late' : s.state === 'done' ? 'font-medium text-foreground' : 'font-medium text-muted-foreground'
                      )}>
                        {s.label}
                        <span className="sr-only">, {STATE_WORDS[s.state] ?? 'To come'}</span>
                      </span>
                      {/* The number keeps to one line, cut short with the whole of it on hover;
                          the date and the count under it may wrap. */}
                      {s.lines.map((line, n) => (
                        <span key={line} title={n === 0 ? line : undefined} className={cn('num mt-0.5 block text-[11px] text-muted-foreground', n === 0 && 'truncate')}>{line}</span>
                      ))}
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          </nav>

          <section id={panelId} aria-label={step.label} className="min-w-0">
            <StepPanel step={step} sale={sale} badge={badge} journey={journey} />
          </section>
        </div>

        {/* Keyed by the record, so another step's timeline starts from its
            own first page and filter rather than the last one's. */}
        {detail && timelineOf(step.record) && (
          <div className="px-5 pb-5">
            <Timeline key={step.key} {...timelineOf(step.record)} />
          </div>
        )}
      </div>

      {(showNext || pagePath) && (
        <SheetFooter className="mt-0 flex-row flex-wrap gap-2 border-t border-border px-5 py-3">
          {showNext && (
            <Button asChild size="sm">
              <Link to={nextPath}>{sale.next.label}</Link>
            </Button>
          )}
          {pagePath && (
            <Button asChild size="sm" variant="outline">
              <Link to={pagePath}>Open full page</Link>
            </Button>
          )}
        </SheetFooter>
      )}
    </>
  );
}

/** The disc of a step, drawn as the record rail draws it (web/CLAUDE.md §4). */
function StepDisc({ state, n }) {
  const done = state === 'done';
  const current = state === 'current';
  const exit = state === 'exit';
  return (
    <span aria-hidden="true" className={cn(
      'num relative grid size-6 shrink-0 place-items-center rounded-full text-[11px] font-bold',
      done && 'bg-settled text-primary-foreground',
      current && 'bg-primary text-primary-foreground ring-4 ring-primary/20',
      exit && 'bg-late text-late-foreground ring-4 ring-late/20',
      !done && !current && !exit && 'border border-border-strong bg-card text-muted-foreground'
    )}>
      {done ? <Check className="size-3.5" strokeWidth={3} /> : exit ? '!' : n}
    </span>
  );
}

/**
 * What the open step holds. The step's state comes first as a chip, with
 * days in step on the current one and its flag when the flag is about
 * something other than time; then the record's facts, as the server sent
 * them and formatted here; then its small steps. A step with no record
 * says so and offers nothing.
 */
function StepPanel({ step, sale, badge, journey }) {
  if (!journey.data) {
    if (journey.loading) {
      return (
        <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading the journey">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      );
    }
    return (
      <ErrorState
        message={journey.errorStatus === 404
          ? 'This sale could not be found, or it is not one you can open.'
          : 'The journey for this sale could not be loaded.'}
        onRetry={journey.refetch}
      />
    );
  }

  const exit = step.state === 'exit' || (step.key === 'po' && sale.exit === 'paid') ? exitChip(sale.exit) : null;
  const flag = step.state === 'current' && sale.flag && sale.flag.kind !== 'stuck' && sale.flag.kind !== 'slow' ? sale.flag : null;
  let chip;
  if (exit) chip = toneChip(exit);
  else if (step.state === 'current' && badge) chip = toneChip(badge);
  else if (step.state === 'done') chip = toneChip({ label: STATE_WORDS.done, tone: 'settled' });
  else chip = <Chip>{STATE_WORDS[step.state] ?? STATE_WORDS.future}</Chip>;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="m-0 font-display text-base font-bold text-foreground">{step.label}</h3>
          {chip}
          {flag && toneChip(flag)}
        </div>
        {step.state === 'current' && step.since && (
          <p className="mt-1 text-[12px] text-muted-foreground">Here since {date(step.since)}</p>
        )}
      </div>

      {!step.record ? (
        <p className="m-0 text-[13px] text-secondary-text">
          {step.state === 'skipped'
            ? `The sale went past ${step.label} without one on record.`
            : `Not recorded yet: the sale has not reached ${step.label}.`}
        </p>
      ) : (
        <>
          {step.facts.length > 0 && (
            <dl className="m-0 grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
              {step.facts.map((fact) => (
                <div key={fact.label} className="min-w-0">
                  <dt className="text-[12px] text-muted-foreground">{fact.label}</dt>
                  <dd className="num m-0 mt-0.5 break-words text-[13px] text-foreground">{factValue(fact)}</dd>
                </div>
              ))}
            </dl>
          )}

          {step.small.length > 0 && (
            <div>
              <div className="eyebrow" aria-hidden="true">Inside {step.label}</div>
              <ol aria-label={`Inside ${step.label}`} className="m-0 mt-2 flex list-none flex-col gap-2 p-0">
                {step.small.map((small) => <SmallStep key={small.label} {...small} />)}
              </ol>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** One small step: a dot, its name, and its date when one is known. */
function SmallStep({ label, state = 'future', date: when }) {
  const done = state === 'done';
  const current = state === 'current';
  return (
    <li aria-current={current ? 'step' : undefined} className="flex items-center gap-2 text-[12.5px]">
      <span aria-hidden="true" className={cn(
        'grid size-3.5 shrink-0 place-items-center rounded-full',
        done && 'bg-settled text-primary-foreground',
        current && 'bg-primary ring-2 ring-primary/25',
        !done && !current && 'border border-border-strong bg-card'
      )}>
        {done && <Check className="size-2.5" strokeWidth={3.5} />}
      </span>
      <span className={current ? 'font-semibold text-primary' : done ? 'font-medium text-foreground' : 'text-muted-foreground'}>
        {label}
        <span className="sr-only">, {STATE_WORDS[state] ?? STATE_WORDS.future}</span>
      </span>
      {when && <span className="num ml-auto text-[11px] text-muted-foreground">{date(when)}</span>}
    </li>
  );
}
