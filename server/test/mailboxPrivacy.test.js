import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * The privacy and plumbing findings from the review of batch 4 (#29, #60),
 * at the request level.
 *
 * A connected mailbox is somebody's personal correspondence, so what it
 * shares by default is the whole question; the Graph webhook is one of the
 * two doors in this batch that sit outside the login, so what it costs an
 * unauthenticated caller is the other.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;

describe('a connected mailbox, and the door Microsoft knocks on', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let db;
  let app;
  let agent;
  let dbName;

  before(async () => {
    const owner = new pg.Client({ connectionString: ADMIN_URL });
    await owner.connect();
    dbName = `mailbox_suite_${process.pid}_${Date.now()}`;
    await owner.query(`CREATE DATABASE ${dbName}`);
    await owner.end();

    const u = new URL(ADMIN_URL);
    u.pathname = `/${dbName}`;
    const dbUrl = u.toString();

    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const dbDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');

    db = new pg.Client({ connectionString: dbUrl });
    await db.connect();
    await db.query(readFileSync(join(dbDir, 'schema.sql'), 'utf8'));
    await db.query(readFileSync(join(dbDir, 'views.sql'), 'utf8'));

    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = dbUrl;
    process.env.AUTH_MODE = 'shared';
    process.env.AUTH_USERNAME = 'admin';
    process.env.AUTH_PASSWORD = 'a-good-long-test-password';
    process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-to-pass';
    process.env.EMAIL_MODE = 'log';

    ({ default: app } = await import('../src/app.js'));
    agent = request.agent(app);
    await agent.post('/api/auth/login').send({ username: 'admin', password: 'a-good-long-test-password' }).expect(200);
  });

  after(async () => {
    const { pool } = await import('../src/db.js');
    await pool.end().catch(() => {});
    await db?.end().catch(() => {});
    const owner = new pg.Client({ connectionString: ADMIN_URL });
    await owner.connect();
    await owner.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await owner.end();
  });

  const testMailbox = async (email) => (await agent.post('/api/mailboxes/test').send({ email, shared: false }).expect(201)).body.data;

  test('a mailbox nobody has chosen for shares who and when, and no more', async () => {
    const box = await testMailbox(`private-${Date.now()}@cetizionverifica.com`);
    assert.equal(box.visibility, 'metadata', 'a personal mailbox is not exposed before its owner decides');

    // The column default is the thing under test, not the route: a mailbox
    // created by any other path has to start in the same place.
    const { rows: [direct] } = await db.query(
      `INSERT INTO connected_accounts (username, provider, email) VALUES ('admin', 'test', $1) RETURNING visibility`,
      [`direct-${Date.now()}@cetizionverifica.com`]);
    assert.equal(direct.visibility, 'metadata');
  });

  test('the owner can still share more, and the three settings all hold', async () => {
    const box = await testMailbox(`choosing-${Date.now()}@cetizionverifica.com`);
    for (const visibility of ['subject', 'share_everything', 'metadata']) {
      const { body } = await agent.patch(`/api/mailboxes/${box.id}`).send({ visibility }).expect(200);
      assert.equal(body.data.visibility, visibility);
    }
  });

  /**
   * How far back a mailbox reads is only consulted for a folder with no
   * delta link, so raising it while a cursor exists changed precisely
   * nothing — the setting looked like it worked and the older mail never
   * arrived. Dropping the cursor is what gives the number meaning.
   */
  test('asking for more history drops the sync cursor so the next pass goes back for it', async () => {
    const box = await testMailbox(`history-${Date.now()}@cetizionverifica.com`);
    await db.query(`INSERT INTO mail_folders (account_id, folder, delta_link) VALUES ($1, 'inbox', 'cursor-abc'), ($1, 'sentitems', 'cursor-def')`, [box.id]);

    const { body } = await agent.patch(`/api/mailboxes/${box.id}`).send({ import_days: 365 }).expect(200);
    assert.equal(body.data.import_days, 365);

    const { rows } = await db.query('SELECT delta_link FROM mail_folders WHERE account_id = $1', [box.id]);
    assert.equal(rows.length, 2);
    assert.ok(rows.every((f) => f.delta_link === null), 'both folders start again from the new window');
  });

  test('changing something else leaves the cursor where it was', async () => {
    const box = await testMailbox(`cursor-kept-${Date.now()}@cetizionverifica.com`);
    await db.query(`INSERT INTO mail_folders (account_id, folder, delta_link) VALUES ($1, 'inbox', 'cursor-keep')`, [box.id]);

    await agent.patch(`/api/mailboxes/${box.id}`).send({ exclude_internal: false }).expect(200);

    const { rows: [folder] } = await db.query('SELECT delta_link FROM mail_folders WHERE account_id = $1', [box.id]);
    assert.equal(folder.delta_link, 'cursor-keep', 're-reading the whole window is not free; only ask for it when asked');
  });

  test('mail between colleagues can be kept, for a mailbox that wants it', async () => {
    const box = await testMailbox(`internal-${Date.now()}@cetizionverifica.com`);
    const { body } = await agent.patch(`/api/mailboxes/${box.id}`).send({ exclude_internal: false }).expect(200);
    assert.equal(body.data.exclude_internal, false);
  });

  /**
   * The sanitiser learned to keep a sender's styling, and cleanHtml runs
   * once — at ingest — so every mail already stored kept the bare version
   * the old rules left of it. refreshBodies is how those catch up.
   *
   * The test provider hands each pushed message over once, so the sweep is
   * given them again: a real provider still holds the mail, which is the
   * whole premise. refreshBodies only ever UPDATEs, so handing it the same
   * message twice is exactly what it is built for.
   */
  const shared = async (email, visibility = 'metadata') => {
    const box = (await agent.post('/api/mailboxes/test').send({ email, shared: true }).expect(201)).body.data;
    // Even a shared mailbox starts at metadata — its owner decides. A test
    // that wants to read a body has to make that choice explicitly, which
    // is the same thing a person does in Settings.
    if (visibility !== 'metadata') await agent.patch(`/api/mailboxes/${box.id}`).send({ visibility }).expect(200);
    return box;
  };

  const designed = '<style>.btn{background:#0a7}</style>'
    + '<table width="640" bgcolor="#ffffff"><tr><td align="center">'
    + '<a href="https://x.test" class="btn" style="padding:10px">Open</a></td></tr></table>';

  const message = (to, providerId, html) => ({
    folder: 'inbox', provider_id: providerId, conversation_id: `conv-${providerId}`,
    from: { email: 'client@elsewhere.test', name: 'A Client' }, to: [{ email: to }],
    subject: 'Designed message', body_html: html, sent_at: new Date().toISOString(),
  });

  test('a backfill re-reads stored mail under the sanitiser as it is now', async () => {
    const box = await shared('refresh@cetizion.test', 'share_everything');
    const { pushTestMessages } = await import('../src/lib/mailbox/sync.js');

    pushTestMessages(box.id, [message('refresh@cetizion.test', 'refresh-1', designed)]);
    await agent.post(`/api/mailboxes/${box.id}/sync`).expect(200);
    const { rows: [stored] } = await db.query(`SELECT body_html FROM email_messages WHERE provider_id = 'refresh-1'`);
    assert.ok(stored, 'the message was stored');

    // Put it back the way the old sanitiser left it, which is what every
    // message stored before the change actually looks like.
    await db.query(`UPDATE email_messages SET body_html = $2 WHERE provider_id = $1`,
      ['refresh-1', '<table><tr><td><a href="https://x.test">Open</a></td></tr></table>']);

    pushTestMessages(box.id, [message('refresh@cetizion.test', 'refresh-1', designed)]);
    const { body } = await agent.post(`/api/mailboxes/${box.id}/refresh-bodies`).send({}).expect(200);
    assert.equal(body.data.updated, 1, `one message should have been rewritten: ${JSON.stringify(body.data)}`);

    const { rows: [m] } = await db.query(`SELECT body_html FROM email_messages WHERE provider_id = 'refresh-1'`);
    assert.match(m.body_html, /<style>/, "the sender's stylesheet is back");
    assert.match(m.body_html, /width="640"/, 'and the layout it was built with');
    assert.match(m.body_html, /class="btn"/);

    // Running it again changes nothing, so it is safe to run twice.
    pushTestMessages(box.id, [message('refresh@cetizion.test', 'refresh-1', designed)]);
    const again = await agent.post(`/api/mailboxes/${box.id}/refresh-bodies`).send({}).expect(200);
    assert.equal(again.body.data.updated, 0, 'a second pass has nothing to do');
  });

  test('a backfill never inserts what ingest chose not to keep', async () => {
    const box = await shared('nothing-new@cetizion.test');
    const { pushTestMessages } = await import('../src/lib/mailbox/sync.js');
    // Never synced, so we hold nothing for it. The sweep sees it and must
    // leave it alone rather than quietly adding mail nobody imported.
    pushTestMessages(box.id, [message('nothing-new@cetizion.test', 'never-stored', designed)]);
    const { body } = await agent.post(`/api/mailboxes/${box.id}/refresh-bodies`).send({}).expect(200);
    assert.equal(body.data.updated, 0);
    assert.equal(body.data.messages_held, 0, 'a backfill is not an import');
  });

  test('a backfill still obeys what the mailbox chose to share', async () => {
    const box = await shared('quiet-refresh@cetizion.test');
    const { pushTestMessages } = await import('../src/lib/mailbox/sync.js');
    const secret = message('quiet-refresh@cetizion.test', 'refresh-2', '<p style="color:red">Commercially sensitive</p>');

    pushTestMessages(box.id, [secret]);
    await agent.post(`/api/mailboxes/${box.id}/sync`).expect(200);
    await agent.patch(`/api/mailboxes/${box.id}`).send({ visibility: 'metadata' }).expect(200);

    pushTestMessages(box.id, [secret]);
    await agent.post(`/api/mailboxes/${box.id}/refresh-bodies`).send({}).expect(200);

    const { rows: [m] } = await db.query(`SELECT subject, body_html FROM email_messages WHERE provider_id = 'refresh-2'`);
    assert.equal(m.body_html, null, "a backfill is not a way round the owner's choice");
    assert.equal(m.subject, null);
  });

  test('disconnecting stops the mail, destroys the tokens and says what it could not do', async () => {
    const box = await testMailbox(`leaving-${Date.now()}@cetizionverifica.com`);
    await db.query(`UPDATE connected_accounts SET tokens_encrypted = 'pretend-token' WHERE id = $1`, [box.id]);
    await db.query(`INSERT INTO mail_folders (account_id, folder, subscription_id) VALUES ($1, 'inbox', 'sub-1')`, [box.id]);

    const { body } = await agent.post(`/api/mailboxes/${box.id}/disconnect`).send({ remove_bodies: true }).expect(200);
    assert.equal(body.data.status, 'disconnected');
    // Microsoft has no endpoint that revokes one application's refresh
    // token, so the tracker says where the person withdraws it instead of
    // pretending it has.
    assert.match(body.data.withdraw_consent_at, /myaccount\.microsoft\.com/);
    assert.match(body.data.upstream, /subscriptions/);

    const { rows: [after] } = await db.query('SELECT status, tokens_encrypted, last_error FROM connected_accounts WHERE id = $1', [box.id]);
    assert.equal(after.status, 'disconnected');
    assert.equal(after.tokens_encrypted, null, 'our copy of the tokens is gone');
    assert.match(after.last_error, /subscriptions/, 'and what happened upstream is on the record');
    const { rows: folders } = await db.query('SELECT 1 FROM mail_folders WHERE account_id = $1', [box.id]);
    assert.equal(folders.length, 0, 'nothing is left to deliver into');
  });

  test('the Graph webhook answers the validation handshake and carries a limit', async () => {
    const echo = await request(app).post('/api/mail/notifications?validationToken=hello-graph').expect(200);
    assert.equal(echo.text, 'hello-graph');
    assert.equal(echo.headers['ratelimit-limit'], '300', 'the public webhook has a ceiling of its own');
  });

  test('a forged notification does nothing, whatever it claims', async () => {
    const box = await testMailbox(`webhook-${Date.now()}@cetizionverifica.com`);
    await db.query(`INSERT INTO mail_folders (account_id, folder, subscription_id, subscription_client_state) VALUES ($1, 'inbox', 'sub-real', 'the-secret')
                    ON CONFLICT (account_id, folder) DO UPDATE SET subscription_id = EXCLUDED.subscription_id, subscription_client_state = EXCLUDED.subscription_client_state`, [box.id]);

    // 100 notifications with the wrong clientState, which is the shape of
    // the amplification the review was worried about.
    const value = Array.from({ length: 100 }, () => ({ subscriptionId: 'sub-real', clientState: 'guessed', resource: 'x' }));
    await request(app).post('/api/mail/notifications').send({ value }).expect(202);

    // Nothing was synced from it: a test mailbox only ever holds what was
    // pushed into it, and nothing was.
    const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM email_messages WHERE account_id = $1', [box.id]);
    assert.equal(rows[0].n, 0);
  });

  test('a request through a proxy the API does not trust is called out', async () => {
    const warnings = [];
    const real = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      await request(app).get('/api/health').set('X-Forwarded-For', '203.0.113.9').expect(200);
    } finally {
      console.warn = real;
    }
    assert.ok(
      warnings.some((w) => /TRUST_PROXY/.test(w)),
      'with a proxy in front and TRUST_PROXY=0, every caller looks like the proxy and nothing says so',
    );
  });
});
