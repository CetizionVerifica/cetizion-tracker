import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Check, CircleAlert, Inbox, RefreshCw } from 'lucide-react';
import { cn } from 'cn';
import { useMediaQuery } from '../lib/hooks.js';
import { enter } from '../styles/mocha/motion.js';

/**
 * The Wave 2 building blocks, from the Mocha Glass system's own classes:
 * a strong-glass list panel, a table that becomes phone rows under 768px,
 * the three states every list has (loading, empty, failed), the caramel
 * tabs and a labelled filter. Every Daily work screen is assembled from
 * these so the screens agree with each other.
 */

/** Strong-glass panel; the head carries the title, a hint and its tools. */
export function Panel({ id, title, hint, tools, label, className, children }) {
  return (
    <section className={cn('mg-glass mg-glass--strong app-panel', className)} data-a="rise" aria-labelledby={title ? id : undefined} aria-label={title ? undefined : label}>
      {(title || tools) && (
        <div className="app-panel__head">
          <div className="app-panel__titles">
            {title && <h2 id={id} className="mg-panel__title">{title}</h2>}
            {hint && <span className="mg-panel__hint">{hint}</span>}
          </div>
          {tools && <div className="app-panel__tools">{tools}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/**
 * A wide table at 768px and up; under it, the same rows as phone rows
 * (`phone(row)` returns one PhoneRow). Only one is rendered, so nothing is
 * in the document twice.
 *
 * columns: { key, header, num, className, width, render(row) }
 */
export function ListTable({ columns, rows, rowKey = (r, i) => r.id ?? i, phone, label, onRowClick, rowClassName, bordered = true, phoneBelow = 768 }) {
  const wide = useMediaQuery(`(min-width: ${phoneBelow}px)`);
  if (!wide && phone) {
    return <div className={cn(bordered && 'app-panel__body')}><div className="mg-rows">{rows.map((r, i) => <PhoneRowSlot key={rowKey(r, i)}>{phone(r)}</PhoneRowSlot>)}</div></div>;
  }
  return (
    <div className={cn('mg-tablewrap', bordered && 'app-panel__body')}>
      <table className="mg-table">
        {label && <caption className="sr-only">{label}</caption>}
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" className={c.num ? 'num' : undefined} style={c.width ? { width: c.width } : undefined} aria-label={c.header ? undefined : c.aria || 'Actions'}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr
              key={rowKey(r, i)}
              className={cn(onRowClick && 'is-clickable', rowClassName?.(r))}
              onClick={onRowClick ? (e) => { if (!e.target.closest('button, a, input, select, label')) onRowClick(r); } : undefined}
            >
              {columns.map((c) => (
                <td key={c.key} className={cn(c.num && 'num', c.className)}>
                  {minOf(c) ? <div style={{ minWidth: minOf(c) }}>{cell(c, r)}</div> : cell(c, r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
const PhoneRowSlot = ({ children }) => children;
const cell = (c, r) => (c.render ? c.render(r) : r[c.key] ?? <span className="text-muted-foreground">—</span>);
/** Sentence columns keep a readable width (min-width is ignored on a table cell, not on its content). */
const minOf = (c) => c.min || (/app-say/.test(c.className || '') ? 190 : /app-wrap--sm/.test(c.className || '') ? 130 : /app-wrap/.test(c.className || '') ? 180 : 0);

/**
 * One phone row: title and figure on the first line, the meta line and a
 * badge under them, then what pressing it does. A row is a link (`to`), a
 * button (`onClick`) or plain.
 */
export function PhoneRow({ title, amount, meta, state, go, goOff, to, onClick, label, wraps, className, children }) {
  const inner = (
    <>
      <span className={cn('mg-row__title', wraps && 'app-wraps')}>{title}</span>
      <span className="mg-row__amount mg-num">{amount}</span>
      {meta != null && <span className="mg-row__meta">{meta}</span>}
      <span className="mg-row__state">{state}</span>
      {go && <span className={cn('app-row__go', goOff && 'is-off')}>{go}</span>}
      {children}
    </>
  );
  if (to) return <Link to={to} className={cn('mg-row app-row', className)} aria-label={label}>{inner}</Link>;
  if (onClick) return <button type="button" className={cn('mg-row app-row', className)} aria-label={label} onClick={onClick}>{inner}</button>;
  return <div className={cn('mg-row', className)}>{inner}</div>;
}

/** Empty or all-clear: a round mark, a title, a line, and what to do next. */
export function StateCard({ tone = 'ok', title, text, children, inPanel = false, bordered = true, dashed = false, icon, role }) {
  const mark = {
    ok: 'bg-ok-soft text-ok',
    late: 'bg-late-soft text-late',
    plain: '',
  }[tone];
  const Icon = icon || (tone === 'late' ? CircleAlert : tone === 'plain' ? Inbox : Check);
  return (
    <section
      className={cn('mg-empty', !inPanel && 'mg-glass', inPanel && bordered && 'app-panel__body')}
      data-a={inPanel ? undefined : 'rise'}
      role={role}
      style={dashed ? { border: '1.5px dashed var(--ok)' } : undefined}
    >
      <span className={cn('mg-empty__mark', mark)}><Icon className="size-6" strokeWidth={tone === 'late' ? 1.8 : 2} aria-hidden="true" /></span>
      <h2 className="mg-empty__title">{title}</h2>
      {text && <p className="mg-empty__text">{text}</p>}
      {children && <div className="flex flex-wrap justify-center gap-2">{children}</div>}
    </section>
  );
}

/** "Couldn't load …": never an all-clear, always a way to try again. */
export function FailedCard({ title, text, onRetry, children }) {
  return (
    <StateCard tone="late" title={title} text={text} role="alert">
      {onRetry && <button type="button" className="mg-btn mg-btn--sm" onClick={onRetry}>Try again</button>}
      {children}
    </StateCard>
  );
}

/** The shape of a list before it lands. */
export function LoadingPanel({ rows = 3 }) {
  return (
    <section className="mg-glass mg-panel" aria-busy="true" aria-label="Loading" data-a="rise">
      <div className="mg-skel" style={{ height: 14, width: '30%' }} />
      {Array.from({ length: rows }).map((_, i) => <div key={i} className="mg-skel" style={{ height: 44, width: i === rows - 1 ? '80%' : undefined }} />)}
    </section>
  );
}

/** Skeleton rows inside a panel that is already glass. */
export function PanelSkeleton({ rows = 3 }) {
  return (
    <div className="app-panel__body flex flex-col gap-2.5 p-5" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => <div key={i} className="mg-skel" style={{ height: 44, width: i === rows - 1 ? '80%' : undefined }} />)}
    </div>
  );
}

/** Caramel-underlined tabs with their counts. */
export function MgTabs({ tabs, active, onChange, label }) {
  return (
    <div className="mg-tabs" role="tablist" aria-label={label} data-a="rise">
      {tabs.map((t) => (
        <button key={t.key} type="button" role="tab" aria-selected={active === t.key} onClick={() => onChange(t.key)}>
          {t.label}
          {t.count != null && <span className="mg-count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** A visible label beside a pill select: "Kind [Every kind]". */
export function FilterSelect({ label, value, onChange, options, placeholder, width = 150 }) {
  return (
    <label className="app-filter">
      {label}
      <span className="mg-select-wrap" style={{ width }}>
        <select className="mg-select" value={value} onChange={(e) => onChange(e.target.value)}>
          {placeholder != null && <option value="">{placeholder}</option>}
          {options.map((o) => {
            const v = typeof o === 'string' ? o : o.value;
            return <option key={v} value={v}>{typeof o === 'string' ? o : o.label}</option>;
          })}
        </select>
      </span>
    </label>
  );
}

/** The page's Refresh button. */
export function RefreshButton({ onClick, busy }) {
  return (
    <button type="button" className="mg-btn" onClick={onClick} disabled={busy}>
      <RefreshCw className="size-4" strokeWidth={1.8} aria-hidden="true" />Refresh
    </button>
  );
}

/** The badge tone for a status word the server sends. */
export function statusTone(status) {
  const s = String(status || '').toLowerCase();
  if (/overdue|late|reject|cancel|withdrawn|expired|escalated/.test(s)) return 'mg-badge--late';
  if (/paid in full|settled|approved|done|issued|confirmed|complete|won|reimbursed/.test(s) && !/to reimburse/.test(s)) return 'mg-badge--ok';
  if (/to invoice|partly|partial|pending|enter|to pay|waiting|draft|hold|to reimburse|submitted/.test(s)) return 'mg-badge--wait';
  return 'mg-badge--info';
}

/** "1 day" / "3 days". */
export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Plays the system's entrance (rise, then count-ups) once, when the page's
 * data has landed: the panels arrive with what they hold, not empty.
 */
export function useEntrance(ready) {
  const ref = useRef(null);
  const done = useRef(false);
  useEffect(() => {
    if (!ready || done.current || !ref.current) return;
    done.current = true;
    enter(ref.current);
  }, [ready]);
  return ref;
}
