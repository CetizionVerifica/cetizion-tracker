import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

/**
 * In production the API also serves the built front end, so the whole tracker
 * is one origin behind one lock. In development Vite serves it instead and
 * this quietly does nothing.
 */

const ASSET_MAX_AGE = '1h';

const here = dirname(fileURLToPath(import.meta.url));

export const webDistDir = process.env.WEB_DIST_DIR
  ? resolve(process.env.WEB_DIST_DIR)
  : join(here, '..', '..', 'web', 'dist');

export function mountWebApp(app) {
  const indexHtml = join(webDistDir, 'index.html');

  if (!existsSync(indexHtml)) {
    console.warn(`[web] No front-end build at ${webDistDir} — serving the API only.`);
    console.warn('[web] Run `npm run build` from the repo root to produce one.');
    return;
  }

  // `index: false` keeps index.html out of the static handler so every HTML
  // request goes through the SPA fallback below and is never cached.
  app.use(express.static(webDistDir, { index: false, maxAge: ASSET_MAX_AGE }));
  // The braces make the wildcard optional, so "/" is matched as well as
  // "/projects/PRJ-2026-001". A bare "/*splat" needs at least one segment.
  app.get('/{*splat}', (req, res) => res.sendFile(indexHtml));

  console.log(`[web] Serving the front end from ${webDistDir}`);
}
