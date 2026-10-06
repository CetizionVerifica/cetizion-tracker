import { createContext, lazy, Suspense, useContext, useEffect, useRef, useState } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';

import Today from './pages/Today.jsx';
import Worklist from './pages/Worklist.jsx';
import DataQuality from './pages/DataQuality.jsx';
import Tasks from './pages/Tasks.jsx';
import FollowUps from './pages/FollowUps.jsx';
import Enquiries from './pages/Enquiries.jsx';
import Companies from './pages/Companies.jsx';
import CompanyDetail from './pages/CompanyDetail.jsx';
import Deliverables from './pages/Deliverables.jsx';
import Schedule from './pages/Schedule.jsx';
import Quotations from './pages/Quotations.jsx';
import QuotationDetail from './pages/QuotationDetail.jsx';
import Pipeline from './pages/Pipeline.jsx';
import Renewals from './pages/Renewals.jsx';
import Projects from './pages/Projects.jsx';
import ProjectDetail from './pages/ProjectDetail.jsx';
import PurchaseOrders from './pages/PurchaseOrders.jsx';
import PurchaseOrderDetail from './pages/PurchaseOrderDetail.jsx';
import PaymentStages from './pages/PaymentStages.jsx';
import Collections from './pages/Collections.jsx';
import Cashflow from './pages/Cashflow.jsx';
import Account from './pages/account/index.jsx';
// Reports is the only page that draws charts, and Recharts is a third of
// the bundle. Loaded when someone asks for it, so every other page is not
// paying for it on first visit.
const Reports = lazy(() => import('./pages/Reports.jsx'));
// Insights draws charts too, so it is loaded the same way.
const Insights = lazy(() => import('./pages/Insights.jsx'));
const ScheduledReports = lazy(() => import('./pages/ScheduledReports.jsx'));
import Profitability from './pages/Profitability.jsx';
import Accounting from './pages/Accounting.jsx';
import Notifications from './pages/Notifications.jsx';
import TravelLogs from './pages/TravelLogs.jsx';
import TripDetail from './pages/TripDetail.jsx';
import InvoiceRun from './pages/InvoiceRun.jsx';
import VendorInvoices from './pages/VendorInvoices.jsx';
import VendorInvoiceDetail from './pages/VendorInvoiceDetail.jsx';
import Payables from './pages/Payables.jsx';
import ExpenseClaims from './pages/ExpenseClaims.jsx';
import TravelDashboard from './pages/TravelDashboard.jsx';
import { useTheme } from 'next-themes';
import SettingsArea from './pages/SettingsArea.jsx';
import ImportReview from './pages/ImportReview.jsx';
import Inbox from './pages/Inbox.jsx';
import NotFound from './pages/NotFound.jsx';
import { useFetch } from './lib/hooks.js';
import { api } from './lib/api.js';
import { useToast } from './components/ui.jsx';

/**
 * New notifications pop up while the app is open (#44): every minute, while
 * the tab is visible, anything that arrived since the last look is shown as
 * a toast and the bell count refreshes. The server leaves out the kinds the
 * person switched off, and says when it is their quiet hours: then only the
 * count moves. The baseline is the server's own latest time, so a clock that
 * disagrees with the server's neither repeats nor misses one.
 */
function useNotificationPopups(onNew) {
  const toast = useToast();
  const since = useRef(null);
  useEffect(() => {
    const tick = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const { data: s } = await api.raw('/notifications/summary');
        if (!s?.latest) return;
        if (since.current === null) { since.current = s.latest; return; }
        if (new Date(s.latest) <= new Date(since.current)) return;
        const { data: fresh } = await api.raw(`/notifications?unread=1&limit=5&since=${encodeURIComponent(since.current)}`);
        since.current = s.latest;
        onNew?.();
        if (s.quiet) return;
        for (const n of (fresh || []).slice(0, 3)) toast(n.body ? `${n.title} · ${n.body}` : n.title, 'info');
      } catch { /* the next tick tries again */ }
    };
    tick();
    const id = setInterval(tick, 60_000);
    return () => clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
import { useAuth } from './lib/auth.jsx';
import { cn } from 'cn';
import { Button } from '@/components/ui/button.tsx';
import { Avatar, AvatarFallback } from '@/components/ui/avatar.tsx';
import { ScrollArea } from '@/components/ui/scroll-area.tsx';
import { Separator } from '@/components/ui/separator.tsx';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet.tsx';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx';
import { CommandPalette, useCommandPalette } from './components/CommandPalette.jsx';
import {
  BarChart3,
  Lightbulb,
  Building2,
  ClipboardList,
  FileText,
  FolderKanban,
  Home,
  Inbox as InboxIcon,
  IndianRupee,
  LogOut,
  PanelLeft,
  Plane,
  PinOff,
  Receipt,
  Search,
  Monitor,
  Moon,
  Settings as SettingsIcon,
  Sun,
  UserRound,
} from 'lucide-react';

// A fresh review (tab, filters, messages) for each batch.
function ImportReviewPage() {
  const { id } = useParams();
  return <ImportReview key={id} />;
}

/**
 * Two links, three saved views and six record types.
 *
 * This used to list thirty screens in six groups, and the design's finding
 * was that a list that long is not navigation — it is a filing cabinet you
 * read every time. Everything that left is a word away in ⌘K, which is
 * also the only place that answers "how do I do X", because it holds the
 * verbs rather than the screens.
 */
const NAV_TOP = [
  { to: '/', icon: Home, label: 'Today', end: true },
  { to: '/inbox', icon: InboxIcon, label: 'Inbox', badge: 'inbox' },
  // A landing screen, like Reports: the five questions to start a day on.
  { to: '/insights', icon: Lightbulb, label: 'Insights' },
  { to: '/reports', icon: BarChart3, label: 'Reports' },
];

/**
 * Where each list lives, so a saved view knows where to send you.
 *
 * A view is stored as a resource key and a set of filters; this is the one
 * place that turns a resource key into a route. Adding a list means adding
 * a line here, and a view on a resource nobody has routed is simply not
 * shown rather than linking into nothing.
 */
const RESOURCE_ROUTES = {
  quotations: '/quotations',
  enquiries: '/enquiries',
  companies: '/companies',
  projects: '/projects',
  'purchase-orders': '/purchase-orders',
  'payment-stages': '/payment-stages',
  'travel-logs': '/travel',
  'vendor-invoices': '/vendor-invoices',
  'expense-claims': '/expense-claims',
};

/** `{stage_status: 'Overdue'}` → `/payment-stages?stage_status=Overdue`. */
function viewHref(view) {
  const base = RESOURCE_ROUTES[view.resource];
  if (!base) return null;
  const query = new URLSearchParams(
    Object.entries(view.filters || {}).filter(([, value]) => value !== '' && value != null)
  ).toString();
  return query ? `${base}?${query}` : base;
}

/**
 * The travel desk's sidebar (#196 §3): HR sees its own records and the
 * travel dashboard, nothing on the sales side.
 */
const NAV_HR_TOP = [
  { to: '/travel-dashboard', icon: Home, label: 'Travel dashboard', end: true },
];
const NAV_HR_RECORDS = [
  { to: '/travel', icon: Plane, label: 'Trips' },
  { to: '/vendor-invoices', icon: Receipt, label: 'Vendor invoices' },
  { to: '/payables', icon: IndianRupee, label: 'Payables' },
];

/** The screens the HR role may open; anything else goes to its dashboard. */
const HR_PATHS = [/^\/travel(\/|$)/, /^\/travel-dashboard$/, /^\/vendor-invoices(\/|$)/, /^\/vendor-credit-notes(\/|$)/,
  /^\/payables$/, /^\/settings(\/|$)/, /^\/account(\/|$)/, /^\/notifications$/, /^\/import-travel(\/|$)/];
export const hrMayOpen = (path) => HR_PATHS.some((re) => re.test(path));

const NAV_RECORDS = [
  { to: '/quotations', icon: FileText, label: 'Deals' },
  { to: '/companies', icon: Building2, label: 'Companies' },
  { to: '/projects', icon: FolderKanban, label: 'Projects' },
  { to: '/purchase-orders', icon: ClipboardList, label: 'Orders' },
  { to: '/payment-stages', icon: IndianRupee, label: 'Payment stages' },
  { to: '/travel', icon: Plane, label: 'Trips' },
];

const TONES = {
  late: { dot: 'bg-late', count: 'text-late' },
  waiting: { dot: 'bg-waiting', count: 'text-waiting' },
  info: { dot: 'bg-info', count: 'text-muted-foreground' },
};

function SideHeading({ children }) {
  return (
    <div className="px-2.5 pt-5 pb-2 text-[10.5px] font-semibold tracking-[0.1em] text-muted-foreground uppercase">
      {children}
    </div>
  );
}

function SideLink({ item, counts, alerts }) {
  return (
    <NavLink
      to={item.to}
      end={item.end}
      className={({ isActive }) => cn(
        'flex h-control items-center gap-2.5 rounded-[6px] px-2.5 text-[13px] font-medium text-sidebar-foreground transition-colors duration-150',
        'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
        isActive && 'bg-primary/12 font-semibold text-primary'
      )}
    >
      {/* Decorative — the label is what names the page. */}
      <item.icon className="size-4 shrink-0" strokeWidth={1.75} aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {item.badge && counts[item.badge] > 0 && (
        <span className={cn(
          'num rounded-full px-1.5 py-px text-[11px] font-semibold',
          alerts[item.badge] ? 'bg-late/15 text-late' : 'bg-secondary text-secondary-text'
        )}>
          {counts[item.badge]}
        </span>
      )}
    </NavLink>
  );
}

/** Two letters for the avatar, from however many names somebody has. */
function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '—';
  return (parts[0][0] + (parts[1]?.[0] ?? '')).toUpperCase();
}

/**
 * A page only an administrator may open (#85).
 *
 * The sidebar does not list these, but a bookmark, a ⌘K result or a typed
 * URL does not go through the sidebar, and the page behind one would
 * otherwise render and then fill with 403s — which reads as the app being
 * broken rather than as the page not being yours.
 *
 * Deliberately the same "not found" a bad URL gets. There is nothing to gain
 * from telling a sales user which admin pages exist, and nothing to protect
 * here either: the routes these pages call are guarded on the server, which
 * is what actually decides.
 *
 * Used sparingly, and only where the server's answer is unconditional. The
 * five pages Settings absorbed (import, emails, mailboxes, webhooks,
 * templates) are not here: SettingsArea filters those panes out of both its
 * rail and its Routes, so a sales user reaching /settings/import is
 * redirected rather than refused. Profitability is not here either — its
 * gate is conditional on the margin_visible_to_sales setting, so hiding the
 * page outright would refuse what the server would have allowed.
 */
function AdminOnly({ children }) {
  const { isAdmin } = useAuth();
  return isAdmin ? children : <NotFound />;
}

/**
 * The sidebar's contents, rendered twice: inside a Sheet on a phone and
 * inside a fixed column above lg. One definition, so the drawer cannot
 * drift from the column.
 */
/**
 * Light, dark, or whatever the machine says.
 *
 * `theme` is the stored choice and `resolvedTheme` is what that turns into
 * once "system" has been asked — the radio has to show the choice, not the
 * outcome, or picking System makes the dot jump to Light and look like it
 * did not take.
 */
function ThemeChoice() {
  const { theme, setTheme } = useTheme();
  const [ready, setReady] = useState(false);
  // Nothing is known about the stored choice until the client has mounted,
  // so render the group only then rather than flashing the wrong dot.
  useEffect(() => setReady(true), []);
  if (!ready) return null;
  return (
    <DropdownMenuRadioGroup value={theme || 'dark'} onValueChange={setTheme}>
      <DropdownMenuRadioItem value="light"><Sun className="size-4" aria-hidden="true" />Light</DropdownMenuRadioItem>
      <DropdownMenuRadioItem value="dark"><Moon className="size-4" aria-hidden="true" />Dark</DropdownMenuRadioItem>
      <DropdownMenuRadioItem value="system"><Monitor className="size-4" aria-hidden="true" />Match the system</DropdownMenuRadioItem>
    </DropdownMenuRadioGroup>
  );
}

function SidebarNav({ pinned, counts, alerts, displayName, signOut, onSearch, onUnpin, mode }) {
  const { isHr } = useAuth();
  const navTop = isHr ? NAV_HR_TOP : NAV_TOP;
  const navRecords = isHr ? NAV_HR_RECORDS : NAV_RECORDS;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2.5 px-4 pt-4 pb-3">
        <Avatar className="size-6 rounded-[6px]">
          <AvatarFallback className="rounded-[6px] bg-primary text-[12px] font-bold text-primary-foreground">C</AvatarFallback>
        </Avatar>
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">Cetizion Verifica</span>
      </div>

      {/* The way to find anything, said once and kept in view. */}
      <div className="px-3 pb-4">
        <Button
          variant="outline"
          onClick={onSearch}
          className="h-control w-full justify-start gap-2 bg-card px-2.5 font-normal"
        >
          <Search className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={2} aria-hidden="true" />
          <span className="flex-1 truncate text-left text-[12.5px] text-muted-foreground">Search or do anything</span>
          <kbd className="num rounded-[4px] bg-secondary px-1.5 py-0.5 text-[10.5px] text-secondary-text">⌘K</kbd>
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <nav className="space-y-0.5 px-2 pb-2">
          {navTop.map((item) => (
            <SideLink key={item.label} item={item} counts={counts} alerts={alerts} />
          ))}

          <SideHeading>Pinned</SideHeading>
          {pinned.length === 0 && (
            <p className="px-2.5 pb-1 text-[11.5px]/[1.5] text-muted-foreground">
              Filter any list, then <span className="text-secondary-text">Save these filters</span> to keep it here with its count.
            </p>
          )}
          {pinned.map((view) => (
            <div key={view.id} className="group/pin relative">
              <NavLink
                to={viewHref(view)}
                className={({ isActive }) => cn(
                  'flex h-control items-center gap-2.5 rounded-[6px] px-2.5 text-[13px] font-medium text-sidebar-foreground transition-colors duration-150',
                  'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
                  isActive && 'bg-sidebar-accent text-sidebar-accent-foreground'
                )}
              >
                {/* A square as well as a colour: the state is never hue alone. */}
                <span className="grid w-4 shrink-0 place-items-center" aria-hidden="true">
                  <span className={cn('size-[7px] rounded-[2px]', (TONES[view.tone] || TONES.info).dot)} />
                </span>
                <span className="min-w-0 flex-1 truncate">{view.name}</span>
                {view.count > 0 && (
                  <span className={cn(
                    'num text-[11px] font-semibold group-hover/pin:opacity-0',
                    (TONES[view.tone] || TONES.info).count
                  )}>
                    {view.count}
                  </span>
                )}
              </NavLink>
              {/* Anything you put here you can take off again, without
                  hunting for the list it came from. */}
              <button
                type="button"
                aria-label={`Unpin ${view.name}`}
                title="Unpin from the sidebar"
                onClick={() => onUnpin(view)}
                className="absolute inset-y-0 right-1.5 hidden place-items-center rounded-[4px] px-1 text-muted-foreground hover:text-late group-hover/pin:grid"
              >
                <PinOff className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
              </button>
            </div>
          ))}

          <SideHeading>Records</SideHeading>
          {navRecords.map((item) => (
            <SideLink key={item.label} item={item} counts={counts} alerts={alerts} />
          ))}
        </nav>
      </ScrollArea>

      <Separator className="bg-sidebar-border" />
      {/* Settings lives here rather than in the nav, which is where the
          design puts it: a "help and settings" button beside whoever is
          signed in. It is a place you go occasionally, so it does not
          earn a permanent row — but it does have to be findable without
          knowing the palette exists, which is what stranded it before. */}
      <div className="flex items-center gap-2 px-3 py-3">
        <Avatar className="size-6">
          <AvatarFallback className="bg-secondary text-[10px] font-semibold text-primary">{initials(displayName)}</AvatarFallback>
        </Avatar>
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-secondary-text" title={displayName}>{displayName}</span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Settings and sign out" className="size-7 shrink-0">
              <SettingsIcon className="size-4" strokeWidth={1.75} aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="top" className="min-w-48">
            {/* Only in database mode: shared mode is one account in an
                environment variable, so there is no personal account to
                own, and the route answers 404 rather than half-working. */}
            {mode === 'database' && (
              <DropdownMenuItem asChild>
                <Link to="/account"><UserRound className="size-4" aria-hidden="true" />My account</Link>
              </DropdownMenuItem>
            )}
            <DropdownMenuItem asChild>
              <Link to="/settings"><SettingsIcon className="size-4" aria-hidden="true" />Settings</Link>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onSearch}>
              <Search className="size-4" aria-hidden="true" />Search or do anything
              <span className="num ml-auto text-[10.5px] text-muted-foreground">⌘K</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <ThemeChoice />
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={signOut}>
              <LogOut className="size-4" aria-hidden="true" />Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

// The burger in every page header toggles the sidebar. The choice is
// remembered per browser so a hidden sidebar stays hidden after a reload.
// Exported, because a screen that draws its own header — the inbox does —
// still needs the burger the shared header would have given it.
export const SidebarContext = createContext({ hidden: false, toggle: () => {} });

/**
 * Hidden by default on a phone, remembered on a desktop.
 *
 * A drawer that starts open covers the page somebody just navigated to,
 * so below the breakpoint the answer is always "closed" until they open
 * it. Above it, the choice is theirs and it survives a reload.
 */
const WIDE = '(min-width: 1024px)';

/**
 * Whether we are at desktop width, as state rather than as a CSS class.
 *
 * The drawer has to be *unmounted* above the breakpoint, not just hidden:
 * a Sheet is modal, so while it is open Radix marks the rest of the
 * document aria-hidden. Hiding only its content with `lg:hidden` left an
 * open modal over a desktop page, and every heading on it vanished from
 * the accessibility tree.
 */
function useIsWide() {
  const [wide, setWide] = useState(() => {
    try { return window.matchMedia(WIDE).matches; } catch { return true; }
  });
  useEffect(() => {
    let mq;
    try { mq = window.matchMedia(WIDE); } catch { return undefined; }
    const onChange = (event) => setWide(event.matches);
    mq.addEventListener('change', onChange);
    setWide(mq.matches);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return wide;
}

function readHidden() {
  try {
    if (!window.matchMedia(WIDE).matches) return true;
    return localStorage.getItem('cetizion.sidebar') === 'hidden';
  } catch { return false; }
}

export default function App() {
  const [hidden, setHidden] = useState(readHidden);
  useEffect(() => {
    // Only the wide choice is worth remembering; on a phone it is always
    // closed to begin with, so storing "shown" there would fight that.
    try {
      if (window.matchMedia(WIDE).matches) localStorage.setItem('cetizion.sidebar', hidden ? 'hidden' : 'shown');
    } catch { /* private mode */ }
  }, [hidden]);
  const sidebar = { hidden, toggle: () => setHidden((h) => !h) };
  const location = useLocation();

  // Going somewhere closes the drawer, because on a phone it is covering
  // the thing you just asked for.
  useEffect(() => {
    try {
      if (!window.matchMedia(WIDE).matches) setHidden(true);
    } catch { /* private mode */ }
  }, [location.pathname]);
  const { displayName, signOut, isAdmin, isHr, mode } = useAuth();
  const { open: paletteOpen, setOpen: setPaletteOpen } = useCommandPalette();
  const isWide = useIsWide();

  // The sidebar counters are the whole point of the app: what is waiting
  // on someone, visible without opening anything.
  const { data: nData, refetch: refetchBell } = useFetch(() => api.raw('/notifications/summary'), [location.pathname]);
  useNotificationPopups(refetchBell);
  // HR has no inbox (#196): the travel desk reads no client mail.
  const { data: iData } = useFetch(() => (isHr ? Promise.resolve(null) : api.raw('/inbox/summary')), [location.pathname, isHr]);
  // A pinned view is only worth its place if it says how much is behind it,
  // and the count is the same one the list shows when you click through.
  const { data: vData, refetch: refetchViews } = useFetch(() => api.raw('/views?counts=1'), [location.pathname]);
  const pinned = (vData?.data || []).filter((view) => view.pinned && viewHref(view));

  // Unpinning leaves the view itself alone: it keeps its name and filters
  // and stays on the list it belongs to, it just stops taking a row here.
  const unpin = async (view) => {
    try {
      await api.update('views', view.id, { pinned: false });
      refetchViews();
    } catch {
      /* A shared view a sales user may not change: the server says 403 and
         the sidebar simply does not move. */
    }
  };

  const counts = {
    inbox: iData?.data?.open ?? null,
    notifications: nData?.data?.unread ?? null,
  };
  const alerts = { inbox: (iData?.data?.overdue ?? 0) > 0 };

  return (
    <SidebarContext.Provider value={sidebar}>
    <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} isAdmin={isAdmin} mode={mode} />
    <div className="flex min-h-screen bg-background text-foreground">
      {/* Below lg the sidebar is a Sheet over the page, not a column
          beside it: 240px of a 390px screen left the content a hundred and
          fifty, which wrapped every sentence one word per line. Above lg it
          is the column it always was, and `hidden` still collapses it. */}
      {!isWide && (
      <Sheet open={!hidden} onOpenChange={(open) => setHidden(!open)}>
        <SheetContent side="left" className="w-60 gap-0 border-sidebar-border bg-sidebar p-0">
          <SheetHeader className="sr-only">
            <SheetTitle>Menu</SheetTitle>
            <SheetDescription>Today, the inbox, your pinned views and the records.</SheetDescription>
          </SheetHeader>
          <SidebarNav
            pinned={pinned} counts={counts} alerts={alerts} onUnpin={unpin}
            displayName={displayName} signOut={signOut} onSearch={() => setPaletteOpen(true)} mode={mode}
          />
        </SheetContent>
      </Sheet>
      )}

      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-30 hidden w-60 shrink-0 border-r border-sidebar-border bg-sidebar transition-transform duration-150 lg:flex lg:flex-col',
          hidden && 'lg:-translate-x-full'
        )}
      >
        <SidebarNav
          pinned={pinned} counts={counts} alerts={alerts} onUnpin={unpin}
          displayName={displayName} signOut={signOut} onSearch={() => setPaletteOpen(true)} mode={mode}
        />
      </aside>

      <main className={cn('min-w-0 flex-1 transition-[margin] duration-150', hidden ? 'ml-0' : 'lg:ml-60')}>
        {/* The travel desk opens its own screens only (#196); the server refuses the rest anyway. */}
        {isHr && !hrMayOpen(location.pathname) ? <Navigate to="/travel-dashboard" replace /> : (
        <Routes>
          <Route path="/" element={<Today />} />
          <Route path="/worklist" element={<Worklist />} />
          <Route path="/data-quality" element={<DataQuality />} />
          <Route path="/tasks" element={<Tasks />} />
          <Route path="/follow-ups" element={<FollowUps />} />
          <Route path="/companies" element={<Companies />} />
          <Route path="/companies/:id" element={<CompanyDetail />} />
          <Route path="/deliverables" element={<Deliverables />} />
          <Route path="/schedule" element={<Schedule />} />
          <Route path="/enquiries" element={<Enquiries />} />
          <Route path="/quotations" element={<Quotations />} />
          <Route path="/quotations/:key" element={<QuotationDetail />} />
          <Route path="/pipeline" element={<Pipeline />} />
          <Route path="/renewals" element={<Renewals />} />
          {/* The two report pages became one (docs/sales-report-rework-plan.md §3.3). */}
          <Route path="/sales-report" element={<LegacyRedirect to="/reports" />} />
          <Route path="/projects" element={<Projects />} />
          <Route path="/projects/:projectId" element={<ProjectDetail />} />
          <Route path="/purchase-orders" element={<PurchaseOrders />} />
          <Route path="/purchase-orders/:poNumber" element={<PurchaseOrderDetail />} />
          <Route path="/payment-stages" element={<PaymentStages />} />
          <Route path="/collections" element={<Collections />} />
          <Route path="/cashflow" element={<Cashflow />} />
          <Route path="/account/*" element={<Account />} />
          <Route path="/reports" element={<Suspense fallback={<div className="page"><div className="skeleton" style={{ height: 320 }} /></div>}><Reports /></Suspense>} />
          <Route path="/insights" element={<Suspense fallback={<div className="page"><div className="skeleton" style={{ height: 320 }} /></div>}><Insights /></Suspense>} />
          <Route path="/reports/scheduled" element={<AdminOnly><Suspense fallback={<div className="page"><div className="skeleton" style={{ height: 320 }} /></div>}><ScheduledReports /></Suspense></AdminOnly>} />
          <Route path="/profitability" element={<Profitability />} />
          <Route path="/accounting" element={<AdminOnly><Accounting /></AdminOnly>} />
          <Route path="/notifications" element={<Notifications />} />
          <Route path="/inbox" element={<Inbox />} />
          <Route path="/money/invoice-run" element={<InvoiceRun />} />
          <Route path="/travel" element={<TravelLogs />} />
          <Route path="/travel/:travelId" element={<TripDetail />} />
          <Route path="/vendor-invoices" element={<VendorInvoices />} />
          <Route path="/vendor-invoices/:id" element={<VendorInvoiceDetail />} />
          <Route path="/payables" element={<Payables />} />
          <Route path="/expense-claims" element={<ExpenseClaims />} />
          <Route path="/travel-dashboard" element={<TravelDashboard />} />
          {/* One Settings area. The five admin pages it absorbed keep
              their old routes as redirects, so a bookmark still lands
              somewhere rather than on the not-found page. */}
          <Route path="/settings/*" element={<SettingsArea />} />
          <Route path="/mailboxes" element={<LegacyRedirect to="/settings/mailboxes" />} />
          <Route path="/webhooks" element={<LegacyRedirect to="/settings/webhooks" />} />
          <Route path="/templates" element={<LegacyRedirect to="/settings/templates" />} />
          <Route path="/emails" element={<LegacyRedirect to="/settings/emails" />} />
          <Route path="/import" element={<LegacyRedirect to="/settings/import" />} />
          {/* A batch in progress is its own screen, not a settings pane. */}
          <Route path="/import/:id" element={<AdminOnly><ImportReviewPage /></AdminOnly>} />
          <Route path="*" element={<NotFound />} />
        </Routes>
        )}
      </main>
    </div>
    </SidebarContext.Provider>
  );
}

/** Shared page chrome so every screen has the same header rhythm. */
/**
 * An old path that moved, keeping its query string.
 *
 * `<Navigate to="/settings/mailboxes">` takes a bare path and drops
 * whatever came with it. The mailbox OAuth callback returns to this app as
 * `?connected=…` or `?error=…`, so the bare version swallowed both — a
 * finished connection and a failed one looked identical, which is to say
 * like nothing had happened.
 */
function LegacyRedirect({ to }) {
  const { search } = useLocation();
  return <Navigate to={`${to}${search}`} replace />;
}

export function PageHeader({ title, subtitle, actions }) {
  const { hidden, toggle } = useContext(SidebarContext);
  // On a phone the actions go under the title rather than beside it.
  // Beside it they are `shrink-0`, so three buttons left the title a
  // column two words wide and pushed the page past the viewport.
  return (
    <header className="sticky top-0 z-20 flex flex-col gap-3 border-b border-border bg-background/95 px-4 py-4 backdrop-blur sm:flex-row sm:items-start sm:px-6">
      <Button
        variant="ghost"
        size="icon"
        onClick={toggle}
        aria-label={hidden ? 'Show sidebar' : 'Hide sidebar'}
        className="size-control shrink-0"
      >
        <PanelLeft className="size-4" strokeWidth={1.75} aria-hidden="true" />
      </Button>
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-2xl font-semibold text-foreground">{title}</h1>
        {subtitle && <div className="measure mt-0.5 text-[13px] text-muted-foreground">{subtitle}</div>}
      </div>
      {/* A filter in the header sizes to itself. The kit's fields are `w-full`
          because they are built for forms; left that way each one claims the
          whole actions column and the row becomes a stack. */}
      {actions && (
        <div className="page-actions flex flex-wrap items-center gap-2 sm:shrink-0 [&_input]:w-auto [&_select]:w-auto">
          {actions}
        </div>
      )}
    </header>
  );
}

