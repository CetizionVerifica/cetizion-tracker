/**
 * Every route the Express application actually mounts — discovered from the
 * application, not from a list somebody keeps by hand (#89).
 *
 * The point of this file is that it is *independent of the policy*. The
 * policy says what access a route should have; this says which routes exist.
 * If the two are generated from the same source, a route nobody declared is
 * invisible, which is exactly the failure #89 exists to stop.
 *
 * ## Why the recorder
 *
 * Express 5 mounts through the `router` package (2.x). Its `Layer` keeps the
 * compiled matchers and throws the pattern away:
 *
 *     function Layer (path, options, fn) {
 *       this.handle = fn; this.keys = []; this.name = fn.name;
 *       this.path = undefined;                 // set while matching, not now
 *       this.matchers = ...                    // the pattern, compiled
 *     }
 *
 * So the Express 4 trick of parsing `layer.regexp.toString()` cannot work:
 * there is no `regexp`, and no mount path to read back. A `Route` does keep
 * its own `path`, so the last segment is recoverable — but the prefixes a
 * router was mounted under are not.
 *
 * The recorder below fills that gap. It wraps `Router.prototype.use`, and for
 * each call notes which layers that call pushed onto the stack and under
 * which path. It records and returns; it does not change dispatch, it does
 * not wrap handlers, and it never runs one. `app.use(...)` delegates to
 * `router.use(...)` in Express 5, and `app.get(...)` to `this.route(path)`,
 * so between the recorder and `layer.route.path` every mounted path is
 * recoverable.
 *
 * It must be imported **before** the application module, so that the mounts
 * in app.js are seen. `loadApp()` below does that in the right order.
 *
 * ## Safety
 *
 * Discovery imports app.js. That builds the router tree and nothing else:
 * `app.js` never calls `listen`, the pg Pool is lazy so no connection is
 * opened, and no module starts a timer or a queue worker at import (the
 * worker is a separate entry point, src/worker.js). `loadApp()` additionally
 * pins DATABASE_URL to an unroutable address unless the caller has already
 * chosen one, so a stray query cannot reach a real database.
 */
import { createRequire } from 'node:module';
import express from 'express';

const require = createRequire(import.meta.url);

/** Layer -> the paths the `use()` call that created it was given. */
const MOUNTED_AT = new WeakMap();

let recorderInstalled = false;
let mountsRecorded = 0;

/** `use('/a', fn)`, `use(['/a','/b'], fn)`, `use(fn)` — always a list of paths. */
function mountPathsOf(firstArgument) {
  if (typeof firstArgument === 'function') return ['/'];
  const given = Array.isArray(firstArgument) ? firstArgument : [firstArgument];
  const paths = given.filter((p) => typeof p === 'string' || p instanceof RegExp);
  return paths.length ? paths : ['/'];
}

/**
 * Start recording mount paths. Idempotent, and safe to call from several
 * modules: the second call is a no-op rather than a second wrapper.
 */
export function installRouteRecorder() {
  if (recorderInstalled) return;
  const routerPrototype = express.Router.prototype;
  const originalUse = routerPrototype.use;

  routerPrototype.use = function recordingUse(...args) {
    const before = this.stack.length;
    const result = originalUse.apply(this, args);
    const paths = mountPathsOf(args[0]);
    for (let i = before; i < this.stack.length; i += 1) {
      MOUNTED_AT.set(this.stack[i], paths);
      mountsRecorded += 1;
    }
    return result;
  };

  recorderInstalled = true;
}

// Installed on import, so that importing this module first is enough.
installRouteRecorder();

function joinPath(prefix, segment) {
  const raw = `${prefix}/${String(segment ?? '')}`.replace(/\/{2,}/g, '/');
  return raw.length > 1 ? raw.replace(/\/$/, '') : '/';
}

/** The verbs a Route answers. `all()` is reported as ALL; HEAD implied by GET is not. */
function methodsOf(route) {
  const names = Object.keys(route.methods || {});
  if (names.includes('_all')) return ['ALL'];
  return names.map((m) => m.toUpperCase()).sort();
}

const isRouter = (handle) => typeof handle === 'function' && Array.isArray(handle.stack);

function walk(router, prefix, found, seen) {
  // A router mounted under itself would loop; nothing does, but discovery
  // must not be the thing that hangs the test suite if one ever does.
  if (seen.has(router)) return;
  seen.add(router);

  for (const layer of router.stack) {
    if (layer.route) {
      const path = joinPath(prefix, layer.route.path);
      for (const method of methodsOf(layer.route)) found.push({ method, path });
      continue;
    }
    if (!isRouter(layer.handle)) continue; // ordinary middleware: not a route
    for (const mount of MOUNTED_AT.get(layer) ?? ['/']) {
      const at = mount instanceof RegExp ? joinPath(prefix, `(regexp:${mount.source})`) : joinPath(prefix, mount);
      walk(layer.handle, at, found, seen);
    }
  }

  seen.delete(router);
}

/** Routes every discovery must find, or discovery itself is broken. */
const ANCHORS = [
  'GET /api/health',
  'POST /api/auth/login',
  'GET /api/auth/config',
  'POST /api/users',
  'GET /metrics',
];

export const routeKey = (route) => `${route.method} ${route.path}`;

/**
 * Every route mounted on `app`, sorted, de-duplicated.
 *
 * Throws rather than returning a short list: an enumeration that silently
 * finds nothing would make the coverage test pass with no routes to cover,
 * which is the one failure mode a coverage test must not have.
 */
export function routeInventory(app) {
  const router = app?.router;
  if (!router || !Array.isArray(router.stack)) {
    throw new Error(
      'Route discovery found no router on the Express application. ' +
      `express@${expressVersion()} may have changed how routes are stored; see src/lib/authz/routeInventory.js.`
    );
  }
  if (!mountsRecorded) {
    throw new Error(
      'Route discovery recorded no mounts. installRouteRecorder() must run before the application module is imported.'
    );
  }

  const found = [];
  walk(router, '', found, new Set());

  const unique = [...new Map(found.map((r) => [routeKey(r), r])).values()]
    .sort((a, b) => routeKey(a).localeCompare(routeKey(b)));

  const keys = new Set(unique.map(routeKey));
  const missing = ANCHORS.filter((a) => !keys.has(a));
  if (missing.length) {
    throw new Error(
      `Route discovery is not working against express@${expressVersion()}: it did not find ${missing.join(', ')}. ` +
      'Fix src/lib/authz/routeInventory.js before trusting the access-policy coverage test.'
    );
  }

  return unique;
}

export function expressVersion() {
  try {
    return require('express/package.json').version;
  } catch {
    return 'unknown';
  }
}

/**
 * Import the application with the recorder already installed, and with an
 * environment that cannot reach a real database.
 */
export async function loadApp() {
  installRouteRecorder();
  process.env.NODE_ENV ||= 'test';
  process.env.SESSION_SECRET ||= 'route-inventory-secret-that-is-long-enough';
  // 0.0.0.0:1 is unroutable. Only used if something queries, which discovery does not.
  process.env.DATABASE_URL ||= 'postgres://route-inventory@0.0.0.0:1/route-inventory';
  const { default: app } = await import('../../app.js');
  return app;
}
