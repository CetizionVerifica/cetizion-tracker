import pg from 'pg';
import { config } from './config.js';

// Money arrives from pg as a string to preserve precision; the amounts in
// this app are well inside float range, so hand the client real numbers.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => (v === null ? null : Number(v)));
// Dates stay as plain YYYY-MM-DD — no timezone shifting on the way out.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
});

pool.on('error', (err) => {
  console.error('[db] idle client error', err);
});

export const query = (text, params) => pool.query(text, params);

export async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Run `fn` in a transaction on one connection, whether `db` is this pool or
 * a single client somebody handed in.
 *
 * `transaction()` above always takes a fresh connection from the pool.
 * This one is for code that must also work against a caller's client — a
 * test's, or a step that is already holding one — because `BEGIN` on a pool
 * is no promise that the next statement lands on the same connection.
 */
export async function withTransaction(db, fn) {
  const isPool = typeof db.connect === 'function' && typeof db.idleCount === 'number';
  const client = isPool ? await db.connect() : db;
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    if (isPool) client.release();
  }
}
