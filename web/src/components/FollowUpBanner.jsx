import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CalendarClock, Clock, TriangleAlert } from 'lucide-react';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/hooks.js';
import { date } from '../lib/format.js';

export const FOLLOW_UP_KINDS = ['enquiry', 'quotation', 'payment_stage'];

/**
 * The open follow-up on one record (docs/follow-up-escalation-plan.md §7.3):
 * when it fell due, when the owner was reminded, and the date by which
 * something must be logged before it goes to management. Nothing when there
 * is no open cycle, or when activity has been logged since the reminder.
 *
 * Bump `version` after logging anything, so the banner hides at once rather
 * than on the next daily run.
 */
export function FollowUpBanner({ entity, id, version = 0, onLog, logLabel = 'Log a touch', className }) {
  const enabled = FOLLOW_UP_KINDS.includes(entity) && Boolean(id);
  const { data } = useFetch(
    // A record the reader cannot reach, or a search term that is not a
    // record at all, is simply no banner.
    () => (enabled ? api.raw(`/follow-ups/record?entity=${entity}&id=${encodeURIComponent(id)}`).catch(() => null) : Promise.resolve(null)),
    [entity, id, version, enabled]
  );
  const c = data?.data;
  const next = data?.next_task;
  if (!c) {
    // Nothing overdue: say what is planned, so the owner can see the date the
    // reminder will go by. A task with a due date is the follow-up date.
    if (!next) return null;
    return (
      <div className={className}>
        <p className="m-0 flex flex-wrap items-center gap-1.5 text-[12.5px] text-muted-foreground">
          <CalendarClock className="size-4" strokeWidth={1.8} aria-hidden="true" />
          Next follow-up: <b className="text-foreground">{date(next.due_at)}</b>
          {next.title && <> · {next.title}</>} <span>(a task)</span>
        </p>
      </div>
    );
  }

  const escalated = Boolean(c.escalated_at);
  return (
    <div className={className}>
      <div className={escalated ? 'mg-banner mg-banner--late' : 'mg-banner mg-banner--wait'} role="status">
        {escalated ? <TriangleAlert aria-hidden="true" /> : <Clock aria-hidden="true" />}
          <div className="mg-banner__body">
            <strong>{escalated ? `Follow-up escalated: due since ${date(c.due_on)}` : `Follow-up due since ${date(c.due_on)}`}</strong>
            {c.reminded_at && <>Reminder sent {date(c.reminded_at)}. </>}
          {next && <>Next task: {next.title ? `${next.title}, ` : ''}due {date(next.due_at)}. </>}
            {escalated
              ? (c.reminded_at
                ? <>Nothing was logged by {date(c.respond_by)}, so it went to management on {date(c.last_escalated_on || c.escalated_at)}.</>
                : <>It has no owner to remind, so it went to management on {date(c.last_escalated_on || c.escalated_at)}.</>)
              : <>Log something by {date(c.respond_by)} or it goes to management.</>}
          </div>
          {onLog && <button type="button" className="mg-btn mg-btn--sm self-center" onClick={onLog}>{logLabel}</button>}
      </div>
    </div>
  );
}

/**
 * Open a log dialog when the page was reached from a follow-up email
 * (`?log=1`), once, as soon as `ready`; then drop the parameter so a reload
 * or Back does not open it again.
 */
export function useLogParam(open, ready = true) {
  const [params, setParams] = useSearchParams();
  const done = useRef(false);
  const wanted = params.get('log') === '1';
  useEffect(() => {
    if (!wanted || !ready || done.current) return;
    done.current = true;
    open();
    const next = new URLSearchParams(params);
    next.delete('log');
    setParams(next, { replace: true });
  }, [wanted, ready, open, params, setParams]);
}
