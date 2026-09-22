import { createContext, useContext, useEffect, useState } from 'react';
import { NavLink, Route, Routes, useLocation, useParams } from 'react-router-dom';

import Today from './pages/Today.jsx';
import Worklist from './pages/Worklist.jsx';
import Tasks from './pages/Tasks.jsx';
import Enquiries from './pages/Enquiries.jsx';
import Companies from './pages/Companies.jsx';
import CompanyDetail from './pages/CompanyDetail.jsx';
import Deliverables from './pages/Deliverables.jsx';
import Schedule from './pages/Schedule.jsx';
import Quotations from './pages/Quotations.jsx';
import QuotationDetail from './pages/QuotationDetail.jsx';
import Pipeline from './pages/Pipeline.jsx';
import Renewals from './pages/Renewals.jsx';
import SalesReport from './pages/SalesReport.jsx';
import Projects from './pages/Projects.jsx';
import ProjectDetail from './pages/ProjectDetail.jsx';
import PurchaseOrders from './pages/PurchaseOrders.jsx';
import PurchaseOrderDetail from './pages/PurchaseOrderDetail.jsx';
import PaymentStages from './pages/PaymentStages.jsx';
import Collections from './pages/Collections.jsx';
import Cashflow from './pages/Cashflow.jsx';
import Profitability from './pages/Profitability.jsx';
import Accounting from './pages/Accounting.jsx';
import Notifications from './pages/Notifications.jsx';
import TravelLogs from './pages/TravelLogs.jsx';
import VendorInvoices from './pages/VendorInvoices.jsx';
import ExpenseClaims from './pages/ExpenseClaims.jsx';
import TravelDashboard from './pages/TravelDashboard.jsx';
import Settings from './pages/Settings.jsx';
import BulkImport from './pages/BulkImport.jsx';
import ImportReview from './pages/ImportReview.jsx';
import Emails from './pages/Emails.jsx';
import Mailboxes from './pages/Mailboxes.jsx';
import Webhooks from './pages/Webhooks.jsx';
import Inbox from './pages/Inbox.jsx';
import Templates from './pages/Templates.jsx';
import NotFound from './pages/NotFound.jsx';
import { useFetch } from './lib/hooks.js';
import { api } from './lib/api.js';
import { useAuth } from './lib/auth.jsx';
import { cn } from 'cn';
import { Button } from '@/components/ui/button.tsx';
import { CommandPalette, useCommandPalette } from './components/CommandPalette.jsx';
import {
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
  Search,
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
];

/**
 * The views worth a permanent place, each with the count that makes it
 * worth looking at. The square is a second signal beside the colour, and
 * the count carries the colour of what it means.
 */
const NAV_PINNED = [
  { to: '/collections', label: 'Overdue money', badge: 'overdue', tone: 'late' },
  { to: '/payment-stages', label: 'To invoice', badge: 'toInvoice', tone: 'waiting' },
  { to: '/quotations', label: 'Open deals', badge: 'openDeals', tone: 'info' },
];

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

// The burger in every page header toggles the sidebar. The choice is
// remembered per browser so a hidden sidebar stays hidden after a reload.
const SidebarContext = createContext({ hidden: false, toggle: () => {} });

function readHidden() {
  try { return localStorage.getItem('cetizion.sidebar') === 'hidden'; } catch { return false; }
}

export default function App() {
  const [hidden, setHidden] = useState(readHidden);
  useEffect(() => {
    try { localStorage.setItem('cetizion.sidebar', hidden ? 'hidden' : 'shown'); } catch { /* private mode */ }
  }, [hidden]);
  const sidebar = { hidden, toggle: () => setHidden((h) => !h) };
  const location = useLocation();
  const { displayName, signOut, isAdmin } = useAuth();
  const { open: paletteOpen, setOpen: setPaletteOpen } = useCommandPalette();

  // The sidebar counters are the whole point of the app: what is waiting
  // on someone, visible without opening anything.
  const { data } = useFetch(() => api.raw('/dashboard/worklist'), [location.pathname]);
  const w = data?.data;
  const { data: nData } = useFetch(() => api.raw('/notifications/summary'), [location.pathname]);
  const { data: iData } = useFetch(() => api.raw('/inbox/summary'), [location.pathname]);
  const { data: oData } = useFetch(() => api.raw('/dashboard/overview'), []);
  const overview = oData?.data;
  // A pinned view is only worth its place if it says how much is behind it.
  const counts = {
    inbox: iData?.data?.open ?? null,
    notifications: nData?.data?.unread ?? null,
    overdue: w?.payment_stages.filter((s) => s.stage_status === 'Overdue').length ?? null,
    toInvoice: w?.payment_stages.filter((s) => s.stage_status === 'To Invoice').length ?? null,
    openDeals: overview?.sales?.open ?? null,
  };
  const alerts = { inbox: (iData?.data?.overdue ?? 0) > 0 };

  return (
    <SidebarContext.Provider value={sidebar}>
    <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} isAdmin={isAdmin} />
    <div className="flex min-h-screen bg-background text-foreground">
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-30 flex w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar transition-[width,transform] duration-150',
          hidden && '-translate-x-full'
        )}
      >
        <div className="flex items-center gap-2.5 px-4 pt-4 pb-3">
          <span className="grid size-6 shrink-0 place-items-center rounded-[6px] bg-primary text-[12px] font-bold text-primary-foreground">C</span>
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">Cetizion Verifica</span>
        </div>

        {/* The way to find anything, said once and kept in view. */}
        <div className="px-3 pb-4">
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="flex h-control w-full items-center gap-2 rounded-[6px] border border-border bg-card px-2.5 text-left transition-colors duration-150 hover:border-muted-foreground"
          >
            <Search className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={2} aria-hidden="true" />
            <span className="flex-1 truncate text-[12.5px] text-muted-foreground">Search or do anything</span>
            <kbd className="num rounded-[4px] bg-secondary px-1.5 py-0.5 text-[10.5px] text-secondary-text">⌘K</kbd>
          </button>
        </div>

        <nav className="flex-1 space-y-0.5 overflow-y-auto px-2">
          {NAV_TOP.map((item) => (
            <SideLink key={item.label} item={item} counts={counts} alerts={alerts} />
          ))}

          <SideHeading>Pinned</SideHeading>
          {NAV_PINNED.map((item) => (
            <NavLink
              key={item.label}
              to={item.to}
              className={({ isActive }) => cn(
                'flex h-control items-center gap-2.5 rounded-[6px] px-2.5 text-[13px] font-medium text-sidebar-foreground transition-colors duration-150',
                'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
                isActive && 'bg-sidebar-accent text-sidebar-accent-foreground'
              )}
            >
              {/* A square as well as a colour: the state is never hue alone. */}
              <span className="grid w-4 shrink-0 place-items-center" aria-hidden="true">
                <span className={cn('size-[7px] rounded-[2px]', TONES[item.tone].dot)} />
              </span>
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {counts[item.badge] > 0 && (
                <span className={cn('num text-[11px] font-semibold', TONES[item.tone].count)}>{counts[item.badge]}</span>
              )}
            </NavLink>
          ))}

          <SideHeading>Records</SideHeading>
          {NAV_RECORDS.map((item) => (
            <SideLink key={item.label} item={item} counts={counts} alerts={alerts} />
          ))}
        </nav>

        <div className="flex items-center gap-2 border-t border-sidebar-border px-3 py-3">
          <span className="grid size-6 shrink-0 place-items-center rounded-full bg-secondary text-[10px] font-semibold text-primary">
            {initials(displayName)}
          </span>
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-secondary-text" title={displayName}>{displayName}</span>
          <Button variant="ghost" size="icon" onClick={signOut} aria-label="Sign out" className="size-7 shrink-0">
            <LogOut className="size-4" strokeWidth={1.75} aria-hidden="true" />
          </Button>
        </div>
      </aside>

      <main className={cn('min-w-0 flex-1 transition-[margin] duration-150', hidden ? 'ml-0' : 'ml-60')}>
        <Routes>
          <Route path="/" element={<Today />} />
          <Route path="/worklist" element={<Worklist />} />
          <Route path="/tasks" element={<Tasks />} />
          <Route path="/companies" element={<Companies />} />
          <Route path="/companies/:id" element={<CompanyDetail />} />
          <Route path="/deliverables" element={<Deliverables />} />
          <Route path="/schedule" element={<Schedule />} />
          <Route path="/enquiries" element={<Enquiries />} />
          <Route path="/quotations" element={<Quotations />} />
          <Route path="/quotations/:key" element={<QuotationDetail />} />
          <Route path="/pipeline" element={<Pipeline />} />
          <Route path="/renewals" element={<Renewals />} />
          <Route path="/sales-report" element={<SalesReport />} />
          <Route path="/projects" element={<Projects />} />
          <Route path="/projects/:projectId" element={<ProjectDetail />} />
          <Route path="/purchase-orders" element={<PurchaseOrders />} />
          <Route path="/purchase-orders/:poNumber" element={<PurchaseOrderDetail />} />
          <Route path="/payment-stages" element={<PaymentStages />} />
          <Route path="/collections" element={<Collections />} />
          <Route path="/cashflow" element={<Cashflow />} />
          <Route path="/profitability" element={<Profitability />} />
          <Route path="/accounting" element={<Accounting />} />
          <Route path="/notifications" element={<Notifications />} />
          <Route path="/mailboxes" element={<Mailboxes />} />
          <Route path="/webhooks" element={<Webhooks />} />
          <Route path="/inbox" element={<Inbox />} />
          <Route path="/travel" element={<TravelLogs />} />
          <Route path="/vendor-invoices" element={<VendorInvoices />} />
          <Route path="/expense-claims" element={<ExpenseClaims />} />
          <Route path="/travel-dashboard" element={<TravelDashboard />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/import" element={<BulkImport />} />
          <Route path="/import/:id" element={<ImportReviewPage />} />
          <Route path="/emails" element={<Emails />} />
          <Route path="/templates" element={<Templates />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
    </div>
    </SidebarContext.Provider>
  );
}

/** Shared page chrome so every screen has the same header rhythm. */
export function PageHeader({ title, subtitle, actions }) {
  const { hidden, toggle } = useContext(SidebarContext);
  return (
    <header className="sticky top-0 z-20 flex items-start gap-3 border-b border-border bg-background/95 px-6 py-4 backdrop-blur">
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
        <div className="page-actions flex shrink-0 flex-wrap items-center gap-2 [&_input]:w-auto [&_select]:w-auto">
          {actions}
        </div>
      )}
    </header>
  );
}

