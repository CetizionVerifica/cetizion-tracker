import { config } from './config.js';
import { runMigrations } from './migrations.js';

/**
 * The production entry point. The database is brought up to date first,
 * then the API starts. A migration that fails stops the start, so the app
 * never serves requests against a schema its code does not match.
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

await import('./index.js');
