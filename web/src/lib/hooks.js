import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';

/**
 * Fetch on mount and whenever `deps` change, with a refetch handle so a
 * mutation elsewhere on the page can pull fresh totals.
 */
export function useFetch(fetcher, deps = []) {
  const [state, setState] = useState({ data: null, loading: true, error: null });
  const [tick, setTick] = useState(0);
  const latest = useRef(0);

  useEffect(() => {
    const run = ++latest.current;
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));

    Promise.resolve(fetcher())
      .then((result) => {
        if (cancelled || run !== latest.current) return;
        setState({ data: result, loading: false, error: null });
      })
      .catch((err) => {
        if (cancelled || err.name === 'AbortError' || run !== latest.current) return;
        setState({ data: null, loading: false, error: err.message });
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const refetch = useCallback(() => setTick((n) => n + 1), []);
  return { ...state, refetch };
}

export function useList(resource, params = {}, deps = []) {
  const serialised = JSON.stringify(params);
  const result = useFetch(() => api.list(resource, params), [resource, serialised, ...deps]);
  return { ...result, rows: result.data?.data ?? [], total: result.data?.total ?? 0 };
}

/** Lookups change rarely; fetch them once per session and share. */
let lookupCache = null;
export function useLookups() {
  const [data, setData] = useState(lookupCache);
  useEffect(() => {
    if (lookupCache) return;
    api
      .raw('/lookups')
      .then((r) => {
        lookupCache = r.data;
        setData(r.data);
      })
      .catch(() => {});
  }, []);
  return data || { services: [], travel_vendors: [], expense_categories: [], projects: [], purchase_orders: [], trips: [], sales_people: [], clients: [], companies: [], sectors: [], settings: {}, quotations: [], won_quotations: [], enums: {}, limits: {} };
}

export function invalidateLookups() {
  lookupCache = null;
}

export function useDebounced(value, delay = 250) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}
