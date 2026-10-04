import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';

/**
 * docs/mis-briefing-fix-plan.md §2 and decision 3, against the database:
 * yesterday's mail in every shared mailbox, without what is not sales
 * business, each email once, and the mailboxes it could not read named.
 * Needs TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
const NAME = `mis_threads_${process.pid}`;
const DAY = '2026-10-04';

describe('the briefing reads the right mail', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let db; let pool; let misAi; let misReports;
  const ids = {};

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
    ({ pool } = await import('../src/db.js'));
    misAi = await import('../src/lib/misAi.js');
    misReports = await import('../src/lib/misReports.js');

    const account = async (email, visibility) => (await db.query(
      `INSERT INTO connected_accounts (username, provider, email, is_shared, visibility) VALUES ('admin', 'test', $1, true, $2) RETURNING id`, [email, visibility])).rows[0].id;
    ids.sales = await account('sales@cetizionverifica.com', 'share_everything');
    ids.info = await account('info@cetizionverifica.com', 'share_everything');
    ids.hr = await account('hr@cetizionverifica.com', 'subject');

    let n = 0;
    const thread = async (acct, { subject, entity = null, entityId = null, messages }) => {
      n += 1;
      const { rows: [t] } = await db.query(
        `INSERT INTO email_threads (account_id, conversation_id, subject, entity, entity_id, last_message_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [acct, `conv-${n}`, subject, entity, entityId, `${DAY}T06:00:00Z`]);
      for (const [i, m] of messages.entries()) {
        const providerId = `p-${n}-${i}`;
        await db.query(
          `INSERT INTO email_messages (account_id, thread_id, provider_id, internet_message_id, direction, from_email, from_name, subject, body_html, sent_at, filtered_as)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [acct, t.id, providerId, m.mid || `<${providerId}@mail>`, m.direction || 'inbound', m.from, m.from, subject, m.body || 'Hello', `${DAY}T0${5 + i}:00:00Z`, m.filtered_as || null]);
        if (m.kind) {
          await db.query(`INSERT INTO email_enquiry_decisions (account_id, provider_id, direction, outcome, kind, method, thread_id) VALUES ($1, $2, 'inbound', 'not_enquiry', $3, 'rules', $4)`, [acct, providerId, m.kind, t.id]);
        }
      }
      return t.id;
    };
    ids.enquiry = await thread(ids.sales, { subject: 'RFQ: EcoVadis for 3 sites', messages: [{ from: 'ravi@acmesteel.in', body: 'Please quote for 3 sites.', kind: 'new_enquiry', mid: '<rfq@acme>' }] });
    ids.newsletter = await thread(ids.sales, { subject: 'This week in ESG', messages: [{ from: 'newsletter@esgdaily.com', body: 'Read more. Unsubscribe here.' }] });
    ids.pitch = await thread(ids.sales, { subject: 'Grow your sales with our CRM', messages: [{ from: 'rahul@crmvendor.io', body: 'Can I have 15 minutes?', kind: 'vendor_or_sales_pitch' }] });
    ids.ownBriefing = await thread(ids.sales, { subject: 'Daily Sales Briefing – 03 Oct 2026: 2 new enquiries, 0 POs, 1 overdue', messages: [{ from: 'sales@cetizionverifica.com', direction: 'outbound', body: 'Good morning' }] });
    ids.internalOnRecord = await thread(ids.sales, { subject: 'Coreal: reminder for the PO', entity: 'quotation', entityId: 'CTZ/QT/2026/001', messages: [{ from: 'deepak@cetizionverifica.com', direction: 'outbound', filtered_as: 'internal only', body: 'Burcu, please chase Coreal.' }] });
    ids.internalChatter = await thread(ids.sales, { subject: 'Lunch on Friday', messages: [{ from: 'priya@cetizionverifica.com', direction: 'outbound', filtered_as: 'internal only', body: 'Who is in?' }] });
    // The same RFQ reached info@ too (sales@ was copied): once in the briefing.
    ids.copy = await thread(ids.info, { subject: 'RFQ: EcoVadis for 3 sites', messages: [{ from: 'ravi@acmesteel.in', body: 'Please quote for 3 sites.', mid: '<rfq@acme>' }] });
    ids.infoOnly = await thread(ids.info, { subject: 'Question about our ISO certificate', messages: [{ from: 'qa@betametals.com', body: 'Is the certificate still valid?' }] });
  });

  after(async () => {
    await pool?.end();
    await db?.end();
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`);
    await admin.end();
  });

  test('sales business is kept, from every shared mailbox; the rest is left out with its reason', async () => {
    const { threads, window } = await misAi.selectThreads(db, { from: DAY, to: DAY });
    const kept = threads.map((t) => t.thread_id).sort((a, b) => a - b);
    assert.deepEqual(kept, [ids.enquiry, ids.internalOnRecord, ids.infoOnly].sort((a, b) => a - b));
    const left = Object.fromEntries(window.excluded.map((e) => [e.reason, e.count]));
    assert.deepEqual(left, {
      'an automatic or bulk sender': 1, "a vendor's pitch": 1, 'our own report': 1, 'internal only': 1, 'the same email in another shared mailbox': 1,
    });
    assert.deepEqual(window.mailboxes, ['info@cetizionverifica.com', 'sales@cetizionverifica.com']);
    assert.deepEqual(window.not_read, [{ email: 'hr@cetizionverifica.com', shared_as: 'subject' }]);
    assert.equal(window.threads, 8);
    assert.equal(window.kept, 3);
    assert.match(misAi.windowNote(window), /^8 threads in the window; 5 left out: .*not read: hr@cetizionverifica\.com \(shared as subject only\)$/);
  });

  test('our own report is recognised by the email log as well as by its subject', async () => {
    // A subject the rule would not catch, sent by the report job: the email log knows it.
    await db.query(`INSERT INTO email_log (to_email, subject, template, status) VALUES ('md@x.com', 'Question about our ISO certificate', 'mis_daily', 'sent')`);
    const { threads, window } = await misAi.selectThreads(db, { from: DAY, to: DAY });
    assert.ok(!threads.some((t) => t.thread_id === ids.infoOnly));
    assert.equal(window.excluded.find((e) => e.reason === 'our own report').count, 2);
    await db.query(`DELETE FROM email_log WHERE template = 'mis_daily'`);
  });

  test('"New enquiries" counts only enquiries the reader called new, besides the ones people logged', async () => {
    const enquiry = async (no, client) => db.query(`INSERT INTO enquiries (enquiry_no, enquiry_date, client_name, status) VALUES ($1, $2, $3, 'New')`, [no, DAY, client]);
    await enquiry('CTZ/ENQ/2026/901', 'Acme Steel');
    await enquiry('CTZ/ENQ/2026/902', 'ESG Daily');
    await enquiry('CTZ/ENQ/2026/903', 'Walk-in client');
    await db.query(`INSERT INTO email_enquiry_decisions (account_id, provider_id, direction, outcome, kind, method, enquiry_no) VALUES ($1, 'e1', 'inbound', 'created', 'new_enquiry', 'ai', 'CTZ/ENQ/2026/901'), ($1, 'e2', 'inbound', 'created', 'marketing', 'ai', 'CTZ/ENQ/2026/902')`, [ids.sales]);
    const data = await misReports.dailyBriefing({ today: '2026-10-05', db });
    assert.equal(data.at_a_glance.new_enquiries, 2, 'the reader-made one from a marketing mail does not count');
  });
});
