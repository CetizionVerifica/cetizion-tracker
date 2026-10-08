import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useTheme } from 'next-themes';
import { DropdownMenu as DM } from 'radix-ui';
import {
  Bell, Keyboard, LogOut, Menu, Moon, Pin, PinOff, Plus, Search,
  Settings as SettingsIcon, Sun, UserRound, X,
} from 'lucide-react';
import { cn } from 'cn';
import { api } from '../../lib/api.js';
import { isPaused, pause as pauseMotion, switchTheme } from '../../styles/mocha/motion.js';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.tsx';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet.tsx';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { DOCK, DOCK_HR, NEW_ITEMS, NEW_ITEMS_HR, TONE_VAR, navFor, tabsFor, viewHref } from './nav.js';

/**
 * The Mocha Glass shell (Wave 1): the icon rail with its coffee-drop marker,
 * the pinned-views panel, the account menu, the bell, the quick-add dock,
 * and on a phone the tab bar with its More and New sheets. App.jsx owns the
 * data (counts, pinned views, who is signed in) and hands it down here.
 */
export const ShellContext = createContext(null);
export const useShell = () => useContext(ShellContext) || {};

/** The coffee bean: the app's mark, in the rail, the phone header and sign-in. */
export function BrandMark({ size = 34, className }) {
  return (
    <svg width={size} height={size} viewBox="0 0 34 34" fill="none" aria-hidden="true" className={className}>
      <ellipse cx="17" cy="17" rx="12" ry="15" transform="rotate(28 17 17)" style={{ fill: 'var(--btn)' }} />
      <path d="M11 9c5 4 6 10 1 16" style={{ stroke: 'var(--caramel)' }} strokeWidth="2.4" strokeLinecap="round" transform="rotate(28 17 17)" />
    </svg>
  );
}

/**
 * Light, dark or the system's, with the shockwave: to dark the dark page
 * spreads out of the button that was pressed, to light it is pulled back in.
 * The stored choice is next-themes' as before ("system" stays "system"); the
 * page is repainted inside the view transition so the wave has both frames.
 */
export function useThemeSwitch() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  const change = useCallback((next, btn) => {
    const html = document.documentElement;
    let system = 'light';
    try { system = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; } catch { /* old browser */ }
    const target = next === 'system' ? system : next;
    const current = html.classList.contains('dark') ? 'dark' : 'light';
    const apply = () => {
      html.classList.toggle('dark', target === 'dark');
      html.setAttribute('data-theme', target);
      html.style.colorScheme = target;
      flushSync(() => setTheme(next));
    };
    if (target === current || isPaused()) { apply(); return; }
    switchTheme(target, btn, apply);
  }, [setTheme]);
  return { theme: theme || 'light', resolved: resolvedTheme || 'light', change };
}

/* ------------------------------------------------------------ pause */

/** One pause state for every control bar on screen (the phone and wide headers both draw one). */
export function usePaused() {
  const [paused, setPaused] = useState(isPaused);
  useEffect(() => {
    const sync = () => setPaused(isPaused());
    window.addEventListener('mg-pause', sync);
    return () => window.removeEventListener('mg-pause', sync);
  }, []);
  const toggle = () => { pauseMotion(); window.dispatchEvent(new Event('mg-pause')); };
  return [paused, toggle];
}

/* ------------------------------------------------------------ rail */

function RailLink({ item, onTip, onUntip }) {
  const { counts = {}, alerts = {} } = useShell();
  const count = item.badge ? counts[item.badge] : null;
  const aria = count > 0 ? `${item.label}, ${count} open` : item.label;
  return (
    <NavLink
      to={item.to}
      end={item.end}
      className="mg-rail__btn"
      aria-label={aria}
      onMouseEnter={(e) => onTip(e.currentTarget, item.label, count)}
      onFocus={(e) => onTip(e.currentTarget, item.label, count)}
      onBlur={onUntip}
    >
      {({ isActive }) => (
        <>
          <item.icon strokeWidth={1.8} aria-hidden="true" />
          {count > 0 && !isActive && (
            <span className="mg-count" style={alerts[item.badge] ? { background: 'var(--late)', color: 'var(--on-late)' } : undefined}>
              {count}
            </span>
          )}
        </>
      )}
    </NavLink>
  );
}

function Rail() {
  const s = useShell();
  const { top, records } = navFor(s.isHr, s.isAdmin);
  const wrapRef = useRef(null);
  const navRef = useRef(null);
  const location = useLocation();
  const [drop, setDrop] = useState(null);
  const [tip, setTip] = useState({ on: false, label: '', count: null, y: 0 });
  const { resolved, change } = useThemeSwitch();

  // The drop sits under whichever link is the current page, and slides on
  // the Brew spring when that changes. No current page (Settings, a record
  // reached from the palette), no drop.
  const measure = useCallback(() => {
    const nav = navRef.current;
    const on = nav?.querySelector('a[aria-current="page"]');
    setDrop(on ? { x: on.offsetLeft, y: on.offsetTop, size: on.offsetHeight } : null);
  }, []);
  useLayoutEffect(measure, [measure, location.pathname, s.isHr]);
  useEffect(() => {
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [measure]);

  const showTip = (el, label, count) => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const y = el.getBoundingClientRect().top - wrap.getBoundingClientRect().top + (el.offsetHeight - 28) / 2;
    setTip({ on: true, label, count, y });
  };
  const hideTip = () => setTip((t) => ({ ...t, on: false }));
  const lateViews = (s.pinned || []).filter((v) => v.tone === 'late').reduce((n, v) => n + (Number(v.count) || 0), 0);

  return (
    <div className="app-shell__rail" ref={wrapRef} data-a="rise">
      <aside className="mg-rail mg-glass" aria-label="Main">
        <Link to={s.isHr ? '/travel-dashboard' : '/'} aria-label={s.isHr ? 'Go to the travel dashboard' : 'Go to Today'} className="mg-rail__logo grid place-items-center">
          <BrandMark />
        </Link>
        <nav className="mg-rail__nav" aria-label="Pages" ref={navRef} onMouseLeave={hideTip}>
          <span
            className="mg-drop"
            aria-hidden="true"
            style={{
              transform: drop ? `translate(${drop.x}px, ${drop.y}px)` : undefined,
              width: drop?.size, height: drop?.size,
              opacity: drop ? 1 : 0,
            }}
          />
          {top.map((item) => <RailLink key={item.to} item={item} onTip={showTip} onUntip={hideTip} />)}
          <span aria-hidden="true" className="app-rail__sep" />
          {records.map((item) => <RailLink key={item.to} item={item} onTip={showTip} onUntip={hideTip} />)}
        </nav>

        <span aria-hidden="true" className="app-rail__rule" />
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="mg-rail__btn app-rail__pin"
              aria-label={lateViews > 0 ? `Pinned views, ${lateViews} overdue` : 'Pinned views'}
              onMouseEnter={(e) => showTip(e.currentTarget, 'Pinned views', null)}
              onMouseLeave={hideTip}
            >
              <Pin strokeWidth={1.8} aria-hidden="true" />
              {lateViews > 0 && <span className="mg-count" style={{ background: 'var(--late)', color: 'var(--on-late)' }}>{lateViews}</span>}
            </button>
          </PopoverTrigger>
          <PopoverContent side="right" align="end" sideOffset={24} collisionPadding={12} className="flex w-[316px] flex-col gap-0.5 rounded-[22px] px-2.5 pt-3.5 pb-2.5" style={{ '--pop-origin': 'bottom left' }}>
            <PinnedPanel />
          </PopoverContent>
        </Popover>

        <div className="mg-rail__foot">
          <button
            type="button"
            className="mg-rail__theme"
            aria-label={`Switch to ${resolved === 'dark' ? 'light' : 'dark'} mode`}
            onClick={(e) => change(resolved === 'dark' ? 'light' : 'dark', e.currentTarget)}
          >
            {resolved === 'dark' ? <Sun size={18} strokeWidth={1.8} aria-hidden="true" /> : <Moon size={18} strokeWidth={1.8} aria-hidden="true" />}
          </button>
          <AccountMenu side="right" align="end" />
        </div>
      </aside>
      <span className={cn('mg-tip', tip.on && 'is-on')} aria-hidden="true" style={{ left: 90, top: 0, transform: `translateY(${tip.y}px) translateX(${tip.on ? 0 : -6}px)` }}>
        {tip.label}
        {tip.count > 0 && <span className="mg-count">{tip.count}</span>}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------ pinned views */

function PinnedPanel() {
  return (
    <>
      <div className="flex items-center px-2.5 pb-1.5">
        <h2 className="mg-panel__title">Pinned views</h2>
      </div>
      <PinnedList />
    </>
  );
}

/**
 * The pinned views, the person's own first and then everybody's, each with
 * its count. Unpin is always shown (touch has no hover); a shared view is
 * only an admin's to unpin, so others are not offered a button that fails.
 */
export function PinnedList({ onPick, roomy = false }) {
  const { pinned = [], pinnedLoading, pinnedError, unpin, isAdmin } = useShell();
  const location = useLocation();
  const here = location.pathname + location.search;

  if (pinnedLoading) {
    return (
      <div className="flex flex-col gap-1.5 px-2.5 py-1" aria-busy="true" aria-label="Loading pinned views">
        {[0, 1, 2].map((i) => <span key={i} className="mg-skel" style={{ height: roomy ? 44 : 40, borderRadius: 12 }} />)}
      </div>
    );
  }
  const hint = (
    <p className="app-pinned__hint">
      Filter any list, then <strong>Save these filters</strong> to pin it here with its count.
    </p>
  );
  if (pinnedError && !pinned.length) {
    return <p className="app-pinned__hint">Couldn&rsquo;t load your pinned views. They&rsquo;ll be back on the next page you open.</p>;
  }
  if (!pinned.length) return hint;

  const mine = pinned.filter((v) => v.owner != null);
  const shared = pinned.filter((v) => v.owner == null);
  const row = (v, canUnpin) => {
    const href = viewHref(v);
    const tone = TONE_VAR[v.tone] || TONE_VAR.info;
    return (
      <div key={v.id} className={cn('app-pinned__row', roomy && 'is-roomy', href === here && 'is-on')}>
        <Link to={href} onClick={onPick} className="app-pinned__link" aria-current={href === here ? 'page' : undefined}>
          <span className="app-pinned__dot" style={{ background: tone }} aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">{v.name}</span>
          {v.count > 0 && <span className="mg-num font-extrabold" style={{ color: tone }}>{v.count}</span>}
        </Link>
        {canUnpin && (
          <button type="button" className="mg-iconbtn app-pinned__unpin" aria-label={`Unpin ${v.name}`} title="Unpin" onClick={() => unpin(v)}>
            <PinOff strokeWidth={1.8} aria-hidden="true" />
          </button>
        )}
      </div>
    );
  };
  return (
    <>
      {mine.length > 0 && <span className="mg-label app-pinned__group">Mine</span>}
      {mine.map((v) => row(v, true))}
      {shared.length > 0 && <span className="mg-label app-pinned__group">Everybody&rsquo;s</span>}
      {shared.map((v) => row(v, isAdmin))}
      {hint}
    </>
  );
}

/* ------------------------------------------------------------ account menu */

const THEMES = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  // "System" on the segment, the full words for anyone reading it out.
  { value: 'system', label: 'System', aria: 'Match the system' },
];

function AccountMenu({ side, align }) {
  const s = useShell();
  const { theme, change } = useThemeSwitch();
  const [ready, setReady] = useState(false);
  // The stored choice is only known once mounted; no dot before then.
  useEffect(() => setReady(true), []);
  const at = Math.max(0, THEMES.findIndex((t) => t.value === theme));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="mg-avatar app-rail__avatar" aria-label={`${s.who || 'You'}: account, settings and sign out`}>
          {s.initials}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side={side} align={align} sideOffset={24} collisionPadding={12} className="w-[272px] rounded-[20px] p-2" style={{ '--pop-origin': 'bottom left' }}>
        <div className="flex items-center gap-2.5 border-b border-line px-2.5 pt-2 pb-2.5 mb-1">
          <span className="mg-avatar">{s.initials}</span>
          <div className="min-w-0">
            <div className="truncate font-bold">{s.who}</div>
            <div className="text-[12px] text-muted-foreground">{s.roleLabel}</div>
          </div>
        </div>
        {/* Only in database mode: shared mode is one account in an
            environment variable, so there is no personal account to own. */}
        {s.mode === 'database' && (
          <DropdownMenuItem asChild>
            <Link to="/account"><UserRound className="size-4" aria-hidden="true" />My account</Link>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem asChild>
          <Link to="/settings"><SettingsIcon className="size-4" aria-hidden="true" />Settings</Link>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => s.openPalette?.()}>
          <Search className="size-4" aria-hidden="true" />Search or do anything
          <span className="mg-kbd ml-auto">Ctrl K</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => s.showShortcuts?.()}>
          <Keyboard className="size-4" aria-hidden="true" />Keyboard shortcuts
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Theme</DropdownMenuLabel>
        {ready && (
          <DM.RadioGroup value={theme} className="mg-seg app-theme-seg mx-2 mb-2 flex" aria-label="Theme">
            <span className="mg-seg__thumb" aria-hidden="true" style={{ transform: `translateX(${at * 100}%)` }} />
            {THEMES.map((t) => (
              <DM.RadioItem
                key={t.value}
                value={t.value}
                aria-label={t.aria}
                className="app-theme-seg__item"
                // Stays open, as a segmented control does, so the wave is seen.
                onSelect={(e) => { e.preventDefault(); change(t.value, e.currentTarget); }}
              >
                {t.label}
              </DM.RadioItem>
            ))}
          </DM.RadioGroup>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={s.signOut}>
          <LogOut className="size-4" aria-hidden="true" />Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Every shortcut the app answers to, in one list (A1-21). */
export function ShortcutsDialog({ open, onOpenChange }) {
  const rows = [
    [['Ctrl', 'K'], 'Search or do anything, from any page (⌘ K on a Mac)'],
    [['/'], 'The same, when you are not typing in a field'],
    [['↑', '↓'], 'Move through the results'],
    [['↵'], 'Run the step, or open the record'],
    [['Esc'], 'Close the palette, a menu or a dialog'],
  ];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogTitle className="text-[18px] font-bold">Keyboard shortcuts</DialogTitle>
        <DialogDescription className="text-secondary-text">They work on every page once you are signed in.</DialogDescription>
        <dl className="m-0 flex flex-col">
          {rows.map(([keys, what]) => (
            <div key={what} className="flex items-center gap-4 border-t border-line py-2.5">
              <dt className="flex w-[92px] shrink-0 gap-1">{keys.map((k) => <kbd key={k} className="mg-kbd">{k}</kbd>)}</dt>
              <dd className="m-0 text-[13.5px] text-secondary-text">{what}</dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------ bell */

function ago(when) {
  const mins = Math.max(0, Math.round((Date.now() - new Date(when).getTime()) / 60000));
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'Yesterday' : `${days}d`;
}

function BellButton() {
  const { unread = 0, refetchBell } = useShell();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [list, setList] = useState({ loading: false, rows: null, error: false });
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setList((l) => ({ ...l, loading: true, error: false }));
    api.raw('/notifications?limit=8')
      .then((res) => setList({ loading: false, rows: res.data || [], error: false }))
      .catch(() => setList({ loading: false, rows: null, error: true }));
  }, []);
  useEffect(() => { if (open) load(); }, [open, load]);

  const openOne = async (n) => {
    setOpen(false);
    if (!n.read_at) await api.raw(`/notifications/${n.id}/read`, { method: 'POST' }).catch(() => {});
    refetchBell?.();
    navigate(n.link || '/notifications');
  };
  const readAll = async () => {
    setBusy(true);
    try { await api.raw('/notifications/read-all', { method: 'POST' }); load(); refetchBell?.(); } catch { /* the list says nothing changed */ }
    setBusy(false);
  };
  const rows = list.rows || [];
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="mg-iconbtn" aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'} style={open ? { background: 'var(--track)' } : undefined}>
          <Bell strokeWidth={1.8} aria-hidden="true" />
          {unread > 0 && <span className="mg-count">{unread > 99 ? '99+' : unread}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={10} collisionPadding={16} className="flex w-[404px] max-w-[calc(100vw-32px)] flex-col gap-0.5 rounded-[22px] px-2 pt-3.5 pb-2" style={{ '--pop-origin': 'top right' }}>
        <div className="flex items-center px-3 pb-2">
          <h2 className="mg-panel__title">Notifications</h2>
          <button type="button" className="mg-btn mg-btn--ghost mg-btn--sm ml-auto" disabled={busy || !rows.some((n) => !n.read_at)} onClick={readAll}>
            {busy ? 'Working…' : 'Mark all read'}
          </button>
        </div>
        {list.loading && !list.rows ? (
          <div className="flex flex-col gap-1.5 px-3 py-1" aria-busy="true" aria-label="Loading notifications">
            {[0, 1, 2].map((i) => <span key={i} className="mg-skel" style={{ height: 52, borderRadius: 14 }} />)}
          </div>
        ) : list.error ? (
          <div className="mg-empty" style={{ padding: '20px 16px' }}>
            <p className="mg-empty__text">Couldn&rsquo;t load your notifications.</p>
            <button type="button" className="mg-btn mg-btn--sm" onClick={load}>Try again</button>
          </div>
        ) : rows.length === 0 ? (
          <div className="mg-empty" style={{ padding: '24px 16px' }}>
            <span className="mg-empty__mark"><Bell size={22} strokeWidth={1.8} aria-hidden="true" /></span>
            <p className="mg-empty__title">You&rsquo;re all caught up</p>
            <p className="mg-empty__text">New payments, follow-ups and enquiries show up here.</p>
          </div>
        ) : (
          <div className="flex max-h-[min(420px,60dvh)] flex-col gap-0.5 overflow-y-auto">
            {rows.map((n) => (
              <button key={n.id} type="button" className={cn('app-note', !n.read_at && 'is-unread')} onClick={() => openOne(n)}>
                <span className="app-note__dot" aria-hidden="true" />
                <span className="min-w-0">
                  <span className="block font-bold">{n.title}</span>
                  {n.body && <span className="block truncate text-[12.5px] text-secondary-text">{n.body}</span>}
                </span>
                <span className="text-[12px] whitespace-nowrap text-muted-foreground">{n.created_at ? ago(n.created_at) : ''}</span>
              </button>
            ))}
          </div>
        )}
        <Link to="/notifications" onClick={() => setOpen(false)} className="app-note__all">See all notifications</Link>
      </PopoverContent>
    </Popover>
  );
}

/** The pause button's glyph as the design draws it: two thin bars, or the play triangle. */
export function MotionGlyph({ paused }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={paused ? 'M8 5v14l11-7z' : 'M9 6v12M15 6v12'} />
    </svg>
  );
}

/** Pause motion and the bell, at the end of every page header. */
export function ControlBar({ className }) {
  const [paused, toggle] = usePaused();
  return (
    <div className={cn('mg-controlbar', className)}>
      <button type="button" className="mg-iconbtn" aria-label={paused ? 'Play motion' : 'Pause motion'} aria-pressed={paused} onClick={toggle}>
        <MotionGlyph paused={paused} />
      </button>
      <BellButton />
    </div>
  );
}

/* ------------------------------------------------------------ dock and New */

function useQuickActions() {
  const s = useShell();
  const navigate = useNavigate();
  const run = (d) => (d.step ? s.openPalette?.({ step: d.step }) : navigate(d.to));
  return { dock: s.isHr ? DOCK_HR : DOCK, news: s.isHr ? NEW_ITEMS_HR : NEW_ITEMS, run };
}

function Dock() {
  const s = useShell();
  const { dock, news, run } = useQuickActions();
  const [open, setOpen] = useState(false);
  return (
    <div className="app-shell__dock" data-a="dock">
      <nav className="mg-dock" aria-label="Quick add">
        <DropdownMenu open={open} onOpenChange={setOpen}>
          <DropdownMenuTrigger asChild>
            <button type="button" className="mg-dock__add" aria-label="New">
              <Plus size={20} strokeWidth={2} aria-hidden="true" style={{ transform: `rotate(${open ? 45 : 0}deg)`, transition: 'transform 420ms var(--mg-spring)' }} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" sideOffset={16} className="w-[248px] rounded-[20px] p-2" style={{ '--pop-origin': 'bottom left' }}>
            <DropdownMenuLabel>New</DropdownMenuLabel>
            {news.map((m) => (
              <DropdownMenuItem key={m.label} asChild>
                <Link to={m.to}><m.icon className="size-4 text-secondary-text" aria-hidden="true" />{m.label}</Link>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        {dock.map((d) => (
          <button key={d.label} type="button" className="mg-btn mg-btn--ghost mg-btn--sm" aria-label={d.label} onClick={() => run(d)}>
            <d.icon size={16} strokeWidth={1.8} aria-hidden="true" />
            <span className="mg-dock__label">{d.label}</span>
          </button>
        ))}
        <span className="mg-dock__sep" aria-hidden="true" />
        <button type="button" className="mg-btn mg-btn--ghost mg-btn--sm" aria-label="Search or do anything, Ctrl K" onClick={() => s.openPalette?.()}>
          <Search size={16} strokeWidth={1.8} aria-hidden="true" />
          <span className="mg-dock__label">Search</span>
          <span className="mg-kbd mg-dock__label">Ctrl K</span>
        </button>
      </nav>
    </div>
  );
}

/* ------------------------------------------------------------ phone */

function SheetFrame({ open, onOpenChange, label, description, children }) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" showCloseButton={false} className="app-sheet inset-x-2 bottom-[92px] max-h-[calc(100dvh-120px)] gap-0 overflow-y-auto rounded-[28px] border px-4 pt-0 pb-[18px]">
        <SheetTitle className="sr-only">{label}</SheetTitle>
        <SheetDescription className="sr-only">{description}</SheetDescription>
        <div className="mg-sheet__grab" aria-hidden="true" />
        {children}
      </SheetContent>
    </Sheet>
  );
}

function MoreSheet({ open, onOpenChange }) {
  const s = useShell();
  const { top, records } = navFor(s.isHr, s.isAdmin);
  const { resolved, change } = useThemeSwitch();
  const close = () => onOpenChange(false);
  return (
    <SheetFrame open={open} onOpenChange={onOpenChange} label="Menu" description="Every page, your pinned views and your account.">
      <div className="flex items-center gap-2.5 px-0.5 pt-2.5 pb-3.5">
        <span className="mg-avatar" style={{ width: 40, height: 40 }}>{s.initials}</span>
        <div className="min-w-0">
          <div className="truncate font-bold">{s.who}</div>
          <div className="text-[12px] text-muted-foreground">{s.roleLabel}</div>
        </div>
        <button type="button" className="mg-iconbtn ml-auto" aria-label="Close menu" onClick={close}><X strokeWidth={1.8} aria-hidden="true" /></button>
      </div>
      {/* Typing here carries on in the palette, which has the results. */}
      <label className="mg-search mb-3.5 flex-none">
        <Search strokeWidth={1.8} aria-hidden="true" />
        <input
          className="mg-input"
          placeholder="Search or do anything"
          aria-label="Search or do anything"
          value=""
          onChange={(e) => { close(); s.openPalette?.({ q: e.target.value }); }}
        />
      </label>
      <nav aria-label="All pages" className="grid grid-cols-3 gap-2">
        {[...top, ...records].map((item) => (
          <NavLink key={item.to} to={item.to} end={item.end} onClick={close} className="app-more__page">
            <item.icon size={22} strokeWidth={1.8} aria-hidden="true" />
            {item.label}
          </NavLink>
        ))}
      </nav>
      <div className="mg-label mt-[18px] mb-1.5 px-0.5">Pinned</div>
      <PinnedList onPick={close} roomy />
      <div className="mt-3.5 flex flex-wrap items-center gap-2 border-t border-line pt-3.5">
        {s.mode === 'database' && <Link to="/account" onClick={close} className="mg-btn mg-btn--sm">My account</Link>}
        <Link to="/settings" onClick={close} className="mg-btn mg-btn--sm">Settings</Link>
        <button type="button" className="mg-btn mg-btn--sm" onClick={(e) => change(resolved === 'dark' ? 'light' : 'dark', e.currentTarget)}>
          {resolved === 'dark' ? <Sun size={15} strokeWidth={1.8} aria-hidden="true" /> : <Moon size={15} strokeWidth={1.8} aria-hidden="true" />}
          {resolved === 'dark' ? 'Light mode' : 'Dark mode'}
        </button>
        <button type="button" className="mg-btn mg-btn--sm" onClick={() => { close(); s.showShortcuts?.(); }}>Shortcuts</button>
        <button type="button" className="mg-btn mg-btn--sm mg-btn--ghost ml-auto" onClick={() => { close(); s.signOut?.(); }}>Sign out</button>
      </div>
    </SheetFrame>
  );
}

function NewSheet({ open, onOpenChange }) {
  const { dock, news, run } = useQuickActions();
  const close = () => onOpenChange(false);
  return (
    <SheetFrame open={open} onOpenChange={onOpenChange} label="New" description="Start a step or a new record.">
      <div className="mg-label mt-3 mb-2 px-0.5">Do</div>
      <div className="flex flex-col gap-2">
        {dock.map((d) => (
          <button key={d.label} type="button" className="mg-btn mg-btn--lg justify-start" onClick={() => { close(); run(d); }}>
            <d.icon size={18} strokeWidth={1.8} aria-hidden="true" />{d.label}
          </button>
        ))}
      </div>
      <div className="mg-label mt-4 mb-2 px-0.5">New</div>
      <div className="grid grid-cols-2 gap-2">
        {news.map((m) => <Link key={m.label} to={m.to} onClick={close} className="mg-btn justify-start">{m.label}</Link>)}
      </div>
    </SheetFrame>
  );
}

function TabBar() {
  const s = useShell();
  const [sheet, setSheet] = useState(null);
  const location = useLocation();
  useEffect(() => { setSheet(null); }, [location.pathname]);
  const toggle = (name) => setSheet((cur) => (cur === name ? null : name));
  return (
    <>
      <nav className="mg-glass app-shell__tabbar" aria-label="Main">
        {tabsFor(s.isHr).map((t) => {
          if (t === '+') {
            return (
              <button key="+" type="button" className="app-tab__add" aria-label="New" aria-expanded={sheet === 'new'} onClick={() => toggle('new')}>
                <Plus size={22} strokeWidth={2} aria-hidden="true" style={{ transform: `rotate(${sheet === 'new' ? 45 : 0}deg)`, transition: 'transform 420ms var(--mg-spring)' }} />
              </button>
            );
          }
          if (t === 'more') {
            return (
              <button key="more" type="button" className={cn('app-tab', sheet === 'more' && 'is-on')} aria-label="More pages, pinned views and account" aria-expanded={sheet === 'more'} onClick={() => toggle('more')}>
                <span className="app-tab__drop" aria-hidden="true" />
                <Menu size={20} strokeWidth={1.8} aria-hidden="true" className="app-tab__icon" />
                <span className="app-tab__label">More</span>
              </button>
            );
          }
          const count = t.badge ? s.counts?.[t.badge] : null;
          return (
            <NavLink key={t.to} to={t.to} end={t.end} className={({ isActive }) => cn('app-tab', isActive && !sheet && 'is-on')} aria-label={count > 0 ? `${t.label}, ${count} open` : t.label}>
              {({ isActive }) => (
                <>
                  <span className="app-tab__drop" aria-hidden="true" />
                  <t.icon size={20} strokeWidth={1.8} aria-hidden="true" className="app-tab__icon" />
                  <span className="app-tab__label">{t.short || t.label}</span>
                  {count > 0 && !isActive && <span className="mg-count app-tab__count">{count}</span>}
                </>
              )}
            </NavLink>
          );
        })}
      </nav>
      <MoreSheet open={sheet === 'more'} onOpenChange={(o) => setSheet(o ? 'more' : null)} />
      <NewSheet open={sheet === 'new'} onOpenChange={(o) => setSheet(o ? 'new' : null)} />
    </>
  );
}

/* ------------------------------------------------------------ the frame */

/** The rail (720px and up), the dock, the phone tab bar, around the page. */
export function ShellFrame({ children }) {
  return (
    <div className="app-shell">
      <Rail />
      <main className="app-shell__main">{children}</main>
      <Dock />
      <TabBar />
    </div>
  );
}
