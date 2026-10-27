import { Fragment, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowRight, Check, ChevronRight, CircleAlert, Clock, Info, X } from 'lucide-react';
import { cn } from 'cn';
import { Chip, initialsOf } from '../record.jsx';
import { Card, Empty, ErrorState, Select } from '../ui.jsx';
import { Button } from '../ui/button';
import { Skeleton } from '../ui/skeleton.tsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs.tsx';
import { useFetch, useLookups, useMediaQuery } from '../../lib/hooks.js';
import { number, periodLabel } from '../../lib/format.js';
import { currentRecordPath, journeyBoard } from '../../lib/journey.js';
import { localToday } from '../../lib/reportPeriods.js';
import {
  PERIODS, boardColumns, boardRequest, cardStatus, cardValue, cohortChipText, columnValueText, funnelFigures, hiddenText, isFiltered,
  medianText, periodPhrase, readBoardQuery, withFilters, withoutRateText,
} from './boardModel.js';
import { JourneyDrawer } from './JourneyDrawer.jsx';

/**
 * Every open sale by where it has got to: the Pipeline's Journey view
 * (docs/specs/sales-journey §4 B; web layer §3, Pipeline).
 *
 * The stage board shows quotations only, so an enquiry waiting for a quote
 * and a won deal waiting for its PO, which is where a sale most often
 * stalls, were nowhere on it. This shows the whole sale: three columns,
 * Enquiry, Quotation and PO, with the funnel for a period above them.
 *
 * Nothing is dragged here (spec D5). A card opens the drawer, to see the
 * sale's steps without leaving the board; its next action opens the
 * record where that action lives (spec C4). The server says where every
 * sale is and what it waits on; the board only lays it out.
 *
 * The filters live in the address bar (web/CLAUDE.md §2.4), so a link
 * carries them. The owner sits in the page header, beside the switch to
 * Quotation stages, because both views filter by it.
 */
export function JourneyBoard() {
  const lookups = useLookups();
  const [params, setParams] = useSearchParams();
  const today = localToday();
  const filters = readBoardQuery(params, today);
  const request = boardRequest(filters);
  const { data, error, refetch } = useFetch(() => journeyBoard(request), [JSON.stringify(request)]);
  // Tailwind's `lg`: three columns side by side above it, three tabs below.
  const wide = useMediaQuery('(min-width: 64rem)');
  // The card stays after the drawer closes, so it slides out still showing it.
  const [drawer, setDrawer] = useState({ card: null, open: false });

  const set = (changes) => setParams(withFilters(params, changes, today), { replace: true });
  const columns = boardColumns(data);
  const cards = data?.cards ?? [];
  const open = (card) => setDrawer({ card, open: true });

  const custom = filters.period === 'custom'
    ? [{ value: 'custom', label: periodLabel({ from: filters.from, to: filters.to }) }]
    : [];

  return (
    <div className="page stack">
      <div className="flex flex-wrap items-center gap-2" aria-label="Filters" role="group">
        <Select
          className="w-auto"
          aria-label="Period"
          placeholder={null}
          value={filters.period}
          options={[...PERIODS.map((p) => ({ value: p.key, label: p.label })), ...custom]}
          onChange={(e) => set({ period: e.target.value })}
        />
        {lookups.services.length > 0 && (
          <Select
            className="w-auto max-w-[260px]"
            aria-label="Service"
            placeholder="Service: all"
            value={filters.service}
            options={lookups.services}
            onChange={(e) => set({ service: e.target.value })}
          />
        )}
        <Toggle on={filters.stuck} onClick={() => set({ stuck: !filters.stuck })}>
          Stuck only
          {/* The server counts it before the switch, so it reads the same on and off. */}
          {data?.stuck_count != null && <span className="num rounded-sm bg-secondary px-1.5 text-[11px] text-secondary-text">{number(data.stuck_count)}</span>}
        </Toggle>
        <Toggle on={filters.closed} onClick={() => set({ closed: !filters.closed })}>Show closed</Toggle>
      </div>

      {error && !data ? (
        <Card><ErrorState message={error} onRetry={refetch} /></Card>
      ) : (
        <>
          <Funnel data={data} filters={filters} wide={wide} onCohort={(cohort) => set({ cohort })} />

          {!data ? (
            <div className={cn('grid gap-3', wide && 'grid-cols-3')} aria-busy="true" aria-label="Loading the board">
              {(wide ? columns : columns.slice(0, 1)).map((c) => <Skeleton key={c.key} className="h-[320px] rounded-lg" />)}
            </div>
          ) : cards.length === 0 ? (
            <Card>
              {isFiltered(filters) ? (
                <Empty
                  title="No sales match these filters"
                  text="Clear them to see every open sale again."
                  action={(
                    <Button variant="outline" size="sm" onClick={() => set({ sales_person: '', service: '', stuck: false, closed: false, cohort: '' })}>
                      Clear filters
                    </Button>
                  )}
                />
              ) : (
                <Empty
                  title="No open sales yet"
                  text="Each sale shows here as one card, from its first enquiry to its paid PO, at the step it has reached. Log an enquiry to start one."
                  action={<Button asChild size="sm"><Link to="/enquiries">New enquiry</Link></Button>}
                />
              )}
            </Card>
          ) : wide ? (
            <div className="grid grid-cols-3 items-start gap-3">
              {columns.map((column) => <Column key={column.key} column={column} onOpen={open} />)}
            </div>
          ) : (
            <Tabs defaultValue={columns.find((c) => c.cards.length)?.key ?? columns[0].key} className="gap-3">
              <TabsList className="w-full">
                {columns.map((column) => (
                  <TabsTrigger key={column.key} value={column.key} className="text-[13px]">
                    {column.label}
                    <span className="num rounded-sm bg-secondary px-1.5 text-[11px] text-secondary-text">{number(column.count)}</span>
                  </TabsTrigger>
                ))}
              </TabsList>
              {columns.map((column) => (
                <TabsContent key={column.key} value={column.key}>
                  <Column column={column} onOpen={open} />
                </TabsContent>
              ))}
            </Tabs>
          )}

          {data && (
            <p className="text-[12.5px] text-muted-foreground">
              Lost and unqualified sales leave the board; Show closed brings them back.
              {data.settings?.paid_visible_days != null && ` A paid sale stays for ${number(data.settings.paid_visible_days)} days after its last payment.`}
            </p>
          )}
        </>
      )}

      <JourneyDrawer
        card={drawer.card}
        open={drawer.open}
        onOpenChange={(isOpen) => setDrawer((d) => ({ ...d, open: isOpen }))}
      />
    </div>
  );
}

export default JourneyBoard;

/** A filter that is on or off, saying which with its fill and a tick. */
function Toggle({ on, onClick, children }) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        'h-control text-[13px]',
        on && 'border-primary/40 bg-primary/12 text-primary hover:bg-primary/12 hover:text-primary dark:border-primary/40 dark:bg-primary/12 dark:hover:bg-primary/12'
      )}
    >
      {on && <Check strokeWidth={2.4} aria-hidden="true" />}
      {children}
    </Button>
  );
}

/**
 * The funnel for the period: Started, Quoted, Won, With PO, with the share
 * that went on between each. Every figure opens the sales behind it
 * (web/CLAUDE.md §2.5), closed ones included (spec D9), and pressing the
 * one that is open shows the whole board again.
 */
function Funnel({ data, filters, wide, onCohort }) {
  const figures = funnelFigures(data?.funnel);
  const chip = cohortChipText(filters);
  return (
    <section aria-label="Funnel" className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="m-0 font-display text-base font-bold text-foreground">Sales started {periodPhrase(filters)}</h2>
        {/* A period a link brought is already named by its dates. */}
        {data?.period && filters.period !== 'custom' && <span className="num text-[12.5px] text-muted-foreground">{periodLabel(data.period)}</span>}
      </div>
      {data ? (
        <div className={cn('mt-3', wide ? 'flex items-stretch gap-2' : 'grid grid-cols-2 gap-2')}>
          {figures.map((figure, i) => {
            const on = filters.cohort === figure.key;
            return (
              <Fragment key={figure.key}>
                {wide && i > 0 && (
                  <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
                    <ChevronRight className="size-4" strokeWidth={1.75} aria-hidden="true" />
                    {figure.conversion && <Chip>{figure.conversion}</Chip>}
                  </span>
                )}
                <button
                  type="button"
                  aria-pressed={on}
                  onClick={() => onCohort(on ? '' : figure.key)}
                  className={cn(
                    'flex min-w-0 flex-1 flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left transition-colors duration-150',
                    on ? 'border-primary/40 bg-primary/12' : 'border-border hover:border-primary/40 hover:bg-accent'
                  )}
                >
                  <span className="eyebrow">{figure.label}</span>
                  <span className={cn('num text-2xl font-semibold', on ? 'text-primary' : 'text-foreground')}>{number(figure.count)}</span>
                  {/* Two by two there is no "between", so the share sits under its figure. */}
                  {!wide && figure.conversion && <span className="text-[12px] text-muted-foreground">{figure.conversion}</span>}
                </button>
              </Fragment>
            );
          })}
        </div>
      ) : (
        <Skeleton className="mt-3 h-[72px] rounded-md" />
      )}
      {chip && (
        <div className="mt-3">
          {/* A custom period makes a long phrase; it wraps inside the strip on a phone. */}
          <Chip tone="info" className="h-auto min-h-[22px] max-w-full whitespace-normal py-0.5 pr-1 text-left">
            {chip}
            <button
              type="button"
              onClick={() => onCohort('')}
              aria-label="Show every sale again"
              className="grid size-5 shrink-0 place-items-center rounded-full hover:bg-info/15"
            >
              <X className="size-3" strokeWidth={2.4} aria-hidden="true" />
            </button>
          </Chip>
        </div>
      )}
    </section>
  );
}

/**
 * One big step: how many sales are at it, what they are worth in ₹, and
 * how long they have typically been there, over its cards.
 */
function Column({ column, onOpen }) {
  const headingId = `journey-column-${column.key}`;
  const median = medianText(column.median_days);
  const left = withoutRateText(column.without_rate);
  const hidden = hiddenText(column);
  return (
    <section aria-labelledby={headingId} className="min-w-0 rounded-lg border border-border bg-muted">
      <div className="rounded-t-lg border-b border-border bg-card px-3 py-2.5">
        <div className="flex items-center gap-2">
          <h2 id={headingId} className="m-0 font-display text-[14px] font-bold text-foreground">{column.label}</h2>
          <span className="num rounded-full bg-secondary px-2 text-[11px] font-semibold text-secondary-text">{number(column.count)}</span>
        </div>
        {column.count > 0 && (
          <div className="num mt-1 text-[12px] text-muted-foreground">
            {columnValueText(column)}{median && <> · {median}</>}
          </div>
        )}
        {left && <p className="m-0 mt-1 text-[12px] text-waiting">{left}</p>}
        {hidden && <p className="m-0 mt-1 text-[12px] text-muted-foreground">{hidden}</p>}
      </div>
      {column.cards.length ? (
        <ul className="m-0 flex list-none flex-col gap-2 p-2">
          {column.cards.map((card) => <JourneyCard key={card.key} card={card} onOpen={onOpen} />)}
        </ul>
      ) : (
        <p className="m-0 p-3 text-[12.5px] text-muted-foreground">No sales at {column.label}.</p>
      )}
    </section>
  );
}

/** A tone's glyph, so a chip is never colour alone (web/CLAUDE.md §1). */
const TONE_GLYPHS = { late: CircleAlert, waiting: Clock, info: Info, settled: Check };

/** The three big steps as segments, in the state each is in (server §3.2). */
const SEGMENT = {
  done: 'bg-settled',
  current: 'bg-primary',
  exit: 'bg-late',
  skipped: 'border border-border-strong bg-card',
  future: 'bg-border',
};

/**
 * One sale. The card is a button that opens the drawer; the next action
 * under it is a link of its own to the record where that action lives,
 * and is not inside the button, so pressing it never opens the drawer.
 */
function JourneyCard({ card, onOpen }) {
  const path = currentRecordPath(card);
  const status = cardStatus(card);
  return (
    <li className="rounded-md border border-border bg-card transition-colors duration-150 hover:border-primary/60">
      <button
        type="button"
        data-journey-card={card.key}
        aria-haspopup="dialog"
        onClick={() => onOpen(card)}
        className="block w-full rounded-md px-3 pt-2.5 pb-2 text-left"
      >
        <span className="flex items-start gap-2">
          <span className="min-w-0 flex-1 text-[13px] font-semibold text-foreground">{card.client_name || 'No client named'}</span>
          {card.sales_person && (
            <span title={card.sales_person} className="grid size-6 shrink-0 place-items-center rounded-full bg-secondary text-[10px] font-bold text-primary">
              <span aria-hidden="true">{initialsOf(card.sales_person)}</span>
              <span className="sr-only">, owner {card.sales_person}</span>
            </span>
          )}
        </span>
        <span className="mt-0.5 block text-[12.5px] text-secondary-text">{card.service || 'No service named'}</span>
        <span className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className={cn('num text-[13px] font-semibold', card.value == null && card.value_inr == null ? 'text-muted-foreground' : 'text-foreground')}>{cardValue(card)}</span>
          <span className="ml-auto">
            {status.chip
              ? <Chip tone={status.chip.tone} icon={TONE_GLYPHS[status.chip.tone]}>{status.chip.label}</Chip>
              : status.days && <span className="num text-[11.5px] text-muted-foreground">{status.days}</span>}
          </span>
        </span>
        <span className="mt-2 flex items-center gap-2">
          <span aria-hidden="true" className="flex shrink-0 gap-0.5">
            {(card.progress || []).map((state, i) => (
              <span key={i} className={cn('h-1.5 w-4 rounded-[2px]', SEGMENT[state] || SEGMENT.future)} />
            ))}
          </span>
          {card.small_step && <span className="min-w-0 truncate text-[12px] text-secondary-text">{card.small_step}</span>}
        </span>
      </button>
      {card.next && path && (
        <div className="border-t border-border px-3 py-1.5">
          <Link to={path} className="inline-flex items-center gap-1 text-[12.5px] font-semibold text-primary no-underline hover:underline">
            {card.next.label}
            <ArrowRight className="size-3.5" strokeWidth={2} aria-hidden="true" />
          </Link>
        </div>
      )}
    </li>
  );
}
