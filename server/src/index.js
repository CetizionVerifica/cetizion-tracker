import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import app from './app.js';
import { config } from './config.js';
import { query } from './db.js';

// Idempotent additions (CREATE TABLE IF NOT EXISTS ...) that an existing
// database needs without the drop-everything `npm run migrate`.
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');
for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
  await query(readFileSync(join(migrationsDir, file), 'utf8'));
}

const server = app.listen(config.port, () => {
  console.log(`Cetizion API listening on http://localhost:${config.port}`);
  console.log(`Database: ${config.databaseUrl.replace(/:[^:@/]*@/, ':***@')}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

export default app;
