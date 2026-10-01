import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, beforeEach, describe } from 'node:test';
import pg from 'pg';

/**
 * The follow-up runner against a real database
 * (docs/follow-up-escalation-test-plan.md §6 and §8).
 *
 * Calendar: Monday 5 October 2026 is the first run; respond-by is Wednesday
 * 7 October; the first escalation is Thursday 8 October.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');

describe('follow-up runner', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let dbUrl;
  let db;
  let pool;
  let runFollowUps;
  let lastActivity;
  let runPaymentReminders;
  let runJob;
  const people = {};

  before(async () => {
    const root = new pg.Client({ connectionString: ADMIN_URL });
    await root.connect();
    const name = `followups_${process.pid}_${Date.now()}`;
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
    process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-to-pass';
    process.env.EMAIL_MODE = 'log';

    ({ pool } = await import('../src/db.js'));
    ({ runFollowUps, lastActivity } = await import('../src/lib/followUps.js'));
    ({ runPaymentReminders } = await import('../src/lib/reminders.js'));
    ({ runJob } = await import('../src/jobs.js'));
  });

  after(async () => {
    await pool?.end();
    await db?.end();
    const root = new pg.Client({ connectionString: ADMIN_URL });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${new URL(dbUrl).pathname.slice(1)} WITH (FORCE)`);
    await root.end();
  });

  const user = async (key, name, email, role, active = true) => {
    const { rows: [row] } = await db.query(
      `INSERT INTO users (name, email, password_hash, role, active) VALUES ($1,$2,'x',$3,$4) RETURNING id`,
      [name, email, role, active]
    );
    people[key] = row.id;
  };

  const setting = (key, value) => db.query(`UPDATE settings SET value = $2 WHERE key = $1`, [key, value]);

  beforeEach(async () => {
    for (const t of ['follow_up_cycles', 'notifications', 'webhook_events', 'webhook_endpoints', 'email_log', 'job_runs', 'communications', 'collection_log',
      'notes', 'task_targets', 'tasks', 'email_messages', 'email_threads', 'connected_accounts', 'quotation_stage_history', 'quotation_revisions',
      'payment_stages', 'po_services', 'purchase_orders', 'enquiries', 'quotations', 'projects', 'holidays', 'users']) {
      await db.query(`DELETE FROM ${t}`);
    }
    await user('asha', 'Asha', 'asha@qa.example', 'sales');
    await user('ben', 'Ben', 'ben@qa.example', 'sales');
    await user('meera', 'Meera', 'meera@qa.example', 'admin');
    await user('old', 'Ravi', 'ravi@qa.example', 'sales', false);
    await setting('followup_enabled', 'true');
    await setting('followup_escalation_emails', 'md@qa.example, Meera@QA.example');
    await setting('followup_cc_owner_on_escalation', 'false');
    await setting('public_app_url', 'https://tracker.example');
  });

  // ------------------------------------------------------------- fixtures

  const enquiry = (no, owner, followUp = '2026-10-05') => db.query(
    `INSERT INTO enquiries (enquiry_no, enquiry_date, client_name, status, next_follow_up_at, owner_user_id, created_at)
     VALUES ($1, '2026-09-20', 'Hetero', 'Contacted', $2, $3, '2026-09-20T05:00:00Z')`,
    [no, followUp, owner]
  );
  const quotation = (no, owner, sentAt = '2026-09-28T06:00:00Z') => db.query(
    `INSERT INTO quotations (quotation_no, client_name, status, sent_at, owner_user_id, quotation_value)
     VALUES ($1, 'Midal', 'Submitted', $2, $3, 250000) RETURNING id`,
    [no, sentAt, owner]
  );
  /** A stage invoiced on 1 August with 30 days' credit: overdue since 31 August. */
  const stage = async (owner) => {
    await db.query(`INSERT INTO projects (project_id, client_name, owner_user_id) VALUES ('P-1', 'Hetero', $1)`, [owner]);
    await db.query(`INSERT INTO purchase_orders (po_number, project_id, po_date, po_value) VALUES ('PO-1', 'P-1', '2026-07-01', 100000)`);
    const { rows: [s] } = await db.query(
      `INSERT INTO payment_stages (po_number, stage_no, stage_name, stage_percent, invoice_no, invoice_date, credit_days)
       VALUES ('PO-1', 1, 'Advance', 1, 'CVPL/26-27/40', '2026-08-01', 30) RETURNING id`
    );
    return String(s.id);
  };

  /** A stand-in for lib/mail.js: records every call, returns the status asked for. */
  const sender = (statusFor = () => 'sent') => {
    const calls = [];
    let id = 0;
    const send = async (msg, conn) => {
      const status = typeof statusFor === 'function' ? statusFor(msg) : statusFor;
      if (status === 'throw') throw new Error('SMTP connection reset');
      const { rows: [row] } = await conn.query(
        `INSERT INTO email_log (to_email, subject, template, entity, entity_id, status, body_text) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [msg.to, msg.subject, msg.template, msg.entity, msg.entityId === null || msg.entityId === undefined ? null : String(msg.entityId), status, msg.text]
      );
      calls.push({ ...msg, status, id: row.id });
      id += 1;
      return { id: row.id, status };
    };
    send.calls = calls;
    return send;
  };

  const run = (today, opts = {}) => runFollowUps({ db: pool, today, now: new Date(`${today}T03:45:00Z`), authMode: 'database', alert: async () => true, ...opts });
  const cycles = async () => (await db.query(`SELECT * FROM follow_up_cycles ORDER BY entity, entity_id, id`)).rows;
  const open = async () => (await db.query(`SELECT * FROM follow_up_cycles WHERE resolved_at IS NULL ORDER BY entity, entity_id`)).rows;

  /** I-03's seed: one of each kind for Asha, one enquiry for Ben. */
  const seedFour = async () => {
    await enquiry('ENQ-1', people.asha);
    await quotation('Q-1', people.asha);
    const stageId = await stage(people.asha);
    await enquiry('ENQ-2', people.ben);
    return stageId;
  };

  // ------------------------------------------------------- §6 activity

  test('U-A: what counts as activity, and the latest of several', async () => {
    await enquiry('ENQ-1', people.asha);
    await enquiry('ENQ-9', people.asha);
    const { rows: [q] } = await quotation('Q-1', people.asha);
    const stageId = await stage(people.asha);
    const at = async (key) => (await lastActivity(db, [key])).get(key)?.toISOString() ?? null;

    assert.equal(await at('enquiry:ENQ-1'), null);
    // U-A13: editing the record is not activity.
    await db.query(`UPDATE enquiries SET notes = 'edited', updated_at = now() WHERE enquiry_no = 'ENQ-1'`);
    assert.equal(await at('enquiry:ENQ-1'), null);
    // U-A02 / U-A03: a no-answer call counts; one on another record does not.
    await db.query(`INSERT INTO communications (channel, outcome, entity, entity_id, started_at) VALUES ('call', 'no_answer', 'enquiry', 'ENQ-1', '2026-10-01T05:00:00Z')`);
    await db.query(`INSERT INTO communications (channel, outcome, entity, entity_id, started_at) VALUES ('call', 'connected', 'enquiry', 'ENQ-9', '2026-10-04T05:00:00Z')`);
    assert.equal(await at('enquiry:ENQ-1'), '2026-10-01T05:00:00.000Z');
    // U-A09 / U-A10 / U-A14: notes and completed tasks count, the latest wins; an open task does not.
    await db.query(`INSERT INTO notes (entity, entity_id, body, created_at) VALUES ('enquiry', 'ENQ-1', 'n', '2026-10-02T05:00:00Z')`);
    await db.query(`INSERT INTO tasks (entity, entity_id, title, created_at) VALUES ('enquiry', 'ENQ-1', 'open task', '2026-10-05T05:00:00Z')`);
    assert.equal(await at('enquiry:ENQ-1'), '2026-10-02T05:00:00.000Z');
    await db.query(`INSERT INTO tasks (entity, entity_id, title, status, completed_at) VALUES ('enquiry', 'ENQ-1', 'done', 'done', '2026-10-03T05:00:00Z')`);
    assert.equal(await at('enquiry:ENQ-1'), '2026-10-03T05:00:00.000Z');

    // U-A04..06: a person's chase counts; the reminder job's never does, whoever started it.
    await db.query(`INSERT INTO collection_log (stage_id, channel, summary, automated, happened_at) VALUES ($1, 'email', 'Reminder level 1 emailed to x', true, '2026-10-04T05:00:00Z')`, [stageId]);
    assert.equal(await at(`payment_stage:${stageId}`), null);
    const send = sender();
    await runPaymentReminders({ db, today: '2026-10-05', startedBy: 'meera@qa.example', send });
    assert.equal(await at(`payment_stage:${stageId}`), null);
    await db.query(`INSERT INTO collection_log (stage_id, channel, summary, happened_at) VALUES ($1, 'call', 'Spoke to accounts', '2026-10-02T05:00:00Z')`, [stageId]);
    assert.equal(await at(`payment_stage:${stageId}`), '2026-10-02T05:00:00.000Z');

    // U-A07 / U-A08: outbound mail on a linked thread counts; inbound does not.
    const { rows: [acct] } = await db.query(`INSERT INTO connected_accounts (username, email, provider) VALUES ('asha', 'asha@qa.example', 'test') RETURNING id`);
    const { rows: [thread] } = await db.query(`INSERT INTO email_threads (account_id, conversation_id, entity, entity_id) VALUES ($1, 'c1', 'quotation', 'Q-1') RETURNING id`, [acct.id]);
    await db.query(`INSERT INTO email_messages (account_id, thread_id, provider_id, direction, sent_at) VALUES ($1, $2, 'm1', 'inbound', '2026-10-04T05:00:00Z')`, [acct.id, thread.id]);
    assert.equal(await at('quotation:Q-1'), null);
    await db.query(`INSERT INTO email_messages (account_id, thread_id, provider_id, direction, sent_at) VALUES ($1, $2, 'm2', 'outbound', '2026-10-01T05:00:00Z')`, [acct.id, thread.id]);
    assert.equal(await at('quotation:Q-1'), '2026-10-01T05:00:00.000Z');
    // U-A11 / U-A12: stage changes and revisions on a quotation.
    await db.query(`INSERT INTO quotation_stage_history (quotation_id, changed_at) VALUES ($1, '2026-10-02T05:00:00Z')`, [q.id]);
    assert.equal(await at('quotation:Q-1'), '2026-10-02T05:00:00.000Z');
    await db.query(`INSERT INTO quotation_revisions (quotation_id, revision, snapshot, created_at) VALUES ($1, 1, '{}', '2026-10-03T05:00:00Z')`, [q.id]);
    assert.equal(await at('quotation:Q-1'), '2026-10-03T05:00:00.000Z');

    // A completed task counts on every record it stands on, not only its first.
    const { rows: [t] } = await db.query(`INSERT INTO tasks (entity, entity_id, title, status, completed_at) VALUES ('enquiry', 'ENQ-9', 'shared', 'done', '2026-10-04T08:00:00Z') RETURNING id`);
    await db.query(`INSERT INTO task_targets (task_id, entity, entity_id) VALUES ($1, 'quotation', 'Q-1')`, [t.id]);
    assert.equal(await at('quotation:Q-1'), '2026-10-04T08:00:00.000Z');

    // A chase logged against the whole client covers each of its invoices.
    const { rows: [co] } = await db.query(`INSERT INTO companies (name) VALUES ('Client chased whole') RETURNING id`);
    await db.query(`UPDATE projects SET company_id = $1 WHERE project_id = 'P-1'`, [co.id]);
    await db.query(`INSERT INTO collection_log (company_id, channel, summary, happened_at) VALUES ($1, 'call', 'Chased the client', '2026-10-04T09:00:00Z')`, [co.id]);
    assert.equal(await at(`payment_stage:${stageId}`), '2026-10-04T09:00:00.000Z');
    // ...but not when the reminder job wrote it.
    await db.query(`INSERT INTO collection_log (company_id, channel, summary, automated, happened_at) VALUES ($1, 'email', 'auto', true, '2026-10-05T09:00:00Z')`, [co.id]);
    assert.equal(await at(`payment_stage:${stageId}`), '2026-10-04T09:00:00.000Z');
  });

  test('U-A15: 500 keys in one query', async () => {
    const keys = Array.from({ length: 500 }, (_, n) => `enquiry:ENQ-${n}`);
    const started = performance.now();
    await lastActivity(db, keys);
    assert.ok(performance.now() - started < 200);
  });

  // --------------------------------------------------------- §8 runner

  test('I-01: switched off, nothing happens', async () => {
    await seedFour();
    await setting('followup_enabled', 'false');
    const send = sender();
    const result = await run('2026-10-05', { send });
    assert.equal(result.skipped, 'followup_enabled is false');
    assert.equal(send.calls.length, 0);
    assert.deepEqual(await cycles(), []);
  });

  test('I-02: a weekend or a holiday is skipped', async () => {
    await seedFour();
    await db.query(`INSERT INTO holidays (holiday_on, name) VALUES ('2026-10-02', 'Gandhi Jayanti')`);
    const send = sender();
    assert.equal((await run('2026-10-03', { send })).skipped, 'not a working day');
    assert.equal((await run('2026-10-02', { send })).skipped, 'not a working day');
    assert.equal(send.calls.length, 0);
  });

  test('I-03/04: one digest per owner, cycles with respond-by, and nothing again the same day', async () => {
    await seedFour();
    const send = sender();
    const result = await run('2026-10-05', { send });
    assert.deepEqual(send.calls.map((c) => [c.to, c.template]), [['asha@qa.example', 'follow_up_reminder'], ['ben@qa.example', 'follow_up_reminder']]);
    assert.equal(send.calls[0].subject, 'Follow up today: 1 enquiry, 1 quotation, 1 invoice');
    const rows = await cycles();
    assert.equal(rows.length, 4);
    for (const c of rows) {
      assert.equal(c.respond_by, '2026-10-07');
      assert.ok(c.reminder_email_id);
      assert.equal(c.resolved_at, null);
    }
    assert.equal(result.reminded.length, 2);

    const again = sender();
    await run('2026-10-05', { send: again });
    assert.equal(again.calls.length, 0);
    assert.equal((await cycles()).length, 4);
  });

  test('I-05/06: a suppressed or failed reminder starts nothing and is retried', async () => {
    for (const status of ['suppressed', 'failed']) {
      await db.query('DELETE FROM follow_up_cycles');
      await enquiry(`ENQ-${status}`, people.asha);
      const result = await run('2026-10-05', { send: sender((m) => (m.to === 'asha@qa.example' ? status : 'sent')) });
      assert.equal(result.not_reminded.length, 1, status);
      assert.deepEqual(await cycles(), [], status);
      // Days later, still nothing to escalate: there is no reminder on record.
      const late = sender();
      await run('2026-10-12', { send: late });
      assert.ok(late.calls.every((c) => c.template === 'follow_up_reminder'), status);
      assert.equal((await open()).length, 1, status);
      await db.query(`DELETE FROM enquiries`);
    }
  });

  test('I-07/08: no escalation inside grace; after it, one digest per recipient, marked, in the bell and to n8n', async () => {
    await db.query(`INSERT INTO webhook_endpoints (name, url, events, secret) VALUES ('n8n', 'https://n8n.example/hook', '{follow_up.escalated}', 's')`);
    await seedFour();
    const { rows: [{ id: companyId }] } = await db.query(`INSERT INTO companies (name) VALUES ('Client with a sector') RETURNING id`);
    await db.query(`UPDATE projects SET company_id = $1`, [companyId]);
    await run('2026-10-05', { send: sender() });
    for (const today of ['2026-10-06', '2026-10-07']) {
      const send = sender();
      await run(today, { send });
      assert.equal(send.calls.length, 0, today);
    }
    const send = sender();
    const result = await run('2026-10-08', { send });
    const escalations = send.calls.filter((c) => c.template === 'follow_up_escalation');
    assert.deepEqual(escalations.map((c) => c.to).sort(), ['md@qa.example', 'meera@qa.example']);
    assert.equal(escalations[0].subject, 'Follow-ups missed: 4 new');
    assert.match(escalations[0].text, /Asha\n.*ENQ-1/s);
    assert.match(escalations[0].text, /Ben\n.*ENQ-2/s);
    for (const c of await cycles()) {
      assert.ok(c.escalated_at);
      assert.equal(c.last_escalated_on, '2026-10-08');
      assert.equal(c.escalation_count, 1);
      assert.ok(c.escalation_email_id);
    }
    assert.equal(result.escalated, 4);
    const { rows: [{ n }] } = await db.query(`SELECT COUNT(*)::int AS n FROM notifications WHERE kind = 'follow_up_escalated' AND username = 'meera@qa.example'`);
    assert.equal(n, 4);
    const { rows: events } = await db.query(`SELECT * FROM webhook_events WHERE event = 'follow_up.escalated'`);
    assert.equal(events.length, 4);
    // The company rides along, so a sector-filtered endpoint can match it.
    const stageEvent = events.find((e) => e.entity === 'payment_stage');
    assert.equal(stageEvent.company_id, companyId);
    assert.ok(events.every((e) => !JSON.stringify(e.data).includes('@')), 'no addresses in webhook payloads');
  });

  test('I-09: with the owner notice on, each owner hears only about their own items', async () => {
    await setting('followup_cc_owner_on_escalation', 'true');
    await seedFour();
    await run('2026-10-05', { send: sender() });
    const send = sender();
    await run('2026-10-08', { send });
    const notices = send.calls.filter((c) => c.template === 'follow_up_escalated_notice');
    assert.deepEqual(notices.map((c) => c.to).sort(), ['asha@qa.example', 'ben@qa.example']);
    const toBen = notices.find((c) => c.to === 'ben@qa.example');
    assert.match(toBen.text, /ENQ-2/);
    assert.doesNotMatch(toBen.text, /ENQ-1|Q-1|CVPL/);
  });

  test('I-10: a touch before respond-by resolves that one; the rest escalate', async () => {
    await seedFour();
    await run('2026-10-05', { send: sender() });
    await db.query(`INSERT INTO communications (channel, outcome, entity, entity_id, started_at) VALUES ('call', 'connected', 'enquiry', 'ENQ-1', '2026-10-06T05:30:00Z')`);
    const result = await run('2026-10-08', { send: sender() });
    const enq = (await cycles()).find((c) => c.entity_id === 'ENQ-1');
    assert.equal(enq.resolved_reason, 'activity');
    assert.equal(enq.escalated_at, null);
    assert.equal(result.escalated, 3);
  });

  test('I-11: nobody to escalate to raises an alert and marks nothing', async () => {
    await seedFour();
    await run('2026-10-05', { send: sender() });
    await db.query(`UPDATE users SET active = false WHERE role = 'admin'`);
    await setting('followup_escalation_emails', '');
    const alerts = [];
    const result = await run('2026-10-08', { send: sender(), alert: async (...a) => { alerts.push(a); return true; } });
    assert.equal(alerts.length, 1);
    assert.equal(result.escalation.marked, false);
    assert.ok((await cycles()).every((c) => !c.escalated_at));
    // Once there is someone, it goes.
    await setting('followup_escalation_emails', 'md@qa.example');
    const send = sender();
    await run('2026-10-09', { send });
    assert.equal(send.calls.filter((c) => c.template === 'follow_up_escalation').length, 1);
    assert.ok((await cycles()).every((c) => c.escalated_at));
  });

  test('I-12/13: escalation marked only when at least one recipient got it', async () => {
    await enquiry('ENQ-1', people.asha);
    await run('2026-10-05', { send: sender() });
    await run('2026-10-08', { send: sender((m) => (m.template === 'follow_up_escalation' ? 'failed' : 'sent')) });
    assert.equal((await cycles())[0].escalated_at, null);
    await run('2026-10-09', { send: sender((m) => (m.to === 'md@qa.example' ? 'failed' : 'sent')) });
    assert.ok((await cycles())[0].escalated_at);
    const { rows } = await db.query(`SELECT to_email, status FROM email_log WHERE template = 'follow_up_escalation' ORDER BY id`);
    assert.ok(rows.some((r) => r.to_email === 'md@qa.example' && r.status === 'failed'));
  });

  test('I-13b: a recipient whose send throws does not undo another who got it', async () => {
    await enquiry('ENQ-1', people.asha);
    await run('2026-10-05', { send: sender() });
    const send = sender((m) => (m.template === 'follow_up_escalation' && m.to === 'md@qa.example' ? 'throw' : 'sent'));
    const result = await run('2026-10-08', { send });
    assert.equal(result.escalation.marked, true);
    assert.ok(result.escalation.recipients.some((r) => r.to === 'md@qa.example' && r.status === 'error'));
    assert.ok((await cycles())[0].escalated_at);
    const again = sender();
    await run('2026-10-09', { send: again });
    assert.equal(again.calls.length, 0, 'not sent to management a second time');
  });

  test('a digest of more than 50 starts cycles only for the 50 listed; the rest lead the next one', async () => {
    for (let n = 0; n < 55; n += 1) await enquiry(`ENQ-${String(n).padStart(2, '0')}`, people.asha);
    const first = sender();
    await run('2026-10-05', { send: first });
    assert.equal(first.calls.length, 1);
    assert.match(first.calls[0].text, /5 more are due as well/);
    assert.equal((await open()).length, 50);
    const second = sender();
    await run('2026-10-06', { send: second });
    assert.equal(second.calls[0].subject, 'Follow up today: 5 enquiries');
    assert.equal((await open()).length, 55);
    // Nothing unseen is escalated: on 8 October only the first 50 are past respond-by.
    const third = sender();
    const result = await run('2026-10-08', { send: third });
    assert.equal(result.escalated, 50);
  });

  test('I-14: two runs at once: one works, the other stands aside', async () => {
    await seedFour();
    const send = sender();
    // Whichever way the two interleave, each owner hears once and each record
    // has one cycle: the lock, or the open-cycle index, stops the second.
    await Promise.all([run('2026-10-05', { send }), run('2026-10-05', { send })]);
    assert.equal(send.calls.length, 2);
    assert.equal((await cycles()).length, 4);
  });

  test('I-15: a send that throws keeps what was already written; a rerun finishes the rest', async () => {
    await seedFour();
    await assert.rejects(run('2026-10-05', { send: sender((m) => (m.to === 'ben@qa.example' ? 'throw' : 'sent')) }));
    assert.equal((await cycles()).length, 3);
    const send = sender();
    await run('2026-10-05', { send });
    assert.deepEqual(send.calls.map((c) => c.to), ['ben@qa.example']);
    assert.equal((await cycles()).length, 4);
  });

  test('I-16: unowned and inactive-owner records go to management on the first run', async () => {
    await quotation('Q-9', null);
    await quotation('Q-8', people.old);
    const send = sender();
    const result = await run('2026-10-05', { send });
    assert.deepEqual(send.calls.map((c) => c.template).sort(), ['follow_up_escalation', 'follow_up_escalation']);
    assert.equal(send.calls[0].subject, 'Follow-ups missed: 2 with no owner');
    assert.match(send.calls[0].text, /was Ravi/);
    assert.equal(result.unowned, 2);
    const rows = await cycles();
    assert.ok(rows.every((c) => c.reminded_at === null && c.escalated_at && c.reminded_user_id === null));
    // Not again the next day.
    const next = sender();
    await run('2026-10-06', { send: next });
    assert.equal(next.calls.length, 0);
  });

  test('I-17: the job records a readable summary', async () => {
    await enquiry('ENQ-1', people.asha);
    const r = await runJob('followups.daily', { startedBy: 'meera@qa.example' });
    assert.equal(r.status, 'done', r.error);
    const { rows: [job] } = await db.query(`SELECT * FROM job_runs WHERE name = 'followups.daily'`);
    assert.equal(job.started_by, 'meera@qa.example');
    assert.ok(job.result);
  });

  test('I-18: shared sign-in: no owners, every item to the management list, or the digest address', async () => {
    await seedFour();
    let send = sender();
    await run('2026-10-05', { send, authMode: 'shared' });
    assert.ok(send.calls.every((c) => c.template === 'follow_up_escalation'));
    assert.deepEqual(send.calls.map((c) => c.to).sort(), ['md@qa.example', 'Meera@QA.example'].sort());
    await db.query('DELETE FROM follow_up_cycles');
    await setting('followup_escalation_emails', '');
    await db.query(`INSERT INTO settings (key, value) VALUES ('digest_email', 'boss@qa.example') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
    send = sender();
    await run('2026-10-05', { send, authMode: 'shared' });
    assert.deepEqual(send.calls.map((c) => c.to), ['boss@qa.example']);
  });

  test('I-19: thirty days with no activity: one reminder, one escalation, then every 5 working days', async () => {
    await enquiry('ENQ-1', people.asha);
    const send = sender();
    for (let d = 0; d < 30; d += 1) {
      const today = new Date(Date.parse('2026-10-05T00:00:00Z') + d * 864e5).toISOString().slice(0, 10);
      await run(today, { send });
    }
    const reminders = send.calls.filter((c) => c.template === 'follow_up_reminder');
    const escalationDays = [...new Set(send.calls.filter((c) => c.template === 'follow_up_escalation').map((c) => c.entityId))];
    assert.equal(reminders.length, 1);
    // 8 Oct, then 5 working days after each: 15, 22, 29 Oct.
    assert.deepEqual(escalationDays, ['2026-10-08', '2026-10-15', '2026-10-22', '2026-10-29']);
    const [c] = await cycles();
    assert.equal(c.escalation_count, 4);
  });

  test('I-20: with the real sendMail in log mode nothing is reminded', async () => {
    await enquiry('ENQ-1', people.asha);
    const { sendMail } = await import('../src/lib/mail.js');
    const result = await run('2026-10-05', { send: sendMail });
    assert.equal(result.not_reminded[0].status, 'suppressed');
    assert.deepEqual(await cycles(), []);
    const { rows } = await db.query(`SELECT status FROM email_log WHERE template = 'follow_up_reminder'`);
    assert.deepEqual(rows.map((r) => r.status), ['suppressed']);
  });

  test('reassignment and closing: the cycle follows the record', async () => {
    await enquiry('ENQ-1', people.asha);
    await quotation('Q-1', people.asha);
    await run('2026-10-05', { send: sender() });
    await db.query(`UPDATE enquiries SET owner_user_id = $1 WHERE enquiry_no = 'ENQ-1'`, [people.ben]);
    await db.query(`UPDATE quotations SET status = 'Lost', closed_at = now() WHERE quotation_no = 'Q-1'`);
    const send = sender();
    await run('2026-10-06', { send });
    const rows = await cycles();
    assert.deepEqual(rows.filter((c) => c.resolved_at).map((c) => [c.entity_id, c.resolved_reason]).sort(), [['ENQ-1', 'reassigned'], ['Q-1', 'closed']]);
    assert.deepEqual(send.calls.map((c) => c.to), ['ben@qa.example']);
    assert.equal((await open())[0].reminded_user_id, people.ben);
  });
});
