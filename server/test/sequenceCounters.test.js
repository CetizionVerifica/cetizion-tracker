import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { describe } from 'node:test';
import pg from 'pg';

/**
 * Reference numbers must never be reissued. nextId() used to read the highest
 * number in the table and add one, so deleting the newest record handed its
 * reference to the next one — CTZ/QT/2026/063 could go out twice.
 *
 * Needs a Postgres the runner may create databases on: set TEST_DATABASE_URL
 * (CI does). Without it the suite is skipped.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');

async function withDatabase(fn) {
  const name = `seq_counter_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(ADMIN_URL);
    url.pathname = `/${name}`;
    const client = new pg.Client({ connectionString: url.toString() });
    try {
      await client.connect();
      await client.query(readFileSync(join(DB_DIR, 'schema.sql'), 'utf8'));
      return await fn(client);
    } finally {
      await client.end();
    }
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
    await admin.end();
  }
}

// claimNextId takes the client it should run on, so no pool is needed.
process.env.DATABASE_URL ??= ADMIN_URL ?? 'postgres://localhost/none';
const { claimNextId, nextId } = await import('../src/lib/sequences.js');

const YEAR = '2026';
const addQuotation = (client, no) =>
  client.query(`INSERT INTO quotations (quotation_no, client_name, quotation_date)
                VALUES ($1, 'Acme', '${YEAR}-05-01')`, [no]);

describe('reference numbers are never reissued', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  test('a deleted record does not give its number back', () =>
    withDatabase(async (client) => {
      const first = await claimNextId('quotation', client, YEAR);
      await addQuotation(client, first);
      const second = await claimNextId('quotation', client, YEAR);
      await addQuotation(client, second);
      assert.equal(first, `CTZ/QT/${YEAR}/001`);
      assert.equal(second, `CTZ/QT/${YEAR}/002`);

      // The newest quotation is deleted — the table's highest is 001 again.
      await client.query('DELETE FROM quotations WHERE quotation_no = $1', [second]);

      const third = await claimNextId('quotation', client, YEAR);
      assert.equal(third, `CTZ/QT/${YEAR}/003`, 'must not reissue 002');
      assert.notEqual(third, second);
    }));

  test('every reference in a run is distinct, even after deleting them all', () =>
    withDatabase(async (client) => {
      const issued = [];
      for (let i = 0; i < 5; i += 1) {
        const id = await claimNextId('quotation', client, YEAR);
        await addQuotation(client, id);
        issued.push(id);
      }
      await client.query('DELETE FROM quotations');
      for (let i = 0; i < 3; i += 1) {
        const id = await claimNextId('quotation', client, YEAR);
        await addQuotation(client, id);
        issued.push(id);
      }
      assert.equal(new Set(issued).size, issued.length, 'a reference was issued twice');
      assert.equal(issued.at(-1), `CTZ/QT/${YEAR}/008`);
    }));

  test('a number typed in by hand above the series is not reissued either', () =>
    withDatabase(async (client) => {
      // Someone enters a historical or imported reference directly.
      await addQuotation(client, `CTZ/QT/${YEAR}/050`);
      assert.equal(await claimNextId('quotation', client, YEAR), `CTZ/QT/${YEAR}/051`);
      await client.query('DELETE FROM quotations');
      assert.equal(await claimNextId('quotation', client, YEAR), `CTZ/QT/${YEAR}/052`);
    }));

  test('each year counts on its own', () =>
    withDatabase(async (client) => {
      assert.equal(await claimNextId('quotation', client, '2025'), 'CTZ/QT/2025/001');
      assert.equal(await claimNextId('quotation', client, '2026'), 'CTZ/QT/2026/001');
      assert.equal(await claimNextId('quotation', client, '2025'), 'CTZ/QT/2025/002');
    }));

  test('each series counts on its own', () =>
    withDatabase(async (client) => {
      await client.query(`INSERT INTO projects (project_id, client_name) VALUES ('PRJ-${YEAR}-001', 'Acme')`);
      assert.equal(await claimNextId('quotation', client, YEAR), `CTZ/QT/${YEAR}/001`);
      assert.equal(await claimNextId('project', client, YEAR), `PRJ-${YEAR}-002`);
      assert.equal(await claimNextId('enquiry', client, YEAR), `CTZ/ENQ/${YEAR}/001`);
    }));

  test('the preview shows the next number without taking it', () =>
    withDatabase(async (client) => {
      assert.equal(await nextId('quotation', client, YEAR), `CTZ/QT/${YEAR}/001`);
      // Reading it twice must give the same answer, or the form would burn numbers.
      assert.equal(await nextId('quotation', client, YEAR), `CTZ/QT/${YEAR}/001`);
      assert.equal(await claimNextId('quotation', client, YEAR), `CTZ/QT/${YEAR}/001`);
      assert.equal(await nextId('quotation', client, YEAR), `CTZ/QT/${YEAR}/002`);
    }));
});

/**
 * Migration 014's backfill. The counter tests above build from schema.sql,
 * where the table starts empty — this runs the migration itself against rows
 * that already carry references, which is what production will do.
 */
describe('014 seeds the counters from references already issued', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  const MIGRATION = readFileSync(join(DB_DIR, 'migrations', '014_sequence_counters.sql'), 'utf8');

  const seedRows = async (client) => {
    await client.query(`DELETE FROM sequence_counters`);
    await client.query(`INSERT INTO quotations (quotation_no, client_name, quotation_date)
      VALUES ('CTZ/QT/2026/063','Acme','2026-05-01'), ('CTZ/QT/2025/007','Acme','2025-05-01')`);
    await client.query(`INSERT INTO projects (project_id, client_name) VALUES ('PRJ-2026-008','Acme')`);
    // The vendor's own number, not a reference this app issues. A loose match
    // would read "2627" out of it and seed a counter for a year that is not one.
    await client.query(`INSERT INTO travel_logs (travel_id, employee_name) VALUES ('TRV-2026-001','Someone')`);
    await client.query(`INSERT INTO travel_vendor_invoices (vendor_invoice_id, travel_id)
      VALUES ('HT/26-27/966', 'TRV-2026-001')`);
  };

  test('each series starts where it actually left off', () =>
    withDatabase(async (client) => {
      await seedRows(client);
      await client.query(MIGRATION);
      const { rows } = await client.query(
        'SELECT kind, year, last_n FROM sequence_counters ORDER BY kind, year');
      assert.deepEqual(rows, [
        { kind: 'project', year: '2026', last_n: 8 },
        { kind: 'quotation', year: '2025', last_n: 7 },
        { kind: 'quotation', year: '2026', last_n: 63 },
        { kind: 'travel', year: '2026', last_n: 1 },
      ]);
    }));

  test('a foreign reference number never becomes a counter', () =>
    withDatabase(async (client) => {
      await seedRows(client);
      await client.query(MIGRATION);
      const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM sequence_counters WHERE kind = 'vendor_invoice'`);
      assert.equal(rows[0].n, 0, "the vendor's own HT/26-27/966 is not our series");
    }));

  test('the next reference carries on from the seeded counter', () =>
    withDatabase(async (client) => {
      await seedRows(client);
      await client.query(MIGRATION);
      assert.equal(await claimNextId('quotation', client, '2026'), 'CTZ/QT/2026/064');
      assert.equal(await claimNextId('project', client, '2026'), 'PRJ-2026-009');
    }));
});
