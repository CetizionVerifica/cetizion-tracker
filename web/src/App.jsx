import { createContext, useContext, useEffect, useState } from 'react';
import { NavLink, Route, Routes, useLocation, useParams } from 'react-router-dom';

import Overview from './pages/Overview.jsx';
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
import {
  BadgeCheck,
  Bell,
  Building2,
  CalendarDays,
  ChartNoAxesColumn,
  CheckSquare,
  ClipboardList,
  Columns3,
  FileText,
  FolderKanban,
  Inbox as InboxIcon,
  IndianRupee,
  LayoutDashboard,
  LayoutTemplate,
  LogOut,
  Mail,
  MailOpen,
  MapPinned,
  MessageSquare,
  PanelLeft,
  Percent,
  PiggyBank,
  Plane,
  ReceiptText,
  RefreshCw,
  Scale,
  Settings as SettingsIcon,
  Target,
  TrendingUp,
  Upload,
  Wallet,
  Webhook,
} from 'lucide-react';

// A fresh review (tab, filters, messages) for each batch.
function ImportReviewPage() {
  const { id } = useParams();
  return <ImportReview key={id} />;
}

const NAV = [
  {
    label: 'Overview',
    items: [
      { to: '/', icon: LayoutDashboard, label: 'Dashboard', end: true },
      { to: '/notifications', icon: Bell, label: 'Notifications', badge: 'notifications' },
      { to: '/worklist', icon: Target, label: 'Action list', badge: 'worklist' },
      { to: '/tasks', icon: CheckSquare, label: 'Tasks' },
    ],
  },
  {
    label: 'Sales',
    items: [
      { to: '/inbox', icon: InboxIcon, label: 'Inbox', badge: 'inbox' },
      { to: '/companies', icon: Building2, label: 'Companies' },
      { to: '/enquiries', icon: MessageSquare, label: 'Enquiries' },
      { to: '/quotations', icon: FileText, label: 'Quotations' },
      { to: '/pipeline', icon: Columns3, label: 'Pipeline' },
      { to: '/renewals', icon: RefreshCw, label: 'Renewals' },
      { to: '/sales-report', icon: ChartNoAxesColumn, label: 'Sales reports' },
    ],
  },
  {
    label: 'Delivery',
    items: [
      { to: '/projects', icon: FolderKanban, label: 'Projects' },
      { to: '/purchase-orders', icon: ClipboardList, label: 'Purchase orders' },
      { to: '/schedule', icon: CalendarDays, label: 'Schedule' },
      { to: '/deliverables', icon: BadgeCheck, label: 'Certificates' },
    ],
  },
  {
    label: 'Finance',
    items: [
      { to: '/payment-stages', icon: IndianRupee, label: 'Payment schedule', badge: 'stages' },
      { to: '/collections', icon: PiggyBank, label: 'Collections' },
      { to: '/cashflow', icon: TrendingUp, label: 'Cash-flow forecast' },
      { to: '/profitability', icon: Percent, label: 'Profitability' , adminOnly: true },
      { to: '/accounting', icon: Scale, label: 'Accounting' , adminOnly: true },
    ],
  },
  {
    label: 'Travel & expenses',
    items: [
      { to: '/travel', icon: Plane, label: 'Trips' },
      { to: '/vendor-invoices', icon: ReceiptText, label: 'Vendor invoices', badge: 'vendors' },
      { to: '/expense-claims', icon: Wallet, label: 'Expense claims', badge: 'claims' },
      { to: '/travel-dashboard', icon: MapPinned, label: 'Travel spend' },
    ],
  },
  {
    label: 'Admin',
    items: [
      { to: '/settings', icon: SettingsIcon, label: 'Settings' },
      { to: '/import', icon: Upload, label: 'Bulk import' },
      { to: '/emails', icon: Mail, label: 'Emails & jobs' },
      { to: '/mailboxes', icon: MailOpen, label: 'Mailboxes', adminOnly: true },
      { to: '/webhooks', icon: Webhook, label: 'Webhooks', adminOnly: true },
      { to: '/templates', icon: LayoutTemplate, label: 'Templates', adminOnly: true },
    ],
  },
];

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

  // The sidebar counters are the whole point of the app: what is waiting
  // on someone, visible without opening anything.
  const { data } = useFetch(() => api.raw('/dashboard/worklist'), [location.pathname]);
  const w = data?.data;
  const { data: nData } = useFetch(() => api.raw('/notifications/summary'), [location.pathname]);
  const { data: iData } = useFetch(() => api.raw('/inbox/summary'), [location.pathname]);
  const counts = {
    worklist: w
      ? w.payment_stages.length + w.vendor_invoices.length + w.expense_claims.length +
        w.late_deliveries.length + w.won_without_project.length
      : null,
    notifications: nData?.data?.unread ?? null,
    inbox: iData?.data?.open ?? null,
    stages: w?.payment_stages.length ?? null,
    vendors: w?.vendor_invoices.length ?? null,
    claims: w?.expense_claims.length ?? null,
  };
  const alerts = {
    worklist: w ? w.payment_stages.some((s) => s.stage_status === 'Overdue') : false,
    stages: w ? w.payment_stages.some((s) => s.stage_status === 'Overdue') : false,
    vendors: w ? w.vendor_invoices.some((v) => v.payment_status === 'Overdue') : false,
    claims: false,
    notifications: false,
    inbox: (iData?.data?.overdue ?? 0) > 0,
  };

  return (
    <SidebarContext.Provider value={sidebar}>
    <div className="flex min-h-screen bg-background text-foreground">
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-30 flex w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar transition-[width,transform] duration-150',
          hidden && '-translate-x-full'
        )}
      >
        <div className="flex flex-col gap-1 border-b border-sidebar-border px-4 py-4">
          <div className="flex items-center gap-2.5">
            <span className="grid size-7 place-items-center rounded-[6px] bg-primary font-semibold text-primary-foreground">C</span>
            <span className="text-[15px] font-semibold text-foreground">Cetizion</span>
          </div>
          <div className="text-[11.5px] text-muted-foreground">Sales · Projects · Payments · Travel</div>
        </div>

        <nav className="flex-1 overflow-y-auto px-2 py-3">
          {NAV.map((group) => (
            <div className="mb-4" key={group.label}>
              <div className="px-2 pb-1.5 text-[10.5px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
                {group.label}
              </div>
              {group.items.filter((item) => isAdmin || !item.adminOnly).map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) => cn(
                    'flex h-control items-center gap-2.5 rounded-[6px] px-2 text-[13px] text-sidebar-foreground transition-colors duration-150',
                    'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
                    isActive && 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
                  )}
                >
                  {/* The icon is decorative — the label is what names the page. */}
                  <item.icon className="size-4 shrink-0" strokeWidth={1.75} aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.badge && counts[item.badge] > 0 && (
                    <span
                      className={cn(
                        'num rounded-[6px] px-1.5 py-0.5 text-[11px] font-medium',
                        alerts[item.badge]
                          ? 'bg-late/15 text-late'
                          : 'bg-secondary text-secondary-foreground'
                      )}
                    >
                      {counts[item.badge]}
                    </span>
                  )}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        <div className="flex items-center justify-between gap-2 border-t border-sidebar-border px-3 py-3">
          <span className="min-w-0 truncate text-[12.5px] text-muted-foreground" title={displayName}>{displayName}</span>
          <Button variant="ghost" size="sm" onClick={signOut} className="h-control gap-1.5 px-2 text-[12.5px]">
            <LogOut className="size-4" strokeWidth={1.75} aria-hidden="true" />
            Sign out
          </Button>
        </div>
      </aside>

      <main className={cn('min-w-0 flex-1 transition-[margin] duration-150', hidden ? 'ml-0' : 'ml-60')}>
        <Routes>
          <Route path="/" element={<Overview />} />
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

