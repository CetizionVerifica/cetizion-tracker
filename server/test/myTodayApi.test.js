import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * GET /api/dashboard/my-today (docs/my-today-plan.md) against a real
 * database: whose items each person sees, the admin's ?owner=, the sidebar
 * summary, the chase rule's reading of collection_log, and the clock.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const PASSWORD = 'a-good-long-test-password';
const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');

const DAY_MS = 86_400_000;
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

describe('GET /api/dashboard/my-today', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let dbUrl; let db; let app; let pool; let createUser; let myToday; let today;
  let admin; let sam; let bea;

  before(async () => {
    const root = new pg.Client({ connectionString: ADMIN_URL });
    await root.connect();
    const name = `mytoday_${process.pid}_${Date.now()}`;
    await root.query(`CREATE DATABASE ${name}`);
    await root.end();

    const u = new URL(ADMIN_URL);
    u.pathname = `/${name}`;
    dbUrl = u.toString();

    db = new pg.Client({ connectionString: dbUrl });
    await db.connect();
    await db.query(readFileSync(join(DB_DIR, 'schema.sql'), 'utf8'));
    await db.query(readFileSync(join(DB_DIR, 'views.sql'), 'utf8'));

    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = dbUrl;
    process.env.AUTH_MODE = 'database';
    process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-to-pass';
    process.env.EMAIL_MODE = 'log';

    ({ default: app } = await import('../src/app.js'));
    ({ pool } = await import('../src/db.js'));
    ({ createUser } = await import('../src/lib/users.js'));
    ({ myToday } = await import('../src/lib/myToday.js'));
    const { businessToday } = await import('../src/lib/businessDate.ts');
    today = businessToday();

    const mk = (over) => createUser({ password: PASSWORD, ...over }, db);
    admin = { user: await mk({ name: 'Alice Admin', email: 'alice@example.com', role: 'admin' }) };
    // Capitalised and spaced on purpose: a fixture that stores the name
    // exactly as the account has it is the one spelling where a
    // case-sensitive comparison looks right (docs/my-today-plan.md, Risks).
    sam = { user: await mk({ name: 'Sam Sharma', email: 'Sam@Example.com', role: 'sales' }) };
    bea = { user: await mk({ name: 'Bea', email: 'bea@example.com', role: 'sales' }) };
    for (const p of [admin, sam, bea]) p.cookie = await signIn(p.user.email);
    await seed();
  });

  after(async () => {
    await pool?.end();
    await db?.end();
    const root = new pg.Client({ connectionString: ADMIN_URL });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${new URL(dbUrl).pathname.slice(1)} WITH (FORCE)`);
    await root.end();
  });

  async function signIn(email) {
    const res = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.headers['set-cookie'];
  }

  const get = (who, path = '') => request(app).get(`/api/dashboard/my-today${path}`).set('Cookie', who.cookie);
  const titles = (body) => [...body.data.late, ...body.data.due_today].map((i) => i.title).sort();

  /**
   * Sam's and Bea's records, side by side, each with one of every kind.
   */
  async function seed() {
    const q = (sql, params) => db.query(sql, params);
    for (const [who, tag] of [[sam, 'S'], [bea, 'B']]) {
      const id = who.user.id;
      await q(`INSERT INTO enquiries (enquiry_no, client_name, owner_user_id, status, next_follow_up_at, source, service, estimated_value)
               VALUES ($1, $2, $3, 'Contacted', $4, 'Referral', 'Audit', 50000)`, [`ENQ-${tag}`, `Client ${tag}`, id, today]);
      // A closed enquiry's follow-up date is not work.
      await q(`INSERT INTO enquiries (enquiry_no, client_name, owner_user_id, status, next_follow_up_at)
               VALUES ($1, $2, $3, 'Unqualified', $4)`, [`ENQ-${tag}-closed`, `Client ${tag}`, id, today]);
      await q(`INSERT INTO quotations (quotation_no, client_name, quotation_date, quotation_value, currency, status, owner_user_id)
               VALUES ($1, $2, $3, 1000, 'INR', 'Won - PO Received', $4)`, [`QT-${tag}`, `Client ${tag}`, today, id]);
      await q(`INSERT INTO projects (project_id, client_name, owner_user_id) VALUES ($1, $2, $3)`, [`PRJ-${tag}`, `Client ${tag}`, id]);
      // One ready to raise since today, and one invoiced 18 days ago on
      // 10-day terms: 8 days past due today, so first on the list today.
      await q(`INSERT INTO purchase_orders (po_number, project_id, quotation_no, po_value, payment_terms_days, po_date)
               VALUES ($1, $2, $3, 100000, 10, $4)`, [`PO-${tag}`, `PRJ-${tag}`, `QT-${tag}`, today]);
      await q(`INSERT INTO payment_stages (po_number, stage_no, stage_name, stage_percent) VALUES ($1, 1, 'Advance', 0.5)`, [`PO-${tag}`]);
      await q(`INSERT INTO payment_stages (po_number, stage_no, stage_name, stage_percent, invoice_no, invoice_date)
               VALUES ($1, 2, 'Balance', 0.5, $2, $3)`, [`PO-${tag}`, `INV-${tag}`, addDays(today, -18)]);
      // Unassigned, on their own quotation.
      await q(`INSERT INTO tasks (entity, entity_id, title, due_at) VALUES ('quotation', $1, $2, $3)`, [`QT-${tag}`, `Unassigned on QT-${tag}`, today]);
    }
    // Assigned to Sam by name, typed differently from the account, on Sam's record.
    await q(`INSERT INTO tasks (entity, entity_id, title, due_at, assignee) VALUES ('project', 'PRJ-S', 'Call back Ravi', $1, '  sam sharma ')`, [today]);
    // Assigned to Sam by email (what communications.js writes), on Sam's record.
    await q(`INSERT INTO tasks (entity, entity_id, title, due_at, assignee) VALUES ('enquiry', 'ENQ-S', 'Send scope', $1, 'sam@example.COM')`, [addDays(today, -40)]);
    // Assigned to Sam, but on Bea's deal: an assignment is not a door into it.
    await q(`INSERT INTO tasks (entity, entity_id, title, due_at, assignee) VALUES ('quotation', 'QT-B', 'Help Bea', $1, 'Sam Sharma')`, [today]);
    // Unassigned on a company: shared master data is nobody's record.
    const { rows: [co] } = await q(`INSERT INTO companies (name, name_key) VALUES ('Shared Co', 'shared co') RETURNING id`);
    await q(`INSERT INTO tasks (entity, entity_id, title, due_at) VALUES ('company', $1, 'Unassigned on a company', $2)`, [String(co.id), today]);
    // Done, and not due yet: neither is on anybody's list.
    await q(`INSERT INTO tasks (entity, entity_id, title, due_at, assignee, status) VALUES ('project', 'PRJ-S', 'Already done', $1, 'Sam Sharma', 'done')`, [today]);
    await q(`INSERT INTO tasks (entity, entity_id, title, due_at, assignee) VALUES ('project', 'PRJ-S', 'Next week', $1, 'Sam Sharma')`, [addDays(today, 7)]);
  }

  test('a sales user sees their own items of every kind, and never anyone else\'s', async () => {
    const res = await get(sam);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.person.name, 'Sam Sharma');
    assert.deepEqual(titles(res.body), [
      'Call back Ravi',
      'Chase INV-S — Balance',
      'Follow up Client S',
      'Raise Advance invoice — PRJ-S',
      'Unassigned on QT-S',
    ]);
    const text = JSON.stringify(res.body);
    for (const leak of ['Client B', 'QT-B', 'PRJ-B', 'INV-B', 'Help Bea', 'Unassigned on a company']) {
      assert.ok(!text.includes(leak), `Sam's day mentions ${leak}`);
    }
    assert.deepEqual(res.body.data.owners, [], 'a sales user gets no staff directory');
  });

  test('more than 30 days late is folded, and listed with ?all=1', async () => {
    const folded = (await get(sam)).body.data;
    assert.equal(folded.older.count, 1);
    assert.equal(folded.older.by_kind.task, 1);
    assert.equal(folded.counts.late, 1);
    const all = (await get(sam, '?all=1')).body.data;
    assert.ok(all.late.some((i) => i.title === 'Send scope'));
    assert.equal(all.older, null);
  });

  test('an unassigned task shows only to the owner of its record', async () => {
    const b = titles((await get(bea)).body);
    assert.ok(b.includes('Unassigned on QT-B'));
    assert.ok(!b.includes('Unassigned on QT-S'));
    assert.ok(!b.includes('Help Bea'), 'assigned to Sam, so not Bea\'s');
  });

  test('a sales user\'s ?owner= is ignored', async () => {
    const res = await get(sam, `?owner=${bea.user.id}`);
    assert.equal(res.body.data.person.id, sam.user.id);
    assert.ok(!JSON.stringify(res.body).includes('Client B'));
  });

  test('an admin sees their own day by default, and a sales person\'s with ?owner=', async () => {
    const own = (await get(admin)).body.data;
    assert.equal(own.person.id, admin.user.id);
    assert.deepEqual(own.counts, { late: 0, due_today: 0 });
    assert.deepEqual(own.owners.map((o) => o.name), ['Alice Admin', 'Bea', 'Sam Sharma']);

    const theirs = await get(admin, `?owner=${sam.user.id}`);
    assert.equal(theirs.body.data.person.id, sam.user.id);
    assert.deepEqual(titles(theirs.body), titles((await get(sam)).body), 'the same day Sam sees');
    assert.equal((await get(admin, '?owner=999999')).status, 404);
  });

  test('?summary=1 agrees with the full list\'s counts', async () => {
    for (const who of [sam, bea, admin]) {
      const full = (await get(who)).body.data;
      const summary = await get(who, '?summary=1');
      assert.equal(summary.status, 200);
      assert.deepEqual(summary.body.data.counts, full.counts);
      assert.equal(summary.body.data.late, undefined, 'the badge gets counts only');
    }
    assert.deepEqual((await get(sam, '?summary=1')).body.data.counts, { late: 1, due_today: 5 });
  });

  test('an automatic reminder is not a chase; one a person logs is', async () => {
    const { rows: [stage] } = await db.query(`SELECT id FROM payment_stages WHERE invoice_no = 'INV-S'`);
    const chaseOn = () => get(sam).then((r) => r.body.data.due_today.some((i) => i.kind === 'payment'));
    assert.equal(await chaseOn(), true, 'no chase yet: on the list');

    await db.query(`INSERT INTO collection_log (stage_id, channel, summary, automated) VALUES ($1, 'email', 'Reminder level 2 emailed to a@b.c', true)`, [stage.id]);
    assert.equal(await chaseOn(), true, 'an automatic email does not clear it');

    const logged = await request(app).post('/api/collections/log').set('Cookie', sam.cookie)
      .send({ stage_id: stage.id, channel: 'call', summary: 'Spoke to accounts' });
    assert.equal(logged.status, 201, JSON.stringify(logged.body));
    assert.equal(await chaseOn(), false, 'a call logged by a person clears it for a week');

    await db.query('DELETE FROM collection_log');
  });

  test('ticking a task done takes it off the list', async () => {
    const before = (await get(sam)).body.data;
    const row = before.due_today.find((i) => i.title === 'Call back Ravi');
    const done = await request(app).patch(`/api/tasks/${row.entity_id}`).set('Cookie', sam.cookie).send({ status: 'done' });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    const afterwards = (await get(sam)).body.data;
    assert.ok(!afterwards.due_today.some((i) => i.title === 'Call back Ravi'));
    assert.equal(afterwards.counts.due_today, before.counts.due_today - 1);
    await db.query(`UPDATE tasks SET status = 'todo', completed_at = NULL WHERE id = $1`, [Number(row.entity_id)]);
  });

  test('at 00:30 India time, "today" is the India date, not the database\'s', async () => {
    // 19:00 UTC on the 28th is 00:30 IST on the 29th. The database's own
    // CURRENT_DATE is whatever the test machine's is; the list must not read it.
    const { rows: [person] } = await db.query('SELECT id, name, email, role FROM users WHERE id = $1', [bea.user.id]);
    await db.query(`INSERT INTO enquiries (enquiry_no, client_name, owner_user_id, status, next_follow_up_at)
                    VALUES ('ENQ-CLOCK', 'Clockwork', $1, 'New', '2026-09-29')`, [bea.user.id]);
    const day = await myToday({ query: (t, p) => pool.query(t, p) }, person, { now: new Date('2026-09-28T19:00:00Z') });
    assert.equal(day.today, '2026-09-29');
    const clock = day.due_today.find((i) => i.entity_id === 'ENQ-CLOCK');
    assert.ok(clock, 'due on the India date, so due today');
    assert.equal(clock.working_days_late, 0);
    await db.query(`DELETE FROM enquiries WHERE enquiry_no = 'ENQ-CLOCK'`);
  });
});
