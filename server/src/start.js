import { bootstrapAdmin } from './auth/bootstrap.js';
import { assertAuthReady } from './auth/readiness.js';
import { config } from './config.js';
import { runMigrations } from './migrations.js';
import { bootstrapFailureLines } from './startupErrors.js';

/**
 * The production entry point, in the order the steps depend on each other:
 *
 *   migrations  ->  bootstrap  ->  auth readiness  ->  the API
 *
 * A migration that fails stops the start, so the app never serves requests
 * against a schema its code does not match. The readiness check stops it
 * for the other reason: AUTH_MODE=database with nobody able to sign in.
 *
 * `npm run dev` starts index.js directly and leaves the database alone.
 */

try {
  await runMigrations({ connectionString: config.databaseUrl, log: (line) => console.log(`[migrations] ${line}`) });
} catch (err) {
  console.error(`[migrations] ${err.message}`);
  console.error('[migrations] The API was not started. Fix the migration and deploy again.');
  process.exit(1);
}

// After the migrations, so the users table is certainly there, and before
// the API listens. Does nothing unless BOOTSTRAP_ADMIN_* is set, and
// nothing a second time. It fills a row; it never signs anybody in, in
// either mode.
//
// Only an unreadable configuration stops the start. If the variables are
// fine but the account they name already exists, bootstrapAdmin warns and
// returns; the tracker is no worse off than before, and refusing to serve
// over it would take working sign-in down. Whether the tracker can be
// signed into at all is the readiness gate's question, below, and it is
// only fatal in database mode.
//
// A failure here is still fatal, but what it is told to fix depends on what
// actually broke — see bootstrapFailureLines. A database that would not
// answer is not a reason to send anyone looking at variables.
try {
  await bootstrapAdmin({
    log: (line) => console.log(`[bootstrap] ${line}`),
    warn: (line) => console.warn(`[bootstrap] ${line}`),
  });
} catch (err) {
  for (const line of bootstrapFailureLines(err)) console.error(line);
  process.exit(1);
}

// Last gate before the API listens. Does nothing in shared mode; in
// database mode it refuses to serve a tracker nobody could sign in to —
// including the case where bootstrapAdmin warned instead of creating one.
try {
  await assertAuthReady({ log: (line) => console.log(`[auth] ${line}`) });
} catch (err) {
  console.error(`[auth] ${err.message}`);
  console.error('[auth] The API was not started. Create an active admin, or set AUTH_MODE=shared.');
  process.exit(1);
}

await import('./index.js');
