import { NavLink } from 'react-router-dom';
import { cn } from 'cn';
import { ScrollArea } from './ui/scroll-area.tsx';

/**
 * The rail beside a settings-shaped area.
 *
 * Settings and My account are the same shape — a list of panes on the left,
 * one pane on the right — and the design draws both that way. They had the
 * markup twice for about a day, which is how the two drifted: one had the
 * group headings, the other did not.
 *
 * `groups` is `[{ label, items: [{ to, label }] }]`. A group with no label
 * renders its items with no heading, which is what a short rail wants.
 */
export function PaneRail({ base, groups }) {
  return (
    /* Horizontal on a phone, a rail beside the page above lg. */
    <ScrollArea className="lg:w-56 lg:shrink-0">
      <nav className="flex gap-1 pb-2 lg:flex-col lg:gap-0 lg:pb-0">
        {groups.map((group, i) => (
          <div key={group.label ?? i} className="contents lg:block lg:pb-3">
            {group.label && (
              <div className="hidden px-2.5 pt-3 pb-1.5 eyebrow lg:block">
                {group.label}
              </div>
            )}
            {group.items.map((item) => (
              <NavLink
                key={item.to}
                to={`${base}/${item.to}`}
                className={({ isActive }) => cn(
                  'flex h-control shrink-0 items-center rounded-[6px] px-2.5 text-[13px] font-medium whitespace-nowrap',
                  'text-secondary-text transition-colors duration-150 hover:bg-accent hover:text-foreground',
                  isActive && 'bg-primary/12 font-semibold text-primary'
                )}
              >
                {item.label}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>
    </ScrollArea>
  );
}
