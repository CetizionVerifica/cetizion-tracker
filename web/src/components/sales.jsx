import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { Download, FileSpreadsheet, FileText, MoreHorizontal } from 'lucide-react';
import { cn } from 'cn';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/hooks.js';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from './ui/dropdown-menu';

/**
 * The Wave 3 building blocks: the Sales views switch, the summary strip,
 * the export menu, a badge in the system's four tones, record tabs held in
 * the address bar, and the titled section that sits inside a panel. Built
 * from the Mocha Glass classes so the Sales screens agree with each other.
 */

/** Enquiries · Deals · Pipeline · Renewals: one switch in all four headers. */
const VIEWS = [
  { to: '/enquiries', label: 'Enquiries' },
  { to: '/quotations', label: 'Deals' },
  { to: '/pipeline', label: 'Pipeline' },
  { to: '/renewals', label: 'Renewals' },
];
export function SalesViews() {
  const { pathname } = useLocation();
  return (
    <nav className="app-views" aria-label="Sales views">
      {VIEWS.map((v) => (
        <Link key={v.to} to={v.to} aria-current={pathname === v.to ? 'page' : undefined}>{v.label}</Link>
      ))}
    </nav>
  );
}

/**
 * The slim strip of figures over a list. A tile with `onClick` filters the
 * list and shows pressed while its filter is on.
 *
 * tile: { key, label, figure, foot, badge: { tone, text }, tone, onClick, pressed }
 */
export function SummaryStrip({ label, tiles, loading }) {
  return (
    <section className="mg-glass mg-strip app-strip" aria-label={label} aria-busy={loading || undefined} data-a="rise">
      {tiles.map((t) => {
        const inner = (
          <>
            <span className="mg-label">{t.label}</span>
            {loading && t.figure == null
              ? <span className="mg-skel" style={{ height: 26, width: '60%' }} />
              : <span className={cn('mg-tile__figure mg-num', t.tone && `is-${t.tone}`)}>{t.figure ?? '—'}</span>}
            {(t.foot || t.badge) && (
              <span className="mg-tile__foot">
                {t.badge && <span className={cn('mg-badge', TONES[t.badge.tone] || 'mg-badge--plain')}>{t.badge.text}</span>}
                {t.foot && <span>{t.foot}</span>}
              </span>
            )}
          </>
        );
        return t.onClick
          ? <button key={t.key} type="button" aria-pressed={Boolean(t.pressed)} onClick={t.onClick}>{inner}</button>
          : <div key={t.key}>{inner}</div>;
      })}
    </section>
  );
}

/** How many records a list filter matches: the list's own total, one row fetched. */
export function useTotal(resource, params, deps = []) {
  const key = JSON.stringify(params);
  const { data, loading, error } = useFetch(
    () => (params ? api.list(resource, { ...params, limit: 1 }) : Promise.resolve(null)),
    [resource, key, ...deps]
  );
  return { total: data?.total ?? null, loading, error };
}

/** The list's rows for one filter (a handful, for a banner's names) and their total. */
export function useRows(resource, params, deps = []) {
  const key = JSON.stringify(params);
  const { data, loading, error } = useFetch(
    () => (params ? api.list(resource, params) : Promise.resolve(null)),
    [resource, key, ...deps]
  );
  return { rows: data?.data ?? [], total: data?.total ?? null, loading, error };
}

/** The badge classes for a tone word. */
export const TONES = { late: 'mg-badge--late', wait: 'mg-badge--wait', ok: 'mg-badge--ok', info: 'mg-badge--info', plain: 'mg-badge--plain' };
export function Tone({ tone = 'plain', className, children, title }) {
  return <span className={cn('mg-badge', TONES[tone] || TONES.plain, className)} title={title}>{children}</span>;
}

/** Export: what the list shows now, as CSV or as an Excel workbook. */
export function ExportMenu({ resource, params, label = 'Export' }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="mg-btn" aria-label={`${label}: CSV or Excel`}>
          <Download className="size-4" strokeWidth={1.8} aria-hidden="true" />{label}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuItem asChild>
          <a href={api.exportUrl(resource, params)} download title="What the list shows now, with the same search and filters">
            <FileText aria-hidden="true" />Export CSV<small className="ml-auto text-[12px] text-muted-foreground">.csv</small>
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href={api.exportXlsxUrl(resource, params)} download title="What the list shows now, as an Excel workbook">
            <FileSpreadsheet aria-hidden="true" />Export Excel<small className="ml-auto text-[12px] text-muted-foreground">.xlsx</small>
          </a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A ⋯ button that opens a menu of `items`: { label, onSelect, icon, danger, to }. */
export function MoreMenu({ items, label = 'More actions', className, size = 'md' }) {
  const shown = items.filter(Boolean);
  if (!shown.length) return null;
  const danger = shown.filter((i) => i.danger);
  const plain = shown.filter((i) => !i.danger);
  const row = (i) => {
    const Icon = i.icon;
    const body = <>{Icon && <Icon aria-hidden="true" />}{i.label}</>;
    return i.to
      ? <DropdownMenuItem key={i.label} asChild><Link to={i.to}>{body}</Link></DropdownMenuItem>
      : <DropdownMenuItem key={i.label} variant={i.danger ? 'destructive' : undefined} disabled={i.disabled} onSelect={i.onSelect}>{body}</DropdownMenuItem>;
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={cn('mg-btn mg-btn--icon', size === 'sm' && 'app-iconbtn', className)} aria-label={label}>
          <MoreHorizontal className="size-[18px]" strokeWidth={2} aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        {plain.map(row)}
        {danger.length > 0 && plain.length > 0 && <div className="mg-menu__sep" role="separator" />}
        {danger.map(row)}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Which tab a record page shows, held in `?tab=` so a link (or Back) lands
 * on it. Unknown or hidden tabs fall back to the first.
 */
export function useTab(keys, fallback = keys[0]) {
  const [params, setParams] = useSearchParams();
  const asked = params.get('tab');
  const tab = keys.includes(asked) ? asked : fallback;
  const setTab = (next) => setParams((prev) => {
    const p = new URLSearchParams(prev);
    if (next === keys[0]) p.delete('tab'); else p.set('tab', next);
    return p;
  }, { replace: true });
  return [tab, setTab];
}

/** Caramel-underlined tabs over a record's sections; each a real tab with its panel. */
export function RecordTabs({ id, tabs, active, onChange, label }) {
  function onKey(e, i) {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    onChange(next.key);
    document.getElementById(`${id}-tab-${next.key}`)?.focus();
  }
  return (
    <div className="mg-tabs" role="tablist" aria-label={label}>
      {tabs.map((t, i) => (
        <button
          key={t.key}
          id={`${id}-tab-${t.key}`}
          type="button"
          role="tab"
          aria-selected={active === t.key}
          aria-controls={`${id}-panel`}
          tabIndex={active === t.key ? 0 : -1}
          onClick={() => onChange(t.key)}
          onKeyDown={(e) => onKey(e, i)}
        >
          {t.label}
          {t.count != null && <span className="mg-count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** A titled part of a panel: a heading, a hint, its tools, then the content. Never glass. */
export function Sec({ title, hint, tools, children, className, id }) {
  return (
    <section className={cn('app-sec', className)} aria-labelledby={title ? id : undefined}>
      {(title || tools) && (
        <div className="app-sec__head">
          {title && <h3 id={id}>{title}</h3>}
          {hint && <span className="mg-panel__hint">{hint}</span>}
          {tools && <div className="app-sec__tools">{tools}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/** "5 days late" / "in 3 days" against today, from an ISO date. */
export function daysFrom(iso) {
  if (!iso) return null;
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00`);
  const t = new Date(); t.setHours(0, 0, 0, 0);
  return Math.round((d - t) / 864e5);
}
