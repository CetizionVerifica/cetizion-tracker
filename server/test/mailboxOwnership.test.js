import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * Each salesperson's own mailbox (docs/per-user-mailboxes-plan.md §7).
 *
 * Two sales users, A and B, each with a personal mailbox; one shared
 * mailbox with an Inbox; an admin. In `AUTH_MODE=database`, which is the
 * only mode with two people to tell apart. Mail goes in through the
 * in-memory `test` provider and the real sync, as Microsoft 365 mail does;
 * no AI key is configured, so the rules decide.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const PASSWORD = 'a-good-long-test-password';
const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
const NAME = `mailbox_ownership_${process.pid}`;

let app; let db; let pool; let sync;
let admin; let salesA; let salesB;
let boxA; let boxB; let shared;
let n = 0;
const uid = (p) => `${p}-${process.pid}-${(n += 1)}`;

const as = (who) => (method, path) => {
  const call = request(app)[method](path);
  return who.cookie ? call.set('Cookie', who.cookie) : call;
};

async function mailbox({ shared: isShared = false, userId = null, email = `${uid('box')}@cetizionverifica.com`, visibility = 'share_everything' } = {}) {
  const { rows: [a] } = await db.query(
    `INSERT INTO connected_accounts (username, provider, email, is_shared, visibility, import_days, user_id, read_scope)
     VALUES ('legacy-name','test',$1,$2,$3,30,$4,$5) RETURNING *`,
    [email, isShared, visibility, isShared ? null : userId, isShared ? 'all' : 'inbox_sent']);
  if (isShared) await db.query(`INSERT INTO inboxes (name, account_id, default_assignment) VALUES ($1, $2, 'unassigned')`, [`Inbox ${a.id}`, a.id]);
  return a;
}

const rfq = (over = {}) => ({
  provider_id: uid('m'), conversation_id: uid('conv'), internet_message_id: `<${uid('mid')}@client>`,
  from: { email: `buyer@${uid('client')}.com`, name: 'Buyer' }, to: [{ email: 'sales@cetizionverifica.com' }], cc: [],
  subject: 'Request for quotation: EcoVadis assessment',
  body_html: '<p>Dear team, we are interested in EcoVadis certification for our plant. Please share your proposal and fee.</p>',
  sent_at: new Date().toISOString(), ...over,
});

async function deliver(account, messages) {
  sync.pushTestMessages(account.id, messages);
  return sync.syncAccount(account.id);
}

/** A thread filed straight into a mailbox, on a record or on nothing. */
async function thread(account, { entity = null, entityId = null, subject = 'A thread' } = {}) {
  const { rows: [t] } = await db.query(
    `INSERT INTO email_threads (account_id, conversation_id, subject, entity, entity_id, first_message_at, last_message_at, message_count, last_direction)
     VALUES ($1,$2,$3,$4,$5,now(),now(),1,'inbound') RETURNING *`, [account.id, uid('conv'), subject, entity, entityId]);
  return t;
}

const threadIds = (res) => res.body.data.map((t) => t.id ?? t.thread_id).sort();

describe('each salesperson\'s own mailbox', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  before(async () => {
    const owner = new pg.Client({ connectionString: ADMIN_URL });
    await owner.connect();
    await owner.query(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`);
    await owner.query(`CREATE DATABASE ${NAME}`);
    await owner.end();
    const url = new URL(ADMIN_URL); url.pathname = `/${NAME}`;
    db = new pg.Client({ connectionString: url.toString() });
    await db.connect();
    for (const f of ['schema.sql', 'views.sql', 'seed.sql']) await db.query(readFileSync(join(DB_DIR, f), 'utf8'));

    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = url.toString();
    process.env.AUTH_MODE = 'database';
    process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-to-pass';
    process.env.EMAIL_MODE = 'log';
    delete process.env.OPENROUTER_API_KEY;

    ({ default: app } = await import('../src/app.js'));
    ({ pool } = await import('../src/db.js'));
    sync = await import('../src/lib/mailbox/sync.js');
    (await import('../src/lib/ai.js')).aiConfig.enabled = false;
    const { createUser } = await import('../src/lib/users.js');
    const { loginLimiter } = await import('../src/auth/routes.js');

    const signIn = async (email) => {
      for (const ip of ['::ffff:127.0.0.1', '127.0.0.1', '::1']) { try { loginLimiter.resetKey(ip); } catch { /* unknown key */ } }
      const res = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      return res.headers['set-cookie'];
    };
    const a = await createUser({ name: 'Ada Admin', email: 'ada@example.com', password: PASSWORD, role: 'admin' }, db);
    const s1 = await createUser({ name: 'Sam Sales', email: 'sam@example.com', password: PASSWORD, role: 'sales' }, db);
    const s2 = await createUser({ name: 'Bea Sales', email: 'bea@example.com', password: PASSWORD, role: 'sales' }, db);
    admin = { user: a, cookie: await signIn(a.email) };
    salesA = { user: s1, cookie: await signIn(s1.email) };
    salesB = { user: s2, cookie: await signIn(s2.email) };

    // A's mailbox address differs from A's login address on purpose (plan §7.4).
    boxA = await mailbox({ userId: s1.id, email: 'sam.sales@cetizionverifica.com' });
    boxB = await mailbox({ userId: s2.id, email: 'bea@cetizionverifica.com' });
    shared = await mailbox({ shared: true, email: 'sales@cetizionverifica.com' });
  });

  after(async () => {
    await pool?.end();
    await db?.end();
    const owner = new pg.Client({ connectionString: ADMIN_URL });
    await owner.connect();
    await owner.query(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`);
    await owner.end();
  });

  test('the schema: a shared mailbox cannot carry a personal owner', async () => {
    await assert.rejects(
      db.query(`INSERT INTO connected_accounts (username, provider, email, is_shared, user_id) VALUES ('x','test','wrong@cetizionverifica.com',true,$1)`, [salesA.user.id]),
      /connected_accounts_shared_unowned/);
  });

  test('each person lists their own mailbox and the shared one; the admin lists all three, with owners', async () => {
    const a = await as(salesA)('get', '/api/mailboxes');
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.deepEqual(a.body.data.map((m) => m.id).sort(), [boxA.id, shared.id].sort());

    const b = await as(salesB)('get', '/api/mailboxes');
    assert.deepEqual(b.body.data.map((m) => m.id).sort(), [boxB.id, shared.id].sort());

    const all = await as(admin)('get', '/api/mailboxes');
    assert.deepEqual(all.body.data.map((m) => m.id).sort(), [boxA.id, boxB.id, shared.id].sort());
    const mine = all.body.data.find((m) => m.id === boxA.id);
    assert.deepEqual(mine.owner, { id: salesA.user.id, name: 'Sam Sales', active: true });
    assert.equal(mine.read_scope, 'inbox_sent');
    assert.equal(all.body.data.find((m) => m.id === shared.id).owner, null);
  });

  test('B\'s mailbox is not there for A: 404 on settings, sync, re-read and disconnect, and nothing changes', async () => {
    for (const [method, path, body] of [
      ['patch', `/api/mailboxes/${boxB.id}`, { visibility: 'metadata' }],
      ['post', `/api/mailboxes/${boxB.id}/sync`, {}],
      ['post', `/api/mailboxes/${boxB.id}/refresh-bodies`, { days: 7 }],
      ['post', `/api/mailboxes/${boxB.id}/disconnect`, {}],
    ]) {
      const res = await as(salesA)(method, path).send(body);
      assert.equal(res.status, 404, `${method} ${path}: ${JSON.stringify(res.body)}`);
    }
    const { rows: [b] } = await db.query('SELECT status, visibility FROM connected_accounts WHERE id = $1', [boxB.id]);
    assert.equal(b.status, 'active');
    assert.equal(b.visibility, 'share_everything');
  });

  test('A may tune their own mailbox, including which folders are read, but not make it shared', async () => {
    const ok = await as(salesA)('patch', `/api/mailboxes/${boxA.id}`).send({ read_scope: 'all', import_days: 60 });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.data.read_scope, 'all');

    const no = await as(salesA)('patch', `/api/mailboxes/${boxA.id}`).send({ is_shared: true });
    assert.equal(no.status, 403, JSON.stringify(no.body));

    const sharedToo = await as(salesA)('patch', `/api/mailboxes/${shared.id}`).send({ visibility: 'metadata' });
    assert.equal(sharedToo.status, 404, 'a shared mailbox is read by the team but run by an admin');

    const owner = await as(salesA)('patch', `/api/mailboxes/${boxA.id}/owner`).send({ user_id: salesB.user.id });
    assert.equal(owner.status, 403);
    await as(salesA)('patch', `/api/mailboxes/${boxA.id}`).send({ read_scope: 'inbox_sent', import_days: 30 });
  });

  test('a thread in B\'s mailbox is A\'s to see only when it sits on a record A owns, by owner_user_id', async () => {
    await db.query(`INSERT INTO enquiries (enquiry_no, client_name, sales_person, owner_user_id) VALUES ('CTZ/ENQ/2026/801', 'Owned Client', 'Sam Sales', $1)`, [salesA.user.id]);
    // The text name says A, the owner column says B: the column wins.
    await db.query(`INSERT INTO enquiries (enquiry_no, client_name, sales_person, owner_user_id) VALUES ('CTZ/ENQ/2026/802', 'Named Client', 'Sam Sales', $1)`, [salesB.user.id]);
    const onMine = await thread(boxB, { entity: 'enquiry', entityId: 'CTZ/ENQ/2026/801', subject: 'About your deal' });
    const onTheirs = await thread(boxB, { entity: 'enquiry', entityId: 'CTZ/ENQ/2026/802', subject: 'Named but not owned' });
    const onNothing = await thread(boxB, { subject: 'Private' });

    const yes = await as(salesA)('get', `/api/mail/threads/${onMine.id}`);
    assert.equal(yes.status, 200, JSON.stringify(yes.body));
    for (const t of [onTheirs, onNothing]) {
      const res = await as(salesA)('get', `/api/mail/threads/${t.id}`);
      assert.equal(res.status, 404, `thread ${t.subject}`);
    }
    // Reading is not speaking: the thread is visible, the mailbox is not A's to send from.
    const reply = await as(salesA)('post', `/api/mail/threads/${onMine.id}/reply`).send({ html: '<p>Hello</p>' });
    assert.equal(reply.status, 404, JSON.stringify(reply.body));
    const relink = await as(salesA)('patch', `/api/mail/threads/${onMine.id}`).send({ entity: null, entity_id: null });
    assert.equal(relink.status, 404);

    const list = await as(salesA)('get', '/api/mail/threads?entity=enquiry&id=CTZ/ENQ/2026/801');
    assert.deepEqual(threadIds(list), [onMine.id]);
  });

  test('a shared client\'s timeline shows A nothing from B\'s personal mailbox (the leak the plan names)', async () => {
    const { rows: [co] } = await db.query(`INSERT INTO companies (name) VALUES ('Shared Client Pvt Ltd') RETURNING id`);
    const { rows: [fromB] } = await db.query(
      `INSERT INTO email_threads (account_id, conversation_id, subject, company_id, first_message_at, last_message_at, message_count, last_direction)
       VALUES ($1,$2,'Bea and the client',$3,now(),now(),1,'inbound') RETURNING id`, [boxB.id, uid('conv'), co.id]);
    const { rows: [fromShared] } = await db.query(
      `INSERT INTO email_threads (account_id, conversation_id, subject, company_id, first_message_at, last_message_at, message_count, last_direction)
       VALUES ($1,$2,'The team and the client',$3,now(),now(),1,'inbound') RETURNING id`, [shared.id, uid('conv'), co.id]);

    const seenByA = await as(salesA)('get', `/api/timeline?entity=company&id=${co.id}&kind=email`);
    assert.equal(seenByA.status, 200, JSON.stringify(seenByA.body));
    assert.deepEqual(seenByA.body.data.map((i) => i.thread_id).sort(), [fromShared.id]);
    assert.ok(!JSON.stringify(seenByA.body).includes('Bea and the client'));

    const seenByAdmin = await as(admin)('get', `/api/timeline?entity=company&id=${co.id}&kind=email`);
    assert.deepEqual(seenByAdmin.body.data.map((i) => i.thread_id).sort(), [fromB.id, fromShared.id].sort());

    const viaThreads = await as(salesA)('get', `/api/mail/threads?company_id=${co.id}`);
    assert.deepEqual(threadIds(viaThreads), [fromShared.id]);
  });

  test('an enquiry read from A\'s mailbox belongs to A, whatever the mailbox\'s address; B cannot open it, the admin can', async () => {
    await deliver(boxA, [rfq()]);
    const { rows: [d] } = await db.query(`SELECT enquiry_no FROM email_enquiry_decisions WHERE account_id = $1 AND outcome = 'created'`, [boxA.id]);
    assert.ok(d?.enquiry_no, 'the enquiry was created');
    const { rows: [e] } = await db.query('SELECT owner_user_id, sales_person FROM enquiries WHERE enquiry_no = $1', [d.enquiry_no]);
    assert.equal(e.owner_user_id, salesA.user.id);
    assert.equal(e.sales_person, 'Sam Sales');

    const mine = await as(salesA)('get', `/api/enquiries?limit=500`);
    assert.equal(mine.status, 200);
    assert.ok(mine.body.data.some((r) => r.enquiry_no === d.enquiry_no), 'A sees it');
    const theirs = await as(salesB)('get', `/api/enquiries?limit=500`);
    assert.ok(!theirs.body.data.some((r) => r.enquiry_no === d.enquiry_no), 'B does not');
    const all = await as(admin)('get', `/api/enquiries?limit=500`);
    assert.ok(all.body.data.some((r) => r.enquiry_no === d.enquiry_no), 'the admin does');

    // A's own thread, and the record it made, are A's to read through every door.
    const origin = await as(salesA)('get', `/api/mail/origin?entity=enquiry&id=${encodeURIComponent(d.enquiry_no)}`);
    assert.equal(origin.status, 200);
    assert.ok(origin.body.data.thread_id, 'A reaches the thread it came from');
  });

  test('the same email in the shared mailbox and then in A\'s: the enquiry made unowned becomes A\'s', async () => {
    const m = rfq({ from: { email: 'procurement@twice-seen.com', name: 'P' } });
    await deliver(shared, [m]);
    const { rows: [d] } = await db.query(`SELECT enquiry_no FROM email_enquiry_decisions WHERE account_id = $1 AND outcome = 'created' ORDER BY id DESC LIMIT 1`, [shared.id]);
    const { rows: [before] } = await db.query('SELECT owner_user_id FROM enquiries WHERE enquiry_no = $1', [d.enquiry_no]);
    assert.equal(before.owner_user_id, null, 'a shared mailbox with no assignee leaves it unowned');

    await deliver(boxA, [{ ...m, provider_id: uid('m') }]);
    const { rows: [linked] } = await db.query(`SELECT outcome FROM email_enquiry_decisions WHERE account_id = $1 AND enquiry_no = $2`, [boxA.id, d.enquiry_no]);
    assert.equal(linked.outcome, 'linked');
    const { rows: [after] } = await db.query('SELECT owner_user_id, sales_person FROM enquiries WHERE enquiry_no = $1', [d.enquiry_no]);
    assert.equal(after.owner_user_id, salesA.user.id);
    assert.equal(after.sales_person, 'Sam Sales');
  });

  test('an enquiry that already names a salesperson is not re-attributed when a copy lands in A\'s mailbox', async () => {
    const m = rfq({ from: { email: 'buyer@attributed-only.com', name: 'B' } });
    await deliver(shared, [m]);
    const { rows: [d] } = await db.query(`SELECT enquiry_no FROM email_enquiry_decisions WHERE account_id = $1 AND outcome = 'created' ORDER BY id DESC LIMIT 1`, [shared.id]);
    // A workbook attribution: a name, no users row.
    await db.query(`UPDATE enquiries SET sales_person = 'Ramesh (left 2024)' WHERE enquiry_no = $1`, [d.enquiry_no]);
    await deliver(boxA, [{ ...m, provider_id: uid('m') }]);
    const { rows: [e] } = await db.query('SELECT owner_user_id, sales_person FROM enquiries WHERE enquiry_no = $1', [d.enquiry_no]);
    assert.equal(e.owner_user_id, null);
    assert.equal(e.sales_person, 'Ramesh (left 2024)');
  });

  test('a shared mailbox that feeds an Inbox cannot be made personal until the Inbox goes', async () => {
    const res = await as(admin)('patch', `/api/mailboxes/${shared.id}`).send({ is_shared: false });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    const { rows: [a] } = await db.query('SELECT is_shared FROM connected_accounts WHERE id = $1', [shared.id]);
    assert.equal(a.is_shared, true);
  });

  test('reassigning a mailbox: new mail goes to the new owner, old records stay, and it is logged', async () => {
    const res = await as(admin)('patch', `/api/mailboxes/${boxB.id}/owner`).send({ user_id: salesA.user.id });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.data.owner, { id: salesA.user.id, name: 'Sam Sales' });

    const { rows: [log] } = await db.query(`SELECT * FROM activity_log WHERE action = 'mailbox.owner_changed' ORDER BY id DESC LIMIT 1`);
    assert.equal(log.entity_id, String(boxB.id));
    assert.equal(log.metadata.old_user_id, salesB.user.id);
    assert.equal(log.metadata.new_user_id, salesA.user.id);

    await deliver(boxB, [rfq({ from: { email: 'new@after-reassign.com', name: 'N' } })]);
    const { rows: [d] } = await db.query(`SELECT enquiry_no FROM email_enquiry_decisions WHERE account_id = $1 AND outcome = 'created' ORDER BY id DESC LIMIT 1`, [boxB.id]);
    const { rows: [e] } = await db.query('SELECT owner_user_id FROM enquiries WHERE enquiry_no = $1', [d.enquiry_no]);
    assert.equal(e.owner_user_id, salesA.user.id);
    // B's earlier enquiry (802) did not move.
    const { rows: [old] } = await db.query(`SELECT owner_user_id FROM enquiries WHERE enquiry_no = 'CTZ/ENQ/2026/802'`);
    assert.equal(old.owner_user_id, salesB.user.id);

    // Now B lists only the shared mailbox; A lists both personal ones.
    const b = await as(salesB)('get', '/api/mailboxes');
    assert.deepEqual(b.body.data.map((m) => m.id), [shared.id]);

    // Refusals on the owner route itself.
    const toShared = await as(admin)('patch', `/api/mailboxes/${shared.id}/owner`).send({ user_id: salesA.user.id });
    assert.equal(toShared.status, 422);
    const toNobody = await as(admin)('patch', `/api/mailboxes/${boxB.id}/owner`).send({ user_id: 999999 });
    assert.equal(toNobody.status, 422);

    // Given back, for the tests below.
    await as(admin)('patch', `/api/mailboxes/${boxB.id}/owner`).send({ user_id: salesB.user.id });
  });

  test('a shared mailbox with named Inbox members is theirs: membership is case-folded, the assignee counts, and the conversation update is scoped', async () => {
    // The team Inbox names B by her name, typed with capitals (plan §1).
    await db.query(`UPDATE inboxes SET members = ARRAY['Bea Sales'] WHERE account_id = $1`, [shared.id]);
    const teamThread = await thread(shared, { subject: 'For the sales team' });
    const { rows: [conv] } = await db.query(
      `INSERT INTO inbox_conversations (inbox_id, thread_id, from_email, status, assignee) VALUES ((SELECT id FROM inboxes WHERE account_id = $1), $2, 'buyer@x.com', 'open', 'bea sales') RETURNING id`, [shared.id, teamThread.id]);
    try {
      const forB = await as(salesB)('get', `/api/mail/threads/${teamThread.id}`);
      assert.equal(forB.status, 200, 'a member, whatever the case her name was typed in');
      const forA = await as(salesA)('get', `/api/mail/threads/${teamThread.id}`);
      assert.equal(forA.status, 404, 'neither a member nor the assignee: not there');
      assert.ok(!(await as(salesA)('get', '/api/mailboxes')).body.data.some((m) => m.id === shared.id), 'nor listed as readable');

      const patchA = await as(salesA)('patch', `/api/inbox/${conv.id}`).send({ priority: 'high' });
      assert.equal(patchA.status, 404, 'a conversation in somebody else\'s queue is not there to change');
      const patchB = await as(salesB)('patch', `/api/inbox/${conv.id}`).send({ assignee: 'Sam Sales' });
      assert.equal(patchB.status, 200, JSON.stringify(patchB.body));

      // Assigned to A: the thread is A's to read now, though A is no member.
      const forAssigned = await as(salesA)('get', `/api/mail/threads/${teamThread.id}`);
      assert.equal(forAssigned.status, 200, JSON.stringify(forAssigned.body));
      // A hands it back to B: the change is saved and answered with the row, not a 404 for a conversation now out of A's scope.
      const handBack = await as(salesA)('patch', `/api/inbox/${conv.id}`).send({ assignee: 'Bea Sales' });
      assert.equal(handBack.status, 200, JSON.stringify(handBack.body));
      assert.equal(handBack.body.data.assignee, 'Bea Sales');
      assert.equal((await as(salesA)('get', `/api/mail/threads/${teamThread.id}`)).status, 404, 'and it is gone from A\'s view');
    } finally {
      await db.query(`UPDATE inboxes SET members = '{}' WHERE account_id = $1`, [shared.id]);
    }
  });

  test('a review item from A\'s own mailbox is A\'s to see even with no quotation suggested', async () => {
    await db.query(
      `INSERT INTO email_po_decisions (account_id, provider_id, internet_message_id, received_at, from_email, outcome, method, ai_calls, review_reason, mode)
       VALUES ($1, $2, $3, now(), 'buyer@nowhere.com', 'review', 'rules', 0, 'no_match', 'live')`, [boxA.id, uid('m'), `<${uid('mid')}@x>`]);
    const a = await as(salesA)('get', '/api/purchase-orders/review');
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.ok(a.body.data.some((r) => r.mailbox === boxA.email), 'A sees the item from their mailbox');
    const b = await as(salesB)('get', '/api/purchase-orders/review');
    assert.ok(!b.body.data.some((r) => r.mailbox === boxA.email), 'B does not');
  });

  test('deactivating A disconnects A\'s mailbox and stops its sync; the mailbox stays listed for the admin', async () => {
    const res = await as(admin)('patch', `/api/users/${salesA.user.id}`).send({ active: false });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.data.mailboxes_disconnected, [boxA.email]);

    const { rows: [a] } = await db.query('SELECT status, tokens_encrypted, user_id FROM connected_accounts WHERE id = $1', [boxA.id]);
    assert.equal(a.status, 'disconnected');
    assert.equal(a.tokens_encrypted, null);
    // The mail it held stays: it is the records' history, not the leaver's.
    const { rows: [kept] } = await db.query(`SELECT count(*)::int AS n FROM email_messages WHERE account_id = $1 AND body_html IS NOT NULL`, [boxA.id]);
    assert.ok(kept.n > 0, 'bodies kept on deactivation');
    assert.equal(a.user_id, salesA.user.id, 'still listed as A\'s, for the admin');
    const r = await sync.syncAccount(boxA.id);
    assert.equal(r.skipped, 'not active');

    const all = await as(admin)('get', '/api/mailboxes');
    assert.ok(all.body.data.some((m) => m.id === boxA.id && m.status === 'disconnected'));
  });
});
