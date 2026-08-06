import 'dotenv/config';

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
};
