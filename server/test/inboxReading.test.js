import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';
import XLSX from 'xlsx';

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
const bytes = (res, cb) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); };
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

    // Somebody else's mailbox is not there; nor is a folder the mailbox does not have — by any name, well-known or not — nor one the switcher hides.
    assert.equal((await as(salesA)('get', `/api/mail/folders/${box.id}/inbox/messages`)).status, 404);
    assert.equal((await as(salesB)('get', `/api/mail/folders/${box.id}/nowhere/messages`)).status, 404);
    assert.equal((await as(salesB)('get', `/api/mail/folders/${box.id}/archive/messages`)).status, 404, 'a well-known folder this mailbox has not got');
    assert.equal((await as(salesA)('get', `/api/mail/folders/${boxA.id}/drafts/messages`)).status, 404, 'drafts is in the folder list and still not served');
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
    assert.equal(d.can_view_attachments, true);
    for (const k of ['provider_id', 'internet_message_id', 'conversation_id', 'mailbox_user_id', 'removed_seen_at', 'attachments_listed_at', 'mailbox_status', 'thread_subject', 'filtered_as']) {
      assert.ok(!(k in d), `${k} stays inside`);
    }
    assert.ok(!('provider_id' in d.attachments[0]), 'nor an attachment\'s');
    assert.deepEqual(d.attachments.map((a) => [a.name, a.content_type, a.is_inline, a.content_id]), [['spec.pdf', 'application/pdf', false, null], ['logo.png', 'image/png', true, 'logo@acme']]);
    assert.equal(d.attachments[0].view_url, `/api/mail/messages/${row.id}/attachments/${d.attachments[0].id}/view`);
    assert.equal(d.attachments[0].view, 'pdf');
    assert.ok(!('url' in d.attachments[0]), 'there is no download address');

    // Another sales user: not theirs, not there.
    assert.equal((await as(salesA)('get', `/api/mail/messages/${row.id}`)).status, 404);
  });

  test('an attachment opens in the viewer only: a PDF streams inline with nosniff, a sheet and a text file come back as data, nothing downloads; a cid: image comes from the inline route', async () => {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Item', 'Rate'], ['Audit', 1200], ['Travel', '=1+1']]), 'Rates');
    const xlsxBytes = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
    const m = mail({ has_attachments: true, body_html: '<p>Logo: <img src="cid:logo@acme"></p>',
      attachments: [
        { provider_id: 'att-spec', name: 'spec.pdf', contentType: 'application/pdf', content: Buffer.from('%PDF-1.4 test') },
        { provider_id: 'att-xls', name: 'rates.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', content: xlsxBytes },
        { provider_id: 'att-csv', name: 'list.csv', contentType: 'application/octet-stream', content: Buffer.from('a,b\n007,x\n') },
        { provider_id: 'att-txt', name: 'notes.txt', contentType: 'text/plain', content: Buffer.from('Hello <b>there</b>') },
        { provider_id: 'att-doc', name: 'letter.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', content: Buffer.from('PK docx') },
        { provider_id: 'att-logo', name: 'logo.png', contentType: 'image/png', content: Buffer.from('PNG bytes'), is_inline: true, content_id: '<logo@acme>' },
      ] });
    await deliver(boxB, [m]);
    const row = await stored(m.provider_id);
    const { rows: atts } = await db.query('SELECT * FROM email_attachments WHERE message_id = $1 ORDER BY id', [row.id]);
    const by = (name) => atts.find((a) => a.name === name);
    const pdf = by('spec.pdf');
    const view = (who, att) => as(who)('get', `/api/mail/messages/${row.id}/attachments/${att.id}/view`).set('X-Tracker-View', '1');

    const listed = (await as(salesB)('get', `/api/mail/messages/${row.id}`)).body.data.attachments;
    assert.deepEqual(listed.map((a) => [a.name, a.view]), [['spec.pdf', 'pdf'], ['rates.xlsx', 'sheet'], ['list.csv', 'sheet'], ['notes.txt', 'text'], ['letter.docx', 'word'], ['logo.png', 'image']]);

    const shown = await view(salesB, pdf).buffer(true).parse(bytes);
    assert.equal(shown.status, 200);
    assert.equal(shown.headers['x-content-type-options'], 'nosniff');
    assert.equal(shown.headers['content-type'], 'application/pdf');
    assert.match(shown.headers['content-disposition'], /^inline; filename="spec\.pdf"/);
    assert.match(shown.headers['content-security-policy'], /sandbox/);
    assert.match(shown.headers['cache-control'], /no-store/);
    assert.equal(shown.body.toString(), '%PDF-1.4 test');

    // Not from a link, a tab or a download: the viewer's header or nothing.
    const bare = await as(salesB)('get', `/api/mail/messages/${row.id}/attachments/${pdf.id}/view`);
    assert.equal(bare.status, 403);
    assert.equal((await as(salesB)('get', `/api/mail/messages/${row.id}/attachments/${pdf.id}`)).status, 404, 'the download route is gone');

    const sheet = await view(salesB, by('rates.xlsx'));
    assert.equal(sheet.status, 200, JSON.stringify(sheet.body));
    assert.equal(sheet.body.data.kind, 'sheet');
    assert.equal(sheet.body.data.sheets[0].name, 'Rates');
    assert.deepEqual(sheet.body.data.sheets[0].rows.slice(0, 2), [['Item', 'Rate'], ['Audit', '1200']]);
    assert.equal(sheet.body.data.sheets[0].truncated, false);
    const csv = await view(salesB, by('list.csv'));
    assert.deepEqual(csv.body.data.sheets[0].rows, [['a', 'b'], ['007', 'x']], 'a CSV keeps the digits it was written with');
    const text = await view(salesB, by('notes.txt'));
    assert.deepEqual(text.body.data, { kind: 'text', text: 'Hello <b>there</b>', truncated: false });
    const doc = await view(salesB, by('letter.docx'));
    assert.equal(doc.status, 422, 'not a real Word file: said plainly, not a crash');

    // Every view is in the activity log; the refused ones are not.
    const { rows: log } = await db.query(`SELECT actor_user_id, entity_id, metadata FROM activity_log WHERE action = 'mail.attachment_viewed' AND entity_id = $1 ORDER BY id`, [String(row.id)]);
    assert.deepEqual(log.map((l) => l.metadata.name), ['spec.pdf', 'rates.xlsx', 'list.csv', 'notes.txt']);
    assert.equal(log[0].actor_user_id, salesB.user.id);

    const cid = await as(salesB)('get', `/api/mail/messages/${row.id}/inline/${encodeURIComponent('logo@acme')}`).buffer(true).parse(bytes);
    assert.equal(cid.status, 200, JSON.stringify(cid.body));
    assert.equal(cid.headers['content-type'], 'image/png');
    assert.match(cid.headers['content-disposition'], /^inline;/);
    assert.equal(cid.body.toString(), 'PNG bytes');
    assert.equal((await as(salesB)('get', `/api/mail/messages/${row.id}/inline/spec.pdf`)).status, 404, 'only an image answers as inline');

    // Not the caller's mailbox: nothing, by either route.
    assert.equal((await view(salesA, pdf)).status, 404);
    assert.equal((await as(salesA)('get', `/api/mail/messages/${row.id}/inline/logo@acme`)).status, 404);
    // Too large for the tracker, by what the provider said of it.
    await db.query('UPDATE email_attachments SET size_bytes = 26 * 1024 * 1024 WHERE id = $1', [pdf.id]);
    assert.equal((await view(salesB, pdf)).status, 413);
  });

  test('a Word document opens as cleaned HTML, a forwarded email as the message it is, and a OneDrive link says where it lives', async () => {
    const box = await mailbox({ userId: salesB.user.id, email: `${uid('b')}@cetizionverifica.com` });
    const forwarded = {
      subject: 'Fwd: PO 4471', from: { email: 'buyer@acme-steel.co.in', name: 'Ravi' }, to: [{ email: 'bea@cetizionverifica.com' }], cc: [],
      sent_at: '2026-10-01T09:30:00Z', body_html: '<p>PO attached.</p><script>steal()</script><img src="https://tracker.invalid/p.gif">',
    };
    const m = mail({ has_attachments: true, attachments: [
      { provider_id: 'w', name: 'scope.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', content: readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'attachments', 'letter.docx')) },
      { provider_id: 'i', name: 'Fwd: PO 4471', contentType: null, kind: 'item', size: 2048, item: forwarded },
      { provider_id: 'r', name: 'Drawings', contentType: null, kind: 'reference', size: 0 },
      { provider_id: 'p', name: 'deck.pptx', contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', content: Buffer.from('PK') },
    ] });
    await deliver(box, [m]);
    const row = await stored(m.provider_id);
    const listed = (await as(salesB)('get', `/api/mail/messages/${row.id}`)).body.data.attachments;
    assert.deepEqual(listed.map((a) => [a.name, a.kind, a.view]), [['scope.docx', 'file', 'word'], ['Fwd: PO 4471', 'item', 'email'], ['Drawings', 'reference', null], ['deck.pptx', 'file', null]]);
    const view = (a) => as(salesB)('get', a.view_url).set('X-Tracker-View', '1');

    const word = await view(listed[0]);
    assert.equal(word.status, 200, JSON.stringify(word.body));
    assert.equal(word.body.data.kind, 'word');
    assert.match(word.body.data.html, /<h1>Scope of audit<\/h1>/);
    assert.match(word.body.data.html, /<td><p>Audit<\/p><\/td>/);

    const fwd = await view(listed[1]);
    assert.equal(fwd.status, 200, JSON.stringify(fwd.body));
    assert.equal(fwd.body.data.kind, 'email');
    assert.equal(fwd.body.data.subject, 'Fwd: PO 4471');
    assert.deepEqual(fwd.body.data.from, { email: 'buyer@acme-steel.co.in', name: 'Ravi' });
    assert.match(fwd.body.data.html, /<p>PO attached\.<\/p>/);
    assert.ok(!fwd.body.data.html.includes('<script'), 'cleaned like any mail body');

    const link = await view(listed[2]);
    assert.equal(link.status, 415);
    assert.match(link.body.error.message, /OneDrive or SharePoint/);
    assert.equal((await view(listed[3])).status, 415, 'PowerPoint needs the converter, which this test does not set up');

    // The thread route lists the same kinds.
    const thread = await as(salesB)('get', `/api/mail/threads/${row.thread_id}`);
    assert.deepEqual(thread.body.data.messages[0].attachments.map((a) => a.view), ['word', 'email', null, null]);
  });

  test('PowerPoint and older Office files open as a PDF from the converter, and say so when it is not there', async () => {
    // A stand-in for Gotenberg: it checks what the tracker sends and answers with a PDF.
    const seen = [];
    let answer = 'pdf';
    const server = createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('latin1');
        seen.push({ path: req.url, auth: req.headers.authorization || null, filename: /filename="([^"]+)"/.exec(body)?.[1], body });
        if (answer === 'fail') { res.writeHead(503); return res.end('busy'); }
        if (answer === 'junk') { res.writeHead(200, { 'Content-Type': 'application/pdf' }); return res.end('<html>'); }
        res.writeHead(200, { 'Content-Type': 'application/pdf' });
        return res.end('%PDF-1.7\nconverted\n%%EOF');
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const box = await mailbox({ userId: salesB.user.id, email: `${uid('b')}@cetizionverifica.com` });
    const m = mail({ has_attachments: true, attachments: [
      { provider_id: 'p', name: 'Audit plan.pptx', contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', content: Buffer.from('PK deck bytes') },
      { provider_id: 'd', name: 'old letter', contentType: 'application/msword', content: Buffer.from('doc bytes') },
      { provider_id: 'r', name: 'terms.rtf', contentType: 'application/octet-stream', content: Buffer.from('{\\rtf1 hi}') },
      { provider_id: 'x', name: 'old.xls', contentType: 'application/vnd.ms-excel', content: Buffer.from('x') },
    ] });
    await deliver(box, [m]);
    const row = await stored(m.provider_id);
    const list = async () => (await as(salesB)('get', `/api/mail/messages/${row.id}`)).body.data.attachments;
    const view = (a) => as(salesB)('get', a.view_url).set('X-Tracker-View', '1').buffer(true).parse(bytes);
    const before = await list();
    try {
      // No converter: listed, not viewable, and the route says to use Outlook.
      assert.deepEqual(before.map((a) => a.view), [null, null, null, 'sheet'], 'an old .xls stays with the sheet viewer');
      const none = await as(salesB)('get', before[0].view_url).set('X-Tracker-View', '1');
      assert.equal(none.status, 415);
      assert.match(none.body.error.message, /Outlook/);
      assert.equal(seen.length, 0);

      process.env.DOC_CONVERTER_URL = `http://conv:s3cret@127.0.0.1:${server.address().port}`;
      const listed = await list();
      assert.deepEqual(listed.map((a) => a.view), ['office', 'office', 'office', 'sheet']);

      const deck = await view(listed[0]);
      assert.equal(deck.status, 200);
      assert.equal(deck.headers['content-type'], 'application/pdf');
      assert.match(deck.headers['content-disposition'], /^inline; filename="Audit plan\.pdf"/);
      assert.equal(deck.headers['cache-control'], 'private, no-store');
      assert.match(deck.headers['content-security-policy'], /sandbox/);
      assert.equal(deck.body.subarray(0, 8).toString(), '%PDF-1.7');
      assert.equal(seen[0].path, '/forms/libreoffice/convert');
      assert.equal(seen[0].auth, `Basic ${Buffer.from('conv:s3cret').toString('base64')}`);
      assert.equal(seen[0].filename, 'attachment.pptx', 'sent under a plain name with the format LibreOffice reads');
      assert.ok(seen[0].body.includes('PK deck bytes'));

      // The extension comes from the type when the name has none, and from the name when the type is vague.
      assert.equal((await view(listed[1])).status, 200);
      assert.equal(seen[1].filename, 'attachment.doc');
      assert.equal((await view(listed[2])).status, 200);
      assert.equal(seen[2].filename, 'attachment.rtf');

      // A converter that fails, or answers with something that is not a PDF, is a 422 and not a view.
      answer = 'fail';
      const failed = await as(salesB)('get', listed[0].view_url).set('X-Tracker-View', '1');
      assert.equal(failed.status, 422);
      assert.match(failed.body.error.message, /could not be converted/);
      answer = 'junk';
      assert.equal((await as(salesB)('get', listed[0].view_url).set('X-Tracker-View', '1')).status, 422);

      const { rows: log } = await db.query(`SELECT metadata FROM activity_log WHERE action = 'mail.attachment_viewed' AND entity_id = $1 ORDER BY id`, [String(row.id)]);
      assert.deepEqual(log.map((l) => l.metadata.name), ['Audit plan.pptx', 'old letter', 'terms.rtf']);

      // Still the viewer only.
      assert.equal((await as(salesB)('get', listed[0].view_url)).status, 403);
    } finally {
      delete process.env.DOC_CONVERTER_URL;
      server.close();
    }
  });

  test('the folder list names what the newest message carries, inline pictures aside', async () => {
    const box = await mailbox({ userId: salesB.user.id, email: `${uid('b')}@cetizionverifica.com` });
    const m = mail({ has_attachments: true, attachments: [
      { provider_id: 'a1', name: 'PO 4471.pdf', contentType: 'application/pdf', content: Buffer.from('%PDF') },
      { provider_id: 'a2', name: 'BOQ.xlsx', contentType: 'application/vnd.ms-excel', content: Buffer.from('x') },
      { provider_id: 'a3', name: 'sig.png', contentType: 'image/png', content: Buffer.from('p'), is_inline: true, content_id: 'sig' },
    ] });
    await deliver(box, [m]);
    const list = await as(salesB)('get', `/api/mail/folders/${box.id}/inbox/messages`);
    assert.deepEqual(list.body.data[0].attachment_names, ['PO 4471.pdf', 'BOQ.xlsx']);
  });

  test('whoever reads a shared mailbox views its attachments, whatever the mailbox stores', async () => {
    const box = await mailbox({ shared: true, email: `${uid('team')}@cetizionverifica.com`, visibility: 'subject' });
    const m = mail({ to: [{ email: box.email }], has_attachments: true,
      attachments: [{ provider_id: 'att-q', name: 'quote.pdf', contentType: 'application/pdf', content: Buffer.from('%PDF team') }] });
    await deliver(box, [m]);
    const row = await stored(m.provider_id);
    const one = await as(salesA)('get', `/api/mail/messages/${row.id}`);
    assert.equal(one.status, 200, JSON.stringify(one.body));
    assert.equal(one.body.data.body_html, null, 'the body stays as the mailbox stores it');
    assert.equal(one.body.data.can_view_attachments, true);
    const att = one.body.data.attachments[0];
    const got = await as(salesA)('get', att.view_url).set('X-Tracker-View', '1').buffer(true).parse(bytes);
    assert.equal(got.status, 200);
    assert.equal(got.body.toString(), '%PDF team');
    const thread = await as(salesA)('get', `/api/mail/threads/${row.thread_id}`);
    assert.equal(thread.body.data.can_view_attachments, true);
    assert.equal(thread.body.data.messages[0].attachments[0].view_url, att.view_url);

    // Members named on its Inbox, and the conversation taken: the others read nothing of it.
    await db.query(`UPDATE inboxes SET members = ARRAY['Sam Sales'] WHERE account_id = $1`, [box.id]);
    const { rowCount } = await db.query(`UPDATE inbox_conversations SET assignee = 'Sam Sales' WHERE thread_id = $1`, [row.thread_id]);
    assert.equal(rowCount, 1);
    assert.equal((await as(salesB)('get', att.view_url).set('X-Tracker-View', '1')).status, 404);
    assert.equal((await as(salesA)('get', att.view_url).set('X-Tracker-View', '1')).status, 200);
  });

  test('a shared mailbox that stores who and when only still names its files in the reading pane, so a PDF Outlook calls octet-stream opens', async () => {
    const box = await mailbox({ shared: true, email: `${uid('team')}@cetizionverifica.com`, visibility: 'metadata' });
    const m = mail({ to: [{ email: box.email }], has_attachments: true,
      attachments: [{ provider_id: 'att-o', name: 'PO 5512.pdf', contentType: 'application/octet-stream', content: Buffer.from('%PDF po') }] });
    await deliver(box, [m]);
    const row = await stored(m.provider_id);
    const { rows: [kept] } = await db.query('SELECT name FROM email_attachments WHERE message_id = $1', [row.id]);
    assert.equal(kept.name, null, 'the name is not stored');
    const thread = await as(salesA)('get', `/api/mail/threads/${row.thread_id}`);
    assert.equal(thread.status, 200, JSON.stringify(thread.body));
    const att = thread.body.data.messages[0].attachments[0];
    assert.equal(att.name, 'PO 5512.pdf', 'read live for the reader');
    assert.equal(att.view, 'pdf');
    assert.equal(att.provider_id, undefined);
    assert.equal(thread.body.data.messages[0].provider_id, undefined);
    const got = await as(salesA)('get', att.view_url).set('X-Tracker-View', '1').buffer(true).parse(bytes);
    assert.equal(got.status, 200);
    assert.equal(got.headers['content-type'], 'application/pdf');
    const { rows: [still] } = await db.query('SELECT name FROM email_attachments WHERE message_id = $1', [row.id]);
    assert.equal(still.name, null, 'and nothing is written');
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
    assert.equal(own.body.data.can_view_attachments, true, 'the owner views their own attachments');
    assert.equal(own.body.data.attachments[0].name, 'terms.pdf', 'a subjects-only mailbox stores attachment names');
    assert.equal((await stored(m.provider_id)).body_html, null, 'still nothing stored');
    assert.equal((await stored(m.provider_id)).snippet, null);

    const other = await as(admin)('get', `/api/mail/messages/${row.id}`);
    assert.equal(other.status, 200);
    assert.equal(other.body.data.live, false);
    assert.equal(other.body.data.body_html, null, 'an admin sees what the owner shares, no more');
    assert.equal(other.body.data.can_view_attachments, false);
    assert.equal(other.body.data.attachments[0].view_url, null);
    assert.equal((await as(admin)('get', `/api/mail/messages/${row.id}/attachments/${other.body.data.attachments[0].id}/view`).set('X-Tracker-View', '1')).status, 404, 'and cannot view');
    assert.equal((await as(salesB)('get', `/api/mail/messages/${row.id}`)).status, 404, 'another sales user gets nothing');

    // The thread route says the same: the owner may read live, an admin may not.
    const asOwner = await as(salesA)('get', `/api/mail/threads/${row.thread_id}`);
    assert.equal(asOwner.status, 200);
    assert.equal(asOwner.body.data.messages[0].can_read_live, true);
    assert.equal(asOwner.body.data.can_view_attachments, true);
    assert.deepEqual(asOwner.body.data.messages[0].cc_emails, ['cc@acme-steel.co.in']);
    assert.equal(asOwner.body.data.messages[0].attachments.length, 1);
    const asAdmin = await as(admin)('get', `/api/mail/threads/${row.thread_id}`);
    assert.equal(asAdmin.body.data.messages[0].can_read_live, false);
    assert.equal(asAdmin.body.data.can_view_attachments, false);
    assert.ok(!('user_id' in asAdmin.body.data));
  });

  test('the owner of a metadata-only mailbox sees attachment names and inline images live; a revoked grant marks the mailbox for reconnecting, in the owner\'s words not Azure\'s', async () => {
    const box = await mailbox({ userId: salesB.user.id, email: `${uid('b')}@cetizionverifica.com`, visibility: 'metadata' });
    const m = mail({ subject: 'Terms', body_html: '<p>Logo: <img src="cid:logo@acme"></p>', has_attachments: true,
      attachments: [
        { provider_id: 'att-terms', name: 'Q4 terms.pdf', contentType: 'application/pdf', content: Buffer.from('%PDF') },
        { provider_id: 'att-logo', name: 'logo.png', contentType: 'image/png', content: Buffer.from('PNG bytes'), is_inline: true, content_id: 'logo@acme' },
      ] });
    await deliver(box, [m]);
    const row = await stored(m.provider_id);
    const { rows: atts } = await db.query('SELECT name, content_id FROM email_attachments WHERE message_id = $1', [row.id]);
    assert.deepEqual(atts, [{ name: null, content_id: null }, { name: null, content_id: null }], 'the mailbox stores neither names nor content ids');

    const own = await as(salesB)('get', `/api/mail/messages/${row.id}`);
    assert.equal(own.status, 200, JSON.stringify(own.body));
    assert.equal(own.body.data.live, true);
    assert.deepEqual(own.body.data.attachments.map((a) => [a.name, a.content_id]), [['Q4 terms.pdf', null], ['logo.png', 'logo@acme']], 'read from the provider with the body');
    const pdf = own.body.data.attachments[0];
    const down = await as(salesB)('get', pdf.view_url).set('X-Tracker-View', '1');
    assert.match(down.headers['content-disposition'], /^inline; filename="Q4 terms\.pdf"/, 'shown under its name');
    const cid = await as(salesB)('get', `/api/mail/messages/${row.id}/inline/logo@acme`).buffer(true).parse((res, cb) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); });
    assert.equal(cid.status, 200, JSON.stringify(cid.body));
    assert.equal(cid.body.toString(), 'PNG bytes');
    const { rows: still } = await db.query('SELECT name, content_id FROM email_attachments WHERE message_id = $1', [row.id]);
    assert.deepEqual(still, atts, 'and nothing was written');
    // An admin sees what is stored: no names, no body, no inline image.
    const other = await as(admin)('get', `/api/mail/messages/${row.id}`);
    assert.equal(other.body.data.attachments[0].name, null);
    assert.equal((await as(admin)('get', `/api/mail/messages/${row.id}/inline/logo@acme`)).status, 404);

    // The grant is revoked: the live read fails, the mailbox is marked, the client hears a fixed sentence.
    sync.pushTestFailure(box.id, { message: { reconnect: true, message: 'AADSTS70000: invalid_grant' } });
    const failed = await as(salesB)('get', `/api/mail/messages/${row.id}`);
    assert.equal(failed.status, 200);
    assert.equal(failed.body.data.live, false);
    assert.equal(failed.body.data.live_error, 'The mailbox needs to be reconnected before it can be read');
    assert.ok(!JSON.stringify(failed.body).includes('AADSTS'), 'Azure\'s words stay on the server');
    const { rows: [acc] } = await db.query('SELECT status, last_error FROM connected_accounts WHERE id = $1', [box.id]);
    assert.equal(acc.status, 'needs_reconnect');
    assert.match(acc.last_error, /AADSTS70000/);
    const thread = await as(salesB)('get', `/api/mail/threads/${row.thread_id}`);
    assert.equal(thread.body.data.messages[0].can_read_live, false, 'no more live reads are promised until it is reconnected');
    assert.equal((await as(salesB)('get', pdf.view_url).set('X-Tracker-View', '1')).status, 409);
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
