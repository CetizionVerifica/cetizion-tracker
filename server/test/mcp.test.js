import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * The MCP server (#50): a sales token sees only its person's records, an
 * admin token sees all, a revoked token sees nothing, and nothing can be
 * deleted, re-staged or paid. Needs TEST_DATABASE_URL; skipped otherwise.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
const NAME = `mcp_test_${process.pid}`;
let app; let pool; let staff;

async function fixtures(client) {
  await client.query(`
    INSERT INTO companies (id, name) VALUES (1001, 'Asha Client Ltd'), (1002, 'Ravi Client Ltd');
    INSERT INTO quotations (quotation_no, client_name, quotation_date, quotation_value, status, sales_person)
      VALUES ('QT-ASHA', 'Asha Client Ltd', '2026-07-01', 100000, 'Submitted', 'Asha'), ('QT-RAVI', 'Ravi Client Ltd', '2026-07-01', 900000, 'Submitted', 'Ravi');
    INSERT INTO projects (project_id, client_name, sales_person) VALUES ('PRJ-ASHA', 'Asha Client Ltd', 'Asha'), ('PRJ-RAVI', 'Ravi Client Ltd', 'Ravi');
    INSERT INTO purchase_orders (po_number, project_id, po_date, po_value) VALUES ('PO-ASHA', 'PRJ-ASHA', '2026-06-01', 100000), ('PO-RAVI', 'PRJ-RAVI', '2026-06-01', 900000);
    INSERT INTO payment_stages (po_number, stage_no, stage_name, trigger_event, stage_percent, invoice_no, invoice_date)
      VALUES ('PO-ASHA', 1, 'Advance', 'On PO Registration', 1, 'INV-ASHA', '2026-06-02'), ('PO-RAVI', 1, 'Advance', 'On PO Registration', 1, 'INV-RAVI', '2026-06-02');
  `);
  // A travel bill still owed, so list_payables has a row to check its
  // schema against. An empty page validates against anything.
  await client.query(`
    INSERT INTO travel_logs (travel_id, po_number, employee_name, arranged_by, travel_start_date)
      VALUES ('TRV-ASHA', 'PO-ASHA', 'Asha', 'Yatra Travels', '2026-05-01');
    INSERT INTO travel_vendor_invoices (vendor_invoice_id, travel_id, vendor_invoice_no, invoice_date, invoice_amount, amount_paid)
      VALUES ('VI-1', 'TRV-ASHA', 'YT/2026/1', '2026-05-31', 40000, 5000);
  `);
  // A shared inbox with one unanswered thread, likewise. 'subject' is the
  // visibility that lets the subject through, which is what list_inbox
  // reads; 'metadata' would null it and prove nothing about the column.
  await client.query(`
    INSERT INTO connected_accounts (id, username, provider, email, is_shared, visibility)
      VALUES (900, 'tester', 'test', 'sales@cetizion.test', true, 'subject');
    INSERT INTO inboxes (id, name, account_id, members) VALUES (900, 'Sales', 900, '{"Asha"}');
    INSERT INTO email_threads (id, account_id, conversation_id, subject, company_id, last_message_at, message_count, last_direction)
      VALUES (900, 900, 'thread-900', 'Quote for the July audit', 1001, now() - interval '3 days', 2, 'inbound');
    INSERT INTO inbox_conversations (inbox_id, thread_id, company_id, from_name, from_email, status, assignee, last_inbound_at, response_due_at)
      VALUES (900, 900, 1001, 'Asha Buyer', 'buyer@asha.test', 'open', 'Priya Menon', now() - interval '3 days', now() - interval '2 days');
  `);
  // A mailbox whose owner shares only metadata: its subject is nulled when
  // the message arrives, and list_inbox leans on that being true.
  await client.query(`
    INSERT INTO connected_accounts (id, username, provider, email, is_shared, visibility)
      VALUES (901, 'tester', 'test', 'quiet@cetizion.test', true, 'metadata');
    INSERT INTO inboxes (id, name, account_id, members) VALUES (901, 'Quiet', 901, '{}');
    INSERT INTO email_threads (id, account_id, conversation_id, subject, last_message_at, message_count, last_direction)
      VALUES (901, 901, 'thread-901', NULL, now() - interval '1 day', 1, 'inbound');
    INSERT INTO inbox_conversations (inbox_id, thread_id, from_name, from_email, status, last_inbound_at, response_due_at)
      VALUES (901, 901, 'Quiet Client', 'someone@quiet.test', 'open', now() - interval '1 day', now() + interval '1 day');
    -- Snoozed until yesterday: nothing but a list request brings it back.
    INSERT INTO email_threads (id, account_id, conversation_id, subject, last_message_at, message_count, last_direction)
      VALUES (902, 900, 'thread-902', 'Overdue and asleep', now() - interval '9 days', 3, 'inbound');
    INSERT INTO inbox_conversations (inbox_id, thread_id, from_name, from_email, status, assignee, snoozed_until, last_inbound_at, response_due_at)
      VALUES (900, 902, 'Sleepy Client', 'sleepy@asha.test', 'snoozed', 'Asha', now() - interval '1 day', now() - interval '9 days', now() - interval '8 days');
  `);
}

describe('MCP server scoping', { skip: !ADMIN_URL && 'TEST_DATABASE_URL is not set' }, () => {
  before(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${NAME}`);
    await admin.end();
    const url = new URL(ADMIN_URL); url.pathname = `/${NAME}`;
    const client = new pg.Client({ connectionString: url.toString() });
    await client.connect();
    for (const f of ['schema.sql', 'views.sql', 'seed.sql']) await client.query(readFileSync(join(DB_DIR, f), 'utf8'));
    await fixtures(client);
    await client.end();
    // SKIP_DOTENV, or a developer's own .env supplies AUTH_MODE=database and
    // the shared-password sign-in below is answered with "email required".
    // CI has no .env, so without this the suite passes there and only there.
    Object.assign(process.env, { SKIP_DOTENV: '1', NODE_ENV: 'test', DATABASE_URL: url.toString(), AUTH_USERNAME: 'tester', AUTH_PASSWORD: 'a-good-long-test-password', SESSION_SECRET: 'test-secret-that-is-long-enough-to-pass' });
    ({ default: app } = await import('../src/app.js'));
    ({ pool } = await import('../src/db.js'));
    const signIn = await request(app).post('/api/auth/login').send({ username: 'tester', password: 'a-good-long-test-password' });
    staff = signIn.headers['set-cookie'][0].split(';')[0];
  });

  after(async () => {
    await pool?.end();
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`);
    await admin.end();
  });

  const token = async (body) => (await request(app).post('/api/api-tokens').set('Cookie', staff).send(body).expect(201)).body.data;
  let id = 0;
  async function call(tok, name, args = {}) {
    id += 1;
    const res = await request(app).post('/api/mcp').set('Authorization', `Bearer ${tok}`).set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
    if (res.status !== 200) return { status: res.status };
    const r = res.body.result;
    return { status: 200, error: Boolean(r.isError), text: r.content.map((c) => c.text).join('\n'), structured: r.structuredContent, raw: r };
  }

  /**
   * Every tool declares an outputSchema, and the SDK validates our own
   * structuredContent against it and throws when it does not match. That is
   * the point — a query that quietly stops returning a column should fail
   * loudly. It also means a schema written from memory rather than from the
   * SQL breaks a working tool, so every one of them gets called here.
   */
  test('every tool answers, and its own output passes the schema it declares', async () => {
    // Writing too: the four write tools are hidden from a reading token,
    // so a reading one would never exercise their schemas.
    const t = (await token({ name: 'Schema check', role: 'admin', can_write: true })).token;
    const calls = [
      ['search_records', { text: 'Client' }],
      ['get_company', { company_id: 1001 }],
      ['get_quotation', { quotation_no: 'QT-ASHA' }],
      ['get_project', { project_id: 'PRJ-ASHA' }],
      ['get_po', { po_number: 'PO-ASHA' }],
      ['list_pipeline', {}],
      ['list_collections', { overdue_only: false }],
      ['get_kpis', {}],
      ['list_activity', { entity: 'quotation', id: 'QT-ASHA' }],
      ['create_task', { entity: 'quotation', id: 'QT-ASHA', title: 'A follow-up from the schema check' }],
      ['add_note', { entity: 'quotation', id: 'QT-ASHA', text: 'A note from the schema check' }],
      ['log_touch', { entity: 'quotation', id: 'QT-ASHA', channel: 'call', outcome: 'connected' }],
      ['update_next_step', { quotation_no: 'QT-ASHA', next_step: 'Send the revised scope' }],
      ['list_inbox', {}],
      ['list_payables', {}],
      ['list_data_gaps', {}],
      ['list_tasks', {}],
    ];
    for (const [name, args] of calls) {
      const r = await call(t, name, args);
      assert.equal(r.status, 200, `${name} -> HTTP ${r.status}`);
      assert.equal(r.error, false, `${name} -> ${r.text}`);
      assert.ok(r.structured !== undefined, `${name} returned no structuredContent, so its schema is never checked`);
    }
    // complete_task needs an id that exists, so it runs on one the loop
    // above just made rather than on a number written here.
    const open = JSON.parse((await call(t, 'list_tasks', {})).text);
    assert.ok(open.items.length >= 1, 'create_task ran above, so there is an open task to close');
    const closed = await call(t, 'complete_task', { task_id: open.items[0].id });
    assert.equal(closed.error, false, closed.text);
    assert.ok(closed.structured !== undefined, 'complete_task declares a schema, so it must return one');
  });

  test('a list says how much it did not return, and the next page differs', async () => {
    const t = (await token({ name: 'Paging', role: 'admin' })).token;
    const first = JSON.parse((await call(t, 'list_pipeline', { limit: 1 })).text);
    assert.equal(first.deals.length, 1);
    assert.equal(first.limit, 1);
    assert.ok(first.total >= 2, 'the fixtures hold two open deals');
    assert.equal(first.has_more, true, 'one of two is not the end of the list');

    const second = JSON.parse((await call(t, 'list_pipeline', { limit: 1, offset: 1 })).text);
    assert.notEqual(second.deals[0].quotation_no, first.deals[0].quotation_no, 'offset must move the window');
    assert.equal(second.total, first.total, 'the total is of the whole list, not of the page');
  });

  /**
   * A page past the end has no row to carry count(*) OVER (), and every list
   * used to answer total 0 there: list_tasks({ offset: 100 }) on five tasks
   * said there were none, and list_payables said "0 bills" beside the debt it
   * had just totalled. The total is of the list, whichever page is asked for.
   */
  test('a page past the end still says how long the list is, on every list', async () => {
    const t = (await token({ name: 'Past the end', role: 'admin', can_write: true })).token;
    // An open task of its own: the schema check above closes the one it made.
    await call(t, 'create_task', { entity: 'quotation', id: 'QT-ASHA', title: 'A task for the paging check' });

    const lists = [
      ['list_pipeline', {}, 'deals'],
      ['list_collections', { overdue_only: false }, 'items'],
      ['list_activity', { entity: 'quotation', id: 'QT-ASHA' }, 'items'],
      ['list_inbox', {}, 'items'],
      ['list_tasks', {}, 'items'],
      ['list_payables', {}, 'items'],
    ];
    for (const [name, args, key] of lists) {
      const first = JSON.parse((await call(t, name, args)).text);
      assert.ok(first.total > 0, `${name}: the fixtures give it something to count`);

      const past = await call(t, name, { ...args, offset: 100 });
      assert.equal(past.error, false, `${name} -> ${past.text}`);
      const page = JSON.parse(past.text);
      assert.deepEqual(page[key], [], `${name}: nothing is left at offset 100`);
      assert.equal(page.total, first.total, `${name}: the total is of the list, not of the empty page`);
      assert.equal(page.has_more, false, `${name}: there is nothing after the end`);
      assert.equal(page.offset, 100);
    }
  });

  test('payables past the end count the same bills the outstanding total covers', async () => {
    const t = (await token({ name: 'Payables past the end', role: 'admin' })).token;
    const first = JSON.parse((await call(t, 'list_payables', {})).text);
    const past = JSON.parse((await call(t, 'list_payables', { offset: 100 })).text);
    // Was: total 0 beside a debt of ₹35,000 — no bills, yet money owed.
    assert.equal(past.total, first.total);
    assert.ok(past.total > 0);
    for (const [k, v] of Object.entries(first)) {
      if (!['items', 'offset', 'has_more'].includes(k)) assert.deepEqual(past[k], v, `${k} is the same whichever page is asked for`);
    }
  });

  test('an empty list is still empty on the first page and past the end', async () => {
    const t = (await token({ name: 'Nothing there', role: 'admin' })).token;
    for (const offset of [0, 50]) {
      const page = JSON.parse((await call(t, 'list_collections', { overdue_only: false, min_days_overdue: 100000, offset })).text);
      assert.deepEqual([page.items, page.total, page.has_more], [[], 0, false], `offset ${offset}`);
    }
  });

  test('a caller cannot ask for a thousand rows', async () => {
    const t = (await token({ name: 'Ceiling', role: 'admin' })).token;
    const res = await call(t, 'list_pipeline', { limit: 1000 });
    // Refused at the boundary rather than silently clamped: a caller that
    // asked for a thousand should learn it cannot have them.
    assert.equal(res.error, true, 'the input schema caps limit at 100');
  });

  test('the result is not pretty-printed', async () => {
    const t = (await token({ name: 'Compact', role: 'admin' })).token;
    const { text } = await call(t, 'list_pipeline', {});
    assert.doesNotMatch(text, /\n /, 'indentation is paid for by the caller and read by nobody');
  });

  test('a sales token sees only its own records, on every tool', async () => {
    const asha = (await token({ name: 'Asha', role: 'sales', person: 'asha' })).token;
    const pipeline = await call(asha, 'list_pipeline');
    assert.match(pipeline.text, /QT-ASHA/);
    assert.doesNotMatch(pipeline.text, /QT-RAVI|Ravi/);
    assert.equal((await call(asha, 'get_quotation', { quotation_no: 'QT-RAVI' })).error, true);
    assert.equal((await call(asha, 'get_project', { project_id: 'PRJ-RAVI' })).error, true);
    assert.equal((await call(asha, 'get_po', { po_number: 'PO-RAVI' })).error, true);
    assert.equal((await call(asha, 'get_company', { company_id: 1002 })).error, true);
    const own = await call(asha, 'get_company', { company_id: 1001 });
    assert.equal(own.error, false, own.text);
    const search = await call(asha, 'search_records', { text: 'Client' });
    assert.match(search.text, /Asha Client/);
    assert.doesNotMatch(search.text, /Ravi/);
    const collections = await call(asha, 'list_collections', { overdue_only: false });
    assert.match(collections.text, /INV-ASHA/);
    assert.doesNotMatch(collections.text, /INV-RAVI/);
    const kpis = JSON.parse((await call(asha, 'get_kpis', { from: '2026-01-01', to: '2026-12-31', person: 'Ravi' })).text);
    assert.equal(kpis.person, 'asha');
    assert.equal(kpis.quotations_issued, 1);
    assert.equal((await call(asha, 'list_activity', { entity: 'quotation', id: 'QT-RAVI' })).error, true);
    assert.equal((await call(asha, 'add_note', { entity: 'quotation', id: 'QT-RAVI', text: 'should not land' })).error, true);
  });

  /**
   * The four reading tools added for the inbox, payables, gaps and tasks.
   * Two of them are scoped by person and two are not, and which is which is
   * a decision rather than an oversight, so it is written down here.
   */
  test('the inbox and tasks are scoped by person; payables and gaps are not', async () => {
    const asha = (await token({ name: 'Asha reads', role: 'sales', person: 'asha', can_write: true })).token;
    const ravi = (await token({ name: 'Ravi reads', role: 'sales', person: 'ravi', can_write: true })).token;

    // The Sales inbox lists her as "Asha", capitalised, which is how a
    // person types a name into a field headed "Names, comma separated";
    // her token's person is "asha". The thread is assigned to somebody
    // else entirely, so membership is the only thing that can bring it in
    // — and a case-sensitive membership test brings in nothing.
    const hers = JSON.parse((await call(asha, 'list_inbox', {})).text);
    const subjects = hers.items.map((i) => i.subject);
    assert.ok(subjects.includes('Quote for the July audit'), `a member of Sales sees its threads: ${JSON.stringify(subjects)}`);

    // A conversation snoozed until yesterday is awake, late, and on the
    // list. Nothing but a list request brings it back.
    assert.ok(subjects.includes('Overdue and asleep'), 'an expired snooze is woken, not left out');
    const woken = hers.items.find((i) => i.subject === 'Overdue and asleep');
    assert.equal(woken.status, 'open');
    assert.equal(woken.overdue, true, 'and it reports as late, which it is by eight days');

    // The unassigned thread in the metadata-only mailbox: its subject was
    // nulled when the message arrived, and that is the whole basis for this
    // tool returning subjects at all.
    const quiet = hers.items.find((i) => i.from_email === 'someone@quiet.test');
    assert.ok(quiet, 'an unassigned conversation is anyone\'s to pick up');
    assert.equal(quiet.subject, null, 'a metadata-only mailbox shares no subject, and list_inbox invents none');

    // unanswered_only is the whole point of the tool.
    const waiting = JSON.parse((await call(asha, 'list_inbox', { unanswered_only: true })).text);
    assert.ok(waiting.items.every((i) => i.last_direction !== 'outbound'));
    assert.ok(waiting.total >= 1);

    // Ravi is a member of nothing. He still sees the unassigned one — the
    // Inbox page's rule, carried here on purpose — but not Asha's threads.
    const his = JSON.parse((await call(ravi, 'list_inbox', {})).text).items.map((i) => i.subject);
    assert.ok(!his.includes('Quote for the July audit'), 'not his inbox, not his thread');

    // No message bodies, whatever the mailbox's visibility says.
    assert.doesNotMatch(JSON.stringify(hers), /body|html|snippet|preview|excerpt/i, 'list_inbox returns subjects and status, never bodies');

    // A vendor bill belongs to the company, not to a salesperson, which is
    // what the Payables page does too. Both tokens see the same debt.
    const ap = JSON.parse((await call(asha, 'list_payables', { limit: 100 })).text);
    assert.equal(ap.currency, 'INR');
    const bill = ap.items.find((r) => r.vendor_invoice_no === 'YT/2026/1');
    assert.ok(bill, 'the fixture bill is in the list');
    assert.equal(Number(bill.outstanding), 35000, '40,000 billed less 5,000 paid');
    assert.equal(bill.bucket, '90+', 'a May bill is well past a September pay-by');
    assert.equal(JSON.parse((await call(ravi, 'list_payables', { limit: 100 })).text).total, ap.total,
      'a vendor bill has no salesperson, so both tokens see the same debt');
    // The summary is of every bucket, so narrowing the rows must not move it.
    const notDue = JSON.parse((await call(asha, 'list_payables', { bucket: 'not due' })).text);
    assert.ok(notDue.total < ap.total, 'one bucket is fewer rows than all of them');
    assert.equal(notDue.total_outstanding, ap.total_outstanding,
      'total_outstanding is the whole debt, not the filtered page of it');
    assert.equal(ap.total_outstanding,
      Math.round(ap.buckets.reduce((n, b) => n + (b.outstanding ?? 0), 0) * 100) / 100,
      'the total is the sum of the buckets it reports beside it');
    assert.equal(ap.buckets.length, 7, 'every bucket has a card, zero rows included');

    // Gaps are counts of missing fields, so there is nothing in them to scope.
    const gaps = JSON.parse((await call(asha, 'list_data_gaps', {})).text);
    assert.ok(gaps.checks_run > 0, 'the checks ran');
    assert.deepEqual(gaps.gaps.map((g) => g.count).filter((c) => c <= 0), [], 'only gaps that found something are listed');

    // Tasks: each sees her or his own, and cannot close the other's.
    await call(asha, 'create_task', { entity: 'quotation', id: 'QT-ASHA', title: 'Asha to send the scope', assignee: 'asha' });
    const ravis = await call(ravi, 'create_task', { entity: 'quotation', id: 'QT-RAVI', title: 'Ravi to chase the PO', assignee: 'ravi' });
    assert.equal(ravis.error, false, ravis.text);
    const ravisId = JSON.parse(ravis.text).id;

    const ahers = JSON.parse((await call(asha, 'list_tasks', {})).text);
    assert.ok(ahers.items.every((t) => !/Ravi to chase/.test(t.title)), 'his task is not on her list');
    assert.ok(ahers.items.some((t) => /Asha to send/.test(t.title)), 'hers is');
    // Naming somebody else is an admin's to do; asking anyway gets her own.
    assert.doesNotMatch((await call(asha, 'list_tasks', { assignee: 'ravi' })).text, /Ravi to chase/);

    assert.equal((await call(asha, 'complete_task', { task_id: ravisId })).error, true, 'she cannot close his task');
    const stillOpen = await pool.query('SELECT status FROM tasks WHERE id = $1', [ravisId]);
    assert.equal(stillOpen.rows[0].status, 'todo', 'and the refusal left it alone');

    // Closing twice is closing once.
    const first = JSON.parse((await call(ravi, 'complete_task', { task_id: ravisId })).text);
    assert.equal(first.status, 'done');
    assert.equal(first.already_done, false);
    const again = JSON.parse((await call(ravi, 'complete_task', { task_id: ravisId })).text);
    assert.equal(again.already_done, true, 'the second call reports, it does not fail');

    // And a closed task drops off the open list.
    assert.doesNotMatch((await call(ravi, 'list_tasks', {})).text, /Ravi to chase/);

    // A task she raised on her own quotation and handed to a colleague.
    // create_task allows it (the record is hers), so list_tasks has to show
    // it back: it is assigned to neither of the two names she is matched on,
    // and without the record itself counting she would never see it again.
    const handed = await call(asha, 'create_task', { entity: 'quotation', id: 'QT-ASHA', title: 'Ravi to co-sign the Asha scope', assignee: 'ravi' });
    assert.equal(handed.error, false, handed.text);
    const handedId = JSON.parse(handed.text).id;
    assert.match((await call(asha, 'list_tasks', {})).text, /Ravi to co-sign/,
      'a task on her own record is hers to see, whoever is doing it');
    assert.equal((await call(asha, 'complete_task', { task_id: handedId })).error, false,
      'and hers to close');

    // The stamp writes say where they came from, and it must not hide a
    // task from the person who raised it.
    const { rows: [stamped] } = await pool.query('SELECT created_by FROM tasks WHERE id = $1', [handedId]);
    assert.match(stamped.created_by, /via MCP/, 'the write is still marked');

    // It stays scoped: Ravi's quotation is not hers, so a task on it is not
    // hers either, however it was raised.
    const onHis = await pool.query(
      `INSERT INTO tasks (entity, entity_id, title, assignee, created_by) VALUES ('quotation','QT-RAVI','Chase the Ravi client','ravi','admin') RETURNING id`);
    assert.doesNotMatch((await call(asha, 'list_tasks', {})).text, /Chase the Ravi client/);
    assert.equal((await call(asha, 'complete_task', { task_id: onHis.rows[0].id })).error, true);
  });

  /**
   * Bulk import (#134). The sheet goes in as rows from a conversation and
   * through the same planner the upload screen uses, so what is proved here
   * is the way in and the gates on it: planning writes nothing, committing
   * needs saying so, and neither is offered to a token that is not an admin.
   */
  describe('bulk import over MCP', () => {
    const SHEET = [
      { 'S.No': 1, 'Client Name': 'Falcon Foods', 'Deal Stage': 'Proposal Sent', 'Proposal Name': 'PCF assessment', 'Proposal Sent Date': '01.09.2026', 'PO Amount': '', 'Quotation No': '', 'Sales Person': 'Asha' },
      { 'S.No': 2, 'Client Name': 'Delta Pumps', 'Deal Stage': 'Closed Won (100%)', 'Proposal Name': 'EcoVadis', 'Proposal Sent Date': '05.08.2026', 'PO Number': '4500999111', 'PO Amount': '7,96,500/-', 'Sales Person': 'Ravi' },
      { 'S.No': 3, 'Client Name': 'Zen Labs', 'Deal Stage': 'Proposal Sent', 'Proposal Name': 'ISO 9001 audit', 'Proposal Sent Date': '02.09.2026', 'PO Amount': '', 'Sales Person': 'Asha' },
    ];
    const admin = async () => (await token({ name: `Import ${id}`, role: 'admin', can_write: true })).token;
    const count = async (sql, args = []) => Number((await pool.query(sql, args)).rows[0].n);

    test('a sales token is not offered the import tools at all', async () => {
      const sales = (await token({ name: 'Sales imports', role: 'sales', person: 'asha', can_write: true })).token;
      const res = await request(app).post('/api/mcp').set('Authorization', `Bearer ${sales}`).set('Accept', 'application/json, text/event-stream')
        .send({ jsonrpc: '2.0', id: 9100, method: 'tools/list', params: {} });
      const names = res.body.result.tools.map((x) => x.name);
      for (const n of ['plan_sheet_import', 'get_import_plan', 'update_import_plan', 'replan_sheet_import', 'commit_sheet_import']) {
        assert.ok(!names.includes(n), `${n} is an admin's, on the Import screen and here`);
      }
      // And asking anyway is refused, not merely unlisted.
      assert.equal((await call(sales, 'plan_sheet_import', { rows: SHEET })).error, true);
    });

    test('planning reads the sheet and writes nothing', async () => {
      const t = await admin();
      const before = await count('SELECT count(*) AS n FROM quotations');
      const plan = JSON.parse((await call(t, 'plan_sheet_import', { rows: SHEET, sheet_name: 'September deals' })).text);

      assert.equal(plan.rows_read, 3);
      assert.equal(plan.committed, false);
      assert.ok(plan.batch_id > 0);
      // The won row carries a PO, so it plans the whole chain beneath it.
      assert.equal(plan.steps.quotation.create, 2, 'two deals; the ISO row is left out by rule');
      assert.equal(plan.steps.purchase_order.create, 1);
      assert.ok(plan.steps.stage.create >= 2, 'a won PO is split into payment stages');
      assert.equal(plan.left_out, 1);
      assert.match(JSON.stringify(plan.left_out_reasons), /ISO/i);

      assert.equal(await count('SELECT count(*) AS n FROM quotations'), before,
        'planning must not write a single record');
      assert.equal(await count('SELECT count(*) AS n FROM purchase_orders WHERE po_number = $1', ['4500999111']), 0);

      // The rules are the reviewer's to change, and changing one re-reads
      // the rows already sent rather than asking for them again.
      const again = JSON.parse((await call(t, 'replan_sheet_import', { batch_id: plan.batch_id, rules: { exclude_iso: false } })).text);
      assert.equal(again.batch_id, plan.batch_id, 'the same batch, re-planned');
      assert.equal(again.steps.quotation.create, 3, 'the ISO deal comes in once the rule is off');
      assert.equal(again.left_out, 0);
      assert.equal(await count('SELECT count(*) AS n FROM quotations'), before, 'and still nothing written');
    });

    test('the plan can be read in detail, changed, and only then committed', async () => {
      const t = await admin();
      const plan = JSON.parse((await call(t, 'plan_sheet_import', { rows: SHEET, sheet_name: 'To commit' })).text);
      const batchId = plan.batch_id;

      // Detail is paged, and filtering to one step gives that step's rows.
      const quotations = JSON.parse((await call(t, 'get_import_plan', { batch_id: batchId, step: 'quotation' })).text);
      assert.equal(quotations.total, 2);
      assert.ok(quotations.items.every((i) => i.step === 'quotation'));
      const falcon = quotations.items.find((i) => /Falcon/.test(i.client || ''));
      assert.ok(falcon, 'the pending deal is in the plan');

      // Committing is refused unless it is asked for in as many words.
      const unconfirmed = await call(t, 'commit_sheet_import', { batch_id: batchId });
      assert.equal(unconfirmed.error, true, 'confirm is required');
      assert.match(unconfirmed.text, /confirm/i);
      assert.equal(await count('SELECT count(*) AS n FROM quotations WHERE client_name = $1', ['Falcon Foods']), 0,
        'a refused commit writes nothing');

      // Untick the pending deal; only the won one should land.
      const changed = JSON.parse((await call(t, 'update_import_plan', { batch_id: batchId, seqs: [falcon.seq], included: false })).text);
      assert.equal(changed.changed, 1);

      const committed = await call(t, 'commit_sheet_import', { batch_id: batchId, confirm: true });
      assert.equal(committed.error, false, committed.text);
      const done = JSON.parse(committed.text);
      assert.equal(done.committed, true);
      assert.ok(done.written_count >= 1, `something was written: ${JSON.stringify(done.written_by_action)}`);

      assert.equal(await count('SELECT count(*) AS n FROM quotations WHERE client_name = $1', ['Delta Pumps']), 1,
        'the won deal landed');
      assert.equal(await count('SELECT count(*) AS n FROM purchase_orders WHERE po_number = $1', ['4500999111']), 1,
        'and its purchase order with it');
      assert.equal(await count('SELECT count(*) AS n FROM quotations WHERE client_name = $1', ['Falcon Foods']), 0,
        'the unticked row did not');

      // Committed once is committed: the batch cannot be run again.
      assert.equal((await call(t, 'commit_sheet_import', { batch_id: batchId, confirm: true })).error, true);
    });

    test('a batch uploaded on the Import screen is not this server\'s to commit', async () => {
      const t = await admin();
      const { rows: [own] } = await pool.query(
        `INSERT INTO import_batches (filename, uploaded_by) VALUES ('september.xlsx', 'someone') RETURNING id`);
      // Two people changing one plan from two places is how a row gets
      // committed that neither of them chose.
      const res = await call(t, 'commit_sheet_import', { batch_id: own.id, confirm: true });
      assert.equal(res.error, true);
      assert.match(res.text, /Import screen/);
      assert.equal((await call(t, 'update_import_plan', { batch_id: own.id, step: 'quotation', included: false })).error, true);
    });

    test('a sheet with no deal columns is refused with a reason', async () => {
      const t = await admin();
      const res = await call(t, 'plan_sheet_import', { rows: [{ 'Client Name': 'Falcon Foods', 'Deal Stage': 'Proposal Sent' }] });
      assert.equal(res.error, true);
      assert.match(res.text, /sales sheet|proposal date|quotation number/i);
    });
  });

  /**
   * One tool for the whole class of counted questions (#140), and the two
   * money questions nothing answered. What matters here is that aggregate
   * cannot be talked into reading a column it was not given, and that an
   * entity whose ownership this server cannot state is admin-only rather
   * than open.
   */
  describe('counting, renewals and cash', () => {
    test('it counts and totals, and the total matches the groups', async () => {
      const t = (await token({ name: 'Counting', role: 'admin' })).token;
      const byStatus = JSON.parse((await call(t, 'aggregate', { entity: 'quotations', by: 'status' })).text);
      assert.equal(byStatus.measure, 'count');
      assert.ok(byStatus.groups.length >= 1);
      assert.equal(byStatus.total, byStatus.groups.reduce((n, g) => n + g.value, 0),
        'the total is of the groups it returned');

      const value = JSON.parse((await call(t, 'aggregate', { entity: 'quotations', by: 'sales_person', measure: 'sum', of: 'quotation_value' })).text);
      assert.equal(value.measure, 'sum of quotation_value');
      const asha = value.groups.find((g) => (g.group || '').toLowerCase() === 'asha');
      assert.equal(asha.value, 100000, 'her one fixture quotation');

      // A date column grouped by period, which is the shape most of these
      // questions actually take.
      const byMonth = JSON.parse((await call(t, 'aggregate', { entity: 'quotations', by: 'quotation_date:month' })).text);
      assert.equal(byMonth.grouped_by, 'quotation_date by month');
      assert.ok(byMonth.groups.every((g) => g.group === null || /^\d{4}-\d{2}$/.test(g.group)), JSON.stringify(byMonth.groups));
    });

    test('it will not read a column it was not given', async () => {
      const t = (await token({ name: 'Injection', role: 'admin' })).token;
      for (const by of ['nonexistent_column', 'name; DROP TABLE companies', '1', '(SELECT 1)']) {
        const res = await call(t, 'aggregate', { entity: 'quotations', by });
        assert.equal(res.error, true, `by: ${by} must be refused`);
      }
      // Same for the measured column and the filters.
      assert.equal((await call(t, 'aggregate', { entity: 'quotations', by: 'status', measure: 'sum', of: 'client_name' })).error, true,
        'a text column cannot be summed');
      assert.equal((await call(t, 'aggregate', { entity: 'quotations', by: 'status', where: { nope: 1 } })).error, true);
      // And the tables are all still there.
      assert.ok(Number((await pool.query('SELECT count(*) AS n FROM companies')).rows[0].n) > 0);
    });

    test('a sales token counts only its own, and cannot count what has no owner', async () => {
      const asha = (await token({ name: 'Asha counts', role: 'sales', person: 'asha' })).token;
      const mine = JSON.parse((await call(asha, 'aggregate', { entity: 'quotations', by: 'sales_person' })).text);
      assert.deepEqual(mine.groups.map((g) => (g.group || '').toLowerCase()), ['asha'],
        'the scoping is applied before the grouping, so Ravi is not even a row');

      // Travel bills and expense claims have no salesperson on them. The
      // safe reading of "I cannot say whose this is" is not "everybody's".
      for (const entity of ['vendor-invoices', 'expense-claims', 'travel-logs']) {
        assert.equal((await call(asha, 'aggregate', { entity, by: 'id' })).error, true, `${entity} must be admin-only`);
      }
      const admin = (await token({ name: 'Admin counts', role: 'admin' })).token;
      assert.equal((await call(admin, 'aggregate', { entity: 'vendor-invoices', by: 'travel_vendor' })).error, false);
    });

    test('renewals are scoped, and the cash forecast is an admin\'s', async () => {
      const admin = (await token({ name: 'Money admin', role: 'admin' })).token;
      const asha = (await token({ name: 'Money sales', role: 'sales', person: 'asha' })).token;

      const r = await call(admin, 'list_renewals', {});
      assert.equal(r.error, false, r.text);
      const renewals = JSON.parse(r.text);
      assert.ok(renewals.counts_all_engagements, 'the summary counts come back');

      // Hers is scoped in SQL: an engagement owned by somebody else is not
      // in her total, not merely absent from her page.
      await pool.query(
        `INSERT INTO engagements (company_id, client_name, service_name, next_due_on, status, owner)
         VALUES (1001, 'Asha Client Ltd', 'EcoVadis', CURRENT_DATE + 10, 'active', 'asha'),
                (1002, 'Ravi Client Ltd', 'EcoVadis', CURRENT_DATE + 10, 'active', 'ravi')`);
      const hers = JSON.parse((await call(asha, 'list_renewals', {})).text);
      assert.equal(hers.total, 1, `only her engagement: ${JSON.stringify(hers.items.map((i) => i.client))}`);
      assert.equal(hers.items[0].client, 'Asha Client Ltd');
      assert.equal(hers.items[0].days_to_due, 10);

      // within_days narrows it, and a long window keeps it.
      assert.equal(JSON.parse((await call(asha, 'list_renewals', { within_days: 5 })).text).total, 0);
      assert.equal(JSON.parse((await call(asha, 'list_renewals', { within_days: 30 })).text).total, 1);

      // The cash forecast is the company's position, so it is an admin's.
      const cash = await call(admin, 'get_cashflow', { months: 3 });
      assert.equal(cash.error, false, cash.text);
      const f = JSON.parse(cash.text);
      assert.equal(f.currency, 'INR');
      assert.ok(f.months.length >= 3);
      assert.ok(f.months.every((m) => typeof m.net === 'number'));
      assert.doesNotMatch(JSON.stringify(f), /"items"/, 'item lines are off unless asked for');
      assert.match(JSON.stringify(JSON.parse((await call(admin, 'get_cashflow', { months: 1, detail: true })).text)), /"items"/);

      assert.equal((await call(asha, 'get_cashflow', {})).error, true, 'not hers to read');
    });
  });

  /**
   * Feeding any kind of record (#138). The sheet importer handles one shape;
   * this handles the other thirty tables, through each resource's own schema
   * and save hooks rather than around them.
   */
  describe('importing records of any kind', () => {
    const admin = async () => (await token({ name: `Records ${id}`, role: 'admin', can_write: true })).token;
    const count = async (sql, args = []) => Number((await pool.query(sql, args)).rows[0].n);

    test('it says what can be imported and what each kind takes', async () => {
      const t = await admin();
      const all = JSON.parse((await call(t, 'describe_entity', {})).text);
      const names = all.entities.map((e) => e.name);
      assert.ok(names.includes('companies') && names.includes('travel-logs') && names.includes('enquiries'));
      // The ones a plain INSERT is the wrong instrument for stay out.
      for (const n of ['quotation-lines', 'payment-stages', 'notes', 'tasks', 'exchange-rates']) {
        assert.ok(!names.includes(n), `${n} is written by something that knows how`);
      }
      const one = JSON.parse((await call(t, 'describe_entity', { entity: 'companies' })).text);
      assert.equal(one.match_on, 'name');
      const name = one.fields.find((f) => f.name === 'name');
      assert.equal(name.required, true, 'a company must be called something');
      assert.equal(one.fields.find((f) => f.name === 'sector').required, false);
    });

    test('a dry run reports what it would do and writes nothing', async () => {
      const t = await admin();
      const before = await count('SELECT count(*) AS n FROM companies');
      const plan = JSON.parse((await call(t, 'import_records', { entity: 'companies', rows: [
        { name: 'Falcon Foods Ltd', sector: 'Food', city: 'Pune' },
        { name: 'Asha Client Ltd', sector: 'Chemicals' },
        { sector: 'no name at all' },
      ] })).text);

      assert.equal(plan.dry_run, true);
      assert.equal(plan.rows_sent, 3);
      assert.equal(plan.created, 1, 'Falcon is new');
      assert.equal(plan.updated, 1, 'Asha Client Ltd is a fixture, so it matches by name');
      assert.equal(plan.rejected, 1, 'a company with no name is refused');
      const refused = plan.rows.find((r) => r.action === 'rejected');
      assert.ok(refused.why.name, `the reason names the field: ${JSON.stringify(refused.why)}`);

      assert.equal(await count('SELECT count(*) AS n FROM companies'), before, 'a dry run writes nothing');
    });

    test('a real run writes, and running it twice does not duplicate', async () => {
      const t = await admin();
      const rows = [{ name: 'Delta Pumps Pvt Ltd', sector: 'Pumps', city: 'Nashik' }];
      const done = JSON.parse((await call(t, 'import_records', { entity: 'companies', rows, dry_run: false })).text);
      assert.equal(done.created, 1);
      assert.equal(done.dry_run, false);
      assert.equal(await count('SELECT count(*) AS n FROM companies WHERE name = $1', ['Delta Pumps Pvt Ltd']), 1);

      // The same list again: an update, not a second copy. This is what makes
      // re-sending a corrected spreadsheet safe.
      const again = JSON.parse((await call(t, 'import_records', {
        entity: 'companies', rows: [{ name: 'Delta Pumps Pvt Ltd', sector: 'Pumps & Valves', city: 'Nashik' }], dry_run: false,
      })).text);
      assert.equal(again.updated, 1);
      assert.equal(again.created, 0);
      assert.equal(await count('SELECT count(*) AS n FROM companies WHERE name = $1', ['Delta Pumps Pvt Ltd']), 1,
        'matched by name, so still one row');
      const { rows: [row] } = await pool.query('SELECT sector FROM companies WHERE name = $1', ['Delta Pumps Pvt Ltd']);
      assert.equal(row.sector, 'Pumps & Valves', 'and the correction landed');
    });

    test('one bad row stops the batch; none of it lands', async () => {
      const t = await admin();
      const before = await count('SELECT count(*) AS n FROM companies');
      const res = JSON.parse((await call(t, 'import_records', { entity: 'companies', rows: [
        { name: 'Good Row Industries' },
        { name: '' },
      ], dry_run: false })).text);
      assert.equal(res.rejected, 1);
      assert.equal(await count('SELECT count(*) AS n FROM companies'), before,
        'half an imported client list is worse than none of it');
    });

    test('it validates by the resource\'s own rules, not looser ones', async () => {
      const t = await admin();
      // currency is an enum on quotations; a form would refuse CAD and so must this.
      const res = JSON.parse((await call(t, 'import_records', { entity: 'quotations', rows: [
        { quotation_no: 'QT-IMPORT-1', client_name: 'Asha Client Ltd', quotation_date: '2026-09-01', currency: 'CAD' },
      ] })).text);
      assert.equal(res.rejected, 1, 'the schema is the form\'s, so the answer is the form\'s');
      assert.ok(JSON.stringify(res.rows[0].why).includes('currency'));
    });

    test('a sales token is not offered it, nor allowed it', async () => {
      const sales = (await token({ name: 'Sales records', role: 'sales', person: 'asha', can_write: true })).token;
      const res = await request(app).post('/api/mcp').set('Authorization', `Bearer ${sales}`).set('Accept', 'application/json, text/event-stream')
        .send({ jsonrpc: '2.0', id: 9200, method: 'tools/list', params: {} });
      const names = res.body.result.tools.map((x) => x.name);
      assert.ok(!names.includes('import_records') && !names.includes('describe_entity'));
      assert.equal((await call(sales, 'import_records', { entity: 'companies', rows: [{ name: 'Sneaky Ltd' }] })).error, true);
      assert.equal(await count('SELECT count(*) AS n FROM companies WHERE name = $1', ['Sneaky Ltd']), 0);
    });

    test('what is written by something that knows how cannot be fed here', async () => {
      const t = await admin();
      for (const entity of ['payment-stages', 'quotation-lines', 'exchange-rates', 'nonsense']) {
        const res = await call(t, 'import_records', { entity, rows: [{ anything: 1 }] });
        assert.equal(res.error, true, `${entity} must be refused`);
      }
    });
  });

  test('duplicate companies come back grouped, and nothing here merges them', async () => {
    const t = (await token({ name: 'Dupes', role: 'admin', can_write: true })).token;
    // The seed already carries Hindalco and three of its plants, which is
    // the real shape of this problem. companies.name_key is UNIQUE, so the
    // only way one name reaches the table twice is punctuated differently.
    await pool.query(`INSERT INTO companies (name) VALUES
      ('Hindalco-Belur'), ('Zephyr Pumps Ltd'), ('Zephyr-Pumps Ltd'), ('Wholly Unrelated Dredging Co')`);

    const res = JSON.parse((await call(t, 'list_duplicate_companies', { limit: 100 })).text);
    const nameOf = (g) => g.names.map((n) => n.name);

    // The property pairs could not have: a company is in one group or none.
    // Pairwise output put Hindalco in four rows at once, each proposing a
    // different merge, several of them contradicting the others.
    const seen = new Map();
    for (const g of res.groups) {
      for (const n of g.names) {
        assert.ok(!seen.has(n.id), `${n.name} is in two groups at once: ${seen.get(n.id)} and ${nameOf(g)}`);
        seen.set(n.id, nameOf(g));
      }
    }

    // Two spellings of one thing, identical once punctuated away: nothing
    // to weigh up, and its own group because nothing else looks like it.
    const zephyr = res.groups.find((g) => nameOf(g).includes('Zephyr Pumps Ltd'));
    assert.ok(zephyr, `Zephyr is grouped: ${JSON.stringify(res.groups.map(nameOf))}`);
    assert.deepEqual(nameOf(zephyr).sort(), ['Zephyr Pumps Ltd', 'Zephyr-Pumps Ltd']);
    assert.equal(zephyr.certain, true);
    assert.match(zephyr.confidence, /same name/);

    // Hindalco's plants land in one group, and it does not claim they are
    // one company — bare "Hindalco" matches each plant while the plants do
    // not match each other, so the group asks rather than asserts.
    const hindalco = res.groups.find((g) => nameOf(g).includes('Hindalco - Belur'));
    assert.ok(hindalco, 'the Hindalco family is grouped');
    assert.ok(nameOf(hindalco).includes('Hindalco-Belur'), 'both spellings of Belur are in it');
    assert.equal(hindalco.certain, false, 'a shared brand is a question, not an answer');
    assert.equal(hindalco.confidence, 'shares a brand');

    assert.ok(!res.groups.some((g) => nameOf(g).includes('Wholly Unrelated Dredging Co')),
      'a company with no look-alike is in no group');

    // No tool here can act on any of it, whatever the token may write.
    const list = await request(app).post('/api/mcp').set('Authorization', `Bearer ${t}`).set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 9300, method: 'tools/list', params: {} });
    assert.ok(!list.body.result.tools.map((x) => x.name).some((n) => /merge/i.test(n)),
      'merging is the Companies screen\'s, not this server\'s');
  });

  /**
   * Where a dialect-sensitive keyword really appears in a schema.
   *
   * Inside a `properties` map the keys are the tool's own field names, so a
   * field called `definitions` is not the draft-7 keyword of that name. Only
   * the keyword positions count.
   */
  const DIALECT_KEYWORDS = new Set(['prefixItems', 'definitions', '$defs', '$ref']);
  function* dialectKeywords(node, path, inProperties = false) {
    if (Array.isArray(node)) {
      for (const [i, v] of node.entries()) yield* dialectKeywords(v, `${path}[${i}]`);
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (inProperties) { yield* dialectKeywords(value, `${path}.${key}`); continue; }
      if (DIALECT_KEYWORDS.has(key)) yield [key, `${path}.${key}`];
      yield* dialectKeywords(value, `${path}.${key}`, key === 'properties' || key === 'patternProperties');
    }
  }

  /**
   * The schemas a client is asked to validate against (#50).
   *
   * The SDK converts our Zod shapes with no target and its converter reads a
   * missing target as draft-7, so every tool went out declaring
   * "http://json-schema.org/draft-07/schema#" while the SDK's own types
   * promised 2020-12. Claude Desktop compiles outputSchema to check
   * structuredContent, its validator is 2020-12 only, and it refused
   * list_tasks before calling it. mcpSchema.test.js pins the correction
   * itself; this is the one that fails if it is ever not wired in.
   */
  test('no tool declares a schema dialect a client cannot validate', async () => {
    // An admin token that may write, so the full set is on the list and no
    // tool's schemas go unchecked.
    const t = (await token({ name: 'Schemas', role: 'admin', can_write: true })).token;
    const res = await request(app).post('/api/mcp').set('Authorization', `Bearer ${t}`).set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 9400, method: 'tools/list', params: {} });

    const tools = res.body.result.tools;
    assert.ok(tools.length > 1, 'there is a list to check');
    assert.ok(!JSON.stringify(res.body).includes('draft-07'), 'a draft-07 dialect reached a client');

    const SUPPORTED = 'https://json-schema.org/draft/2020-12/schema';
    for (const tool of tools) {
      for (const which of ['inputSchema', 'outputSchema']) {
        const schema = tool[which];
        if (!schema) continue;
        assert.equal(schema.$schema, SUPPORTED, `${tool.name}.${which} declares ${schema.$schema}`);
        // Said once rather than inferred: the 2020-12 claim is only free while
        // nothing tuple-shaped or reused is in there, which is all the two
        // dialects disagree about for these shapes. By keyword and not by
        // substring — get_kpis returns a glossary in a field it calls
        // `definitions`, and a search for the text finds that and reports a
        // draft-7 keyword block that is not there.
        for (const [keyword, path] of dialectKeywords(schema, which)) {
          assert.fail(`${tool.name}.${which} uses ${keyword} at ${path}, so the dialect it declares is no longer free`);
        }
      }
    }

    // The correction replaces a line; it does not rewrite the shapes. The
    // output contract is what makes a query that stops returning a column
    // fail loudly, so a flattened schema would cost that quietly.
    const tasks = tools.find((x) => x.name === 'list_tasks');
    assert.equal(tasks.outputSchema.type, 'object');
    for (const field of ['items', 'total', 'offset', 'limit', 'has_more']) {
      assert.ok(tasks.outputSchema.properties[field], `list_tasks no longer declares ${field}`);
    }
    assert.ok(tasks.inputSchema.properties.limit, 'list_tasks no longer declares its limit argument');

    // And it still validates: structuredContent is checked against the Zod
    // schema, not the JSON Schema, so correcting the dialect must not have
    // bought compatibility by dropping the check.
    const listed = await call(t, 'list_tasks');
    assert.equal(listed.error, false, listed.text);
    assert.ok(Array.isArray(JSON.parse(listed.text).items), 'list_tasks still answers with its declared shape');
  });

  test('a reading token is not offered complete_task', async () => {
    const t = (await token({ name: 'Reader', role: 'admin' })).token;
    const res = await request(app).post('/api/mcp').set('Authorization', `Bearer ${t}`).set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 9001, method: 'tools/list', params: {} });
    const names = res.body.result.tools.map((x) => x.name);
    assert.ok(names.includes('list_tasks'), 'it may read tasks');
    assert.ok(!names.includes('complete_task'), 'a tool it would be refused is worse than no tool');
  });

  test('an admin token sees everything', async () => {
    const admin = (await token({ name: 'Admin', role: 'admin' })).token;
    const pipeline = await call(admin, 'list_pipeline');
    assert.match(pipeline.text, /QT-ASHA/);
    assert.match(pipeline.text, /QT-RAVI/);
    assert.ok(JSON.parse((await call(admin, 'get_kpis', { from: '2026-01-01', to: '2026-12-31' })).text).quotations_issued >= 2);
  });

  test('writes are marked as made through MCP and logged', async () => {
    const asha = await token({ name: 'Asha writes', role: 'sales', person: 'Asha', can_write: true });
    const note = await call(asha.token, 'add_note', { entity: 'quotation', id: 'QT-ASHA', text: 'Client asked for a call on Friday' });
    assert.equal(note.error, false, note.text);
    assert.equal((await call(asha.token, 'update_next_step', { quotation_no: 'QT-ASHA', next_step: 'Call on Friday' })).error, false);
    const timeline = await request(app).get('/api/timeline?entity=quotation&id=QT-ASHA&kind=note').set('Cookie', staff);
    assert.match(JSON.stringify(timeline.body), /via MCP/);
    const list = await request(app).get('/api/api-tokens').set('Cookie', staff);
    assert.ok(list.body.log.some((l) => l.tool === 'add_note' && l.name === 'Asha writes'));
    assert.ok(!JSON.stringify(list.body).includes(asha.token), 'the token value is never listed');
  });

  test('a token reads unless it was given writing, and does not pretend otherwise', async () => {
    // role says whose records a token sees; it never said whether the token
    // may change them, so a token issued to answer questions could write
    // notes and tasks on everything it could see (#50).
    const reader = await token({ name: 'Reads only', role: 'admin' });
    assert.equal(reader.can_write, false, 'a token asked for without saying otherwise is a reading token');

    const tools = await request(app).post('/api/mcp').set('Authorization', `Bearer ${reader.token}`).set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 300, method: 'tools/list' });
    const names = tools.body.result.tools.map((t) => t.name);
    for (const w of ['create_task', 'add_note', 'log_touch', 'update_next_step']) {
      assert.ok(!names.includes(w), `${w} is offered to a token that may not write`);
    }
    assert.ok(names.includes('list_pipeline'), 'and it can still do its job');
    assert.match(tools.body.result.tools.length ? JSON.stringify(tools.body) : '', /list_pipeline/);

    // Not merely hidden: asked for by name, it is refused.
    const tried = await call(reader.token, 'add_note', { entity: 'quotation', id: 'QT-ASHA', text: 'Trying to write' });
    assert.ok(tried.error || tried.status !== 200, 'a hidden tool is still refused when called directly');
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM notes WHERE body = 'Trying to write'`);
    assert.equal(rows[0].n, 0, 'and nothing was written');

    // A token given writing still writes.
    const writer = await token({ name: 'May write', role: 'admin', can_write: true });
    assert.equal(writer.can_write, true);
    const wrote = await call(writer.token, 'add_note', { entity: 'quotation', id: 'QT-ASHA', text: 'A note from a writing token' });
    assert.equal(wrote.error, false, wrote.text);
  });

  test('a database error is not handed to the client verbatim', async () => {
    // 31 February passes the YYYY-MM-DD check and fails in Postgres. The
    // raw text names the column and the value, and it is written to the
    // token log, which every signed-in person can read.
    const t = await token({ name: 'Clumsy', role: 'admin', can_write: true });
    const bad = await call(t.token, 'create_task', { entity: 'quotation', id: 'QT-ASHA', title: 'A task with an impossible date', due_on: '2026-02-31' });
    assert.equal(bad.error, true);
    assert.doesNotMatch(bad.text, /out of range|due_on|column|relation|syntax/i, `raw database text reached the client: ${bad.text}`);
    assert.match(bad.text, /could not do that/);

    // The detail is not lost: it is in the log, where it belongs.
    const { rows } = await pool.query(`SELECT error FROM api_token_log WHERE tool = 'create_task' AND NOT ok ORDER BY id DESC LIMIT 1`);
    assert.match(rows[0].error, /date|range/i, 'the reason is recorded for whoever has to fix it');

    // And what the tracker does mean to say still reaches the client: a
    // record this token may not see is named as not found, not masked.
    const sales = await token({ name: 'Asha reads', role: 'sales', person: 'asha', can_write: true });
    const notMine = await call(sales.token, 'create_task', { entity: 'quotation', id: 'QT-RAVI', title: 'A task on a deal that is not theirs' });
    assert.equal(notMine.error, true);
    assert.match(notMine.text, /was not found/);
  });

  test('the rate limit is one budget per token, not one for everybody', async () => {
    // Behind a proxy every MCP client arrives from the same address, so an
    // address bucket is shared by all of them: one busy client starves the
    // rest. #50 asks for it to be per token.
    const a = await token({ name: 'Client A', role: 'admin' });
    const b = await token({ name: 'Client B', role: 'admin' });
    const remaining = async (tok) => {
      const res = await request(app).post('/api/mcp').set('Authorization', `Bearer ${tok}`).set('Accept', 'application/json, text/event-stream')
        .send({ jsonrpc: '2.0', id: 500, method: 'tools/list' });
      return Number(res.headers['ratelimit-remaining']);
    };
    const first = await remaining(a.token);
    const second = await remaining(a.token);
    assert.equal(second, first - 1, 'the same token spends its own budget');
    const other = await remaining(b.token);
    assert.equal(other, first, 'a different token starts from its own, not from what the first one left');
  });

  test('revoking a token stops it at once, and nothing destructive exists', async () => {
    const t = await token({ name: 'Short lived', role: 'admin', can_write: true });
    const tools = await request(app).post('/api/mcp').set('Authorization', `Bearer ${t.token}`).set('Accept', 'application/json, text/event-stream').send({ jsonrpc: '2.0', id: 99, method: 'tools/list' });
    const names = tools.body.result.tools.map((x) => x.name);
    assert.ok(names.length >= 27, `only ${names.length} tools are offered`);
    assert.ok(names.length >= 19, `only ${names.length} tools are offered`);
    // Every name is verb_noun, so the verb is what decides whether the tool
    // could do damage. Matching anywhere in the name read 'pay' inside
    // list_payables and called a read destructive, which is the kind of
    // false alarm that gets a guard deleted.
    for (const n of names) {
      assert.doesNotMatch(n, /^(delete|remove|drop|void|cancel|pay|send|reassign|set)_/, `${n} names something this server must not be able to do`);
      assert.match(n, /^(get|list|search|add|create|log|update|complete|plan|replan|commit|import|describe)_|^aggregate$/, `${n} is a verb this server has not agreed to`);
    }
    await request(app).post(`/api/api-tokens/${t.id}/revoke`).set('Cookie', staff).expect(200);
    assert.equal((await call(t.token, 'list_pipeline')).status, 401);
    assert.equal((await call('ctz_not-a-real-token-at-all-000000000000', 'list_pipeline')).status, 401);
    assert.equal((await request(app).post('/api/mcp').send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 401);
  });
});
