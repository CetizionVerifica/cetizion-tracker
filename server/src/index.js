import app from './app.js';
import { authConfig } from './auth/config.js';
import { config } from './config.js';
import { logger } from './lib/ops/logger.js';
import { watchProcess } from './lib/ops/errors.js';

watchProcess('api', logger);

const server = app.listen(config.port, () => {
  logger.info(`Cetizion API listening on http://localhost:${config.port}`);
  // Only the host and database name: never the user or password.
  const db = new URL(config.databaseUrl);
  logger.info(`Database: ${db.hostname}:${db.port || 5432}${db.pathname}`);
  // Which credentials this process will accept. The mode and nothing else —
  // after a cutover this one line is what tells a deploy it took effect.
  logger.info(`[auth] mode: ${authConfig.mode}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

export default app;
