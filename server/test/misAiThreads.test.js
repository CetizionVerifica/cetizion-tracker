import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import XLSX from 'xlsx';

/**
 * docs/mis-briefing-fix-plan.md §2 and decision 3, against the database:
 * yesterday's mail in every shared mailbox, without what is not sales
 * business, each email once, and the mailboxes it could not read named.
 * And §3: each pending row's last email, earlier emails on a highlight,
 * and the reminders carried forward; §3a: Finance's debtors list, read once.
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
    assert.deepEqual(data.glance_detail.new_enquiries, ['Acme Steel', 'Walk-in client'], 'the Detail column names the same two');
  });

  test('a pending row shows its latest shared email; a highlight its earlier ones', async () => {
    await db.query(`UPDATE email_messages SET web_link = 'https://outlook.office.com/mail/item/q1' WHERE thread_id = $1`, [ids.internalOnRecord]);
    await db.query(`UPDATE email_messages SET folder_id = 'inbox-1' WHERE thread_id = $1`, [ids.enquiry]);
    // A personal mailbox's later mail on the same record is not the briefing's to show.
    const { rows: [mine] } = await db.query(`INSERT INTO connected_accounts (username, provider, email, is_shared) VALUES ('priya', 'test', 'priya@cetizionverifica.com', false) RETURNING id`);
    const { rows: [own] } = await db.query(`INSERT INTO email_threads (account_id, conversation_id, subject, entity, entity_id) VALUES ($1, 'conv-personal', 'Coreal', 'quotation', 'CTZ/QT/2026/001') RETURNING id`, [mine.id]);
    await db.query(
      `INSERT INTO email_messages (account_id, thread_id, provider_id, direction, from_email, subject, sent_at, web_link)
       VALUES ($1, $2, 'p-personal', 'outbound', 'priya@cetizionverifica.com', 'Coreal', '2026-10-05T09:00:00Z', 'https://outlook.office.com/mail/item/personal')`, [mine.id, own.id]);
    const rows = await misReports.attachMail(db, [
      { mail: { entity: 'quotation', id: 'CTZ/QT/2026/001' } },
      { mail: { thread_id: ids.enquiry } },
      { mail: { entity: 'enquiry', id: 'CTZ/ENQ/2026/999' }, last_activity: null, email_link: null },
    ]);
    assert.deepEqual(rows.map((r) => [r.last_activity, r.email_link]), [
      ['2026-10-04', 'https://outlook.office.com/mail/item/q1'],
      ['2026-10-04', `/inbox?mb=${ids.sales}&f=inbox-1&t=${ids.enquiry}`],
      [null, null],
    ]);

    await db.query(
      `INSERT INTO email_messages (account_id, thread_id, provider_id, direction, from_email, from_name, subject, sent_at)
       VALUES ($1, $2, 'p-earlier', 'outbound', 'sales@cetizionverifica.com', 'Sales', 'RFQ: EcoVadis for 3 sites', '2026-10-01T06:00:00Z')`, [ids.sales, ids.enquiry]);
    const highlights = [{ thread_id: ids.enquiry, client: 'Acme Steel', source: 'records' }, { thread_id: null, client: 'Walk-in client', source: 'records' }];
    await misReports.attachRelated(db, highlights, { from: DAY });
    assert.deepEqual(highlights[0].related, [{ day: '2026-10-01', from: 'Sales', subject: 'RFQ: EcoVadis for 3 sites', link: `/inbox?mb=${ids.sales}` }]);
    assert.equal(highlights[0].web_link, `/inbox?mb=${ids.sales}&f=inbox-1&t=${ids.enquiry}`, 'a highlight worded from a record gets its source email');
    assert.deepEqual(highlights[1].related, [], 'no thread, nothing earlier');
  });

  test('the reminders carried forward are the next three days\' visits and meetings; the source line names the mailboxes', async () => {
    const visit = (title, startsAt, status = 'planned', type = 'audit') => db.query(
      `INSERT INTO visits (title, type, status, starts_at, ends_at, city) VALUES ($1, $2, $3, $4, $4, 'Pune')`, [title, type, status, startsAt]);
    await visit('EcoVadis audit at Acme', '2026-10-06T04:30:00Z', 'confirmed');
    await visit('Kick-off call', '2026-10-08T04:30:00Z', 'planned', 'meeting');
    await visit('Too far ahead', '2026-10-09T04:30:00Z');
    await visit('Called off', '2026-10-06T04:30:00Z', 'cancelled');
    const data = await misReports.dailyBriefing({ today: '2026-10-05', db });
    assert.deepEqual(data.reminders.map((r) => r.text), ['Visit: EcoVadis audit at Acme, 6 Oct, Pune (confirmed)', 'Meeting: Kick-off call, 8 Oct, Pune (planned)']);
    assert.deepEqual(data.mailboxes, {
      read: [{ email: 'info@cetizionverifica.com', folders: 'all folders' }, { email: 'sales@cetizionverifica.com', folders: 'all folders' }],
      not_read: [{ email: 'hr@cetizionverifica.com', shared_as: 'subject' }],
    });
    assert.deepEqual(Object.keys(data.invoice_tables), ['actions', 'to_raise', 'receivables', 'list']);
  });

  test("Finance's debtors list: the newest from Finance is read once, used when it adds up, and not when it does not", async () => {
    const { refreshReceivableList } = await import('../src/lib/mailbox/receivablesList.js');
    const workbook = (grand) => {
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
        ['Particulars', 'Closing Balance', 'Days'], ['Hindalco Industries Ltd', 244530, 49], ['Pending for invoicing'], ['Aragen Life Sciences', 100000, 10], ['Grand Total', grand],
      ]), 'Debtors');
      return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    };
    let asked = 0;
    let file = workbook(344530);
    const provider = { attachments: async () => { asked += 1; return [{ name: 'Sundry Debtors.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', content: file }]; } };
    const email = async (from, subject, at, attachment = null, direction = 'inbound') => {
      const { rows: [t] } = await db.query(`INSERT INTO email_threads (account_id, conversation_id, subject) VALUES ($1, $2, $3) RETURNING id`, [ids.sales, `debtors-${at}`, subject]);
      const { rows: [m] } = await db.query(
        `INSERT INTO email_messages (account_id, thread_id, provider_id, direction, from_email, subject, sent_at, has_attachments) VALUES ($1, $2, $3, $8, $4, $5, $6, $7) RETURNING id`,
        [ids.sales, t.id, `debtors-${at}`, from, subject, at, Boolean(attachment), direction]);
      if (attachment) await db.query(`INSERT INTO email_attachments (message_id, provider_id, name) VALUES ($1, 'a1', $2)`, [m.id, attachment]);
      await db.query('UPDATE email_messages SET attachments_listed_at = now() WHERE id = $1', [m.id]);
      return m.id;
    };
    await email('accounts@cetizionverifica.com', 'Debtors as on 03-10-2026', '2026-10-04T05:00:00Z', 'Sundry Debtors.xlsx');
    // Newer, but from a client: not Finance's list.
    await email('ravi@acmesteel.in', 'Outstanding payment query', '2026-10-04T08:00:00Z');

    const first = await refreshReceivableList(db, { now: new Date('2026-10-05T03:00:00Z'), provider });
    assert.equal(first.stored.status, 'used', JSON.stringify(first));
    assert.equal(first.stored.method, 'xlsx');
    assert.equal(String(first.stored.list_date).slice(0, 10), '2026-10-04', "no date read from a sheet: the email's");
    const again = await refreshReceivableList(db, { now: new Date('2026-10-05T03:00:00Z'), provider });
    assert.ok(again.already, 'read once');
    assert.equal(asked, 1, 'the mailbox was asked once');
    // Newer, but not a list: a reply with only a signature image, and our own mail to a client about an invoice.
    await email('accounts@cetizionverifica.com', 'Re: Debtors as on 03-10-2026', '2026-10-04T09:00:00Z', 'image001.png');
    await email('sales@cetizionverifica.com', 'Outstanding payment: invoice CVPL/2026-27/037', '2026-10-04T10:00:00Z', 'Invoice 037.pdf', 'outbound');
    assert.equal((await refreshReceivableList(db, { now: new Date('2026-10-05T03:00:00Z'), provider })).already?.status, 'used', 'the list stands');
    assert.equal(asked, 1);

    let data = await misReports.dailyBriefing({ today: '2026-10-05', db });
    assert.deepEqual([data.invoice_tables.list.list_only, data.invoice_tables.list.matched], [2, 0], 'nothing in this tracker: both lines are on the list only');
    assert.equal(data.invoice_tables.receivables.rows[0].client, 'Hindalco Industries Ltd');
    assert.equal(data.invoice_tables.to_raise.rows[0].client, 'Aragen Life Sciences', 'pending for invoicing goes with the invoices to raise');
    assert.equal(data.invoice_tables.list.link, `/inbox?mb=${ids.sales}`);

    // Finance's next list does not add up: it is not used, and no older list stands in for it.
    file = workbook(999999);
    await email('accounts@cetizionverifica.com', 'Sundry debtors', '2026-10-05T02:00:00Z', 'Sundry Debtors.xlsx');
    const bad = await refreshReceivableList(db, { now: new Date('2026-10-05T03:00:00Z'), provider });
    assert.equal(bad.stored.status, 'rejected');
    assert.match(bad.stored.reason, /not the grand total 999999/);
    data = await misReports.dailyBriefing({ today: '2026-10-05', db });
    assert.equal(data.invoice_tables.list.rejected, true);
    assert.equal(data.invoice_tables.receivables.count, 0);

    // A protected or damaged file is recorded as not used, so it is not fetched again on every run.
    file = Buffer.from('PK not really a workbook');
    await email('accounts@cetizionverifica.com', 'Sundry debtors (protected)', '2026-10-05T02:30:00Z', 'Sundry Debtors.xlsx');
    const damaged = await refreshReceivableList(db, { now: new Date('2026-10-05T03:00:00Z'), provider });
    assert.equal(damaged.stored.status, 'rejected');
    assert.match(damaged.stored.reason, /could not be opened/);
    assert.ok((await refreshReceivableList(db, { now: new Date('2026-10-05T03:00:00Z'), provider })).already, 'and not read again');
  });
});
