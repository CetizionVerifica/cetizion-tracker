import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';

/**
 * The staging scrub (#35): after it runs, no client or contact name, email
 * or phone from the source is left anywhere in the database, amounts are
 * unchanged, and nothing can reach the outside world. Needs
 * TEST_DATABASE_URL; skipped otherwise.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
const NAME = `staging_scrub_test_${process.pid}`;
let client;
let staffBefore;

describe('staging scrub', { skip: !ADMIN_URL && 'TEST_DATABASE_URL is not set' }, () => {
  before(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${NAME}`);
    await admin.end();
    const url = new URL(ADMIN_URL); url.pathname = `/${NAME}`;
    client = new pg.Client({ connectionString: url.toString() });
    await client.connect();
    for (const f of ['schema.sql', 'views.sql', 'seed.sql', 'demo.sql']) await client.query(readFileSync(join(DB_DIR, f), 'utf8'));
    // A staff account as production would hold one, so the scrub below has
    // something real to strip. Nothing else in the demo data creates users.
    ({ rows: [staffBefore] } = await client.query(
      `INSERT INTO users (name, email, password_hash, role, session_version, last_login_at)
       VALUES ('Ganga Sharma', 'gangaacsharma@cetizionverifica.com', '$2b$12$realhashfromproduction', 'admin', 3, now())
       RETURNING id, session_version`));
    await client.query(`
      INSERT INTO companies (name, gstin) VALUES ('Zephyrine Bottling Works', '27AAPFU0939F1ZV');
      INSERT INTO contacts (company_id, name, email, phone) SELECT id, 'Hemavathi Krishnaswamy', 'hema.k@zephyrine.example', '+91 98450 12345' FROM companies WHERE name = 'Zephyrine Bottling Works';
      INSERT INTO quotations (quotation_no, client_name, contact_person, quotation_value, status) VALUES ('QT-SCRUB', 'Zephyrine Bottling Works', 'Hemavathi Krishnaswamy', 123456, 'Submitted');
      INSERT INTO notes (entity, entity_id, body, author) VALUES ('quotation', 'QT-SCRUB', 'Hemavathi said Zephyrine will sign next week', 'admin');
      INSERT INTO email_log (to_email, subject, template, status, mode, body_text) VALUES ('hema.k@zephyrine.example', 'Quote', 'quotation', 'sent', 'live', 'Dear Hemavathi');
      INSERT INTO webhook_endpoints (name, url, events, secret) VALUES ('n8n', 'https://n8n.example/hook', '{quotation.won}', 'whsec_real');
      UPDATE companies SET portal_enabled = true;
    `);
  });

  after(async () => {
    await client?.end();
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`);
    await admin.end();
  });

  test('no real name, email or phone remains, and the money is untouched', async () => {
    const { rows: people } = await client.query(`
      SELECT name AS v FROM companies UNION SELECT name FROM contacts UNION SELECT email FROM contacts WHERE email IS NOT NULL
      UNION SELECT phone FROM contacts WHERE phone IS NOT NULL UNION SELECT client_name FROM quotations UNION SELECT contact_person FROM quotations WHERE contact_person IS NOT NULL
      UNION SELECT client_name FROM projects UNION SELECT gstin FROM companies WHERE gstin IS NOT NULL`);
    const originals = people.map((r) => r.v).filter((v) => v && v.length >= 5);
    assert.ok(originals.length > 20, `${originals.length} values to look for`);
    const money = (await client.query(`SELECT (SELECT sum(quotation_value) FROM quotations) AS q, (SELECT sum(po_value) FROM purchase_orders) AS p, (SELECT sum(amount_received) FROM payment_stages) AS s, (SELECT count(*) FROM companies) AS c, (SELECT count(*) FROM contacts) AS ct`)).rows[0];

    await client.query(readFileSync(join(DB_DIR, 'scrub.sql'), 'utf8'));

    const { rows: tables } = await client.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('schema_migrations', 'settings')`);
    const patterns = originals.map((v) => `%${v.replace(/[%_\\]/g, '\\$&')}%`);
    for (const { tablename } of tables) {
      const { rows: [hit] } = await client.query(`SELECT row_to_json(t)::text AS row FROM "${tablename}" t WHERE row_to_json(t)::text ILIKE ANY($1) LIMIT 1`, [patterns]);
      assert.equal(hit, undefined, `${tablename} still holds a real value (${originals.filter((o) => hit?.row.toLowerCase().includes(o.toLowerCase())).join(", ")}): ${hit?.row.slice(0, 120)}`);
    }
    const after = (await client.query(`SELECT (SELECT sum(quotation_value) FROM quotations) AS q, (SELECT sum(po_value) FROM purchase_orders) AS p, (SELECT sum(amount_received) FROM payment_stages) AS s, (SELECT count(*) FROM companies) AS c, (SELECT count(*) FROM contacts) AS ct`)).rows[0];
    assert.deepEqual(after, money);
  });

  test('names stay consistent, and nothing can reach the outside world', async () => {
    const { rows: [q] } = await client.query(`SELECT q.client_name, c.name FROM quotations q JOIN companies c ON c.id = q.company_id WHERE q.quotation_no = 'QT-SCRUB'`);
    assert.equal(q.client_name, q.name);
    assert.match(q.name, /^[A-Z][a-z]+ [A-Za-z ]+ (Pvt Ltd|Limited|Industries|India Pvt Ltd|Group)/);
    const { rows: [s] } = await client.query(`
      SELECT (SELECT count(*) FROM webhook_endpoints WHERE active)::int AS hooks,
             (SELECT count(*) FROM companies WHERE portal_enabled)::int AS portals,
             (SELECT value FROM settings WHERE key = 'emails_enabled') AS emails,
             (SELECT count(*) FROM contacts WHERE email NOT LIKE '%@example.test')::int AS real_emails,
             (SELECT count(*) FROM (SELECT name_key FROM companies GROUP BY name_key HAVING count(*) > 1) d)::int AS duplicate_keys`);
    assert.deepEqual(s, { hooks: 0, portals: 0, emails: 'false', real_emails: 0, duplicate_keys: 0 });
    // The views still build and answer on the scrubbed data.
    await client.query(readFileSync(join(DB_DIR, 'views.sql'), 'utf8'));
    await client.query('SELECT count(*) FROM v_quotations');
  });

  test('staff accounts keep their names and lose their credentials', async () => {
    // A hash is a credential: given one, the password can be attacked
    // offline at leisure. An address is a person. #35 asks for both to be
    // reset, and the scrub was not touching the table at all. The scrub ran
    // in the first test; this reads what it left.
    const before = staffBefore;
    const { rows: [after] } = await client.query('SELECT name, email, password_hash, active, session_version, last_login_at FROM users WHERE id = $1', [before.id]);
    assert.equal(after.email, null, 'the address is gone');
    assert.equal(after.password_hash, null, 'and so is the hash');
    assert.equal(after.last_login_at, null);
    assert.equal(after.active, false, 'an account that cannot sign in is not left marked active');
    assert.equal(after.name, 'Ganga Sharma', 'the name stays, so attribution on old records still reads');
    assert.ok(after.session_version > before.session_version, 'a cookie copied from production is dead too');

    // Nothing on staging can be signed in to with a production password.
    const { rows } = await client.query('SELECT COUNT(*)::int AS n FROM users WHERE password_hash IS NOT NULL OR email IS NOT NULL');
    assert.equal(rows[0].n, 0);
  });

  test('refuses a database named like production', async () => {
    const sql = readFileSync(join(DB_DIR, 'scrub.sql'), 'utf8').replace("current_database() ILIKE '%prod%'", 'true');
    await assert.rejects(client.query(sql), /looks like production/);
    await client.query('ROLLBACK').catch(() => {});
  });
});
