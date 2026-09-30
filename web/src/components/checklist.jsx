import { Check, Lock, MoreHorizontal } from 'lucide-react';
import { cn } from 'cn';
import { Button } from './ui/button.tsx';
import { Checkbox } from './ui/checkbox.tsx';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from './ui/dropdown-menu.tsx';
import { Chip } from './record.jsx';

/**
 * The onboarding checklist (#22 / C15) — the project record's main column.
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
 * yours to do" — so it gets a lock, a chip naming the owner, and no
 * control at all.
 */

const OWNER_LABEL = { finance: 'with finance', sales: 'with sales', delivery: 'with delivery' };

/** The disc a derived step wears: done, moving, or not begun. */
function StepMark({ status }) {
  const done = status === 'Done';
  const moving = status === 'In Progress';
  return (
    <span
      className={cn(
        'mt-0.5 grid size-4 shrink-0 place-items-center rounded-full',
        done && 'border border-settled/40 bg-settled/15',
        moving && 'border border-waiting/45 bg-waiting/12',
        !done && !moving && 'border border-border-strong'
      )}
      aria-hidden="true"
    >
      {done
        ? <Check className="size-[10px] text-settled" strokeWidth={3.2} />
        : moving ? <Lock className="size-[9px] text-waiting" strokeWidth={2.4} /> : null}
    </span>
  );
}

function ChecklistRow({ step, onToggle, onEdit, onDelete, last }) {
  const status = step.effective_status;
  const done = status === 'Done';
  const skipped = status === 'N/A';
  const label = `Step ${step.step_no}: ${step.step}`;

  return (
    <li className={cn('flex items-start gap-3 px-5 py-3', !last && 'border-b border-border')}>
      {step.derived
        ? <StepMark status={status} />
        : (
          <Checkbox
            checked={done}
            disabled={skipped}
            onCheckedChange={() => onToggle(step)}
            aria-label={label}
            className="mt-0.5"
          />
        )}

      <div className="min-w-0 flex-1">
        <div className={cn(
          'text-[13px]/[1.5]',
          done ? 'text-secondary-text' : skipped ? 'text-muted-foreground line-through' : 'text-foreground'
        )}>
          {step.step}
        </div>
        {step.detail && <div className="mt-0.5 text-[12px] text-muted-foreground">{step.detail}</div>}
      </div>

      {step.derived && !done && step.owned_by && (
        <Chip tone={status === 'In Progress' ? 'waiting' : 'plain'}>{OWNER_LABEL[step.owned_by] || step.owned_by}</Chip>
      )}

      {!step.derived && (onEdit || onDelete) && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={`More for step ${step.step_no}`} className="shrink-0 text-muted-foreground">
              <MoreHorizontal strokeWidth={2.4} aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-40 rounded-[10px] p-1.5">
            {onEdit && <DropdownMenuItem className="text-[13px]" onSelect={() => onEdit(step)}>Edit this step</DropdownMenuItem>}
            {onDelete && <DropdownMenuItem className="text-[13px]" onSelect={() => onDelete(step)}>Remove it</DropdownMenuItem>}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </li>
  );
}

export function Checklist({ steps, onToggle, onEdit, onDelete }) {
  return (
    <ol className="list-none">
      {steps.map((step, i) => (
        <ChecklistRow
          key={step.id}
          step={step}
          onToggle={onToggle}
          onEdit={onEdit}
          onDelete={onDelete}
          last={i === steps.length - 1}
        />
      ))}
    </ol>
  );
}
