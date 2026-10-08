import { createContext, useContext, useLayoutEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Info, Lock, Search, UserRound } from 'lucide-react';
import { toast as sonnerToast } from 'sonner';
import { cn } from 'cn';
import { PageHeader } from '../App.jsx';
import { MoneyBanner } from './money.jsx';

/**
 * Wave 8: the Settings shell's pieces.
 *
 * One h1 per page, the pane's own title, with "Settings › Group" above it
 * as a breadcrumb. The sub-navigation is a labelled glass list beside the
 * pane (1100px and up), a labelled select with a group per heading under
 * it, and on a phone `/settings` is a grouped list page with each pane
 * carrying a "‹ Settings" back link.
 *
 * `SettingsContext` is provided by SettingsArea: the groups the role sees,
 * the attention counts, and where /settings lands.
 */
export const SettingsContext = createContext(null);
export const useSettings = () => useContext(SettingsContext);

/** The pane a path is on: `/settings/rates/x` → the Exchange rates item. */
export function useCurrentItem() {
  const ctx = useSettings();
  const { pathname } = useLocation();
  const key = pathname.replace(/^\/settings\/?/, '').split('/')[0];
  if (!ctx) return null;
  for (const g of ctx.groups) for (const i of g.items) if (i.to === key) return { ...i, group: g.label };
  return null;
}

/**
 * The shape every settings pane wears: crumbs (or the phone's back link),
 * the title, one sentence saying what the pane is for, a "Read only" chip
 * where the role can't change it, the actions, then the tablet's section
 * select and any notice the shell carried here.
 */
export function SettingsPane({ title, description, actions, readOnly, crumbs, back, children }) {
  const ctx = useSettings();
  const item = useCurrentItem();
  const { state } = useLocation();
  const trail = crumbs ?? (item ? [{ label: item.group }] : []);
  const backTo = back ?? { to: '/settings', label: 'Settings' };
  return (
    <>
      <PageHeader
        className="set-header"
        eyebrow=""
        title={title}
        subtitle={description}
        actions={actions}
        lead={ctx && (
          <>
            <nav className="mg-crumbs set-crumbs" aria-label="Breadcrumb">
              <Link to="/settings">Settings</Link>
              {trail.map((c) => (
                <span key={c.label} className="contents">
                  <span aria-hidden="true">›</span>
                  {c.to ? <Link to={c.to}>{c.label}</Link> : <span>{c.label}</span>}
                </span>
              ))}
            </nav>
            <Link to={backTo.to} className="mg-btn mg-btn--ghost mg-btn--sm set-back">
              <ChevronLeft className="size-4" aria-hidden="true" />{backTo.label}
            </Link>
          </>
        )}
        nav={readOnly ? (
          <span className="mg-badge mg-badge--plain set-ro">
            <Lock className="size-3" strokeWidth={2.2} aria-hidden="true" />
            {typeof readOnly === 'string' ? readOnly : 'Read only: an admin changes these'}
          </span>
        ) : null}
      />
      {ctx && <SettingsSwitch />}
      {state?.settingsNotice && (
        <MoneyBanner icon={Info} title={state.settingsNotice}>{' '}Ask an admin if something there needs changing.</MoneyBanner>
      )}
      {children}
    </>
  );
}

/** Under 1100px the sub-navigation is one labelled select, a group per heading. */
function SettingsSwitch() {
  const { groups } = useSettings();
  const item = useCurrentItem();
  const navigate = useNavigate();
  return (
    <div className="mg-glass set-switch" data-a="rise">
      <label htmlFor="set-switch" className="mg-label">Settings section</label>
      <span className="mg-select-wrap">
        <select id="set-switch" className="mg-select" value={item?.to ?? ''} onChange={(e) => navigate(`/settings/${e.target.value}`)}>
          {!item && <option value="">Choose a section</option>}
          {groups.map((g) => (
            <optgroup key={g.label} label={g.label}>
              {g.items.map((i) => <option key={i.to} value={i.to}>{i.label}</option>)}
            </optgroup>
          ))}
        </select>
      </span>
    </div>
  );
}

/** The grouped glass list beside the pane, with its sliding marker and filter. */
export function SettingsNav({ showAccount }) {
  const { groups, counts } = useSettings();
  const [q, setQ] = useState('');
  const { pathname } = useLocation();
  const navRef = useRef(null);
  const [mark, setMark] = useState(null);
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  const ql = q.trim().toLowerCase();
  const shown = groups
    .map((g) => ({ ...g, items: g.items.filter((i) => !ql || i.label.toLowerCase().includes(ql) || g.label.toLowerCase().includes(ql)) }))
    .filter((g) => g.items.length);

  useLayoutEffect(() => {
    const el = navRef.current?.querySelector('a[aria-current="page"]');
    setMark(el ? el.offsetTop : null);
  }, [pathname, ql]);

  return (
    <aside className="mg-glass set-nav" data-a="rise" aria-label="Settings">
      <div className="set-nav__head"><span className="mg-label">Settings</span><span>{total} sections</span></div>
      {total > 8 && (
        <label className="mg-search">
          <Search aria-hidden="true" />
          <input className="mg-input" type="search" placeholder="Find a setting" aria-label="Find a setting" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
      )}
      <nav ref={navRef} aria-label="Settings sections" className="set-nav__list">
        <span className="set-nav__mark" aria-hidden="true" style={{ transform: `translateY(${mark ?? 0}px)`, opacity: mark == null ? 0 : 1 }} />
        {shown.map((g) => (
          <div key={g.label} className="contents">
            <span className="mg-label set-nav__group">{g.label}</span>
            {g.items.map((i) => {
              const c = counts[i.to];
              const Icon = i.icon;
              return (
                <NavLink key={i.to} to={`/settings/${i.to}`} className="set-nav__item" aria-label={c ? `${i.label}, ${c.say}` : undefined}>
                  {Icon && <Icon aria-hidden="true" />}
                  <span className="set-nav__label">{i.label}</span>
                  {c && <span className={cn('mg-count', c.tone === 'late' && 'is-late')} aria-hidden="true">{c.n}</span>}
                </NavLink>
              );
            })}
          </div>
        ))}
        {!shown.length && <p className="set-nav__none">No setting matches &ldquo;{q}&rdquo;.</p>}
      </nav>
      {showAccount && (
        <Link to="/account" className="set-nav__acct"><UserRound aria-hidden="true" />My account<ChevronRight className="ml-auto" aria-hidden="true" /></Link>
      )}
    </aside>
  );
}

/** `/settings` on a phone: My account, then every group as a list of rows. */
export function SettingsIndex({ showAccount, initials }) {
  const { groups, counts } = useSettings();
  return (
    <>
      <PageHeader className="set-header" title="Settings" subtitle="The lists, rates and connections the rest of the app reads from." />
      {showAccount && (
        <Link to="/account" className="mg-glass set-index__acct" data-a="rise">
          <span className="mg-avatar">{initials}</span>
          <span className="min-w-0 flex-1"><b>My account</b><small>Profile, notifications, ways in and devices</small></span>
          <ChevronRight aria-hidden="true" />
        </Link>
      )}
      {groups.map((g, gi) => (
        <section key={g.label} className="mg-glass mg-glass--strong set-index__group" data-a="rise" aria-labelledby={`set-g${gi}`}>
          <h2 className="mg-label" id={`set-g${gi}`}>{g.label}</h2>
          {g.items.map((i) => {
            const c = counts[i.to];
            const Icon = i.icon;
            return (
              <Link key={i.to} to={`/settings/${i.to}`} className="set-index__row" aria-label={c ? `${i.label}, ${c.say}` : undefined}>
                <span className="set-index__icon">{Icon && <Icon aria-hidden="true" />}</span>
                <span className="min-w-0 flex-1">{i.label}</span>
                {c && <span className={cn('mg-badge', c.tone === 'late' ? 'mg-badge--late' : 'mg-badge--wait')}>{c.short}</span>}
                <ChevronRight className="set-index__chev" aria-hidden="true" />
              </Link>
            );
          })}
        </section>
      ))}
    </>
  );
}

/** A labelled Edit / Delete pair for a row, or nothing for a reader. */
export function RowActions({ children }) {
  return <span className="set-acts">{children}</span>;
}

/** A row of figures a pane is about. */
export function SetStrip({ label, cells }) {
  return (
    <section className="mg-glass mg-strip set-strip" aria-label={label} data-a="rise">
      {cells.map((c) => (
        <div key={c.label}>
          <span className="mg-label">{c.label}</span>
          <span className={cn('mg-tile__figure mg-num', c.tone && `is-${c.tone}`)}>{c.figure}</span>
          {c.foot && <span className="mg-tile__foot">{c.foot}</span>}
        </div>
      ))}
    </section>
  );
}

/** A toast with Undo (Hide, alias removed, role changed): the system's pill with a button. */
export function undoToast(message, onUndo) {
  return sonnerToast.success(message, { action: { label: 'Undo', onClick: onUndo } });
}
