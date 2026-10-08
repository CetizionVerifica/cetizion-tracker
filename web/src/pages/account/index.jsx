import { createContext, useContext } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { PageHeader } from '../../App.jsx';
import { PaneRail } from '../../components/PaneRail.jsx';
import { Chip, initialsOf } from '../../components/record.jsx';
import { Avatar, AvatarFallback } from '../../components/ui/avatar.tsx';
import { ErrorState, useToast } from '../../components/ui.jsx';
import { api } from '../../lib/api.js';
import { useFetch } from '../../lib/hooks.js';

import { Profile } from './Profile.jsx';
import { Notifications } from './Notifications.jsx';
import { WaysIn } from './WaysIn.jsx';
import { Devices } from './Devices.jsx';

/**
 * My account (C20).
 *
 * The design draws this with a rail — the same shape as Settings — and the
 * first version of it was one long scroll with the title said twice: once
 * in the page header and again as a heading immediately under it. Four
 * sections of equal weight, stacked, with the only thing that identifies
 * whose account it is buried in a sentence.
 *
 * So: one identity block at the top that answers "who am I signed in as",
 * and four panes behind a rail. Each pane is small enough to read at once,
 * which is the point of splitting them.
 *
 * What is deliberately not here: role, email address, and whether the
 * account is active. Those are facts about somebody's job, an admin sets
 * them under Users & roles, and the header says so rather than showing
 * greyed-out boxes — a disabled field only invites somebody to hunt for
 * the way to enable it.
 */

const PANES = [
  { to: 'profile', label: 'Profile', element: <Profile /> },
  { to: 'notifications', label: 'Notifications', element: <Notifications /> },
  { to: 'ways-in', label: 'Ways in', element: <WaysIn /> },
  { to: 'devices', label: 'Devices', element: <Devices /> },
];

const AccountContext = createContext(null);

/** The one fetch, shared: four panes reading the same payload, one refresh. */
export const useAccount = () => useContext(AccountContext);

export default function Account() {
  const toast = useToast();
  const { data, loading, error, refetch } = useFetch(() => api.raw('/auth/account'), []);

  if (error) {
    return (
      <>
        <PageHeader title="My account" />
        <div className="page"><ErrorState message={error} onRetry={refetch} /></div>
      </>
    );
  }
  if (loading || !data) {
    return (
      <>
        <PageHeader title="My account" />
        <div className="page"><div className="skeleton h-[240px]" /></div>
      </>
    );
  }

  const account = data.data;
  const { profile, identities } = account;

  return (
    <AccountContext.Provider value={{ ...account, refetch, toast }}>
      <PageHeader
        title="My account"
        subtitle="How you sign in, where you are signed in, and what the rest of the app calls you."
      />

      <div className="flex flex-col gap-6 p-4 sm:p-6">
        {/* Who you are signed in as, once, at the top — rather than a
            sentence in the middle of a form. */}
        <div className="flex flex-wrap items-center gap-4">
          <Avatar className="size-12 shrink-0 rounded-lg">
            <AvatarFallback className="rounded-lg bg-secondary text-[15px] font-semibold text-primary">
              {initialsOf(profile.name)}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <div className="truncate font-display text-lg font-bold text-foreground">{profile.name}</div>
            <div className="truncate text-[13px] text-secondary-text">{profile.email}</div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Chip tone={profile.role === 'admin' ? 'info' : 'plain'}>
              {profile.role === 'admin' ? 'Admin' : 'Sales'}
            </Chip>
            {identities.map((i) => (
              <Chip key={i.provider} tone="settled">
                {i.provider === 'microsoft' ? 'Microsoft 365' : 'Google'}
              </Chip>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-6 lg:flex-row">
          <PaneRail base="/account" groups={[{ items: PANES.map(({ to, label }) => ({ to, label })) }]} />

          <div className="flex min-w-0 flex-1 flex-col gap-4">
            <Routes>
              <Route index element={<Navigate to="/account/profile" replace />} />
              {PANES.map((pane) => <Route key={pane.to} path={pane.to} element={pane.element} />)}
              <Route path="*" element={<Navigate to="/account/profile" replace />} />
            </Routes>
          </div>
        </div>
      </div>
    </AccountContext.Provider>
  );
}
