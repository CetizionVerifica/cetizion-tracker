import { Fragment, useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { RecordFlow } from '../record.jsx';
import { Button } from '../ui/button';
import { Skeleton } from '../ui/skeleton.tsx';
import { useFetch } from '../../lib/hooks.js';
import { factValue, journeyOf, railProps } from '../../lib/journey.js';

/**
 * The sale a record belongs to, as three steps: Enquiry, Quotation, PO
 * (docs/specs/sales-journey).
 *
 * Each sales page used to draw a rail of its own: nine rungs on the deal,
 * a different five on the order, the onboarding stages on the project.
 * None could be clicked, and the same sale read differently depending on
 * which of its pages you opened. This draws the one journey the server
 * works out for the record (`GET /api/journey/of`), the same on every page
 * that holds a part of it, and every step that has a record opens it.
 *
 * The page keeps its own opinion. `verdict`, `actions` and `note` are its
 * sentence, its one primary button and its small print, passed through as
 * they were, and they show whatever happens to the journey: while it
 * loads, a skeleton holds the rail's place, and if it cannot be read the
 * page says so in one line and keeps its button. A record never loses the
 * move that takes it forward because the journey failed to load.
 *
 * `refreshKey` is anything that changes when the page reloads its record
 * (the record itself will do), so the rail catches up after an action.
 * `onJourney` hears each journey as it arrives, so the page can tell which
 * of its links the viewer may open (`steps[].reachable`, server §6).
 */
export function JourneyRail({ of, verdict, actions, note, refreshKey, onJourney }) {
  const { pathname } = useLocation();
  const journey = useFetch(() => journeyOf(of), [JSON.stringify(of), refreshKey]);
  const page = { verdict, actions, note };
  const heard = useRef(onJourney);
  heard.current = onJourney;
  useEffect(() => { if (journey.data) heard.current?.(journey.data); }, [journey.data]);

  // A reload keeps the journey it had until the new one arrives, so acting
  // on the page does not flash the rail back to a skeleton.
  if (!journey.data) {
    return (
      <RecordFlow
        {...page}
        placeholder={journey.loading
          ? <Skeleton className="h-[96px] rounded-md" />
          : <Unavailable notFound={journey.errorStatus === 404} onRetry={journey.refetch} />}
      />
    );
  }

  const { steps, nowLabel, substeps } = railProps(journey.data, pathname);
  return (
    <RecordFlow
      {...page}
      steps={steps.map(({ facts, ...step }) => ({ ...step, peek: facts.length ? <Peek facts={facts} /> : undefined }))}
      nowLabel={nowLabel}
      substeps={substeps}
    />
  );
}

export default JourneyRail;

/** The first facts of a step's record, shown on hover and focus. */
function Peek({ facts }) {
  return (
    <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12px]">
      {facts.map((fact) => (
        <Fragment key={fact.label}>
          <dt className="text-background/70">{fact.label}</dt>
          <dd className="num m-0">{factValue(fact)}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

/**
 * One muted line where the rail would be. A 404 is an answer, not a
 * failure (a cancelled PO, a project with no order yet), so it offers no
 * retry; anything else does.
 */
function Unavailable({ notFound, onRetry }) {
  return (
    <p className="m-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-muted-foreground">
      {notFound ? 'This record is not part of a sale yet.' : 'The journey for this record could not be loaded.'}
      {!notFound && <Button variant="link" size="sm" className="h-auto p-0 text-[12.5px]" onClick={onRetry}>Try again</Button>}
    </p>
  );
}
