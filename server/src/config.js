import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// Resolved against this file rather than the working directory, so
// `node server/src/index.js` from the repo root reads server/.env too.
// Starting with the wrong credentials is not a failure you want to be quiet.
dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env'), quiet: true });

const dbName = process.env.PGDATABASE || 'cetizion_tracker';

/** A time zone Intl knows, or the fallback — a typo should not stop the API starting. */
function timeZoneOr(value, fallback) {
  if (!value) return fallback;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: value });
    return value;
  } catch {
    console.warn(`[config] BUSINESS_TIME_ZONE "${value}" is not a time zone; using ${fallback}`);
    return fallback;
  }
}

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
  // Where the business is. Dates the server stamps itself — the year in a
  // reference number, the date of a quotation made from a won enquiry —
  // follow this zone, not the container's UTC clock.
  businessTimeZone: timeZoneOr(process.env.BUSINESS_TIME_ZONE, 'Asia/Kolkata'),
  // Quotation and PO documents live in Cloudinary; Postgres keeps the reference.
  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME || '',
    apiKey: process.env.CLOUDINARY_API_KEY || '',
    apiSecret: process.env.CLOUDINARY_API_SECRET || '',
    folder: process.env.CLOUDINARY_FOLDER || 'cetizion-tracker',
  },
  // Cloudinary's Free plan refuses files over 10 MB.
  documentMaxBytes: Math.round((Number(process.env.DOCUMENT_MAX_MB) || 10) * 1024 * 1024),
  // Outgoing email (#21). Mode defaults to log, so nothing leaves a server
  // until someone deliberately sets live (or sandbox with an allowlist).
  mail: {
    mode: ['log', 'sandbox', 'live'].includes(process.env.EMAIL_MODE) ? process.env.EMAIL_MODE : 'log',
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.EMAIL_FROM || '',
    replyTo: process.env.EMAIL_REPLY_TO || '',
    bcc: process.env.EMAIL_BCC || '',
    allowlist: (process.env.EMAIL_ALLOWLIST || '').split(',').map((s) => s.trim()).filter(Boolean),
  },
};
