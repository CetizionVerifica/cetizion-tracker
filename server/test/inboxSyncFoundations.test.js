import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';

/**
 * The Inbox like Outlook, step 1: sync foundations
 * (docs/inbox-outlook-plan.md §3.5, §7). Outlook is the one source of truth
 * for mail state: what it says about a message — its folder, read flag,
 * flag, importance — is stored as it comes, and what changes there changes
 * here on the next sync. Mail goes in through the in-memory `test` provider
 * and the real sync.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
const NAME = `inbox_sync_${process.pid}`;

let db; let pool; let sync;
let n = 0;
const uid = (p) => `${p}-${process.pid}-${(n += 1)}`;

async function mailbox({ shared = true, visibility = 'share_everything' } = {}) {
  const { rows: [a] } = await db.query(
    `INSERT INTO connected_accounts (username, provider, email, is_shared, visibility, import_days) VALUES ('admin','test',$1,$2,$3,30) RETURNING *`,
    [`${uid('box')}@cetizionverifica.com`, shared, visibility]);
  if (shared) await db.query(`INSERT INTO inboxes (name, account_id, default_assignment) VALUES ($1, $2, 'unassigned')`, [`Inbox ${a.id}`, a.id]);
  return a;
}
const mail = (over = {}) => ({
  provider_id: uid('m'), conversation_id: uid('conv'), internet_message_id: `<${uid('mid')}@client>`,
  from: { email: 'ravi@acme-steel.co.in', name: 'Ravi' }, to: [{ email: 'sales@cetizionverifica.com' }], cc: [],
  subject: 'Pressure vessel audit', body_html: '<p>Please quote.</p>', sent_at: new Date().toISOString(),
  is_read: false, flag_status: 'notFlagged', importance: 'normal', ...over,
});
const message = async (providerId) => (await db.query('SELECT * FROM email_messages WHERE provider_id = $1', [providerId])).rows[0];

describe('sync foundations for the Outlook-style Inbox', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  before(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${NAME}`);
    await admin.end();
    const url = new URL(ADMIN_URL); url.pathname = `/${NAME}`;
    db = new pg.Client({ connectionString: url.toString() });
    await db.connect();
    for (const f of ['schema.sql', 'views.sql', 'seed.sql']) await db.query(readFileSync(join(DB_DIR, f), 'utf8'));
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = url.toString();
    process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-to-pass';
    process.env.EMAIL_MODE = 'log';
    delete process.env.OPENROUTER_API_KEY;
    ({ pool } = await import('../src/db.js'));
    sync = await import('../src/lib/mailbox/sync.js');
    (await import('../src/lib/ai.js')).aiConfig.enabled = false;
    await import('../src/lib/inbox.js');
  });

  after(async () => {
    sync.clock.now = () => new Date();
    await pool?.end();
    await db?.end();
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`);
    await admin.end();
  });

  test('a message is stored with Outlook\'s state, and a read, a flag or an importance set in Outlook shows after the next sync', async () => {
    const box = await mailbox();
    const m = mail({ bcc: [{ email: 'hidden@cetizionverifica.com' }] });
    sync.pushTestMessages(box.id, [m]);
    let r = await sync.syncAccount(box.id);
    assert.equal(r.stored, 1);
    let row = await message(m.provider_id);
    assert.equal(row.folder_id, 'inbox');
    assert.equal(row.is_read, false);
    assert.equal(row.flag_status, 'notFlagged');
    assert.equal(row.importance, 'normal');
    assert.deepEqual(row.bcc_emails, ['hidden@cetizionverifica.com']);

    // Read and flagged in "Outlook": delta hands the same message over again.
    sync.pushTestMessages(box.id, [{ ...m, is_read: true, flag_status: 'flagged', importance: 'high' }]);
    r = await sync.syncAccount(box.id);
    assert.equal(r.stored, 0, 'not a new message');
    assert.equal(r.updated, 1, 'but its state moved');
    row = await message(m.provider_id);
    assert.equal(row.is_read, true);
    assert.equal(row.flag_status, 'flagged');
    assert.equal(row.importance, 'high');
    const { rows: [{ count }] } = await db.query('SELECT count(*)::int AS count FROM email_messages WHERE account_id = $1', [box.id]);
    assert.equal(count, 1, 'one row');
    // An update is not new mail: the readers are not told again.
    const { rows: queue } = await db.query('SELECT count(*)::int AS n FROM email_reader_queue WHERE account_id = $1', [box.id]);
    assert.ok(queue[0].n <= 1);
  });

  test('a move keeps the record link and changes the folder; the old id gives way to the new one', async () => {
    const box = await mailbox();
    const no = `CTZ/QT/2027/${String(100 + (process.pid % 900))}`;
    const m = mail({ subject: `About quotation ${no}` });
    await db.query(`INSERT INTO quotations (quotation_no, client_name, status) VALUES ($1, 'Acme Steel', 'Submitted')`, [no]);
    // Clients has to be on the (cached) folder list from the first sync.
    sync.pushTestMessages(box.id, [m, { ...mail({ subject: 'Old, filed' }), folder: 'Clients', history: true }]);
    await sync.syncAccount(box.id);
    const before = await message(m.provider_id);
    const { rows: [t] } = await db.query('SELECT entity, entity_id FROM email_threads WHERE id = $1', [before.thread_id]);
    assert.deepEqual([t.entity, t.entity_id], ['quotation', no]);

    // Filed under Clients in Outlook, under a new id (a mailbox not yet on immutable ids).
    sync.pushTestMessages(box.id, [{ ...m, provider_id: uid('m2'), folder: 'Clients' }]);
    const r = await sync.syncAccount(box.id);
    assert.equal(r.updated, 1);
    const { rows } = await db.query('SELECT provider_id, folder_id, thread_id FROM email_messages WHERE account_id = $1', [box.id]);
    assert.equal(rows.length, 1, 'still one message');
    assert.equal(rows[0].folder_id, 'Clients');
    assert.notEqual(rows[0].provider_id, m.provider_id, 'known by its new id from now on');
    assert.equal(rows[0].thread_id, before.thread_id, 'the thread, and so the record link, is unchanged');
  });

  test('reported gone, then seen in another folder: a move. Gone ten minutes with no sighting: deleted', async () => {
    const box = await mailbox();
    const moved = mail({ subject: 'Moved' });
    const gone = mail({ subject: 'Gone' });
    // The folder list is cached for fifteen minutes (foldersOf), so Archive has to be on it from the first sync.
    sync.pushTestMessages(box.id, [moved, gone, { ...mail({ subject: 'Old, filed' }), folder: 'Archive', history: true }]);
    await sync.syncAccount(box.id);

    const t0 = new Date('2026-10-05T04:00:00Z');
    sync.clock.now = () => t0;
    // Both leave the Inbox; the moved one turns up in Archive in the same sweep.
    sync.pushTestMessages(box.id, [{ provider_id: moved.provider_id, removed: true }, { provider_id: gone.provider_id, removed: true }, { ...moved, folder: 'Archive' }]);
    let r = await sync.syncAccount(box.id);
    assert.equal(r.deleted, undefined, 'nothing is deleted yet');
    let a = await message(moved.provider_id); let b = await message(gone.provider_id);
    assert.equal(a.folder_id, 'Archive');
    assert.equal(a.removed_seen_at, null, 'seen again: not removed');
    assert.ok(b.removed_seen_at, 'noted as gone');
    assert.equal(b.removed_at, null, 'but not yet a delete');

    // Five minutes on: still waiting.
    sync.clock.now = () => new Date(t0.getTime() + 5 * 60_000);
    r = await sync.syncAccount(box.id);
    b = await message(gone.provider_id);
    assert.equal(b.removed_at, null);

    // Eleven minutes on: deleted in Outlook.
    sync.clock.now = () => new Date(t0.getTime() + 11 * 60_000);
    r = await sync.syncAccount(box.id);
    assert.equal(r.deleted, 1);
    b = await message(gone.provider_id);
    assert.ok(b.removed_at);
    a = await message(moved.provider_id);
    assert.equal(a.removed_at, null);

    // Restored from Deleted Items in Outlook: back, as a move.
    sync.pushTestMessages(box.id, [{ ...gone, folder: 'inbox' }]);
    await sync.syncAccount(box.id);
    b = await message(gone.provider_id);
    assert.equal(b.removed_at, null);
    assert.equal(b.folder_id, 'inbox');
    sync.clock.now = () => new Date();
  });

  test('the mailbox\'s folders are stored with Outlook\'s own counts, and a folder gone from Outlook goes', async () => {
    const box = await mailbox();
    sync.pushTestFolders(box.id, [
      { folder_id: 'inbox', parent_id: null, display_name: 'Inbox', well_known: 'inbox', unread_count: 5, total_count: 120 },
      { folder_id: 'f-clients', parent_id: null, display_name: 'Clients', well_known: null, unread_count: 0, total_count: 40 },
      { folder_id: 'f-hindalco', parent_id: 'f-clients', display_name: 'Hindalco', well_known: null, unread_count: 1, total_count: 12 },
    ]);
    await sync.syncAccount(box.id);
    let { rows } = await db.query('SELECT folder_id, parent_id, display_name, well_known, unread_count FROM mail_folder_list WHERE account_id = $1 ORDER BY folder_id', [box.id]);
    assert.deepEqual(rows.map((f) => [f.folder_id, f.parent_id, f.display_name, f.well_known, f.unread_count]), [
      ['f-clients', null, 'Clients', null, 0], ['f-hindalco', 'f-clients', 'Hindalco', null, 1], ['inbox', null, 'Inbox', 'inbox', 5],
    ]);
    sync.pushTestFolders(box.id, [{ folder_id: 'inbox', parent_id: null, display_name: 'Inbox', well_known: 'inbox', unread_count: 4, total_count: 119 }]);
    await sync.syncAccount(box.id);
    ({ rows } = await db.query('SELECT folder_id, unread_count FROM mail_folder_list WHERE account_id = $1', [box.id]));
    assert.deepEqual(rows, [{ folder_id: 'inbox', unread_count: 4 }]);
  });

  test('what is attached is stored as metadata; a mailbox that keeps metadata only keeps no file names', async () => {
    const open = await mailbox();
    const quiet = await mailbox({ visibility: 'metadata' });
    const a = mail({ has_attachments: true, attachments: [{ provider_id: 'att-1', name: 'PO-4500.pdf', contentType: 'application/pdf', content: Buffer.from('%PDF-1.4 x') }, { provider_id: 'att-2', name: 'logo.png', contentType: 'image/png', content: Buffer.from('png'), is_inline: true, content_id: 'logo@cid' }] });
    const b = mail({ has_attachments: true, attachments: [{ provider_id: 'att-3', name: 'Secret terms.pdf', contentType: 'application/pdf', content: Buffer.from('%PDF') }] });
    sync.pushTestMessages(open.id, [a]);
    sync.pushTestMessages(quiet.id, [b]);
    await sync.syncAccount(open.id);
    await sync.syncAccount(quiet.id);
    const ma = await message(a.provider_id);
    const { rows: ra } = await db.query('SELECT provider_id, name, content_type, size_bytes, is_inline, content_id FROM email_attachments WHERE message_id = $1 ORDER BY provider_id', [ma.id]);
    assert.deepEqual(ra, [
      { provider_id: 'att-1', name: 'PO-4500.pdf', content_type: 'application/pdf', size_bytes: 10, is_inline: false, content_id: null },
      { provider_id: 'att-2', name: 'logo.png', content_type: 'image/png', size_bytes: 3, is_inline: true, content_id: 'logo@cid' },
    ]);
    const mb = await message(b.provider_id);
    const { rows: rb } = await db.query('SELECT name, content_type, size_bytes, content_id FROM email_attachments WHERE message_id = $1', [mb.id]);
    assert.deepEqual(rb, [{ name: null, content_type: 'application/pdf', size_bytes: 4, content_id: null }], 'the kind and size, never the name');
  });
});
