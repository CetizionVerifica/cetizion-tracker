import { createContext, useContext, useEffect, useState } from 'react';
import { NavLink, Route, Routes, useLocation } from 'react-router-dom';

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

const NAV = [
  {
    label: 'Overview',
    items: [
      { to: '/', icon: '◈', label: 'Dashboard', end: true },
      { to: '/notifications', icon: '◔', label: 'Notifications', badge: 'notifications' },
      { to: '/worklist', icon: '◉', label: 'Action list', badge: 'worklist' },
      { to: '/tasks', icon: '☐', label: 'Tasks' },
    ],
  },
  {
    label: 'Sales',
    items: [
      { to: '/inbox', icon: '✉', label: 'Inbox', badge: 'inbox' },
      { to: '/companies', icon: '⌂', label: 'Companies' },
      { to: '/enquiries', icon: '◇', label: 'Enquiries' },
      { to: '/quotations', icon: '◆', label: 'Quotations' },
      { to: '/pipeline', icon: '▥', label: 'Pipeline' },
      { to: '/renewals', icon: '↻', label: 'Renewals' },
      { to: '/sales-report', icon: '◔', label: 'Sales reports' },
    ],
  },
  {
    label: 'Delivery',
    items: [
      { to: '/projects', icon: '▤', label: 'Projects' },
      { to: '/purchase-orders', icon: '▦', label: 'Purchase orders' },
      { to: '/schedule', icon: '▤', label: 'Schedule' },
      { to: '/deliverables', icon: '✪', label: 'Certificates' },
    ],
  },
  {
    label: 'Finance',
    items: [
      { to: '/payment-stages', icon: '₹', label: 'Payment schedule', badge: 'stages' },
      { to: '/collections', icon: '◔', label: 'Collections' },
      { to: '/cashflow', icon: '◐', label: 'Cash-flow forecast' },
      { to: '/profitability', icon: '%', label: 'Profitability' , adminOnly: true },
      { to: '/accounting', icon: '⚖', label: 'Accounting' , adminOnly: true },
    ],
  },
  {
    label: 'Travel & expenses',
    items: [
      { to: '/travel', icon: '✈', label: 'Trips' },
      { to: '/vendor-invoices', icon: '▥', label: 'Vendor invoices', badge: 'vendors' },
      { to: '/expense-claims', icon: '◫', label: 'Expense claims', badge: 'claims' },
      { to: '/travel-dashboard', icon: '◷', label: 'Travel spend' },
    ],
  },
  {
    label: 'Admin',
    items: [
      { to: '/settings', icon: '⚙', label: 'Settings' },
      { to: '/import', icon: '⇪', label: 'Bulk import' },
      { to: '/emails', icon: '✉', label: 'Emails & jobs' },
      { to: '/mailboxes', icon: '✉', label: 'Mailboxes', adminOnly: true },
      { to: '/webhooks', icon: '⇄', label: 'Webhooks', adminOnly: true },
      { to: '/templates', icon: '▤', label: 'Templates', adminOnly: true },
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
    <div className={`app ${hidden ? 'sidebar-hidden' : ''}`}>
      <aside className="sidebar">
        <div className="sidebar__brand">
          <div className="sidebar__mark">
            <span className="sidebar__logo">C</span>
            <span className="sidebar__name">Cetizion</span>
          </div>
          <div className="sidebar__tagline">Sales · Projects · Payments · Travel</div>
        </div>

        <nav className="nav">
          {NAV.map((group) => (
            <div className="nav__group" key={group.label}>
              <div className="nav__label">{group.label}</div>
              {group.items.filter((item) => isAdmin || !item.adminOnly).map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  title={item.label}
                  className={({ isActive }) => `nav__item ${isActive ? 'is-active' : ''}`}
                >
                  <span className="nav__icon">{item.icon}</span>
                  <span className="nav__text">{item.label}</span>
                  {item.badge && counts[item.badge] > 0 && (
                    <span className={`nav__count ${alerts[item.badge] ? 'is-alert' : ''}`}>
                      {counts[item.badge]}
                    </span>
                  )}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        <div className="sidebar__foot">
          <span className="sidebar__user" title={displayName}>{displayName}</span>
          <button type="button" className="btn btn--sm sidebar__signout" onClick={signOut} title="Sign out">
            <span className="nav__text">Sign out</span><span className="sidebar__signout-icon" aria-hidden="true">⏻</span>
          </button>
        </div>
      </aside>

      <main className="main">
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
          <Route path="/import/:id" element={<ImportReview />} />
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
    <header className="topbar">
      <button type="button" className="btn btn--ghost btn--sm menu-toggle" onClick={toggle} title={hidden ? 'Show sidebar' : 'Hide sidebar'} aria-label={hidden ? 'Show sidebar' : 'Hide sidebar'}>☰</button>
      <div className="topbar__title">
        <h1>{title}</h1>
        {subtitle && <div className="topbar__sub">{subtitle}</div>}
      </div>
      {actions && <div className="topbar__actions">{actions}</div>}
    </header>
  );
}
