import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { api, setUnauthorizedHandler } from './api.js';
import { invalidateLookups } from './hooks.js';

/**
 * Who is signed in, for the one person who can be.
 *
 * The cookie itself is httpOnly, so the browser holds the session and this
 * only ever knows whether the API still recognises it.
 */

const AuthContext = createContext(null);

export const useAuth = () => useContext(AuthContext);

const SIGNED_OUT = { status: 'out', user: null };

export function AuthProvider({ children }) {
  const [state, setState] = useState({ status: 'checking', user: null });

  // Ask once on load: a cookie from a previous visit means no sign-in screen.
  useEffect(() => {
    let cancelled = false;

    api.auth
      .me()
      .then((result) => {
        if (!cancelled) setState({ status: 'in', user: result.data });
      })
      .catch(() => {
        if (!cancelled) setState(SIGNED_OUT);
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

  const signIn = useCallback(async (username, password) => {
    const result = await api.auth.login(username, password);
    // Anything cached belongs to the session that just ended.
    invalidateLookups();
    setState({ status: 'in', user: result.data });
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api.auth.logout();
    } finally {
      invalidateLookups();
      setState(SIGNED_OUT);
    }
  }, []);

  const value = useMemo(
    () => ({ ...state, signIn, signOut }),
    [state, signIn, signOut]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
