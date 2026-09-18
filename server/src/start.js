import { bootstrapAdmin } from './auth/bootstrap.js';
import { config } from './config.js';
import { runMigrations } from './migrations.js';
import { bootstrapFailureLines } from './startupErrors.js';

/**
 * The production entry point. The database is brought up to date first,
 * then the first admin is created if one is configured, then the API
 * starts. A migration that fails stops the start, so the app never serves
 * requests against a schema its code does not match.
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
// nothing a second time. Signing in is unaffected either way: it still
// checks AUTH_USERNAME / AUTH_PASSWORD.
//
// Only an unreadable configuration stops the start. If the variables are
// fine but the account they name already exists, bootstrapAdmin warns and
// returns; the tracker is no worse off than before, and refusing to serve
// over it would take working sign-in down to protect a facility nobody is
// using yet.
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

await import('./index.js');
