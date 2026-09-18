#!/usr/bin/env node
/**
 * Is this database ready to become the only way in?
 *
 *   npm run auth:check
 *
 * Read-only. Run it BEFORE setting AUTH_MODE=database, and again after a
 * deploy if you want to be sure. It changes nothing, prints no secrets,
 * and exits non-zero when the answer is no — so a deploy pipeline can gate
 * on it.
 */
import { authReadinessReport, formatReadinessReport } from '../src/auth/check.js';
import { pool } from '../src/db.js';
import { authConfig } from '../src/auth/config.js';

const report = await authReadinessReport();
console.log(formatReadinessReport(report));

if (authConfig.mode === 'shared') {
  console.log('');
  console.log('  This API is running AUTH_MODE=shared; nothing above is in force yet.');
}

await pool.end();
process.exit(report.ready ? 0 : 1);
