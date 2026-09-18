import app from './app.js';
import { authConfig } from './auth/config.js';
import { config } from './config.js';

const server = app.listen(config.port, () => {
  console.log(`Cetizion API listening on http://localhost:${config.port}`);
  console.log(`Database: ${config.databaseUrl.replace(/:[^:@/]*@/, ':***@')}`);
  // Which credentials this process will accept. The mode and nothing else —
  // after a cutover this one line is what tells a deploy it took effect.
  console.log(`[auth] mode: ${authConfig.mode}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

export default app;
