import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * The Inbox like Outlook, step 2: reading (docs/inbox-outlook-plan.md §3.3,
 * §7). A mailbox's folders with Outlook's counts, a folder's conversations,
 * one message with its recipients and attachments, the attachments
 * themselves, and the owner's live read of a body the mailbox does not
 * store — which stores nothing.
 *
 * Two sales users, each with a personal mailbox, a shared mailbox with an
 * Inbox, an admin; AUTH_MODE=database. Mail goes in through the in-memory
 * `test` provider and the real sync.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const PASSWORD = 'a-good-long-test-password';
const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
const NAME = `inbox_reading_${process.pid}`;

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
     VALUES ('legacy-name','test',$1,$2,$3,30,$4,'all') RETURNING *`,
    [email, isShared, visibility, isShared ? null : userId]);
  if (isShared) await db.query(`INSERT INTO inboxes (name, account_id, default_assignment) VALUES ($1, $2, 'unassigned')`, [`Inbox ${a.id}`, a.id]);
  return a;
}

const mail = (over = {}) => ({
  provider_id: uid('m'), conversation_id: uid('conv'), internet_message_id: `<${uid('mid')}@client>`,
  from: { email: 'ravi@acme-steel.co.in', name: 'Ravi' }, to: [{ email: 'sam.sales@cetizionverifica.com' }], cc: [{ email: 'cc@acme-steel.co.in', name: 'CC Person' }],
  subject: 'Pressure vessel audit', body_html: '<p>Please quote.</p>', sent_at: new Date().toISOString(),
  is_read: false, flag_status: 'notFlagged', importance: 'normal', ...over,
});

async function deliver(account, messages) {
  sync.pushTestMessages(account.id, messages);
  return sync.syncAccount(account.id);
}
const stored = async (providerId) => (await db.query('SELECT * FROM email_messages WHERE provider_id = $1', [providerId])).rows[0];

describe('reading mail as Outlook shows it', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
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
    await import('../src/lib/inbox.js');
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

    // A's mailbox stores subjects only: the body is the owner's to read live.
    boxA = await mailbox({ userId: s1.id, email: 'sam.sales@cetizionverifica.com', visibility: 'subject' });
    boxB = await mailbox({ userId: s2.id, email: 'bea@cetizionverifica.com' });
    shared = await mailbox({ shared: true, email: 'sales@cetizionverifica.com' });
    // The client is on file, so a personal mailbox keeps the mail.
    const { rows: [co] } = await db.query(`INSERT INTO companies (name, website) VALUES ('Acme Steel', 'https://acme-steel.co.in') RETURNING id`);
    await db.query(`INSERT INTO contacts (company_id, name, email) VALUES ($1, 'Ravi', 'ravi@acme-steel.co.in')`, [co.id]);
    sync.pushTestFolders(boxA.id, [
      { folder_id: 'inbox', parent_id: null, display_name: 'Inbox', well_known: 'inbox', unread_count: 3, total_count: 9 },
      { folder_id: 'sentitems', parent_id: null, display_name: 'Sent Items', well_known: 'sentitems', unread_count: 0, total_count: 4 },
      { folder_id: 'drafts', parent_id: null, display_name: 'Drafts', well_known: 'drafts', unread_count: 0, total_count: 1 },
      { folder_id: 'Clients', parent_id: null, display_name: 'Clients', well_known: null, unread_count: 1, total_count: 2 },
      { folder_id: 'Clients/Hindalco', parent_id: 'Clients', display_name: 'Hindalco', well_known: null, unread_count: 0, total_count: 1 },
    ]);
  });

  after(async () => {
    await pool?.end();
    await db?.end();
    const owner = new pg.Client({ connectionString: ADMIN_URL });
    await owner.connect();
    await owner.query(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`);
    await owner.end();
  });

  test('the switcher lists the caller\'s own mailbox with Outlook\'s folders and counts, never a colleague\'s; an admin sees every folder list', async () => {
    await deliver(boxA, [mail()]);
    const mine = await as(salesA)('get', '/api/mail/mailboxes');
    assert.equal(mine.status, 200, JSON.stringify(mine.body));
    const ids = mine.body.data.map((b) => b.id);
    assert.ok(ids.includes(boxA.id), 'A sees A\'s mailbox');
    assert.ok(ids.includes(shared.id), 'and the shared one, whose Inbox names nobody');
    assert.ok(!ids.includes(boxB.id), 'not B\'s');
    const a = mine.body.data.find((b) => b.id === boxA.id);
    assert.equal(a.mine, true);
    assert.deepEqual(a.folders.map((f) => f.display_name), ['Inbox', 'Sent Items', 'Clients', 'Hindalco'], 'well-known first in Outlook\'s order, then by name; Drafts waits for compose');
    assert.equal(a.folders[0].unread_count, 3, 'Outlook\'s own count');
    assert.equal(a.folders[3].parent_id, 'Clients', 'nesting is kept');
    assert.ok(!('tokens_encrypted' in a));

    const all = await as(admin)('get', '/api/mail/mailboxes');
    assert.ok(all.body.data.map((b) => b.id).includes(boxB.id), 'an admin sees every mailbox');
    assert.equal(all.body.data.find((b) => b.id === boxA.id).mine, false);
  });

  test('a folder lists one row per conversation, newest first, with unread, flag, paperclip and To in Sent Items', async () => {
    const box = await mailbox({ userId: salesB.user.id, email: `${uid('b')}@cetizionverifica.com` });
    const conv = uid('conv');
    const t0 = Date.now() - 3600e3;
    await deliver(box, [
      mail({ conversation_id: conv, subject: 'Thread one', sent_at: new Date(t0).toISOString(), is_read: true }),
      mail({ conversation_id: conv, subject: 'RE: Thread one', sent_at: new Date(t0 + 60e3).toISOString(), is_read: false, has_attachments: true, attachments: [{ name: 'spec.pdf', contentType: 'application/pdf', content: Buffer.from('%PDF-1.4 test') }] }),
      mail({ subject: 'Thread two', sent_at: new Date(t0 - 60e3).toISOString(), is_read: true, flag_status: 'flagged', importance: 'high' }),
      { ...mail({ subject: 'Our reply', sent_at: new Date(t0 + 120e3).toISOString(), is_read: true }), folder: 'sentitems', from: { email: box.email, name: 'Bea' }, to: [{ email: 'ravi@acme-steel.co.in', name: 'Ravi' }] },
    ]);
    const inbox = await as(salesB)('get', `/api/mail/folders/${box.id}/inbox/messages`);
    assert.equal(inbox.status, 200, JSON.stringify(inbox.body));
    assert.equal(inbox.body.meta.total, 2, 'two conversations, not three messages');
    const [one, two] = inbox.body.data;
    assert.equal(one.subject, 'RE: Thread one', 'the newest message stands for the conversation');
    assert.equal(one.in_folder, 2);
    assert.equal(one.unread, true, 'one of its messages is unread');
    assert.equal(one.has_attachments, true);
    assert.equal(one.flagged, false);
    assert.equal(two.subject, 'Thread two');
    assert.equal(two.unread, false);
    assert.equal(two.flagged, true);
    assert.equal(two.importance, 'high');
    assert.equal(two.company_name, 'Acme Steel', 'the row already knows its company');

    const unread = await as(salesB)('get', `/api/mail/folders/${box.id}/inbox/messages?unread=1`);
    assert.deepEqual(unread.body.data.map((r) => r.subject), ['RE: Thread one']);
    const flagged = await as(salesB)('get', `/api/mail/folders/${box.id}/inbox/messages?flagged=1`);
    assert.deepEqual(flagged.body.data.map((r) => r.subject), ['Thread two']);
    const search = await as(salesB)('get', `/api/mail/folders/${box.id}/inbox/messages?q=two`);
    assert.deepEqual(search.body.data.map((r) => r.subject), ['Thread two']);

    const sent = await as(salesB)('get', `/api/mail/folders/${box.id}/sentitems/messages`);
    assert.equal(sent.body.meta.total, 1);
    assert.equal(sent.body.data[0].direction, 'outbound');
    assert.deepEqual(sent.body.data[0].to_emails, ['ravi@acme-steel.co.in'], 'Sent Items shows who it went to');

    // Somebody else's mailbox is not there; nor is a folder the mailbox does not have.
    assert.equal((await as(salesA)('get', `/api/mail/folders/${box.id}/inbox/messages`)).status, 404);
    assert.equal((await as(salesB)('get', `/api/mail/folders/${box.id}/nowhere/messages`)).status, 404);
    // An admin may list it.
    assert.equal((await as(admin)('get', `/api/mail/folders/${box.id}/inbox/messages`)).status, 200);
  });

  test('a message shows From, To, Cc, state and attachments; Bcc only on mail we sent', async () => {
    const m = mail({ importance: 'high', flag_status: 'flagged', has_attachments: true, web_link: 'https://outlook.office.com/mail/id/abc',
      attachments: [{ provider_id: 'att-spec', name: 'spec.pdf', contentType: 'application/pdf', content: Buffer.from('%PDF-1.4 test') }, { provider_id: 'att-logo', name: 'logo.png', contentType: 'image/png', content: Buffer.from('PNG'), is_inline: true, content_id: 'logo@acme' }],
      bcc: [{ email: 'secret@acme-steel.co.in' }] });
    await deliver(boxB, [m]);
    const row = await stored(m.provider_id);
    const res = await as(salesB)('get', `/api/mail/messages/${row.id}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const d = res.body.data;
    assert.equal(d.from_email, 'ravi@acme-steel.co.in');
    assert.deepEqual(d.to_emails, ['sam.sales@cetizionverifica.com']);
    assert.deepEqual(d.cc_emails, ['cc@acme-steel.co.in']);
    assert.deepEqual(d.bcc_emails, [], 'Bcc is not shown on mail we received');
    assert.equal(d.importance, 'high');
    assert.equal(d.flag_status, 'flagged');
    assert.equal(d.is_read, false);
    assert.equal(d.web_link, 'https://outlook.office.com/mail/id/abc');
    assert.equal(d.body_html, '<p>Please quote.</p>');
    assert.equal(d.live, false);
    assert.equal(d.can_download, true);
    assert.ok(!('provider_id' in d), 'the provider id stays inside');
    assert.deepEqual(d.attachments.map((a) => [a.name, a.content_type, a.is_inline, a.content_id]), [['spec.pdf', 'application/pdf', false, null], ['logo.png', 'image/png', true, 'logo@acme']]);
    assert.equal(d.attachments[0].url, `/api/mail/messages/${row.id}/attachments/${d.attachments[0].id}`);

    // Another sales user: not theirs, not there.
    assert.equal((await as(salesA)('get', `/api/mail/messages/${row.id}`)).status, 404);
  });

  test('an attachment streams from the provider with nosniff; a PDF may open inline, anything else downloads; a cid: image comes from the inline route', async () => {
    const m = mail({ has_attachments: true, body_html: '<p>Logo: <img src="cid:logo@acme"></p>',
      attachments: [
        { provider_id: 'att-spec', name: 'spec.pdf', contentType: 'application/pdf', content: Buffer.from('%PDF-1.4 test') },
        { provider_id: 'att-xls', name: 'rates.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', content: Buffer.from('xlsx bytes') },
        { provider_id: 'att-logo', name: 'logo.png', contentType: 'image/png', content: Buffer.from('PNG bytes'), is_inline: true, content_id: '<logo@acme>' },
      ] });
    await deliver(boxB, [m]);
    const row = await stored(m.provider_id);
    const { rows: atts } = await db.query('SELECT * FROM email_attachments WHERE message_id = $1 ORDER BY id', [row.id]);
    const pdf = atts.find((a) => a.name === 'spec.pdf'); const xls = atts.find((a) => a.name === 'rates.xlsx');

    const down = await as(salesB)('get', `/api/mail/messages/${row.id}/attachments/${pdf.id}`).buffer(true).parse((res, cb) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); });
    assert.equal(down.status, 200);
    assert.equal(down.headers['x-content-type-options'], 'nosniff');
    assert.equal(down.headers['content-type'], 'application/pdf');
    assert.match(down.headers['content-disposition'], /^attachment; filename="spec\.pdf"/);
    assert.equal(down.body.toString(), '%PDF-1.4 test');

    const inline = await as(salesB)('get', `/api/mail/messages/${row.id}/attachments/${pdf.id}?inline=1`);
    assert.match(inline.headers['content-disposition'], /^inline;/);
    assert.match(inline.headers['content-security-policy'], /sandbox/);
    const notPreviewable = await as(salesB)('get', `/api/mail/messages/${row.id}/attachments/${xls.id}?inline=1`);
    assert.match(notPreviewable.headers['content-disposition'], /^attachment;/, 'a spreadsheet never opens in the browser');

    const cid = await as(salesB)('get', `/api/mail/messages/${row.id}/inline/${encodeURIComponent('logo@acme')}`).buffer(true).parse((res, cb) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); });
    assert.equal(cid.status, 200, JSON.stringify(cid.body));
    assert.equal(cid.headers['content-type'], 'image/png');
    assert.equal(cid.body.toString(), 'PNG bytes');
    assert.equal((await as(salesB)('get', `/api/mail/messages/${row.id}/inline/spec.pdf`)).status, 404, 'only an image answers as inline');

    // Not the caller's mailbox: nothing, by either route.
    assert.equal((await as(salesA)('get', `/api/mail/messages/${row.id}/attachments/${pdf.id}`)).status, 404);
    assert.equal((await as(salesA)('get', `/api/mail/messages/${row.id}/inline/logo@acme`)).status, 404);
    // Too large for the tracker, by what the provider said of it.
    await db.query('UPDATE email_attachments SET size_bytes = 26 * 1024 * 1024 WHERE id = $1', [pdf.id]);
    assert.equal((await as(salesB)('get', `/api/mail/messages/${row.id}/attachments/${pdf.id}`)).status, 413);
  });

  test('the owner of a mailbox that stores subjects only reads the body live, and nothing is stored; an admin sees only what is stored', async () => {
    const m = mail({ subject: 'Confidential terms', body_html: '<p>Our best price is <b>secret</b>.</p><script>x()</script>', has_attachments: true,
      attachments: [{ provider_id: 'att-1', name: 'terms.pdf', contentType: 'application/pdf', content: Buffer.from('%PDF') }] });
    const r = await deliver(boxA, [m]);
    assert.equal(r.stored, 1, JSON.stringify(r));
    const row = await stored(m.provider_id);
    assert.equal(row.body_html, null, 'the mailbox stores no body');
    assert.equal(row.subject, 'Confidential terms');

    const own = await as(salesA)('get', `/api/mail/messages/${row.id}`);
    assert.equal(own.status, 200, JSON.stringify(own.body));
    assert.equal(own.body.data.live, true);
    assert.equal(own.body.data.body_html, '<p>Our best price is <b>secret</b>.</p>', 'read live, and cleaned like a stored body');
    assert.equal(own.body.data.can_download, true, 'the owner downloads their own attachments');
    assert.equal(own.body.data.attachments[0].name, 'terms.pdf', 'a subjects-only mailbox stores attachment names');
    assert.equal((await stored(m.provider_id)).body_html, null, 'still nothing stored');
    assert.equal((await stored(m.provider_id)).snippet, null);

    const other = await as(admin)('get', `/api/mail/messages/${row.id}`);
    assert.equal(other.status, 200);
    assert.equal(other.body.data.live, false);
    assert.equal(other.body.data.body_html, null, 'an admin sees what the owner shares, no more');
    assert.equal(other.body.data.can_download, false);
    assert.equal(other.body.data.attachments[0].url, null);
    assert.equal((await as(admin)('get', `/api/mail/messages/${row.id}/attachments/${other.body.data.attachments[0].id}`)).status, 404, 'and cannot download');
    assert.equal((await as(salesB)('get', `/api/mail/messages/${row.id}`)).status, 404, 'another sales user gets nothing');

    // The thread route says the same: the owner may read live, an admin may not.
    const asOwner = await as(salesA)('get', `/api/mail/threads/${row.thread_id}`);
    assert.equal(asOwner.status, 200);
    assert.equal(asOwner.body.data.messages[0].can_read_live, true);
    assert.equal(asOwner.body.data.can_download, true);
    assert.deepEqual(asOwner.body.data.messages[0].cc_emails, ['cc@acme-steel.co.in']);
    assert.equal(asOwner.body.data.messages[0].attachments.length, 1);
    const asAdmin = await as(admin)('get', `/api/mail/threads/${row.thread_id}`);
    assert.equal(asAdmin.body.data.messages[0].can_read_live, false);
    assert.equal(asAdmin.body.data.can_download, false);
    assert.ok(!('user_id' in asAdmin.body.data));
  });

  test('a message deleted in Outlook is in no folder, and the thread keeps its place with no body', async () => {
    const box = await mailbox({ userId: salesB.user.id, email: `${uid('b')}@cetizionverifica.com` });
    const m = mail({ subject: 'Will be deleted' });
    await deliver(box, [m]);
    const row = await stored(m.provider_id);
    await db.query('UPDATE email_messages SET removed_at = now() WHERE id = $1', [row.id]);
    const list = await as(salesB)('get', `/api/mail/folders/${box.id}/inbox/messages`);
    assert.equal(list.body.meta.total, 0);
    const thread = await as(salesB)('get', `/api/mail/threads/${row.thread_id}`);
    assert.equal(thread.status, 200);
    assert.ok(thread.body.data.messages[0].removed_at, 'said to have been deleted');
    assert.equal(thread.body.data.messages[0].body_html, null);
    const one = await as(salesB)('get', `/api/mail/messages/${row.id}`);
    assert.equal(one.body.data.body_html, null);
  });

  test('mail synced before folders were stored shows in the Inbox or Sent Items by its direction, nowhere else', async () => {
    const box = await mailbox({ userId: salesB.user.id, email: `${uid('b')}@cetizionverifica.com` });
    const m = mail({ subject: 'Old mail' });
    await deliver(box, [m]);
    await db.query('UPDATE email_messages SET folder_id = NULL WHERE provider_id = $1', [m.provider_id]);
    assert.equal((await as(salesB)('get', `/api/mail/folders/${box.id}/inbox/messages`)).body.meta.total, 1);
    assert.equal((await as(salesB)('get', `/api/mail/folders/${box.id}/sentitems/messages`)).body.meta.total, 0);
  });
});
