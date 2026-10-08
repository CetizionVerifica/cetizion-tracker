import { useCallback, useMemo } from 'react';
import { cn } from 'cn';
import { api } from '../lib/api.js';
import { toneFor } from '../lib/format.js';
import { useMediaQuery } from '../lib/hooks.js';
import { CircleAlert, CircleCheck, Info, TriangleAlert, Upload } from 'lucide-react';
import { toast as sonnerToast } from 'sonner';
import { Toaster } from '@/components/ui/sonner.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { Badge as UiBadge } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Input as UiInput } from '@/components/ui/input.tsx';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog.tsx';
import { Card as UiCard, CardContent, CardHeader } from '@/components/ui/card.tsx';

/**
 * These keep the names and props every page already passes, and render the
 * prebuilt shadcn components underneath. That is the whole migration plan in
 * one line: a page changes appearance without being rewritten, and is
 * converted properly only when somebody is in it for another reason.
 *
 * The design's own rules live in styles/globals.css — three radii, three
 * heights, a 4px grid — so the classes below only ever compose those.
 */

/** The design names four states; toneFor still speaks in the old words. */
const TONE = {
  danger: 'border-late/30 bg-late/10 text-late',
  warning: 'border-waiting/30 bg-waiting/10 text-waiting',
  success: 'border-settled/30 bg-settled/10 text-settled',
  info: 'border-info/30 bg-info/10 text-info',
  neutral: 'border-border bg-secondary text-secondary-foreground',
};

/* ------------------------------------------------------------------ card */

export function Card({ title, hint, actions, children, flush = false, className = '' }) {
  return (
    <UiCard className={cn('gap-0 py-0', className)}>
      {/* The actions sit beside the title when there is room and under it
          when there is not. Held `shrink-0` beside it, a card header
          carrying two filters pushed a phone page past its viewport. */}
      {(title || actions) && (
        <CardHeader className="flex flex-col gap-3 border-b border-border px-4 py-3 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between sm:gap-4">
          {/* The title keeps a readable width; actions too wide to sit
              beside it wrap onto their own line rather than squeezing it
              to a word per line. */}
          <div className="min-w-0 sm:flex-[1_1_260px]">
            {title && <div className="text-[15px] font-semibold text-foreground">{title}</div>}
            {hint && <div className="measure mt-1 text-[12.5px] text-muted-foreground">{hint}</div>}
          </div>
          {actions && <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">{actions}</div>}
        </CardHeader>
      )}
      <CardContent className={flush ? 'p-0' : 'p-4'}>{children}</CardContent>
    </UiCard>
  );
}

/* ------------------------------------------------------------------ stat */


/* ----------------------------------------------------------------- badge */

export function Badge({ children, tone, dot = false, className }) {
  if (children === null || children === undefined || children === '') {
    return <span className="text-muted-foreground">—</span>;
  }
  const resolved = tone || toneFor(children);
  // The word is the state; the hue only agrees with it. Colour alone never
  // says anything here, which is the design's rule and also the accessible
  // one.
  return (
    <UiBadge variant="outline" className={cn('gap-1.5 font-semibold', TONE[resolved] || TONE.neutral, className)}>
      {dot && <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />}
      {children}
    </UiBadge>
  );
}

/* -------------------------------------------------------------- document */

/** Opens a record's document in a new tab; a dash when it has none. */
export function DocumentLink({ id, name }) {
  if (!id) return <span className="muted">—</span>;
  return (
    <a
      className="mg-btn mg-btn--sm mg-btn--ghost"
      href={api.documentUrl(id)}
      target="_blank"
      rel="noopener noreferrer"
      title={name || undefined}
    >
      View
    </a>
  );
}

/* ----------------------------------------------------------------- table */

/**
 * The same rows as a stack of cards, for a phone.
 *
 * A twelve-column table on a 390px screen is a horizontal scrollbar and a
 * guess about which column you are looking at. Below the breakpoint each
 * row becomes a card and each cell a labelled line, so the column header
 * travels with the value instead of being three swipes away.
 *
 * Columns with no header are actions; they keep their place at the foot
 * of the card rather than getting a label that says nothing.
 */
function CardList({ columns, rows, onRowClick, rowClassName }) {
  const labelled = columns.filter((col) => col.header);
  const actions = columns.filter((col) => !col.header);
  return (
    <div className="flex flex-col gap-2 p-3">
      {rows.map((row, i) => {
        const Cell = ({ col }) => col.render ? col.render(row) : row[col.key] ?? <span className="text-muted-foreground">—</span>;
        return (
          <UiCard
            key={row.id ?? i}
            className={cn(
              'gap-0 rounded-[18px] border-line py-0 shadow-none [background:var(--track)] [backdrop-filter:none]',
              onRowClick && 'cursor-pointer',
              rowClassName ? rowClassName(row) || '' : ''
            )}
            onClick={onRowClick ? (e) => {
              if (e.target.closest('button, a, input, select')) return;
              onRowClick(row);
            } : undefined}
          >
            <CardContent className="px-3 py-3">
            {labelled.map((col, index) => (
              <div key={col.key} className={cn('flex gap-3 py-1', index > 0 && 'border-t border-border/60 pt-2')}>
                <span className="w-[38%] shrink-0 text-[11px] font-semibold tracking-[0.04em] text-muted-foreground uppercase">
                  {col.header}
                </span>
                <span className={cn('min-w-0 flex-1 wrap-anywhere text-[13px]', col.align === 'right' && 'num')}>
                  <Cell col={col} />
                </span>
              </div>
            ))}
            {actions.length > 0 && (
              <div className="mt-2 flex flex-wrap justify-end gap-2 border-t border-border/60 pt-2">
                {actions.map((col) => <Cell key={col.key} col={col} />)}
              </div>
            )}
            </CardContent>
          </UiCard>
        );
      })}
    </div>
  );
}

/**
 * The table every list in the app draws.
 *
 * `sort` and `onSort` make a column header sortable: a header only offers
 * it when the column names a real field, because sorting by a computed
 * cell would silently sort by something else. `label` names the table for
 * anybody who cannot see it sitting under a heading.
 */
export function DataTable({ columns, rows, empty, onRowClick, footer, loading, rowClassName, label, sort, onSort, stickyHeader = false, phone, phoneBelow = 768 }) {
  // `phoneBelow`: a wide table (Wave 6 lists) switches to its phone rows
  // under 1024px, so a tablet never scrolls a table sideways.
  const wide = useMediaQuery(`(min-width: ${phone ? phoneBelow : 768}px)`);
  if (loading) return <TableSkeleton />;
  if (!rows.length) return empty || <Empty title="Nothing here yet" />;

  // One or the other, never both: rendering the rows twice put every row
  // in the document twice and left the first match hidden. A page that
  // draws its own phone row (`phone(row)`) gets the system's mg-rows.
  if (!wide && phone) return <div className="mg-rows">{rows.map((row, i) => <PhoneSlot key={row.id ?? i}>{phone(row)}</PhoneSlot>)}</div>;
  if (!wide) return <CardList columns={columns} rows={rows} onRowClick={onRowClick} rowClassName={rowClassName} />;

  const [sortKey, sortDir] = String(sort || '').split(':');

  /*
   * The system's mg-table. `position: sticky` resolves against the nearest
   * scrolling ancestor, so full-page lists opt in to a bounded wrapper
   * (`stickyHeader`): the table gets the height and the page stops
   * scrolling, one scroll region rather than two fighting. A table inside a
   * record page does not, because there it is one section among several.
   */
  return (
    <div className={cn('mg-tablewrap', stickyHeader && 'is-sticky')}>
      <table className="mg-table app-dtable">
        {label && <caption className="sr-only">{label}</caption>}
        <thead>
          <tr>
            {columns.map((col) => {
              const sortable = onSort && col.sortBy;
              const active = sortable && sortKey === col.sortBy;
              const next = active && sortDir === 'asc' ? 'desc' : 'asc';
              return (
                <th
                  key={col.key}
                  scope="col"
                  aria-sort={active ? (sortDir === 'desc' ? 'descending' : 'ascending') : undefined}
                  aria-label={col.header ? undefined : 'Actions'}
                  className={cn(col.align === 'right' && 'num', !col.header && 'actions')}
                  style={col.width ? { width: col.width } : undefined}
                >
                  {sortable ? (
                    <button type="button" data-active={active || undefined} onClick={() => onSort(`${col.sortBy}:${next}`)} title={`Sort by ${col.header}`}>
                      {col.header}
                    </button>
                  ) : col.header}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={row.id ?? i}
              // A row that opens a record has to be openable without a
              // pointer. `tabIndex` and Enter give it that without a
              // wrapper element inside the cell.
              tabIndex={onRowClick ? 0 : undefined}
              aria-label={onRowClick ? `Open ${String(row[columns[0].key] ?? 'this record')}` : undefined}
              onKeyDown={onRowClick ? (e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                if (e.target !== e.currentTarget) return;
                e.preventDefault();
                onRowClick(row);
              } : undefined}
              className={cn(onRowClick && 'is-clickable', rowClassName ? rowClassName(row) || '' : '')}
              onClick={onRowClick ? (e) => {
                if (e.target.closest('button, a, input, select, label')) return;
                onRowClick(row);
              } : undefined}
            >
              {columns.map((col) => (
                // Cells wrap rather than truncate: a client's name is the
                // thing you came to read. Sentence columns keep a width.
                <td
                  key={col.key}
                  className={cn(col.align === 'right' && 'num', !col.header && 'actions', col.className)}
                >
                  {col.min ? <div style={{ minWidth: col.min }}>{cellOf(col, row)}</div> : cellOf(col, row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {footer && <tfoot><tr>{footer}</tr></tfoot>}
      </table>
    </div>
  );
}
const PhoneSlot = ({ children }) => children;
const cellOf = (col, row) => (col.render ? col.render(row) : row[col.key] ?? <span className="text-muted-foreground">—</span>);

function TableSkeleton() {
  return (
    <div className="flex flex-col gap-2.5 p-4">
      {Array.from({ length: 6 }).map((_, i) => (
        <Skeleton key={i} className="h-4 rounded-[6px]" style={{ width: `${100 - (i % 3) * 12}%` }} />
      ))}
    </div>
  );
}


/* ----------------------------------------------------------------- empty */

export function Empty({ icon, title, text, action }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      {icon && <div className="text-muted-foreground" aria-hidden="true">{icon}</div>}
      <div className="text-[15px] font-semibold text-foreground">{title}</div>
      {text && <p className="measure m-0 text-[13px] text-muted-foreground">{text}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}


/* ----------------------------------------------------------------- modal */

export function Modal({ title, subtitle, onClose, children, footer, size = '' }) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        className={cn(
          'max-h-[86vh] gap-0 overflow-hidden p-0',
          size === 'lg' ? 'sm:max-w-3xl' : size === 'sm' ? 'sm:max-w-md' : 'sm:max-w-xl'
        )}
      >
        <DialogHeader className="border-b border-border px-5 py-4 text-left">
          <DialogTitle className="text-[15px] font-semibold">{title}</DialogTitle>
          {subtitle && <DialogDescription className="measure text-[12.5px]">{subtitle}</DialogDescription>}
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto px-5 py-4">{children}</div>
        {footer && (
          <DialogFooter className="border-t border-border px-5 py-3 sm:flex-wrap sm:justify-end">{footer}</DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}


/* ---------------------------------------------------------------- fields */

export function Field({ label, required, hint, error, children, as: Tag = 'label' }) {
  return (
    <Tag className={cn('flex flex-col gap-1.5', error && 'is-error')}>
      <span className="text-[12px] font-medium text-secondary-foreground">
        {label}
        {required && <span className="ml-0.5 text-late" aria-hidden="true">*</span>}
      </span>
      {children}
      {error ? (
        <span className="text-[12px] text-late">{error}</span>
      ) : hint ? (
        <span className="text-[12px] text-muted-foreground">{hint}</span>
      ) : null}
    </Tag>
  );
}


export function Input({ error, className, ...props }) {
  return (
    <UiInput
      aria-invalid={error ? true : undefined}
      className={cn(className)}
      {...props}
    />
  );
}


export function Textarea({ error, className, ...props }) {
  return (
    <textarea
      aria-invalid={error ? true : undefined}
      className={cn(
        'min-h-20 w-full rounded-[14px] border border-input bg-glass-strong px-3.5 py-2.5 text-[13.5px] text-foreground transition-[border-color,box-shadow] hover:border-glass-edge',
        'placeholder:text-muted-foreground aria-invalid:border-late focus-visible:border-caramel focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-wait-soft',
        className
      )}
      {...props}
    />
  );
}


export function Select({ error, options = [], placeholder = '—', children, className, ...props }) {
  return (
    <select
      aria-invalid={error ? true : undefined}
      className={cn(
        'h-11 w-full rounded-[14px] border border-input bg-glass-strong px-3.5 text-[13.5px] text-foreground transition-[border-color,box-shadow] hover:border-glass-edge',
        'aria-invalid:border-late focus-visible:border-caramel focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-wait-soft',
        className
      )}
      {...props}
    >
      {placeholder !== null && <option value="">{placeholder}</option>}
      {options.map((opt) => {
        const value = typeof opt === 'string' ? opt : opt.value;
        const label = typeof opt === 'string' ? opt : opt.label;
        return <option key={value} value={value}>{label}</option>;
      })}
      {children}
    </select>
  );
}


/** A free-text input backed by suggestions — the workbook's dropdowns,
 *  without blocking a value that is not on the list yet. */
export function Combo({ options = [], listId, error, ...props }) {
  const id = useMemo(() => listId || `combo-${Math.random().toString(36).slice(2)}`, [listId]);
  return (
    <>
      <input className={cn('mg-input', error && 'border-late')} aria-invalid={error ? true : undefined} list={id} {...props} />
      <datalist id={id}>
        {options.map((opt) => (
          <option key={typeof opt === 'string' ? opt : opt.value} value={typeof opt === 'string' ? opt : opt.value} />
        ))}
      </datalist>
    </>
  );
}

/**
 * A file field as the design system's drop zone (FilePicker): drop a file
 * anywhere on it, or press "Choose a file". pickers.js lights it while a
 * file is dragged over and shows the chosen file's name and size.
 */
export function FileDrop({ text = 'Drop a PDF or image here', onFile, accept, label, id, error, ...props }) {
  return (
    <label className={cn('mg-file', error && 'is-error')}>
      <Upload className="size-[18px] shrink-0 text-muted-foreground" strokeWidth={1.8} aria-hidden="true" />
      <span className="mg-drop__text">{text}</span>
      <span className="mg-btn mg-btn--sm">Choose a file</span>
      <input type="file" id={id} aria-label={label} accept={accept} aria-invalid={error ? true : undefined} onChange={(e) => onFile?.(e.target.files?.[0] || null)} {...props} />
    </label>
  );
}

/* ---------------------------------------------------------------- pieces */

export function Progress({ value }) {
  const pct = Math.max(0, Math.min(1, Number(value) || 0));
  return (
    <div className="flex items-center gap-2">
      <div
        className="h-2.5 flex-1 overflow-hidden rounded-full bg-track"
        role="progressbar"
        aria-valuenow={Math.round(pct * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className="h-full rounded-full bg-figure transition-[width] duration-150" style={{ width: `${pct * 100}%` }} />
      </div>
      <span className="num min-w-8 text-right text-[12px] text-muted-foreground">{Math.round(pct * 100)}%</span>
    </div>
  );
}




export function Tabs({ tabs, active, onChange }) {
  return (
    <div className="flex flex-wrap items-center gap-1 border-b border-border" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          role="tab"
          aria-selected={active === tab.key}
          className={cn(
            'flex h-10 items-center gap-2 border-b-[2.5px] px-3 text-[13px] font-bold transition-colors duration-150',
            active === tab.key
              ? 'border-caramel text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          )}
          onClick={() => onChange(tab.key)}
        >
          {tab.label}
          {tab.count !== undefined && (
            <span className={cn('num rounded-full px-1.5 text-[10.5px] font-extrabold', active === tab.key ? 'bg-caramel text-on-caramel' : 'bg-track text-secondary-text')}>{tab.count}</span>
          )}
          {tab.warning ? (
            <span className="num rounded-full bg-wait-soft px-1.5 text-[11px] text-waiting" title={tab.warningTitle}>{tab.warning}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}


const ALERT = {
  info: ['', Info],
  warning: ['mg-banner--wait', TriangleAlert],
  danger: ['mg-banner--late', CircleAlert],
  success: ['mg-banner--ok', CircleCheck],
};

/**
 * A note, hint or warning inside a page or dialog: the Mocha Glass banner
 * (tone tint, tone icon, theme text). Tone is never the only signal: the
 * text says what it is, and the icon agrees with it.
 */
export function Alert({ tone = 'info', children }) {
  const [cls, Icon] = ALERT[tone] || ALERT.info;
  return (
    <div className={cn('mg-banner', cls)} role="status">
      <Icon strokeWidth={1.8} aria-hidden="true" />
      <div className="mg-banner__body">{children}</div>
    </div>
  );
}



/* ---------------------------------------------------------------- toasts */

/**
 * Same call as before — toast(message, tone) — so no caller changed. sonner
 * does the stacking, the timing and the live region; the tones map onto the
 * design's four states.
 */
export const useToast = () => useCallback((message, tone = 'default') => {
  if (tone === 'danger') return sonnerToast.error(message);
  if (tone === 'success') return sonnerToast.success(message);
  if (tone === 'warning') return sonnerToast.warning(message);
  if (tone === 'info') return sonnerToast.info(message);
  return sonnerToast(message);
}, []);

export function ToastProvider({ children }) {
  return (
    <>
      {children}
      {/* Bottom centre, above the dock (above the tab bar on a phone): styles/mocha/shell.css. */}
      <Toaster position="bottom-center" offset={{ bottom: 100 }} mobileOffset={{ bottom: 96 }} closeButton toastOptions={{ className: 'toast' }} />
    </>
  );
}


/* ------------------------------------------------------------- confirm */

/**
 * `tone` because not everything worth confirming is destructive. The
 * button was always red, which is right for a delete and wrong for an
 * action whose own message says it can be run twice — a red button and a
 * calm sentence disagree, and the button is the one people read.
 */
export function ConfirmDialog({ title, subtitle, message, confirmLabel = 'Delete', cancelLabel = 'Cancel', onConfirm, onClose, busy, tone = 'danger', busyLabel = 'Working…', children }) {
  return (
    <Modal
      title={title}
      subtitle={subtitle}
      onClose={onClose}
      size="sm"
      footer={
        <>
          {/* On a phone the two stack, full width and 44px tall (the dialog is a bottom sheet there). */}
          <Button variant="outline" size="sm" onClick={onClose} disabled={busy} className="max-sm:h-11 max-sm:w-full">{cancelLabel}</Button>
          <Button variant={tone === 'danger' ? 'destructive' : 'default'} size="sm" onClick={onConfirm} disabled={busy} aria-busy={busy || undefined} className="max-sm:h-11 max-sm:w-full">
            {busy ? busyLabel : confirmLabel}
          </Button>
        </>
      }
    >
      <p className="measure m-0 text-[13px] text-secondary-foreground">{message}</p>
      {children}
    </Modal>
  );
}

