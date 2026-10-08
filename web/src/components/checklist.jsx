import { Link } from 'react-router-dom';
import { Check, Lock, MoreHorizontal } from 'lucide-react';
import { cn } from 'cn';
import { Checkbox } from './ui/checkbox.tsx';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from './ui/dropdown-menu.tsx';
import { Tone } from './sales.jsx';

/**
 * The onboarding checklist (#22 / C15) — the project record's first tab.
 *
 * Two kinds of row, and the difference is the whole point:
 *
 *  - A step a person owns is a real checkbox. Ticking it is the fact.
 *  - A step another record owns is not a checkbox at all. Whether the
 *    advance invoice went out is settled by the payment schedule, and a
 *    tick beside it could only ever agree with the schedule by luck. The
 *    server decides which is which (`derived`) and says who is holding it
 *    (`owned_by`); this file only draws the difference.
 *
 * A derived row is deliberately not a disabled checkbox. A disabled
 * checkbox reads as "you may not do this", and the truth is "this is not
 * yours to do" — so it gets a disc, a chip naming the owner, a link to the
 * record that answers it, and no control at all.
 *
 * A step marked N/A says "Not needed", struck through, and its menu offers
 * "Needed again" (Wave 6).
 */

const OWNER_LABEL = { finance: 'with finance', sales: 'with sales', delivery: 'with delivery' };

/** The disc a derived step wears: done, moving, or not begun. */
function StepMark({ status }) {
  const done = status === 'Done';
  const moving = status === 'In Progress';
  return (
    <span className={cn('app-step__disc', done && 'is-done', moving && 'is-moving')} aria-hidden="true">
      {done ? <Check strokeWidth={3} /> : moving ? <Lock strokeWidth={2.4} /> : null}
    </span>
  );
}

function ChecklistRow({ step, onToggle, onEdit, onDelete, onSkip, link }) {
  const status = step.effective_status;
  const done = status === 'Done';
  const skipped = status === 'N/A';
  const label = `Step ${step.step_no}: ${step.step}`;
  const to = step.derived && link ? link(step) : null;

  return (
    <li className={cn('app-step', skipped && 'is-skipped')}>
      {step.derived
        ? <StepMark status={status} />
        : <Checkbox checked={done} disabled={skipped} onCheckedChange={() => onToggle(step)} aria-label={label} className="app-step__box" />}

      <div className="app-step__text">
        <div className={cn('app-step__title', done && 'is-done')}>
          <span className="app-step__no mg-num">{step.step_no}</span>{step.step}
        </div>
        {step.detail && <div className="app-step__detail">{skipped && !String(step.detail).startsWith('Not needed') ? `Not needed: ${step.detail}` : step.detail}</div>}
      </div>

      <div className="app-step__end">
        {step.derived && !done && step.owned_by && (
          <Tone tone={status === 'In Progress' ? 'wait' : 'plain'}>{OWNER_LABEL[step.owned_by] || step.owned_by}</Tone>
        )}
        {skipped && <Tone>Not needed</Tone>}
        {to && <Link className="mg-btn mg-btn--ghost mg-btn--sm" to={to.to} aria-label={`${to.label}: ${step.step}`}>{to.label}</Link>}
        {!step.derived && (onEdit || onDelete || onSkip) && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className="mg-iconbtn app-step__more" aria-label={`More for step ${step.step_no}`}>
                <MoreHorizontal strokeWidth={2.2} aria-hidden="true" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-48">
              {onEdit && <DropdownMenuItem onSelect={() => onEdit(step)}>Edit this step</DropdownMenuItem>}
              {onSkip && <DropdownMenuItem onSelect={() => onSkip(step)}>{skipped ? 'Needed again' : 'Mark not needed'}</DropdownMenuItem>}
              {onDelete && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem className="text-late" onSelect={() => onDelete(step)}>Remove it</DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </li>
  );
}

export function Checklist({ steps, onToggle, onEdit, onDelete, onSkip, link }) {
  return (
    <ol className="app-steps">
      {steps.map((step) => (
        <ChecklistRow key={step.id} step={step} onToggle={onToggle} onEdit={onEdit} onDelete={onDelete} onSkip={onSkip} link={link} />
      ))}
    </ol>
  );
}
