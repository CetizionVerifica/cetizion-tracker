import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { cn } from 'cn';
import { api } from '../lib/api.js';
import { toneFor } from '../lib/format.js';
import { useMediaQuery } from '../lib/hooks.js';
import { TriangleAlert } from 'lucide-react';
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
import {
  Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow,
} from '@/components/ui/table.tsx';

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
    <UiCard className={cn('gap-0 rounded-[10px] border-border bg-card py-0 shadow-none', className)}>
      {/* The actions sit beside the title when there is room and under it
          when there is not. Held `shrink-0` beside it, a card header
          carrying two filters pushed a phone page past its viewport. */}
      {(title || actions) && (
        <CardHeader className="flex flex-col gap-3 border-b border-border px-4 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
          <div className="min-w-0">
            {title && <div className="text-[15px] font-semibold text-foreground">{title}</div>}
            {hint && <div className="measure mt-1 text-[12.5px] text-muted-foreground">{hint}</div>}
          </div>
          {actions && <div className="flex min-w-0 flex-wrap items-center gap-2 sm:shrink-0">{actions}</div>}
        </CardHeader>
      )}
      <CardContent className={flush ? 'p-0' : 'p-4'}>{children}</CardContent>
    </UiCard>
  );
}

/* ------------------------------------------------------------------ stat */

export function Stat({ label, value, meta, tone = '', to, onClick }) {
  const accent = {
    danger: 'text-late',
    warning: 'text-waiting',
    success: 'text-settled',
    info: 'text-info',
  }[tone];
  const className = cn(
    'flex min-w-0 flex-col gap-1 rounded-[10px] border border-border bg-card px-4 py-3 text-left transition-colors duration-150',
    (to || onClick) && 'hover:border-primary/40 hover:bg-accent'
  );
  const inner = (
    <>
      <div className="text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">{label}</div>
      <div className={cn('num text-2xl font-semibold', accent || 'text-foreground')}>{value}</div>
      {meta && <div className="text-[12px] text-muted-foreground">{meta}</div>}
    </>
  );
  if (to) return <Link className={className} to={to}>{inner}</Link>;
  if (onClick) return <button type="button" className={className} onClick={onClick}>{inner}</button>;
  return <div className={className}>{inner}</div>;
}


/* ----------------------------------------------------------------- badge */

export function Badge({ children, tone, dot = false }) {
  if (children === null || children === undefined || children === '') {
    return <span className="text-muted-foreground">—</span>;
  }
  const resolved = tone || toneFor(children);
  // The word is the state; the hue only agrees with it. Colour alone never
  // says anything here, which is the design's rule and also the accessible
  // one.
  return (
    <UiBadge variant="outline" className={cn('gap-1.5 rounded-[6px] font-medium', TONE[resolved] || TONE.neutral)}>
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
      className="btn btn--sm btn--ghost"
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
              'gap-0 rounded-[10px] border-border bg-card py-0 shadow-none',
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

export function DataTable({ columns, rows, empty, onRowClick, footer, loading, rowClassName }) {
  const wide = useMediaQuery('(min-width: 768px)');
  if (loading) return <TableSkeleton />;
  if (!rows.length) return empty || <Empty title="Nothing here yet" />;

  // One or the other, never both: rendering the rows twice put every row
  // in the document twice and left the first match hidden.
  if (!wide) return <CardList columns={columns} rows={rows} onRowClick={onRowClick} rowClassName={rowClassName} />;

  return (
      <div className="w-full overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow className="border-border hover:bg-transparent">
            {columns.map((col) => (
              <TableHead
                key={col.key}
                className={cn(
                  'h-row whitespace-nowrap px-3 text-[12px] font-semibold text-muted-foreground',
                  col.align === 'right' && 'num text-right'
                )}
                style={col.width ? { width: col.width } : undefined}
              >
                {col.header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, i) => (
            <TableRow
              key={row.id ?? i}
              className={cn(
                'border-border',
                onRowClick && 'cursor-pointer',
                rowClassName ? rowClassName(row) || '' : ''
              )}
              onClick={onRowClick ? (e) => {
                if (e.target.closest('button, a, input, select')) return;
                onRowClick(row);
              } : undefined}
            >
              {columns.map((col) => (
                // Cells wrap rather than truncate: a client's name is the
                // thing you came to read.
                <TableCell
                  key={col.key}
                  className={cn('px-3 py-2 align-top text-[13px] whitespace-normal', col.align === 'right' && 'num text-right', col.className)}
                >
                  {col.render ? col.render(row) : row[col.key] ?? <span className="text-muted-foreground">—</span>}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
        {footer && <TableFooter className="bg-muted/40"><TableRow className="border-border">{footer}</TableRow></TableFooter>}
      </Table>
      </div>
  );
}

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
          'max-h-[86vh] gap-0 overflow-hidden rounded-[14px] border-border bg-popover p-0',
          size === 'lg' ? 'sm:max-w-3xl' : size === 'sm' ? 'sm:max-w-md' : 'sm:max-w-xl'
        )}
      >
        <DialogHeader className="border-b border-border px-5 py-4 text-left">
          <DialogTitle className="text-[15px] font-semibold">{title}</DialogTitle>
          {subtitle && <DialogDescription className="measure text-[12.5px]">{subtitle}</DialogDescription>}
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto px-5 py-4">{children}</div>
        {footer && (
          <DialogFooter className="border-t border-border px-5 py-3 sm:justify-end">{footer}</DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}


/* ---------------------------------------------------------------- fields */

export function Field({ label, required, hint, error, children }) {
  return (
    <label className="flex flex-col gap-1.5">
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
    </label>
  );
}


export function Input({ error, className, ...props }) {
  return (
    <UiInput
      aria-invalid={error ? true : undefined}
      className={cn('h-control rounded-[6px] bg-secondary text-[13px]', className)}
      {...props}
    />
  );
}


export function Textarea({ error, className, ...props }) {
  return (
    <textarea
      aria-invalid={error ? true : undefined}
      className={cn(
        'min-h-20 w-full rounded-[6px] border border-input bg-secondary px-3 py-2 text-[13px] text-foreground',
        'placeholder:text-muted-foreground aria-invalid:border-late',
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
        'h-control w-full rounded-[6px] border border-input bg-secondary px-2.5 text-[13px] text-foreground',
        'aria-invalid:border-late',
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
      <input className={`input ${error ? 'has-error' : ''}`} list={id} {...props} />
      <datalist id={id}>
        {options.map((opt) => (
          <option key={typeof opt === 'string' ? opt : opt.value} value={typeof opt === 'string' ? opt : opt.value} />
        ))}
      </datalist>
    </>
  );
}

/* ---------------------------------------------------------------- pieces */

export function Progress({ value }) {
  const pct = Math.max(0, Math.min(1, Number(value) || 0));
  return (
    <div className="flex items-center gap-2">
      <div
        className="h-1.5 flex-1 overflow-hidden rounded-[6px] bg-secondary"
        role="progressbar"
        aria-valuenow={Math.round(pct * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className="h-full rounded-[6px] bg-primary transition-[width] duration-150" style={{ width: `${pct * 100}%` }} />
      </div>
      <span className="num min-w-8 text-right text-[12px] text-muted-foreground">{Math.round(pct * 100)}%</span>
    </div>
  );
}


export function BarList({ items, valueFormat = (v) => v, max: providedMax }) {
  const max = providedMax ?? Math.max(...items.map((i) => Number(i.value) || 0), 1);
  if (!items.length) return <Empty title="No data yet" />;
  return (
    <div className="flex flex-col gap-3">
      {items.map((item, i) => (
        <div key={item.label ?? i} className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 truncate text-[13px] text-foreground" title={item.label}>
              {item.label || 'Not recorded'}
            </span>
            <span className="num shrink-0 text-[12.5px] text-secondary-foreground">{valueFormat(item.value, item)}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-[6px] bg-secondary">
            <div
              className="h-full rounded-[6px] bg-primary/80"
              style={{ width: `${((Number(item.value) || 0) / max) * 100}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}


export function KeyValues({ items }) {
  return (
    <dl className="auto-grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-4">
      {items.filter(Boolean).map((item) => (
        <div key={item.label} className="min-w-0">
          <dt className="text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">{item.label}</dt>
          <dd className="mt-0.5 ml-0 text-[13px] text-foreground">{item.value ?? <span className="text-muted-foreground">—</span>}</dd>
        </div>
      ))}
    </dl>
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
            'flex h-control items-center gap-1.5 rounded-t-[6px] border-b-2 px-3 text-[13px] transition-colors duration-150',
            active === tab.key
              ? 'border-primary font-medium text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          )}
          onClick={() => onChange(tab.key)}
        >
          {tab.label}
          {tab.count !== undefined && (
            <span className="num rounded-[6px] bg-secondary px-1.5 text-[11px] text-secondary-foreground">{tab.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}


export function Alert({ tone = 'info', children }) {
  // Tone is never the only signal: the text says what it is, and the icon
  // agrees with it.
  const look = {
    info: 'border-info/30 bg-info/10 text-info',
    warning: 'border-waiting/30 bg-waiting/10 text-waiting',
    danger: 'border-late/30 bg-late/10 text-late',
    success: 'border-settled/30 bg-settled/10 text-settled',
  }[tone] || 'border-info/30 bg-info/10 text-info';
  return (
    <div className={cn('alert flex items-start gap-2 rounded-[10px] border px-3 py-2.5 text-[13px]', look)} role="status">
      {children}
    </div>
  );
}


export function ErrorState({ message, onRetry }) {
  return (
    <Empty
      icon={<TriangleAlert className="size-6" strokeWidth={1.75} />}
      title="Could not load this"
      text={message}
      action={onRetry && <Button variant="outline" size="sm" onClick={onRetry}>Try again</Button>}
    />
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
  return sonnerToast(message);
}, []);

export function ToastProvider({ children }) {
  return (
    <>
      {children}
      <Toaster position="bottom-right" richColors closeButton theme="dark" toastOptions={{ className: 'toast' }} />
    </>
  );
}


/* ------------------------------------------------------------- confirm */

export function ConfirmDialog({ title, message, confirmLabel = 'Delete', onConfirm, onClose, busy }) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      size="sm"
      footer={
        <>
          <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="destructive" size="sm" onClick={onConfirm} disabled={busy}>
            {busy ? 'Working…' : confirmLabel}
          </Button>
        </>
      }
    >
      <p className="measure m-0 text-[13px] text-secondary-foreground">{message}</p>
    </Modal>
  );
}

