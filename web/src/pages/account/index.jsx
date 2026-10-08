import { createContext, useContext, useLayoutEffect, useRef, useState } from 'react';
import { Link, Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { Bell, KeyRound, Laptop, Settings, UserRound } from 'lucide-react';
import { PageHeader } from '../../App.jsx';
import { ConfirmDialog, useToast } from '../../components/ui.jsx';
import { FailedCard, LoadingPanel, StateCard } from '../../components/daily.jsx';
import { initialsOf } from '../../components/record.jsx';
import { Tone } from '../../components/sales.jsx';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.jsx';
import { useFetch } from '../../lib/hooks.js';

import { Profile } from './Profile.jsx';
import { Notifications } from './Notifications.jsx';
import { WaysIn } from './WaysIn.jsx';
import { Devices } from './Devices.jsx';
import { sentence } from '../../lib/format.js';

/**
 * My account (C20), Wave 8: the Settings shape. Who you are and the four
 * sections sit in a glass list beside the pane (1100px and up), or above it
 * as tabs; the pane's own title is the one h1, with "My account › Pane" as
 * its crumb. Role, email and whether the account is active are an admin's,
 * set under Users & roles. In shared mode there is no personal account, so
 * the page says that instead of failing.
 */

const PANES = [
  { to: 'profile', label: 'Profile', icon: UserRound, sub: 'What the app calls you, and what it prints under your name.', element: <Profile /> },
  { to: 'notifications', label: 'Notifications', icon: Bell, sub: 'What reaches you, and how. Every choice saves as you make it.', element: <Notifications /> },
  { to: 'ways-in', label: 'Ways in', icon: KeyRound, sub: 'One person, several doors. Any of them signs you in to the same account.', element: <WaysIn /> },
  { to: 'devices', label: 'Devices', icon: Laptop, sub: 'Where you’re signed in. A session lasts twelve hours; signing one out ends it straight away, wherever it is.', element: <Devices /> },
];
const ROLE = { admin: ['Admin', 'info'], sales: ['Sales', 'plain'], hr: ['HR (travel)', 'wait'] };
const PROVIDER = { microsoft: 'Microsoft 365', google: 'Google' };

const AccountContext = createContext(null);

/** The one fetch, shared: four panes reading the same payload, one refresh. */
export const useAccount = () => useContext(AccountContext);

function Who({ profile, identities }) {
  const [role, tone] = ROLE[profile.role] || [profile.role, 'plain'];
  return (
    <div className="acc-who__inner flex min-w-0 flex-wrap items-center gap-3">
      <span className="mg-avatar" style={{ width: 44, height: 44, flex: 'none' }}>{initialsOf(profile.name)}</span>
      <span className="min-w-0 flex-[1_1_140px]">
        <b className="block font-bold [overflow-wrap:anywhere]">{profile.name}</b>
        <small className="block text-[12.5px] text-secondary-text [overflow-wrap:anywhere]">{profile.email?.includes('@') ? <>{profile.email.split('@')[0]}<wbr />@{profile.email.split('@').slice(1).join('@')}</> : profile.email}</small>
      </span>
      <span className="flex flex-wrap gap-1.5">
        <Tone tone={tone}>{role}</Tone>
        {identities.map((i) => <Tone key={i.provider} tone="ok">{PROVIDER[i.provider] || i.provider}</Tone>)}
      </span>
    </div>
  );
}

export default function Account() {
  const toast = useToast();
  const { mode, isHr, signOut } = useAuth();
  const shared = mode === 'shared';
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { data, loading, fresh, error, refetch } = useFetch(() => (shared ? null : api.raw('/auth/account')), [shared]);
  const [everywhere, setEverywhere] = useState(false);
  const navRef = useRef(null);
  const [mark, setMark] = useState(null);
  const key = pathname.replace(/^\/account\/?/, '').split('/')[0];
  const pane = PANES.find((p) => p.to === key) ?? PANES[0];
  useLayoutEffect(() => {
    const el = navRef.current?.querySelector('a[aria-current="page"]');
    setMark(el ? el.offsetTop : null);
  }, [pathname, data]);

  const head = (actions) => (
    <PageHeader
      className="set-header"
      eyebrow=""
      title={shared ? 'My account' : pane.label}
      subtitle={shared ? 'How you sign in, where you’re signed in, and what the rest of the app calls you.' : pane.sub}
      actions={actions}
      lead={<nav className="mg-crumbs" aria-label="Breadcrumb"><span>My account</span>{!shared && <><span aria-hidden="true">›</span><span>{pane.label}</span></>}</nav>}
    />
  );

  if (shared) {
    return (
      <div className="app-page set-page">
        {head()}
        <StateCard tone="plain" title="Everyone signs in with one shared account" text="There’s no personal account here to change: no profile, notifications, ways in or devices of your own. Those arrive when the server switches to personal sign-ins (AUTH_MODE=database).">
          <Link to="/settings" className="mg-btn mg-btn--sm">Open Settings</Link>
        </StateCard>
      </div>
    );
  }
  if (error) {
    return (
      <div className="app-page set-page">
        {head()}
        <FailedCard title="Couldn’t load your account" text={`${sentence(error)} Nothing has changed. Try again in a moment.`} onRetry={refetch} />
      </div>
    );
  }
  if ((loading && !fresh) || !data) {
    return <div className="app-page set-page">{head()}<LoadingPanel rows={4} /></div>;
  }

  const account = data.data;
  const { profile, identities, sessions = [] } = account;

  async function endEverything() {
    try {
      await api.raw('/auth/account/sessions/revoke-all', { method: 'POST' });
    } finally {
      // Including here — that is what the words say, so the app follows.
      signOut();
    }
  }

  return (
    <AccountContext.Provider value={{ ...account, refetch, toast }}>
      <div className="app-page set-page">
        <div className="set-body">
          <aside className="mg-glass set-nav" data-a="rise" aria-label="My account">
            <div className="px-2 pb-1"><Who profile={profile} identities={identities} /></div>
            <nav ref={navRef} aria-label="Account sections" className="set-nav__list">
              <span className="set-nav__mark" aria-hidden="true" style={{ transform: `translateY(${mark ?? 0}px)`, opacity: mark == null ? 0 : 1 }} />
              {PANES.map((p) => {
                const Icon = p.icon;
                return <NavLink key={p.to} to={`/account/${p.to}`} className="set-nav__item"><Icon aria-hidden="true" /><span className="set-nav__label">{p.label}</span></NavLink>;
              })}
            </nav>
            <Link to="/settings" className="set-nav__acct"><Settings aria-hidden="true" />{isHr ? 'Travel settings' : 'Settings'}</Link>
          </aside>
          <div className="set-main">
            {head(pane.to === 'devices' && sessions.length > 1 && <button type="button" className="mg-btn" onClick={() => setEverywhere(true)}>Sign out everywhere</button>)}
            <div className="mg-glass acc-tabs acc-who flex-col items-stretch" data-a="rise">
              <Who profile={profile} identities={identities} />
              <div className="mg-tabs overflow-x-auto" role="tablist" aria-label="Account sections">
                {PANES.map((p) => <button key={p.to} type="button" role="tab" aria-selected={p.to === pane.to} onClick={() => navigate(`/account/${p.to}`)}>{p.label}</button>)}
              </div>
            </div>
            <Routes>
              <Route index element={<Navigate to="/account/profile" replace />} />
              {PANES.map((p) => <Route key={p.to} path={p.to} element={p.element} />)}
              <Route path="*" element={<Navigate to="/account/profile" replace />} />
            </Routes>
          </div>
        </div>
      </div>
      {everywhere && (
        <ConfirmDialog
          title="Sign out everywhere?"
          subtitle={`${sessions.length} sessions, including this one`}
          message="Every session ends straight away, this one too, so you’ll sign in again here. Use it if a device is lost or shared."
          tone="neutral"
          confirmLabel="Sign out everywhere"
          onConfirm={endEverything}
          onClose={() => setEverywhere(false)}
        />
      )}
    </AccountContext.Provider>
  );
}
