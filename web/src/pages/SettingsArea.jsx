import { useMemo } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import {
  ArrowLeftRight, Briefcase, Building2, CalendarDays, ChartPie, Clock, FileSpreadsheet, FileText, KeyRound, LogIn,
  Mail, Percent, Plane, ScanText, Tag, Upload, Users, Wallet, Webhook,
} from 'lucide-react';
import { SettingsContext, SettingsIndex, SettingsNav, SettingsPane } from '../components/settings.jsx';
import { initialsOf } from '../components/record.jsx';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useFetch, useLookups, useMediaQuery } from '../lib/hooks.js';

import { Assumptions, Catalogue, ExchangeRates, Holidays, CATALOGUES } from './Settings.jsx';
import { CompanyProfile } from './CompanyProfile.jsx';
import { ApiTokens } from '../components/ApiTokens.jsx';
import { SignInMethods } from './SignInMethods.jsx';
import { UsersAdmin } from '../components/UsersAdmin.jsx';
import Mailboxes from './Mailboxes.jsx';
import Webhooks from './Webhooks.jsx';
import Templates from './Templates.jsx';
import Emails from './Emails.jsx';
import BulkImport from './BulkImport.jsx';
import TravelImport from './TravelImport.jsx';
import ReportCategories from './ReportCategories.jsx';
import DocumentProfiles from './DocumentProfiles.jsx';

/**
 * One Settings area, with a rail grouped by what a setting is about.
 *
 * Six admin destinations used to sit in the sidebar — Settings, Mailboxes,
 * Webhooks, Templates, Emails and Import — each because a different issue
 * built it. Nobody thinks "I need the Webhooks page"; they think "the
 * n8n flow stopped firing". Grouping by subject rather than by origin is
 * the whole change, and it is what lets the sidebar carry two links
 * instead of thirty.
 *
 * A sales user sees Money and Lists. Everything else is an admin's, and
 * hiding it here is only tidiness: every route behind these pages is
 * guarded by requireAdmin on the server, so a sales user who reached one
 * anyway would get a 403 from it rather than a page.
 */

/** Every pane wears the Wave 8 shape: see components/settings.jsx. */
export { SettingsPane };

const LIST_ICON = { services: Briefcase, 'travel-vendors': Plane, 'trip-types': Tag, 'expense-categories': Wallet };

const GROUPS = [
  {
    label: 'Organisation',
    items: [
      { to: 'company', icon: Building2, label: 'Company profile', element: <CompanyProfile />, adminOnly: true },
      { to: 'holidays', icon: CalendarDays, label: 'Holidays', element: <Holidays /> },
    ],
  },
  {
    label: 'Money',
    items: [
      { to: 'rates', icon: ArrowLeftRight, label: 'Exchange rates', element: <ExchangeRates /> },
      { to: 'assumptions', icon: Percent, label: 'Assumptions', element: <Assumptions /> },
    ],
  },
  {
    label: 'Lists',
    items: [
      ...Object.entries(CATALOGUES).map(([key, c]) => ({
        to: key, icon: LIST_ICON[key], label: c.title, element: <Catalogue key={key} {...c} />, hr: c.hr,
      })),
      { to: 'templates', icon: FileText, label: 'Templates', element: <Templates />, adminOnly: true },
      { to: 'reports', icon: ChartPie, label: 'Report categories', element: <ReportCategories />, adminOnly: true },
    ],
  },
  {
    label: 'People & access',
    items: [
      { to: 'users', icon: Users, label: 'Users & roles', element: <UsersAdmin />, adminOnly: true },
      { to: 'sign-in', icon: LogIn, label: 'Sign-in methods', element: <SignInMethods />, adminOnly: true },
      { to: 'tokens', icon: KeyRound, label: 'API tokens', element: <ApiTokens />, adminOnly: true },
    ],
  },
  {
    label: 'Connections',
    items: [
      // Every role: a salesperson connects their own mailbox here, and sees
      // only that (docs/per-user-mailboxes-plan.md §5). The admin's view of
      // every mailbox is the same pane, titled for what it shows.
      { to: 'mailboxes', icon: Mail, label: 'Mailboxes', salesLabel: 'My mailbox', element: <Mailboxes /> },
      { to: 'document-notes', icon: ScanText, label: 'Client document notes', element: <DocumentProfiles />, adminOnly: true },
      { to: 'webhooks', icon: Webhook, label: 'Webhooks', element: <Webhooks />, adminOnly: true },
    ],
  },
  {
    label: 'Data',
    items: [
      { to: 'import', icon: Upload, label: 'Import', element: <BulkImport />, adminOnly: true },
      { to: 'import-travel', icon: FileSpreadsheet, label: 'Import travel', element: <TravelImport />, adminOnly: true, hr: true },
      { to: 'emails', icon: Clock, label: 'Emails & jobs', element: <Emails />, adminOnly: true },
    ],
  },
];

/**
 * What needs an admin's eye, said in the sub-navigation: a currency with no
 * rate, suggested document notes waiting for approval, a failing webhook.
 * Admin only (the design shows sales no counts); refreshed as panes change.
 */
function useAttention(isAdmin, pathname) {
  const lookups = useLookups();
  const rates = useFetch(() => (isAdmin ? api.list('exchange-rates', { limit: 500 }) : null), [isAdmin, pathname]);
  const notes = useFetch(() => (isAdmin ? api.list('document-profiles', { limit: 500 }) : null), [isAdmin, pathname]);
  const hooks = useFetch(() => (isAdmin ? api.raw('/webhooks') : null), [isAdmin, pathname]);
  return useMemo(() => {
    if (!isAdmin) return {};
    const out = {};
    const have = new Set((rates.data?.data ?? []).map((r) => r.from_currency));
    const missing = rates.data ? (lookups.currencies_in_use ?? []).filter((c) => c !== 'INR' && !have.has(c)).length : 0;
    if (missing) out.rates = { n: missing, tone: 'wait', say: `${missing} ${missing === 1 ? 'currency has' : 'currencies have'} no rate`, short: `${missing} missing` };
    const suggested = (notes.data?.data ?? []).filter((n) => !n.approved).length;
    if (suggested) out['document-notes'] = { n: suggested, tone: 'wait', say: `${suggested} suggested ${suggested === 1 ? 'note' : 'notes'} to review`, short: `${suggested} to review` };
    const failing = (hooks.data?.data ?? []).filter((w) => w.active && w.failed > 0).length;
    if (failing) out.webhooks = { n: failing, tone: 'late', say: `${failing} ${failing === 1 ? 'endpoint' : 'endpoints'} failing`, short: `${failing} failing` };
    return out;
  }, [isAdmin, lookups.currencies_in_use, rates.data, notes.data, hooks.data]);
}

/** Every pane a role might ask for, so a refused one can be named. */
const ALL_ITEMS = GROUPS.flatMap((g) => g.items);

export default function SettingsArea() {
  const { isAdmin, isHr, mode, user, displayName } = useAuth();
  const { pathname } = useLocation();
  const phone = useMediaQuery('(max-width: 719px)');
  const groups = GROUPS
    .map((group) => ({
      ...group,
      items: group.items
        // The travel desk (#196) sees the travel lists and the travel import only.
        .filter((item) => (isHr ? item.hr : isAdmin || !item.adminOnly))
        .map((item) => (!isAdmin && item.salesLabel ? { ...item, label: item.salesLabel } : item)),
    }))
    .filter((group) => group.items.length > 0);
  /**
   * Where /settings lands, stated rather than inferred.
   *
   * This was `groups[0].items[0]`, which meant the landing pane moved
   * whenever the first group's membership changed. Adding Holidays — a
   * pane every role may read — kept the Organisation group alive for a
   * sales user, whose /settings had been landing on Exchange rates, and
   * silently moved them to a list of public holidays. The first item of
   * the first group is a fact about the menu, not a decision about where
   * somebody should start.
   */
  const DEFAULT_PANE = isHr ? 'travel-vendors' : 'rates';
  const first = groups.some((group) => group.items.some((item) => item.to === DEFAULT_PANE))
    ? DEFAULT_PANE
    : groups[0]?.items[0]?.to ?? DEFAULT_PANE;
  const firstLabel = groups.flatMap((g) => g.items).find((i) => i.to === first)?.label ?? 'Settings';
  const counts = useAttention(isAdmin, pathname);
  const showAccount = mode === 'database';

  /* A bookmark to a pane this role may not see, or one that moved, lands on
     the first thing they can and says why, rather than silently. */
  const wanted = pathname.replace(/^\/settings\/?/, '').split('/')[0];
  const refused = ALL_ITEMS.find((i) => i.to === wanted);
  const notice = !wanted ? null : refused
    ? (isHr ? `${refused.label} isn’t part of the travel desk, so you’re on ${firstLabel}.` : `${refused.label} is only for admins, so you’re on ${firstLabel}.`)
    : `There’s no settings page at that address, so you’re on ${firstLabel}.`;

  const index = phone
    ? <SettingsIndex showAccount={showAccount} initials={initialsOf(displayName || user?.name || '')} />
    : <Navigate to={`/settings/${first}`} replace />;

  return (
    <SettingsContext.Provider value={{ groups, counts }}>
      <div className="app-page set-page">
        <div className="set-body">
          <SettingsNav showAccount={showAccount} />
          <div className="set-main">
            <Routes>
              <Route index element={index} />
              {groups.flatMap((group) => group.items).map((item) => (
                <Route key={item.to} path={`${item.to}/*`} element={item.element} />
              ))}
              <Route path="*" element={<Navigate to={`/settings/${first}`} replace state={{ settingsNotice: notice }} />} />
            </Routes>
          </div>
        </div>
      </div>
    </SettingsContext.Provider>
  );
}
