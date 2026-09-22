import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

/**
 * Two findings from the review of batch 6 that are settled by reading what
 * is there (#33, #34, #38): the watchdog recorded nothing, so deep health
 * reported it as never run, and the read-only database account could read
 * the users table while the runbook said it could not.
 *
 * In its own file because importing the job registry connects the shared
 * pool, and the suite next door builds its own database.
 */

test('the watchdog records every run, including the quiet ones', async () => {
  const { JOBS } = await import('../src/jobs.js');
  const watch = JOBS['ops.watch'];
  assert.ok(watch, 'the job still exists');
  assert.equal(watch.quiet, undefined,
    'quiet decides whether a successful run is written down; with one that always says no, the deep health check calls the watchdog "never run" for ever');
  // The jobs that genuinely are noisy keep theirs, so this is a decision
  // rather than an oversight.
  assert.equal(typeof JOBS['webhooks.deliver'].quiet, 'function');
});

test('the read-only database account cannot read the users table', () => {
  const sql = readFileSync(new URL('../scripts/sql/readonly-user.sql', import.meta.url), 'utf8');
  const revoked = sql.match(/REVOKE SELECT ON ([^;]+) FROM tracker_readonly/g).join(' ');
  for (const table of ['users', 'connected_accounts', 'api_tokens', 'webhook_endpoints', 'portal_links', 'portal_sessions']) {
    assert.match(revoked, new RegExp(`\\b${table}\\b`), `${table} holds secrets and must not be readable`);
  }
  // And the runbook must not claim more than the script does.
  const doc = readFileSync(new URL('../../docs/security.md', import.meta.url), 'utf8');
  assert.match(doc, /users/, 'security.md names what is out of reach, so the claim can be checked against the script');
});

