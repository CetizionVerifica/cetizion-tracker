import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * Who may say which client invoice billed a trip (#214).
 *
 * `travel_logs.billed_stage_id` is the link between a trip's cost and the
 * client invoice that recovered it. It used to be an ordinary writable column
 * on the travel-log resource, and the only thing keeping it away from the
 * wrong hands was the Trip screen hiding the selector from HR. The API did
 * not: HR has full write access to a trip (#196 §3), so a PATCH naming the
 * field went straight through — as it did for every other signed-in caller,
 * with nothing recorded about who had done it.
 *
 * Two halves, and both are needed:
 *
 *   protectedFields   closes the generic form to the column, for everybody,
 *                     including an administrator and including the MCP
 *                     importer, which reaches crud.js without a route;
 *   the billing route POST /api/travel-logs/:travelId/billed-stage, open to
 *                     admin and sales and absent from HR_ROUTES, so hrGate
 *                     answers HR 403 before the handler runs.
 *
 * Every "cannot" below reads the stored row as well as the status code: a 403
 * with the column changed anyway would pass a test that only read the reply.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
const NAME = `trip_billed_stage_${process.pid}_${Date.now()}`;
const PASSWORD = 'a-good-long-test-password';

describe('which invoice billed a trip (#214)', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let db; let app; let admin; let sales; let hr;
  let stage; let otherStage; let poStage; let chargeable; let internal;

  before(async () => {
    const root = new pg.Client({ connectionString: ADMIN_URL });
    await root.connect();
    await root.query(`CREATE DATABASE ${NAME}`);
    await root.end();

    const url = new URL(ADMIN_URL); url.pathname = `/${NAME}`;
    db = new pg.Client({ connectionString: url.toString() });
    await db.connect();
    for (const f of ['schema.sql', 'views.sql']) await db.query(readFileSync(join(DB_DIR, f), 'utf8'));

    Object.assign(process.env, {
      NODE_ENV: 'test', DATABASE_URL: url.toString(), AUTH_MODE: 'database', EMAIL_MODE: 'log',
      SESSION_SECRET: 'test-secret-that-is-long-enough-to-pass',
    });
    ({ default: app } = await import('../src/app.js'));
    const { createUser } = await import('../src/lib/users.js');

    const signIn = async (email) => {
      const agent = request.agent(app);
      await agent.post('/api/auth/login').send({ email, password: PASSWORD }).expect(200);
      return agent;
    };
    for (const [role, email] of [['admin', 'ada@example.com'], ['sales', 'sam@example.com'], ['hr', 'hema@example.com']]) {
      await createUser({ name: email.split('@')[0], email, password: PASSWORD, role }, db);
    }
    admin = await signIn('ada@example.com');
    sales = await signIn('sam@example.com');
    hr = await signIn('hema@example.com');

    // A PO with its own split, two travel invoices on it, a chargeable trip
    // on it, and an internal trip on nothing — the trip the database's own
    // rule refuses to bill.
    //
    // The stages a trip is billed on are travel invoices since 097 (#214):
    // `billed_stage_id` may only name a `kind = 'travel'` stage, and an
    // ordinary share of the PO is refused. The split is kept here as
    // `poStage` because that refusal is now worth asserting.
    await db.query(`INSERT INTO projects (project_id, client_name) VALUES ('PRJ-BS-1', 'Billed Stage Ltd')`);
    await db.query(`INSERT INTO purchase_orders (po_number, project_id, po_value) VALUES ('PO-BS-1', 'PRJ-BS-1', 200000)`);
    ({ rows: [{ id: poStage }] } = await db.query(
      `INSERT INTO payment_stages (po_number, stage_no, stage_name, stage_percent, invoice_no)
            VALUES ('PO-BS-1', 1, 'Advance', 1.0, 'CVPL/BS/PO') RETURNING id`));
    ({ rows: [stage] } = await db.query(
      `INSERT INTO payment_stages (kind, po_number, stage_name, trigger_event, amount, invoice_no, invoice_date)
            VALUES ('travel', 'PO-BS-1', 'Travel invoice', 'Manual', 25000, 'CVPL/BS/1', CURRENT_DATE) RETURNING id`));
    ({ rows: [otherStage] } = await db.query(
      `INSERT INTO payment_stages (kind, po_number, stage_name, trigger_event, amount, invoice_no, invoice_date)
            VALUES ('travel', 'PO-BS-1', 'Travel invoice', 'Manual', 12000, 'CVPL/BS/2', CURRENT_DATE) RETURNING id`));

    chargeable = (await admin.post('/api/travel-logs')
      .send({ travel_id: 'TRV-BS-1', employee_name: 'Asha', po_number: 'PO-BS-1', travel_start_date: '2026-08-01' })
      .expect(201)).body.data;
    internal = (await admin.post('/api/travel-logs')
      .send({ travel_id: 'TRV-BS-2', employee_name: 'Ravi', travel_start_date: '2026-08-04' })
      .expect(201)).body.data;
    assert.equal(chargeable.chargeable, true);
    assert.equal(internal.chargeable, false);
  });

  after(async () => {
    const { pool } = await import('../src/db.js');
    await pool.end().catch(() => {});
    await db?.end().catch(() => {});
    const root = new pg.Client({ connectionString: ADMIN_URL });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`);
    await root.end();
  });

  /** What the table actually holds, which is the half worth checking. */
  const storedStage = async (travelId = 'TRV-BS-1') => (await db.query(
    'SELECT billed_stage_id FROM travel_logs WHERE travel_id = $1', [travelId]
  )).rows[0].billed_stage_id;

  const setStoredStage = (value, travelId = 'TRV-BS-1') => db.query(
    'UPDATE travel_logs SET billed_stage_id = $1 WHERE travel_id = $2', [value, travelId]
  );

  const auditRows = async () => (await db.query(
    `SELECT action, entity_type, entity_id, metadata FROM activity_log
      WHERE action = 'travel_log.billed_stage_set' ORDER BY id`
  )).rows;

  // ------------------------------------------- the generic form is closed

  describe('the generic travel-log form', () => {
    for (const [label, agent] of [['an administrator', () => admin], ['a sales user', () => sales], ['an HR user', () => hr]]) {
      test(`${label} cannot set billed_stage_id through PATCH`, async () => {
        await setStoredStage(null);

        const res = await agent().patch(`/api/travel-logs/${chargeable.id}`).send({ billed_stage_id: stage.id });

        assert.equal(res.status, 403, JSON.stringify(res.body));
        assert.match(res.body.error.message, /billed_stage_id/, 'the refusal should name the field');
        assert.equal(await storedStage(), null, 'the column moved despite the refusal');
      });

      test(`${label} cannot clear billed_stage_id through PATCH either`, async () => {
        await setStoredStage(stage.id);

        const res = await agent().patch(`/api/travel-logs/${chargeable.id}`).send({ billed_stage_id: null });

        assert.equal(res.status, 403, JSON.stringify(res.body));
        assert.equal(await storedStage(), stage.id, 'an explicit null is an attempt like any other');
      });
    }

    test('a new trip cannot be created already carrying one', async () => {
      const res = await admin.post('/api/travel-logs')
        .send({ travel_id: 'TRV-BS-NEW', employee_name: 'Nobody', po_number: 'PO-BS-1', billed_stage_id: stage.id });

      assert.equal(res.status, 403, JSON.stringify(res.body));
      const { rows } = await db.query(`SELECT 1 FROM travel_logs WHERE travel_id = 'TRV-BS-NEW'`);
      assert.equal(rows.length, 0, 'a refused row was written anyway');
    });

    test('the rest of a trip still edits normally, and billing is untouched', async () => {
      await setStoredStage(stage.id);

      const res = await admin.patch(`/api/travel-logs/${chargeable.id}`)
        .send({ destination: 'Hyderabad', remarks: 'Rescheduled' });

      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.destination, 'Hyderabad');
      assert.equal(res.body.data.remarks, 'Rescheduled');
      assert.equal(await storedStage(), stage.id, 'an ordinary edit moved the billing link');
    });

    test('HR can still do its own work on a trip', async () => {
      const res = await hr.patch(`/api/travel-logs/${chargeable.id}`).send({ purpose: 'Site survey' });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.purpose, 'Site survey');
    });
  });

  // ------------------------------------------------- the billing route

  describe('the billing route', () => {
    const path = (travelId = 'TRV-BS-1') => `/api/travel-logs/${travelId}/billed-stage`;

    test('nobody signed in is refused', async () => {
      await setStoredStage(null);
      const res = await request(app).post(path()).send({ billed_stage_id: stage.id });
      assert.equal(res.status, 401, JSON.stringify(res.body));
      assert.equal(await storedStage(), null);
    });

    test('HR is refused: the travel desk does not decide what the client was billed', async () => {
      await setStoredStage(null);
      const res = await hr.post(path()).send({ billed_stage_id: stage.id });
      assert.equal(res.status, 403, JSON.stringify(res.body));
      assert.equal(await storedStage(), null, 'HR set the billing link despite the 403');
    });

    test('an administrator sets it, and the change is recorded', async () => {
      await setStoredStage(null);
      const before = (await auditRows()).length;

      const res = await admin.post(path()).send({ billed_stage_id: stage.id });

      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.billed_stage_id, stage.id);
      assert.equal(res.body.data.billed_invoice_no, 'CVPL/BS/1', 'the reply carries the view row the screen re-reads');
      assert.equal(await storedStage(), stage.id);

      const audit = await auditRows();
      assert.equal(audit.length, before + 1, 'the change left no audit row');
      const last = audit.at(-1);
      assert.equal(last.entity_type, 'travel_log');
      assert.equal(last.entity_id, 'TRV-BS-1');
      assert.equal(last.metadata.billed_stage_id_before, null);
      assert.equal(last.metadata.billed_stage_id_after, stage.id);
      assert.equal(last.metadata.actor_name, 'ada');
    });

    test('a sales user sets it too, and may reassign it to another invoice', async () => {
      await setStoredStage(stage.id);

      const res = await sales.post(path()).send({ billed_stage_id: otherStage.id });

      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(await storedStage(), otherStage.id);
      assert.equal((await auditRows()).at(-1).metadata.billed_stage_id_before, stage.id);
    });

    test('null clears it', async () => {
      await setStoredStage(stage.id);

      const res = await admin.post(path()).send({ billed_stage_id: null });

      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.billed_stage_id, null);
      assert.equal(await storedStage(), null);
      assert.equal((await auditRows()).at(-1).metadata.billed_stage_id_after, null);
    });

    test('a trip that is not there is a 404', async () => {
      const res = await admin.post(path('TRV-NOT-A-TRIP')).send({ billed_stage_id: stage.id });
      assert.equal(res.status, 404, JSON.stringify(res.body));
    });

    test('a stage that is not there is refused, and nothing is written', async () => {
      await setStoredStage(null);
      const res = await admin.post(path()).send({ billed_stage_id: 987654 });
      // 404 since 097 (#214): the handler looks the stage up to check it is a
      // travel invoice, so a missing one is answered as missing rather than
      // reaching the foreign key and coming back as a conflict.
      assert.equal(res.status, 404, JSON.stringify(res.body));
      assert.equal(await storedStage(), null);
    });

    test('an ordinary share of the PO is not a billing target (097, #214)', async () => {
      await setStoredStage(null);
      const res = await admin.post(path()).send({ billed_stage_id: poStage });
      assert.equal(res.status, 422, JSON.stringify(res.body));
      assert.match(JSON.stringify(res.body), /not on an ordinary PO payment stage/);
      assert.equal(await storedStage(), null, 'and nothing was written');
    });

    test('a body that says nothing, or says nonsense, is a 422', async () => {
      await setStoredStage(null);
      for (const body of [{}, { billed_stage_id: 'CVPL/BS/1' }, { billed_stage_id: 0 }, { billed_stage_id: -1 }]) {
        const res = await admin.post(path()).send(body);
        assert.equal(res.status, 422, `${JSON.stringify(body)} answered ${res.status}: ${JSON.stringify(res.body)}`);
      }
      assert.equal(await storedStage(), null);
    });

    test('the database\'s own rule still stands: a non-chargeable trip cannot be billed', async () => {
      const res = await admin.post(path('TRV-BS-2')).send({ billed_stage_id: stage.id });

      assert.equal(res.status, 422, JSON.stringify(res.body));
      assert.equal(await storedStage('TRV-BS-2'), null);
    });
  });
});
