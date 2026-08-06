import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// Resolved against this file rather than the working directory, so
// `node server/src/index.js` from the repo root reads server/.env too.
// Starting with the wrong credentials is not a failure you want to be quiet.
dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env') });

const dbName = process.env.PGDATABASE || 'cetizion_tracker';

export const config = {
  port: Number(process.env.PORT || 4000),
  databaseUrl:
    process.env.DATABASE_URL ||
    `postgres://${process.env.PGUSER || process.env.USER}@${
      process.env.PGHOST || 'localhost'
    }:${process.env.PGPORT || 5432}/${dbName}`,
  dbName,
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  nodeEnv: process.env.NODE_ENV || 'development',
  // How many reverse proxies sit in front of the API. 0 means none, so
  // X-Forwarded-For is ignored and nobody can claim someone else's address.
  trustProxy: Number(process.env.TRUST_PROXY || 0),
};
