import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';

/**
 * The invoice that bills a trip to the client (#214 §5.1, migration 097).
 *
 * Travel is billed with its own invoice on the project or the PO, so a
 * travel invoice is a *kind* of payment stage rather than a table of its
 * own. Three things are held in place here.
 *
 * **Nothing already in the table moves.** `kind` defaults to 'po_stage'
 * and three NOT NULLs become one rule per kind that says exactly what they
 * said. The upgrade suite below seeds a pre-097 database with ordinary
 * stages, receipts against them and a trip billed on one, runs the
 * migration, and proves every figure and every link survives.
 *
 * **A travel invoice's amount is its own.** ₹37,500 against a ₹10,00,000
 * PO is ₹37,500, and the PO's 50/50 split is still 100% of the PO.
 *
 * **The PO's split stays the PO's.** Travel invoices are counted beside
 * `stages_percent_total`, `balance_to_bill` and `stage_count`, never
 * inside them, because each of those answers a question about the order.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');

/** The schema as it stood before 097, so the migration has work to do. */
function schemaBefore() {
  const full = readFileSync(join(DB_DIR, 'schema.sql'), 'utf8');
  const marker = '-- The invoice that bills a trip to the client, as a kind of payment\n-- stage (097, #214 §5.1).';
  const at = full.indexOf(marker);
  assert.ok(at > 0, 'the 097 section should be marked in schema.sql');
  return full.slice(0, full.lastIndexOf('-- ---------------------------------------------------------------------', at));
}

const read = (f) => readFileSync(join(DB_DIR, f), 'utf8');

describe('travel invoices (#214)', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  // ------------------------------------------------- upgrading a live database

  describe('097 leaves everything already in the table exactly as it was', () => {
    const NAME = `ti_up_${process.pid}_${Date.now()}`;
    let db;

    before(async () => {
      const root = new pg.Client({ connectionString: ADMIN_URL });
      await root.connect();
      await root.query(`CREATE DATABASE ${NAME}`);
      await root.end();
      const url = new URL(ADMIN_URL); url.pathname = `/${NAME}`;
      db = new pg.Client({ connectionString: url.toString() });
      await db.connect();

      // Pre-097 schema, then a realistic PO with a 50/50 split, a receipt
      // on the first half, and a chargeable trip billed on it — the
      // "legacy billed stage" shape 097 must preserve rather than tidy.
      await db.query(schemaBefore());
      await db.query(`INSERT INTO companies (name) VALUES ('Upgrade Co')`);
      await db.query(`INSERT INTO projects (project_id, client_name, primary_service)
                           VALUES ('UP-PRJ', 'Upgrade Co', 'Testing')`);
      await db.query(`INSERT INTO purchase_orders (po_number, project_id, po_value, po_date, payment_terms_days)
                           VALUES ('UP-PO', 'UP-PRJ', 1000000, CURRENT_DATE - 60, 30)`);
      await db.query(`INSERT INTO payment_stages (po_number, stage_no, stage_name, trigger_event, stage_percent, invoice_no, invoice_date, amount_received)
                           VALUES ('UP-PO', 1, 'Advance (50%)', 'On PO Registration', 0.5, 'UP/INV/1', CURRENT_DATE - 50, 300000),
                                  ('UP-PO', 2, 'On delivery (50%)', 'On Delivery', 0.5, NULL, NULL, 0)`);
      await db.query(`INSERT INTO travel_logs (travel_id, employee_name, po_number)
                           VALUES ('UP-TRV-1', 'Asha', 'UP-PO')`);
      await db.query(`UPDATE travel_logs SET billed_stage_id =
                        (SELECT id FROM payment_stages WHERE po_number = 'UP-PO' AND stage_no = 1)
                      WHERE travel_id = 'UP-TRV-1'`);
    });

    after(async () => {
      await db?.end().catch(() => {});
      const root = new pg.Client({ connectionString: ADMIN_URL });
      await root.connect();
      await root.query(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`);
      await root.end();
    });

    test('the migration runs and every stage becomes an ordinary PO stage', async () => {
      const before = (await db.query(
        `SELECT stage_no, stage_percent, invoice_no, amount_received FROM payment_stages ORDER BY stage_no`)).rows;
      await db.query(read('migrations/097_travel_invoices.sql'));
      // And anything after it, for the same reason the vendor-payment suite
      // does: views.sql is always current, so the table has to be too.
      for (const file of readdirSync(join(DB_DIR, 'migrations')).filter((f) => f.endsWith('.sql') && f > '097_travel_invoices.sql').sort()) {
        await db.query(read(`migrations/${file}`));
      }
      await db.query(read('views.sql'));

      const after = (await db.query(
        `SELECT kind, stage_no, stage_percent, invoice_no, amount_received, amount, project_id
           FROM payment_stages ORDER BY stage_no`)).rows;
      assert.equal(after.length, 2);
      for (const [i, row] of after.entries()) {
        assert.equal(row.kind, 'po_stage', 'what was there is a PO stage');
        assert.equal(row.amount, null, 'and has no explicit amount');
        assert.equal(row.project_id, null, 'its project is the PO\'s, not its own');
        assert.equal(Number(row.stage_percent), Number(before[i].stage_percent));
        assert.equal(row.invoice_no, before[i].invoice_no);
        assert.equal(Number(row.amount_received), Number(before[i].amount_received));
      }
    });

    test('a trip billed on an ordinary stage before 097 keeps its link', async () => {
      const { rows: [trip] } = await db.query(
        `SELECT t.billed_stage_id, s.kind FROM travel_logs t JOIN payment_stages s ON s.id = t.billed_stage_id
          WHERE t.travel_id = 'UP-TRV-1'`);
      assert.ok(trip.billed_stage_id, 'the legacy link is still there');
      assert.equal(trip.kind, 'po_stage', 'pointing at the ordinary stage it always did');
    });

    test('and that trip can still be edited, legacy link and all', async () => {
      // The new rule is checked only when the link is set or changed, so a
      // migration that preserved the row must not have made it uneditable.
      await db.query(`UPDATE travel_logs SET employee_name = 'Asha P' WHERE travel_id = 'UP-TRV-1'`);
      const { rows: [t] } = await db.query(`SELECT employee_name, billed_stage_id FROM travel_logs WHERE travel_id = 'UP-TRV-1'`);
      assert.equal(t.employee_name, 'Asha P');
      assert.ok(t.billed_stage_id);
    });

    test('the PO reads exactly as it did: 100% split, nothing new counted', async () => {
      const { rows: [po] } = await db.query(
        `SELECT stage_count, stages_percent_total, total_invoiced, total_received, balance_to_bill,
                travel_invoice_count, travel_invoiced
           FROM v_purchase_orders WHERE po_number = 'UP-PO'`);
      assert.equal(Number(po.stage_count), 2);
      assert.equal(Number(po.stages_percent_total), 1);
      assert.equal(Number(po.total_received), 300000);
      assert.equal(Number(po.travel_invoice_count), 0, 'no travel invoice yet');
      assert.equal(Number(po.travel_invoiced), 0);
    });

    test('an existing stage still prices off the PO value', async () => {
      const { rows: [s] } = await db.query(
        `SELECT stage_amount, stage_status FROM v_payment_stages WHERE po_number = 'UP-PO' AND stage_no = 1`);
      assert.equal(Number(s.stage_amount), 500000, '50% of 1,000,000');
      // Invoiced 50 days ago on 30-day terms and only part paid, so the
      // view's own precedence puts Overdue ahead of Partially Paid. 097 did
      // not touch that ladder, which is the point of asserting it.
      assert.equal(s.stage_status, 'Overdue');
    });
  });

  // ------------------------------------------------------- the travel invoice

  describe('a travel invoice on a fresh database', () => {
    const NAME = `ti_new_${process.pid}_${Date.now()}`;
    let db;

    before(async () => {
      const root = new pg.Client({ connectionString: ADMIN_URL });
      await root.connect();
      await root.query(`CREATE DATABASE ${NAME}`);
      await root.end();
      const url = new URL(ADMIN_URL); url.pathname = `/${NAME}`;
      db = new pg.Client({ connectionString: url.toString() });
      await db.connect();
      for (const f of ['schema.sql', 'views.sql']) await db.query(read(f));

      await db.query(`INSERT INTO companies (name) VALUES ('Honor Labs'), ('Other Co')`);
      await db.query(`INSERT INTO projects (project_id, client_name, primary_service)
                           VALUES ('TI-PRJ', 'Honor Labs', 'Testing'),
                                  ('TI-PRJ-ONLY', 'Honor Labs', 'Testing'),
                                  ('TI-OTHER', 'Other Co', 'Testing')`);
      await db.query(`INSERT INTO purchase_orders (po_number, project_id, po_value, po_date, payment_terms_days)
                           VALUES ('TI-PO', 'TI-PRJ', 1000000, CURRENT_DATE - 60, 30),
                                  ('TI-OTHER-PO', 'TI-OTHER', 500000, CURRENT_DATE - 60, 30)`);
      await db.query(`INSERT INTO payment_stages (po_number, stage_no, stage_name, trigger_event, stage_percent)
                           VALUES ('TI-PO', 1, 'Advance (50%)', 'On PO Registration', 0.5),
                                  ('TI-PO', 2, 'On delivery (50%)', 'On Delivery', 0.5)`);
    });

    after(async () => {
      await db?.end().catch(() => {});
      const root = new pg.Client({ connectionString: ADMIN_URL });
      await root.connect();
      await root.query(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`);
      await root.end();
    });

    const travel = (over = {}) => {
      const v = {
        project_id: 'TI-PRJ', po_number: null, invoice_no: 'TI/INV/X',
        invoice_date: 'CURRENT_DATE', amount: 37500, credit_days: 30, ...over,
      };
      return db.query(
        `INSERT INTO payment_stages (kind, project_id, po_number, stage_name, trigger_event, amount, invoice_no, invoice_date, credit_days)
         VALUES ('travel', $1, $2, 'Travel invoice', 'Manual', $3, $4, ${v.invoice_date}, $5) RETURNING id`,
        [v.project_id, v.po_number, v.amount, v.invoice_no, v.credit_days]
      );
    };

    test('a travel invoice on a project with no PO is allowed', async () => {
      const { rows: [s] } = await travel({ project_id: 'TI-PRJ-ONLY', invoice_no: 'TI/INV/PRJ' });
      const { rows: [v] } = await db.query('SELECT * FROM v_payment_stages WHERE id = $1', [s.id]);
      assert.equal(v.kind, 'travel');
      assert.equal(v.po_number, null, 'no PO at all');
      assert.equal(v.project_id, 'TI-PRJ-ONLY', 'the project it was raised on');
      assert.equal(v.client_name, 'Honor Labs', 'and its client is still resolved');
      assert.equal(Number(v.stage_amount), 37500, 'its own printed total');
      assert.equal(v.stage_percent, null);
      assert.equal(v.stage_no, null, 'it takes no place in any PO split');
    });

    test('a travel invoice on a PO takes the PO\'s project without being told', async () => {
      const { rows: [s] } = await travel({ po_number: 'TI-PO', project_id: 'TI-PRJ', invoice_no: 'TI/INV/PO' });
      const { rows: [row] } = await db.query('SELECT project_id FROM payment_stages WHERE id = $1', [s.id]);
      assert.equal(row.project_id, 'TI-PRJ');
    });

    test('the amount is never derived from the PO value', async () => {
      const { rows: [v] } = await db.query(
        `SELECT stage_amount FROM v_payment_stages WHERE invoice_no = 'TI/INV/PO'`);
      assert.equal(Number(v.stage_amount), 37500,
        'a 37,500 travel invoice on a 1,000,000 PO is 37,500, not a percentage of it');
    });

    test('the PO\'s own split is still 100% of the PO, and its stage count is 2', async () => {
      const { rows: [po] } = await db.query(
        `SELECT stage_count, stages_percent_total, balance_to_bill, travel_invoice_count, travel_invoiced, travel_received
           FROM v_purchase_orders WHERE po_number = 'TI-PO'`);
      assert.equal(Number(po.stage_count), 2, 'the travel invoice is not one of the PO\'s stages');
      assert.equal(Number(po.stages_percent_total), 1, 'and it did not push the split past 100%');
      assert.equal(Number(po.travel_invoice_count), 1, 'it is reported beside the split');
      assert.equal(Number(po.travel_invoiced), 37500);
      assert.equal(Number(po.travel_received), 0);
    });

    test('the project reports its travel invoices beside its stage counts', async () => {
      // v_projects exposes the counts it needs and uses stage_count only
      // inside its own status CASE, so what is asserted here is the pair of
      // travel columns the lateral adds and the fact that the ordinary
      // counts did not move.
      const { rows: [p] } = await db.query(
        `SELECT overdue_stages, stages_to_invoice, travel_invoice_count, travel_invoiced, travel_overdue
           FROM v_projects WHERE project_id = 'TI-PRJ'`);
      assert.equal(Number(p.travel_invoice_count), 1);
      assert.equal(Number(p.travel_invoiced), 37500);
      // The advance half is triggered by PO registration and has no
      // invoice yet; the delivery half is not due until there is a delivery.
      assert.equal(Number(p.stages_to_invoice), 1, 'the PO split\'s own count is untouched');
    });

    test('a travel invoice does not make a project look as though its split were set', async () => {
      // stage_count feeds "No stages" on v_projects. A project whose only
      // payment stage is a travel invoice has no split at all, and the
      // lateral has to keep saying so.
      const { rows: [p] } = await db.query(
        `SELECT travel_invoice_count, overdue_stages, stages_to_invoice FROM v_projects WHERE project_id = 'TI-PRJ-ONLY'`);
      assert.equal(Number(p.travel_invoice_count), 1, 'the travel invoice is counted as travel');
      assert.equal(Number(p.stages_to_invoice), 0, 'and not as a stage waiting to be invoiced');
      const { rows: [n] } = await db.query(
        `SELECT count(*)::int AS c FROM v_payment_stages WHERE project_id = 'TI-PRJ-ONLY' AND kind = 'po_stage'`);
      assert.equal(n.c, 0, 'there is no split on this project');
    });

    // ------------------------------------------------------- what is refused

    test('the shape constraint refuses every malformed stage', async () => {
      const refusals = [
        ['a kind that is not a kind',
          `INSERT INTO payment_stages (kind, po_number, stage_no, stage_name, stage_percent) VALUES ('invoice','TI-PO',9,'x',0.1)`],
        ['a travel invoice with no amount',
          `INSERT INTO payment_stages (kind, project_id, stage_name, trigger_event) VALUES ('travel','TI-PRJ','x','Manual')`],
        ['a travel invoice with a zero amount',
          `INSERT INTO payment_stages (kind, project_id, stage_name, trigger_event, amount) VALUES ('travel','TI-PRJ','x','Manual',0)`],
        ['a travel invoice on neither a PO nor a project',
          `INSERT INTO payment_stages (kind, stage_name, trigger_event, amount) VALUES ('travel','x','Manual',1)`],
        ['a travel invoice carrying a stage_percent',
          `INSERT INTO payment_stages (kind, project_id, stage_name, trigger_event, amount, stage_percent) VALUES ('travel','TI-PRJ','x','Manual',1,0.5)`],
        ['a travel invoice taking a stage number',
          `INSERT INTO payment_stages (kind, project_id, stage_name, trigger_event, amount, stage_no) VALUES ('travel','TI-PRJ','x','Manual',1,3)`],
        ['a travel invoice waiting on a delivery',
          `INSERT INTO payment_stages (kind, project_id, stage_name, trigger_event, amount) VALUES ('travel','TI-PRJ','x','On Delivery',1)`],
        ['a PO stage with no PO',
          `INSERT INTO payment_stages (kind, stage_no, stage_name, stage_percent) VALUES ('po_stage',9,'x',0.1)`],
        ['a PO stage with no percentage',
          `INSERT INTO payment_stages (kind, po_number, stage_no, stage_name) VALUES ('po_stage','TI-PO',9,'x')`],
        ['a PO stage carrying an explicit amount',
          `INSERT INTO payment_stages (kind, po_number, stage_no, stage_name, stage_percent, amount) VALUES ('po_stage','TI-PO',9,'x',0.1,5000)`],
        ['a PO stage carrying its own project',
          `INSERT INTO payment_stages (kind, po_number, project_id, stage_no, stage_name, stage_percent) VALUES ('po_stage','TI-PO','TI-PRJ',9,'x',0.1)`],
      ];
      for (const [why, sql] of refusals) {
        await assert.rejects(() => db.query(sql), (err) => /check|violat/i.test(err.message), why);
      }
    });

    test('a travel invoice naming a project its PO does not belong to is refused', async () => {
      await assert.rejects(
        () => travel({ po_number: 'TI-PO', project_id: 'TI-OTHER', invoice_no: 'TI/INV/BAD' }),
        (err) => /belongs to project/.test(err.message)
      );
    });

    test('the one GST invoice series covers both kinds', async () => {
      await assert.rejects(
        () => travel({ project_id: 'TI-PRJ-ONLY', invoice_no: 'TI/INV/PO' }),
        (err) => /payment_stages_invoice_no_key|already/i.test(err.message),
        'a travel invoice cannot reuse a number an ordinary stage has'
      );
    });

    test('two PO stages still cannot share a stage number, and travel never collides', async () => {
      await assert.rejects(
        () => db.query(`INSERT INTO payment_stages (po_number, stage_no, stage_name, stage_percent) VALUES ('TI-PO', 1, 'dup', 0.1)`),
        (err) => /payment_stages_po_stage_no_key|duplicate/i.test(err.message)
      );
      // Any number of travel invoices on the same PO: no stage_no to clash.
      await travel({ po_number: 'TI-PO', project_id: 'TI-PRJ', invoice_no: 'TI/INV/PO/2' });
      await travel({ po_number: 'TI-PO', project_id: 'TI-PRJ', invoice_no: 'TI/INV/PO/3' });
      const { rows: [n] } = await db.query(
        `SELECT count(*)::int AS c FROM payment_stages WHERE po_number = 'TI-PO' AND kind = 'travel'`);
      assert.equal(n.c, 3);
    });

    // ------------------------------------------------- receipts and statuses

    test('a receipt against a travel invoice moves it through the one status model', async () => {
      const { rows: [s] } = await travel({ project_id: 'TI-PRJ-ONLY', invoice_no: 'TI/INV/RCPT', amount: 50000 });
      const status = async () => (await db.query('SELECT stage_status, amount_received FROM v_payment_stages WHERE id = $1', [s.id])).rows[0];
      assert.equal((await status()).stage_status, 'Due', 'raised, within terms');

      await db.query(`INSERT INTO payments (stage_id, amount, received_on, mode) VALUES ($1, 20000, CURRENT_DATE, 'bank_transfer')`, [s.id]);
      let st = await status();
      assert.equal(Number(st.amount_received), 20000, 'the payments trigger keeps the cache, as it does for any stage');
      assert.equal(st.stage_status, 'Partially Paid');

      await db.query(`INSERT INTO payments (stage_id, amount, received_on, mode) VALUES ($1, 30000, CURRENT_DATE, 'bank_transfer')`, [s.id]);
      st = await status();
      assert.equal(Number(st.amount_received), 50000);
      assert.equal(st.stage_status, 'Paid', 'paid against its own amount, not a share of a PO');
    });

    test('an overdue travel invoice reads Overdue and counts its days', async () => {
      const { rows: [s] } = await db.query(
        `INSERT INTO payment_stages (kind, project_id, stage_name, trigger_event, amount, invoice_no, invoice_date, credit_days)
         VALUES ('travel','TI-PRJ-ONLY','Travel invoice','Manual', 10000, 'TI/INV/LATE', CURRENT_DATE - 45, 30) RETURNING id`);
      const { rows: [v] } = await db.query('SELECT stage_status, days_overdue FROM v_payment_stages WHERE id = $1', [s.id]);
      assert.equal(v.stage_status, 'Overdue');
      assert.equal(v.days_overdue, 15);
    });

    test('a project-only travel invoice with no credit days still gets a due date', async () => {
      const { rows: [s] } = await db.query(
        `INSERT INTO payment_stages (kind, project_id, stage_name, trigger_event, amount, invoice_no, invoice_date)
         VALUES ('travel','TI-PRJ-ONLY','Travel invoice','Manual', 10000, 'TI/INV/NOTERMS', CURRENT_DATE - 60) RETURNING id`);
      const { rows: [v] } = await db.query('SELECT terms_days, stage_status FROM v_payment_stages WHERE id = $1', [s.id]);
      assert.equal(Number(v.terms_days), 30, 'the same default a new PO takes');
      assert.equal(v.stage_status, 'Overdue', 'so it can actually become overdue');
    });

    // --------------------------------------------------- which invoice bills

    test('a trip is billed on a travel invoice of its own project', async () => {
      await db.query(`INSERT INTO travel_logs (travel_id, employee_name, project_id) VALUES ('TI-TRV-PRJ', 'Asha', 'TI-PRJ-ONLY')`);
      const { rows: [inv] } = await db.query(`SELECT id FROM payment_stages WHERE invoice_no = 'TI/INV/PRJ'`);
      await db.query(`UPDATE travel_logs SET billed_stage_id = $1 WHERE travel_id = 'TI-TRV-PRJ'`, [inv.id]);
      const { rows: [t] } = await db.query(`SELECT billed_invoice_no FROM v_travel_logs WHERE travel_id = 'TI-TRV-PRJ'`);
      assert.equal(t.billed_invoice_no, 'TI/INV/PRJ');
    });

    test('a PO trip may be billed on a travel invoice of its PO or of its project', async () => {
      await db.query(`INSERT INTO travel_logs (travel_id, employee_name, po_number) VALUES ('TI-TRV-PO', 'Vijay', 'TI-PO')`);
      const { rows: [onPo] } = await db.query(`SELECT id FROM payment_stages WHERE invoice_no = 'TI/INV/PO'`);
      await db.query(`UPDATE travel_logs SET billed_stage_id = $1 WHERE travel_id = 'TI-TRV-PO'`, [onPo.id]);

      // And a travel invoice raised on the PO's project, with no PO of its own.
      const { rows: [onProject] } = await db.query(
        `INSERT INTO payment_stages (kind, project_id, stage_name, trigger_event, amount, invoice_no, invoice_date)
         VALUES ('travel','TI-PRJ','Travel invoice','Manual', 1000, 'TI/INV/PRJ2', CURRENT_DATE) RETURNING id`);
      await db.query(`UPDATE travel_logs SET billed_stage_id = $1 WHERE travel_id = 'TI-TRV-PO'`, [onProject.id]);
      const { rows: [t] } = await db.query(`SELECT billed_invoice_no FROM v_travel_logs WHERE travel_id = 'TI-TRV-PO'`);
      assert.equal(t.billed_invoice_no, 'TI/INV/PRJ2', 'reassignment works too');
    });

    test('an ordinary PO stage can no longer be chosen as a new billing target', async () => {
      const { rows: [stage] } = await db.query(`SELECT id FROM payment_stages WHERE po_number = 'TI-PO' AND stage_no = 1`);
      await assert.rejects(
        () => db.query(`UPDATE travel_logs SET billed_stage_id = $1 WHERE travel_id = 'TI-TRV-PO'`, [stage.id]),
        (err) => /ordinary PO stage/.test(err.message)
      );
    });

    test('another client\'s travel invoice is refused', async () => {
      const { rows: [other] } = await db.query(
        `INSERT INTO payment_stages (kind, project_id, stage_name, trigger_event, amount, invoice_no, invoice_date)
         VALUES ('travel','TI-OTHER','Travel invoice','Manual', 1000, 'TI/INV/OTHER', CURRENT_DATE) RETURNING id`);
      await assert.rejects(
        () => db.query(`UPDATE travel_logs SET billed_stage_id = $1 WHERE travel_id = 'TI-TRV-PO'`, [other.id]),
        (err) => /belongs to project/.test(err.message)
      );
    });

    test('clearing the link is always allowed', async () => {
      await db.query(`UPDATE travel_logs SET billed_stage_id = NULL WHERE travel_id = 'TI-TRV-PO'`);
      const { rows: [t] } = await db.query(`SELECT billed_stage_id FROM travel_logs WHERE travel_id = 'TI-TRV-PO'`);
      assert.equal(t.billed_stage_id, null);
    });

    test('a non-chargeable trip still cannot be billed at all', async () => {
      await db.query(`INSERT INTO travel_logs (travel_id, employee_name) VALUES ('TI-TRV-NC', 'Nobody')`);
      const { rows: [inv] } = await db.query(`SELECT id FROM payment_stages WHERE invoice_no = 'TI/INV/PRJ'`);
      await assert.rejects(
        () => db.query(`UPDATE travel_logs SET billed_stage_id = $1 WHERE travel_id = 'TI-TRV-NC'`, [inv.id]),
        (err) => /not a chargeable trip/.test(err.message)
      );
    });
  });
});
