import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { toneFor } from '../lib/format.js';

/* ------------------------------------------------------------------ card */

export function Card({ title, hint, actions, children, flush = false, className = '' }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="card__head">
          <div className="card__lead">
            {title && <div className="card__title">{title}</div>}
            {hint && <div className="card__hint">{hint}</div>}
          </div>
          {actions}
        </header>
      )}
      <div className={flush ? 'card__body card__body--flush' : 'card__body'}>{children}</div>
    </section>
  );
}

/* ------------------------------------------------------------------ stat */

export function Stat({ label, value, meta, tone = '', to, onClick }) {
  const className = `stat ${tone ? `stat--${tone}` : ''} ${to || onClick ? 'stat--link' : ''}`;
  const inner = (
    <>
      <div className="stat__label">{label}</div>
      <div className="stat__value">{value}</div>
      {meta && <div className="stat__meta">{meta}</div>}
    </>
  );
  if (to) return <Link className={className} to={to}>{inner}</Link>;
  if (onClick) return <button type="button" className={className} onClick={onClick} style={{ textAlign: 'left', font: 'inherit' }}>{inner}</button>;
  return <div className={className}>{inner}</div>;
}

/* ----------------------------------------------------------------- badge */

export function Badge({ children, tone, dot = false }) {
  if (children === null || children === undefined || children === '') return <span className="muted">—</span>;
  const resolved = tone || toneFor(children);
  return (
    <span className={`badge ${resolved !== 'neutral' ? `badge--${resolved}` : ''}`}>
      {dot && <span className="badge__dot" />}
      {children}
    </span>
  );
}

/* ----------------------------------------------------------------- table */

export function DataTable({ columns, rows, empty, onRowClick, footer, loading, rowClassName }) {
  if (loading) return <TableSkeleton />;
  if (!rows.length) return empty || <Empty title="Nothing here yet" />;

  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            {columns.map((col) => (
              <th key={col.key} className={col.align === 'right' ? 'num' : ''} style={col.width ? { width: col.width } : undefined}>
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={row.id ?? i}
              className={[onRowClick ? 'is-clickable' : '', rowClassName ? rowClassName(row) || '' : ''].join(' ').trim()}
              onClick={onRowClick ? (e) => {
                if (e.target.closest('button, a, input, select')) return;
                onRowClick(row);
              } : undefined}
            >
              {columns.map((col) => (
                <td key={col.key} className={[col.align === 'right' ? 'num' : '', col.className || ''].join(' ').trim()}>
                  {col.render ? col.render(row) : row[col.key] ?? <span className="muted">—</span>}
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

function TableSkeleton() {
  return (
    <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="skeleton" style={{ height: 16, width: `${100 - (i % 3) * 12}%` }} />
      ))}
    </div>
  );
}

/* ----------------------------------------------------------------- empty */

export function Empty({ icon = '◇', title, text, action }) {
  return (
    <div className="empty">
      <div className="empty__icon">{icon}</div>
      <div className="empty__title">{title}</div>
      {text && <p className="empty__text">{text}</p>}
      {action && <div style={{ marginTop: 14 }}>{action}</div>}
    </div>
  );
}

/* ----------------------------------------------------------------- modal */

export function Modal({ title, subtitle, onClose, children, footer, size = '' }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [onClose]);

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${size ? `modal--${size}` : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal__head">
          <div style={{ flex: 1 }}>
            <h2>{title}</h2>
            {subtitle && <div className="card__hint" style={{ marginTop: 3 }}>{subtitle}</div>}
          </div>
          <button type="button" className="btn btn--ghost btn--sm" onClick={onClose} aria-label="Close">✕</button>
        </header>
        <div className="modal__body">{children}</div>
        {footer && <footer className="modal__foot">{footer}</footer>}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- fields */

export function Field({ label, required, hint, error, children }) {
  return (
    <label className="field">
      <span className="field__label">
        {label}
        {required && <span className="req">*</span>}
      </span>
      {children}
      {error ? <span className="field__error">{error}</span> : hint ? <span className="field__hint">{hint}</span> : null}
    </label>
  );
}

export function Input({ error, ...props }) {
  return <input className={`input ${error ? 'has-error' : ''}`} {...props} />;
}

export function Textarea({ error, ...props }) {
  return <textarea className={`textarea ${error ? 'has-error' : ''}`} {...props} />;
}

export function Select({ error, options = [], placeholder = '—', children, ...props }) {
  return (
    <select className={`select ${error ? 'has-error' : ''}`} {...props}>
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
    <div className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
      <div className="progress" style={{ flex: 1 }}>
        <div className="progress__bar" style={{ width: `${pct * 100}%` }} />
      </div>
      <span className="small muted num" style={{ minWidth: 32, textAlign: 'right' }}>
        {Math.round(pct * 100)}%
      </span>
    </div>
  );
}

export function BarList({ items, valueFormat = (v) => v, max: providedMax }) {
  const max = providedMax ?? Math.max(...items.map((i) => Number(i.value) || 0), 1);
  if (!items.length) return <Empty title="No data yet" />;
  return (
    <div className="bars">
      {items.map((item, i) => (
        <div key={item.label ?? i}>
          <div className="bar__top">
            <span className="bar__label" title={item.label}>{item.label || 'Not recorded'}</span>
            <span className="bar__value">{valueFormat(item.value, item)}</span>
          </div>
          <div className="bar__track">
            <div
              className={`bar__fill ${i % 3 === 1 ? 'bar__fill--2' : i % 3 === 2 ? 'bar__fill--3' : ''}`}
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
    <div className="kv">
      {items.filter(Boolean).map((item) => (
        <div key={item.label}>
          <div className="kv__k">{item.label}</div>
          <div className="kv__v">{item.value ?? <span className="muted">—</span>}</div>
        </div>
      ))}
    </div>
  );
}

export function Tabs({ tabs, active, onChange }) {
  return (
    <div className="tabs">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          className={`tab ${active === tab.key ? 'is-active' : ''}`}
          onClick={() => onChange(tab.key)}
        >
          {tab.label}
          {tab.count !== undefined && <span className="tab__count">{tab.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Alert({ tone = 'info', children }) {
  return <div className={`alert ${tone !== 'info' ? `alert--${tone}` : ''}`}>{children}</div>;
}

export function ErrorState({ message, onRetry }) {
  return (
    <Empty
      icon="⚠"
      title="Could not load this"
      text={message}
      action={onRetry && <button type="button" className="btn" onClick={onRetry}>Try again</button>}
    />
  );
}

/* ---------------------------------------------------------------- toasts */

const ToastContext = createContext(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const push = useCallback((message, tone = 'default') => {
    const id = Date.now() + Math.random();
    setToasts((all) => [...all, { id, message, tone }]);
    setTimeout(() => setToasts((all) => all.filter((t) => t.id !== id)), 4200);
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toast-host">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.tone !== 'default' ? `toast--${toast.tone}` : ''}`}>
            <span>{toast.tone === 'danger' ? '⚠' : toast.tone === 'success' ? '✓' : 'ℹ'}</span>
            <span>{toast.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
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
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn btn--danger" onClick={onConfirm} disabled={busy}>
            {busy ? 'Working…' : confirmLabel}
          </button>
        </>
      }
    >
      <p>{message}</p>
    </Modal>
  );
}
