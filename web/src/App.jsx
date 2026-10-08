import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Link, Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';

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
import SettingsArea from './pages/SettingsArea.jsx';
import ImportReview from './pages/ImportReview.jsx';
import TravelImportReview from './pages/TravelImportReview.jsx';
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
import { CommandPalette, useCommandPalette } from './components/CommandPalette.jsx';
import { BrandMark, ControlBar, ShellContext, ShellFrame, ShortcutsDialog, useShell } from './components/shell/Shell.jsx';
import { PageErrorBoundary } from './components/shell/ErrorBoundary.jsx';
import { ROLE_LABEL, eyebrowFor, initials, viewHref } from './components/shell/nav.js';

// A fresh review (tab, filters, messages) for each batch.
function ImportReviewPage() {
  const { id } = useParams();
  return <ImportReview key={id} />;
}
function TravelImportReviewPage() {
  const { id } = useParams();
  return <TravelImportReview key={id} />;
}

/** The screens the HR role may open; anything else goes to its dashboard. */
const HR_PATHS = [/^\/travel(\/|$)/, /^\/travel-dashboard$/, /^\/vendor-invoices(\/|$)/, /^\/vendor-credit-notes(\/|$)/,
  /^\/payables$/, /^\/settings(\/|$)/, /^\/account(\/|$)/, /^\/notifications$/, /^\/import-travel(\/|$)/];
export const hrMayOpen = (path) => HR_PATHS.some((re) => re.test(path));

/**
 * A page only an administrator may open (#85).
 *
 * The rail does not list these, but a bookmark, a Ctrl K result or a typed
 * URL does not go through the rail, and the page behind one would
 * otherwise render and then fill with 403s — which reads as the app being
 * broken rather than as the page not being yours.
 *
 * Deliberately the same "not found" a bad URL gets. The routes these pages
 * call are guarded on the server, which is what actually decides.
 */
function AdminOnly({ children }) {
  const { isAdmin } = useAuth();
  return isAdmin ? children : <NotFound />;
}

/** The travel import is the travel desk's: an administrator or HR (#196 §3). */
function TravelDeskOnly({ children }) {
  const { isAdmin, isHr } = useAuth();
  return isAdmin || isHr ? children : <NotFound />;
}

const Lazy = ({ children }) => (
  <Suspense fallback={<div className="page"><div className="skeleton" style={{ height: 320 }} /></div>}>{children}</Suspense>
);

export default function App() {
  const location = useLocation();
  const { displayName, signOut, isAdmin, isHr, mode, user } = useAuth();
  const { open: paletteOpen, setOpen: setPaletteOpen, start, openWith } = useCommandPalette();
  const [shortcuts, setShortcuts] = useState(false);

  // The counters are the whole point of the app: what is waiting on
  // someone, visible without opening anything.
  const { data: nData, refetch: refetchBell } = useFetch(() => api.raw('/notifications/summary'), [location.pathname]);
  useNotificationPopups(refetchBell);
  // HR has no inbox (#196): the travel desk reads no client mail.
  const { data: iData } = useFetch(() => (isHr ? Promise.resolve(null) : api.raw('/inbox/summary')), [location.pathname, isHr]);
  // A pinned view is only worth its place if it says how much is behind it,
  // and the count is the same one the list shows when you click through.
  const views = useFetch(() => api.raw('/views?counts=1'), [location.pathname]);
  const pinned = (views.data?.data || []).filter((view) => view.pinned && viewHref(view));

  // Unpinning leaves the view itself alone: it keeps its name and filters
  // and stays on the list it belongs to, it just stops taking a row here.
  const unpin = async (view) => {
    try {
      await api.update('views', view.id, { pinned: false });
      views.refetch();
    } catch {
      /* A shared view a sales user may not change: the server says 403 and
         nothing moves. The shell only offers Unpin on those to admins. */
    }
  };

  const shell = {
    isAdmin, isHr, mode, signOut,
    who: displayName,
    initials: initials(displayName),
    roleLabel: mode === 'shared' ? 'Shared sign-in' : (ROLE_LABEL[user?.role] || ''),
    counts: { inbox: iData?.data?.open ?? null, notifications: nData?.data?.unread ?? null },
    alerts: { inbox: (iData?.data?.overdue ?? 0) > 0 },
    unread: nData?.data?.unread ?? 0,
    refetchBell,
    pinned,
    pinnedLoading: views.loading && !views.data,
    pinnedError: Boolean(views.error),
    unpin,
    openPalette: (opts) => openWith(opts || {}),
    showShortcuts: () => setShortcuts(true),
    eyebrow: eyebrowFor(location.pathname),
  };

  return (
    <ShellContext.Provider value={shell}>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} start={start} isAdmin={isAdmin} isHr={isHr} mode={mode} />
      <ShortcutsDialog open={shortcuts} onOpenChange={setShortcuts} />
      <ShellFrame>
        <PageErrorBoundary key={location.pathname}>
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
          <Route path="/reports" element={<Lazy><Reports /></Lazy>} />
          <Route path="/insights" element={<Lazy><Insights /></Lazy>} />
          <Route path="/reports/scheduled" element={<Lazy><ScheduledReports /></Lazy>} />
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
          <Route path="/import-travel/:id" element={<TravelDeskOnly><TravelImportReviewPage /></TravelDeskOnly>} />
          <Route path="*" element={<NotFound />} />
        </Routes>
        )}
        </PageErrorBoundary>
      </ShellFrame>
    </ShellContext.Provider>
  );
}

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

/**
 * Shared page chrome so every screen has the same header rhythm: the small
 * word for where the page lives, the title in the display face, the line
 * under it, the page's own actions, then pause and the bell. On a phone
 * the mark, the word and the bell share a row above the title, and the
 * actions go under the title rather than beside it.
 */
export function PageHeader({ title, subtitle, actions, eyebrow, nav, titleClassName = 'mg-display', titleAside }) {
  const shell = useShell();
  const word = eyebrow ?? shell.eyebrow;
  return (
    <header className="mg-header page-header" data-a="rise">
      <div className="page-header__top">
        <Link to={shell.isHr ? '/travel-dashboard' : '/'} aria-label={shell.isHr ? 'Go to the travel dashboard' : 'Go to Today'} className="grid place-items-center">
          <BrandMark size={28} />
        </Link>
        {word && <span className="mg-eyebrow">{word}</span>}
        <ControlBar className="page-header__controls ml-auto" />
      </div>
      <div className="mg-header__text">
        {word && <span className="mg-eyebrow page-header__eyebrow">{word}</span>}
        {titleAside ? (
          <div className="page-header__title">
            <h1 className={titleClassName}>{title}</h1>
            {titleAside}
          </div>
        ) : <h1 className={titleClassName}>{title}</h1>}
        {subtitle && <div className="mg-header__sub measure">{subtitle}</div>}
        {nav}
      </div>
      <div className="mg-header__actions page-header__actions">
        {/* A filter in the header sizes to itself. The kit's fields are `w-full`
            because they are built for forms; left that way each one claims the
            whole actions column and the row becomes a stack. */}
        {actions && (
          <div className="page-actions flex flex-wrap items-center gap-2 [&_input]:w-auto [&_select]:w-auto">
            {actions}
          </div>
        )}
        <ControlBar className="page-header__controls page-header__controls--wide" />
      </div>
    </header>
  );
}
