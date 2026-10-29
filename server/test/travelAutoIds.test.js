import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { describe } from 'node:test';
import pg from 'pg';

/**
 * A trip, an expense claim and a vendor invoice get their reference on
 * create (TRV-2026-001, CLM-2026-001, VINV-2026-001): nobody has to type
 * one. A reference typed in by hand (an old trip being entered late) is
 * kept as typed, and the series carries on above it.
 *
 * Needs a Postgres the runner may create databases on: set TEST_DATABASE_URL
 * (CI does). Without it the suite is skipped.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');

async function withDatabase(fn) {
  const name = `travel_ids_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
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

process.env.DATABASE_URL ??= ADMIN_URL ?? 'postgres://localhost/none';
const { insertRecord, validateRecord } = await import('../src/lib/crud.js');
const { resources } = await import('../src/lib/resources.js');

/** Creates a record the way the form and the MCP import do. */
async function create(client, name, body) {
  const def = resources[name];
  const { values, input } = validateRecord(def, body);
  return (await insertRecord(client, def, { values, input })).row;
}

describe('travel references are assigned on create', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  test('a trip saved without a Travel ID gets the next one, by its start year', () =>
    withDatabase(async (client) => {
      const first = await create(client, 'travel-logs', { employee_name: 'Asha', travel_start_date: '2026-03-04' });
      const second = await create(client, 'travel-logs', { employee_name: 'Ravi', travel_start_date: '2026-05-10' });
      assert.equal(first.travel_id, 'TRV-2026-001');
      assert.equal(second.travel_id, 'TRV-2026-002');

      const older = await create(client, 'travel-logs', { employee_name: 'Meera', travel_start_date: '2025-12-30' });
      assert.equal(older.travel_id, 'TRV-2025-001', 'the year comes from the trip, not today');
    }));

  test('a Travel ID typed in is kept, and the series carries on above it', () =>
    withDatabase(async (client) => {
      const typed = await create(client, 'travel-logs', { travel_id: 'TRV-2026-040', employee_name: 'Asha', travel_start_date: '2026-01-02' });
      assert.equal(typed.travel_id, 'TRV-2026-040');
      const next = await create(client, 'travel-logs', { employee_name: 'Ravi', travel_start_date: '2026-02-02' });
      assert.equal(next.travel_id, 'TRV-2026-041', 'must not hand out a number at or below one already used');
    }));

  test('an expense claim and a vendor invoice are numbered the same way', () =>
    withDatabase(async (client) => {
      const trip = await create(client, 'travel-logs', { employee_name: 'Asha', travel_start_date: '2026-03-04' });
      const claim = await create(client, 'expense-claims', { travel_id: trip.travel_id, submission_date: '2026-03-20' });
      assert.equal(claim.claim_id, 'CLM-2026-001');

      const invoice = await create(client, 'vendor-invoices', { vendor_invoice_no: 'HT/2627/001', invoice_date: '2026-04-02' });
      assert.equal(invoice.vendor_invoice_id, 'VINV-2026-001');
      assert.equal(invoice.vendor_invoice_no, 'HT/2627/001', 'the vendor\'s own number is untouched');
    }));
});
