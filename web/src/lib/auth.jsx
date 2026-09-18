import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { api, setUnauthorizedHandler } from './api.js';
import { invalidateLookups } from './hooks.js';

/**
 * Who is signed in, and which question the sign-in form should ask.
 *
 * The cookie itself is httpOnly, so the browser holds the session and this
 * only ever knows whether the API still recognises it.
 *
 * Two shapes come back from /auth/me, one per sign-in mode:
 *
 *   shared    { username, expires_at }
 *   database  { id, name, email, role, expires_at }
 *
 * `isAdmin` below is for deciding what to *show*. It is never the boundary:
 * every admin-only route checks the role again on the server, against the
 * account as it stands rather than as the cookie remembers it.
 */

const AuthContext = createContext(null);

export const useAuth = () => useContext(AuthContext);

const SIGNED_OUT = { status: 'out', user: null };

/** What to call whoever is signed in, whichever mode issued the session. */
const displayName = (user) => user?.name ?? user?.username ?? '';

export function AuthProvider({ children }) {
  const [state, setState] = useState({ status: 'checking', user: null });
  // Which field to ask for. Unknown until the API says; the form waits.
  const [mode, setMode] = useState(null);

  // Ask once on load: a cookie from a previous visit means no sign-in screen.
  useEffect(() => {
    let cancelled = false;

    Promise.all([
      api.auth.me().then((result) => result.data, () => null),
      // Its own catch: not knowing the mode must not look like being signed out.
      api.auth.config().then((result) => result.data.mode, () => 'shared'),
    ]).then(([user, resolvedMode]) => {
      if (cancelled) return;
      setMode(resolvedMode);
      setState(user ? { status: 'in', user } : SIGNED_OUT);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      invalidateLookups();
      setState(SIGNED_OUT);
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  const signIn = useCallback(
    async (identifier, password) => {
      const result = await api.auth.login(identifier, password, mode);
      // Anything cached belongs to the session that just ended.
      invalidateLookups();
      setState({ status: 'in', user: result.data });
    },
    [mode]
  );

  const signOut = useCallback(async () => {
    try {
      await api.auth.logout();
    } finally {
      invalidateLookups();
      setState(SIGNED_OUT);
    }
  }, []);

  const value = useMemo(
    () => ({
      ...state,
      mode,
      displayName: displayName(state.user),
      // Shared mode has one account with full access, so it is an admin.
      // Database mode asks the role the server just re-read.
      isAdmin: state.status === 'in' && (mode === 'shared' || state.user?.role === 'admin'),
      signIn,
      signOut,
    }),
    [state, mode, signIn, signOut]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
