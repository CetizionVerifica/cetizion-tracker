import pg from 'pg';
import { config } from './config.js';

// Money arrives from pg as a string to preserve precision; the amounts in
// this app are well inside float range, so hand the client real numbers.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => (v === null ? null : Number(v)));
// Dates stay as plain YYYY-MM-DD — no timezone shifting on the way out.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

/**
 * Ten connections is right for one server. It is wrong for the test suite.
 *
 * `node --test` runs one process per CPU — ten here — and 53 test files open
 * a pool each, plus a pg.Client of their own to set the database up. Ten
 * processes at ten connections is exactly Postgres' default max_connections
 * of 100 before anything else connects, so the suite ran on the edge: a run
 * would pass, and the next would fail somewhere unrelated with a 401 or a
 * 404 because a connection could not be had. Each failure was in a different
 * file and each file passed alone, which is what that looks like from the
 * outside.
 *
 * A test process does not need ten. Three leaves room for every worker, the
 * clients they open, and whatever else is talking to the database.
 */
export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: process.env.NODE_ENV === 'test' ? 3 : 10,
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
