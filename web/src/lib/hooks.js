import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { MIN_ROWS, rowsThatFit } from './pageFit.js';

/**
 * Fetch on mount and whenever `deps` change, with a refetch handle so a
 * mutation elsewhere on the page can pull fresh totals.
 */
export function useFetch(fetcher, deps = []) {
  const [state, setState] = useState({ data: null, loading: true, error: null, errorStatus: null });
  const [tick, setTick] = useState(0);
  const latest = useRef(0);

  useEffect(() => {
    const run = ++latest.current;
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null, errorStatus: null }));

    Promise.resolve(fetcher())
      .then((result) => {
        if (cancelled || run !== latest.current) return;
        setState({ data: result, loading: false, error: null, errorStatus: null });
      })
      .catch((err) => {
        if (cancelled || err.name === 'AbortError' || run !== latest.current) return;
        // The status rides along so a screen can tell "not found" from "not now".
        setState({ data: null, loading: false, error: err.message, errorStatus: err.status ?? null });
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

const LOOKUP_DEFAULTS = { services: [], owners: [], catalogue: [], travel_vendors: [], travel_vendor_list: [], trip_types: [], staff: [], expense_categories: [], projects: [], purchase_orders: [], trips: [], sales_people: [], clients: [], companies: [], sectors: [], settings: {}, quotations: [], won_quotations: [], pipeline_stages: [], lost_reasons: [], lead_sources: [], payment_terms_templates: [], onboarding_templates: [], enums: {}, limits: {} };

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
  // Every list present even when the server sends fewer: the travel desk's
  // lookups (#196) carry the travel lists only.
  return { ...LOOKUP_DEFAULTS, ...(data || {}) };
}

export function invalidateLookups() {
  lookupCache = null;
}

/**
 * Uploads a chosen file once and remembers what it became, so a save that
 * fails on another field and is tried again does not send the same file to
 * storage twice. The upload is remembered before it finishes, so two saves
 * at once share one upload rather than racing; a failed one is forgotten, so
 * the next attempt really does try again.
 *
 * Keyed by the File object itself and the kind of record it belongs to.
 * Picking the same file from disk again makes a new File, and uploads again,
 * exactly as it did before.
 */
export function useDocumentUploads() {
  const uploads = useRef(new Map());

  return useCallback(async (file, owner) => {
    let byOwner = uploads.current.get(file);
    if (!byOwner) {
      byOwner = new Map();
      uploads.current.set(file, byOwner);
    }
    if (!byOwner.has(owner)) {
      byOwner.set(
        owner,
        api.uploadDocument(file, owner).then(
          (response) => response.data,
          (err) => {
            byOwner.delete(owner);
            throw err;
          }
        )
      );
    }
    return (await byOwner.get(owner)).id;
  }, []);
}

export function useDebounced(value, delay = 250) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/**
 * A media query as state, so a component can render one thing or the
 * other rather than rendering both and hiding one.
 *
 * Hiding with CSS is fine for a wrapper. It is not fine for a table: it
 * puts every row in the document twice, doubles the work on every render,
 * and leaves tests and screen readers picking whichever copy comes first
 * in the DOM — which is the hidden one.
 */
export function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => {
    try { return window.matchMedia(query).matches; } catch { return false; }
  });
  useEffect(() => {
    let mq;
    try { mq = window.matchMedia(query); } catch { return undefined; }
    const onChange = (event) => setMatches(event.matches);
    mq.addEventListener('change', onChange);
    setMatches(mq.matches);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

/**
 * How many rows of `rowHeight` an element has room for (#250), re-measured
 * as the window changes, or null until it has been laid out.
 *
 * Returns `[measure, rows]`: pass `measure` as the element's ref. A ref
 * callback rather than a ref object, so an element that appears later (the
 * inbox's list, back from the setup screen) is measured when it does.
 *
 * The first measurement is taken at once, so the list is not fetched at a
 * guessed size and then again at the right one; later ones wait until the
 * resize has settled, so dragging a window edge is one request, not one
 * per pixel.
 */
export function useRowsThatFit(rowHeight, { min = MIN_ROWS, settleMs = 150 } = {}) {
  const [node, setNode] = useState(null);
  const [rows, setRows] = useState(null);
  useEffect(() => {
    if (!node) return undefined;
    const measure = () => setRows(rowsThatFit(node.clientHeight, rowHeight, min));
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    let timer = null;
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(measure, settleMs);
    });
    observer.observe(node);
    return () => { clearTimeout(timer); observer.disconnect(); };
  }, [node, rowHeight, min, settleMs]);
  return [setNode, rows];
}
