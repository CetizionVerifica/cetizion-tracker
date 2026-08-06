import { useState } from 'react';
import { NavLink, Route, Routes, useLocation } from 'react-router-dom';

import Overview from './pages/Overview.jsx';
import Worklist from './pages/Worklist.jsx';
import Quotations from './pages/Quotations.jsx';
import Projects from './pages/Projects.jsx';
import ProjectDetail from './pages/ProjectDetail.jsx';
import PurchaseOrders from './pages/PurchaseOrders.jsx';
import PurchaseOrderDetail from './pages/PurchaseOrderDetail.jsx';
import PaymentStages from './pages/PaymentStages.jsx';
import TravelLogs from './pages/TravelLogs.jsx';
import VendorInvoices from './pages/VendorInvoices.jsx';
import ExpenseClaims from './pages/ExpenseClaims.jsx';
import TravelDashboard from './pages/TravelDashboard.jsx';
import Settings from './pages/Settings.jsx';
import NotFound from './pages/NotFound.jsx';
import { useFetch } from './lib/hooks.js';
import { api } from './lib/api.js';

const NAV = [
  {
    label: 'Overview',
    items: [
      { to: '/', icon: '◈', label: 'Dashboard', end: true },
      { to: '/worklist', icon: '◉', label: 'Action list', badge: 'worklist' },
    ],
  },
  {
    label: 'Sales',
    items: [{ to: '/quotations', icon: '◆', label: 'Quotations' }],
  },
  {
    label: 'Delivery',
    items: [
      { to: '/projects', icon: '▤', label: 'Projects' },
      { to: '/purchase-orders', icon: '▦', label: 'Purchase orders' },
    ],
  },
  {
    label: 'Finance',
    items: [{ to: '/payment-stages', icon: '₹', label: 'Payment schedule', badge: 'stages' }],
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
    items: [{ to: '/settings', icon: '⚙', label: 'Settings' }],
  },
];

export default function App() {
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();

  // The sidebar counters are the whole point of the app: what is waiting
  // on someone, visible without opening anything.
  const { data } = useFetch(() => api.raw('/dashboard/worklist'), [location.pathname]);
  const w = data?.data;
  const counts = {
    worklist: w
      ? w.payment_stages.length + w.vendor_invoices.length + w.expense_claims.length +
        w.late_deliveries.length + w.won_without_project.length
      : null,
    stages: w?.payment_stages.length ?? null,
    vendors: w?.vendor_invoices.length ?? null,
    claims: w?.expense_claims.length ?? null,
  };
  const alerts = {
    worklist: w ? w.payment_stages.some((s) => s.stage_status === 'Overdue') : false,
    stages: w ? w.payment_stages.some((s) => s.stage_status === 'Overdue') : false,
    vendors: w ? w.vendor_invoices.some((v) => v.payment_status === 'Overdue') : false,
    claims: false,
  };

  return (
    <div className="app">
      <aside className={`sidebar ${menuOpen ? 'is-open' : ''}`} onClick={() => setMenuOpen(false)}>
        <div className="sidebar__brand">
          <div className="sidebar__mark">
            <span className="sidebar__logo">C</span>
            Cetizion
          </div>
          <div className="sidebar__tagline">Sales · Projects · Payments · Travel</div>
        </div>

        <nav className="nav">
          {NAV.map((group) => (
            <div className="nav__group" key={group.label}>
              <div className="nav__label">{group.label}</div>
              {group.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) => `nav__item ${isActive ? 'is-active' : ''}`}
                >
                  <span className="nav__icon">{item.icon}</span>
                  {item.label}
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
      </aside>

      <main className="main">
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/worklist" element={<Worklist />} />
          <Route path="/quotations" element={<Quotations />} />
          <Route path="/projects" element={<Projects />} />
          <Route path="/projects/:projectId" element={<ProjectDetail />} />
          <Route path="/purchase-orders" element={<PurchaseOrders />} />
          <Route path="/purchase-orders/:poNumber" element={<PurchaseOrderDetail />} />
          <Route path="/payment-stages" element={<PaymentStages />} />
          <Route path="/travel" element={<TravelLogs />} />
          <Route path="/vendor-invoices" element={<VendorInvoices />} />
          <Route path="/expense-claims" element={<ExpenseClaims />} />
          <Route path="/travel-dashboard" element={<TravelDashboard />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
    </div>
  );
}

/** Shared page chrome so every screen has the same header rhythm. */
export function PageHeader({ title, subtitle, actions, onMenu }) {
  return (
    <header className="topbar">
      <button type="button" className="btn btn--ghost btn--sm menu-toggle" onClick={onMenu}>☰</button>
      <div className="topbar__title">
        <h1>{title}</h1>
        {subtitle && <div className="topbar__sub">{subtitle}</div>}
      </div>
      {actions && <div className="topbar__actions">{actions}</div>}
    </header>
  );
}
