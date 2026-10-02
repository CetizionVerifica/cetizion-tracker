/**
 * New mail without pressing Sync.
 *
 * Mail used to arrive only when the worker's mail.sync job ran (every five
 * minutes, and not at all where the worker is not deployed), a Graph
 * webhook fired, or somebody pressed Sync now under Settings. The Inbox is
 * a screen people live in, so the API now pulls mail itself:
 *
 *   startAutoSync()   every MAIL_AUTOSYNC_SECONDS (60 by default), from index.js
 *   kickSync()        once, now, when the Inbox page asks (POST /api/inbox/sync)
 *
 * Both go through syncAll(), and syncAccount holds a per-mailbox advisory
 * lock, so this, the worker and the webhook can all run without storing
 * anything twice. Within this process only one sweep runs at a time, and a
 * page asking again within a few seconds gets the sweep already running.
 */
import { config } from '../../config.js';
import { isStaging } from '../ops/environment.js';
import { syncAll } from './sync.js';

let running = null;
let lastStartedAt = 0;

/**
 * Start a sweep of every active mailbox unless one is running or one
 * started under `minGapMs` ago. Returns the sweep's promise, or null when
 * it was not started. Never rejects.
 */
export function kickSync({ minGapMs = 15_000, log = console } = {}) {
  if (running) return running;
  if (Date.now() - lastStartedAt < minGapMs) return null;
  lastStartedAt = Date.now();
  running = syncAll()
    .then((r) => {
      for (const x of r.results) if (x.error) log.warn?.(`[mail.autosync] ${x.email}: ${x.error}`);
      return r;
    })
    .catch((err) => {
      log.error?.(`[mail.autosync] ${err.message}`);
      return { mailboxes: 0, results: [], error: err.message };
    })
    .finally(() => { running = null; });
  return running;
}

export const isSyncing = () => Boolean(running);

/**
 * The API's own timer. Off in tests, and on staging, where mailbox sync is
 * switched off (assertNotStaging) and every sweep would only write the
 * same error onto every mailbox.
 */
export function startAutoSync({ seconds = config.microsoft.autoSyncSeconds, log = console } = {}) {
  if (!seconds || config.nodeEnv === 'test' || isStaging()) return () => {};
  const tick = () => { kickSync({ minGapMs: 0, log }); };
  const first = setTimeout(tick, 5_000);
  const timer = setInterval(tick, seconds * 1000);
  first.unref();
  timer.unref();
  log.info?.(`[mail.autosync] every ${seconds}s`);
  return () => { clearTimeout(first); clearInterval(timer); };
}
