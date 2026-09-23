import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { PageHeader } from '../App.jsx';
import { ScrollArea } from '@/components/ui/scroll-area.tsx';
import { useAuth } from '../lib/auth.jsx';
import { cn } from 'cn';

import { Assumptions, Catalogue, ExchangeRates, CATALOGUES } from './Settings.jsx';
import { CompanyProfile } from './CompanyProfile.jsx';
import { ApiTokens } from '../components/ApiTokens.jsx';
import { UsersAdmin } from '../components/UsersAdmin.jsx';
import Mailboxes from './Mailboxes.jsx';
import Webhooks from './Webhooks.jsx';
import Templates from './Templates.jsx';
import Emails from './Emails.jsx';
import BulkImport from './BulkImport.jsx';

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

/**
 * The shell every settings pane wears.
 *
 * The panes arrived from six separate screens and each carried its own
 * idea of a heading — some put the title inside a card, some had none,
 * and the padding differed by pane, so moving between them in the rail
 * looked like moving between apps. This is the one shape: a title, a
 * sentence saying what the pane is for, and the room around it.
 */
export function SettingsPane({ title, description, actions, children }) {
  return (
    <div className="flex flex-col gap-5 px-4 pt-6 pb-8 sm:px-8">
      {/* On a phone the actions go under the title rather than beside it.
          Wrapping them individually let the first button sit next to the
          heading and squeeze the sentence into a column a few words wide. */}
      <div className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-start">
        <div className="min-w-0 flex-1">
          <h1 className="text-[20px] font-semibold tracking-[-0.018em] text-foreground">{title}</h1>
          {description && (
            <p className="mt-1.5 max-w-[66ch] text-[13px]/[1.6] text-secondary-text">{description}</p>
          )}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </div>
  );
}

const GROUPS = [
  {
    label: 'Organisation',
    items: [
      { to: 'company', label: 'Company profile', element: <CompanyProfile />, adminOnly: true },
    ],
  },
  {
    label: 'Money',
    items: [
      { to: 'rates', label: 'Exchange rates', element: <ExchangeRates /> },
      { to: 'assumptions', label: 'Assumptions', element: <Assumptions /> },
    ],
  },
  {
    label: 'Lists',
    items: [
      ...Object.entries(CATALOGUES).map(([key, c]) => ({
        to: key, label: c.title, element: <Catalogue key={key} {...c} />,
      })),
      { to: 'templates', label: 'Templates', element: <Templates />, adminOnly: true },
    ],
  },
  {
    label: 'People & access',
    items: [
      { to: 'users', label: 'Users & roles', element: <UsersAdmin />, adminOnly: true },
      { to: 'tokens', label: 'API tokens', element: <ApiTokens />, adminOnly: true },
    ],
  },
  {
    label: 'Connections',
    items: [
      { to: 'mailboxes', label: 'Mailboxes', element: <Mailboxes />, adminOnly: true },
      { to: 'webhooks', label: 'Webhooks', element: <Webhooks />, adminOnly: true },
    ],
  },
  {
    label: 'Data',
    items: [
      { to: 'import', label: 'Import', element: <BulkImport />, adminOnly: true },
      { to: 'emails', label: 'Emails & jobs', element: <Emails />, adminOnly: true },
    ],
  },
];

export default function SettingsArea() {
  const { isAdmin } = useAuth();
  const groups = GROUPS
    .map((group) => ({ ...group, items: group.items.filter((item) => isAdmin || !item.adminOnly) }))
    .filter((group) => group.items.length > 0);
  const first = groups[0]?.items[0]?.to ?? 'rates';

  return (
    <>
      <PageHeader
        title="Settings"
        subtitle="The lists, rates and connections the rest of the app reads from"
      />

      <div className="flex flex-col gap-6 p-4 sm:p-6 lg:flex-row">
        {/* Horizontal on a phone, a rail beside the page above lg. */}
        <ScrollArea className="lg:w-56 lg:shrink-0">
          <nav className="flex gap-1 pb-2 lg:flex-col lg:gap-0 lg:pb-0">
            {groups.map((group) => (
              <div key={group.label} className="contents lg:block lg:pb-3">
                <div className="hidden px-2.5 pt-3 pb-1.5 text-[10.5px] font-semibold tracking-[0.1em] text-muted-foreground uppercase lg:block">
                  {group.label}
                </div>
                {group.items.map((item) => (
                  <NavLink
                    key={item.to}
                    to={`/settings/${item.to}`}
                    className={({ isActive }) => cn(
                      'flex h-control shrink-0 items-center rounded-[6px] px-2.5 text-[13px] font-medium whitespace-nowrap',
                      'text-secondary-text transition-colors duration-150 hover:bg-accent hover:text-foreground',
                      isActive && 'bg-primary/12 font-semibold text-primary'
                    )}
                  >
                    {item.label}
                  </NavLink>
                ))}
              </div>
            ))}
          </nav>
        </ScrollArea>

        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <Routes>
            <Route index element={<Navigate to={`/settings/${first}`} replace />} />
            {groups.flatMap((group) => group.items).map((item) => (
              <Route key={item.to} path={item.to} element={item.element} />
            ))}
            {/* A bookmark to a page that moved, or one a sales user may not
                see, lands on the first thing they can. */}
            <Route path="*" element={<Navigate to={`/settings/${first}`} replace />} />
          </Routes>
        </div>
      </div>
    </>
  );
}
