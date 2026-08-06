import app from './app.js';
import { config } from './config.js';

const server = app.listen(config.port, () => {
  console.log(`Cetizion API listening on http://localhost:${config.port}`);
  console.log(`Database: ${config.databaseUrl.replace(/:[^:@/]*@/, ':***@')}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

export default app;
