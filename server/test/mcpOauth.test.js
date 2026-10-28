import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * The claude.ai connector (#249): discovery, registration, the consent
 * screen, the code and refresh exchanges, and /api/mcp answering as the
 * person who approved — no wider than their own role, and not at all once
 * they disconnect, are switched off, or the connector is.
 *
 * Runs in database mode, because a grant belongs to a users row. Needs
 * TEST_DATABASE_URL; skipped otherwise.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
const NAME = `mcp_oauth_test_${process.pid}`;
const PASSWORD = 'a-good-long-test-password';
const ORIGIN = 'https://tracker.example.test';
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

describe('claude.ai connector', { skip: !ADMIN_URL && 'TEST_DATABASE_URL is not set' }, () => {
  let app; let pool; let db;
  const cookies = {};
  const users = {};

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
    await db.query(`
      INSERT INTO companies (id, name) VALUES (1001, 'Asha Client Ltd'), (1002, 'Ravi Client Ltd');
      INSERT INTO quotations (quotation_no, client_name, quotation_date, quotation_value, status, sales_person)
        VALUES ('QT-ASHA', 'Asha Client Ltd', '2026-07-01', 100000, 'Submitted', 'Asha'), ('QT-RAVI', 'Ravi Client Ltd', '2026-07-01', 900000, 'Submitted', 'Ravi');
    `);
    Object.assign(process.env, {
      SKIP_DOTENV: '1', NODE_ENV: 'test', DATABASE_URL: url.toString(), AUTH_MODE: 'database',
      AUTH_USERNAME: 'shared-admin', AUTH_PASSWORD: 'the-shared-password-in-env',
      SESSION_SECRET: 'test-secret-that-is-long-enough-to-pass', CORS_ORIGIN: ORIGIN,
    });
    ({ default: app } = await import('../src/app.js'));
    ({ pool } = await import('../src/db.js'));
    const { createUser } = await import('../src/lib/users.js');
    for (const [key, name, role] of [['admin', 'Alice', 'admin'], ['asha', 'Asha', 'sales'], ['hr', 'Hari', 'hr']]) {
      users[key] = await createUser({ name, email: `${key}@example.test`, password: PASSWORD, role }, db);
      const res = await request(app).post('/api/auth/login').send({ email: `${key}@example.test`, password: PASSWORD });
      assert.equal(res.status, 200, `${key} signs in`);
      cookies[key] = res.headers['set-cookie'].map((c) => c.split(';')[0]).join('; ');
    }
  });

  after(async () => {
    await pool?.end();
    await db?.end();
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`);
    await admin.end();
  });

  const pkce = () => {
    const verifier = crypto.randomBytes(32).toString('base64url');
    return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
  };
  const register = (body = {}) => request(app).post('/api/oauth/register').send({ client_name: 'Claude', redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none', ...body });
  const authorize = (query) => request(app).get('/api/oauth/authorize').query({ response_type: 'code', redirect_uri: CALLBACK, code_challenge_method: 'S256', state: 'st-1', resource: `${ORIGIN}/api/mcp`, scope: 'tracker:read tracker:write', ...query });
  const requestId = (res) => new URL(res.headers.location, ORIGIN).searchParams.get('request');
  const token = (body) => request(app).post('/api/oauth/token').type('form').send(body);
  const rpc = (bearer, method, params = {}) => request(app).post('/api/mcp').set('Authorization', `Bearer ${bearer}`)
    .set('Accept', 'application/json, text/event-stream').send({ jsonrpc: '2.0', id: 1, method, params });

  /** The whole dance: register, authorize, approve as `who`, exchange the code. */
  async function connect(who, { canWrite = false } = {}) {
    const client = (await register().expect(201)).body;
    const { verifier, challenge } = pkce();
    const a = await authorize({ client_id: client.client_id, code_challenge: challenge }).expect(302);
    const decided = await request(app).post(`/api/oauth/requests/${requestId(a)}`).set('Cookie', cookies[who]).send({ allow: true, can_write: canWrite }).expect(200);
    const back = new URL(decided.body.data.redirect);
    assert.equal(`${back.origin}${back.pathname}`, CALLBACK);
    assert.equal(back.searchParams.get('state'), 'st-1');
    const t = await token({ grant_type: 'authorization_code', client_id: client.client_id, code: back.searchParams.get('code'), code_verifier: verifier, redirect_uri: CALLBACK }).expect(200);
    return { client, tokens: t.body, code: back.searchParams.get('code'), verifier };
  }

  test('discovery answers JSON, and an unauthenticated MCP call says where to sign in', async () => {
    const prm = await request(app).get('/.well-known/oauth-protected-resource/api/mcp').expect(200);
    assert.equal(prm.body.resource, `${ORIGIN}/api/mcp`);
    assert.deepEqual(prm.body.authorization_servers, [ORIGIN]);
    const as = await request(app).get('/.well-known/oauth-authorization-server').expect(200);
    assert.equal(as.body.issuer, ORIGIN);
    assert.equal(as.body.registration_endpoint, `${ORIGIN}/api/oauth/register`);
    assert.deepEqual(as.body.code_challenge_methods_supported, ['S256']);
    const res = await request(app).post('/api/mcp').send({ jsonrpc: '2.0', id: 1, method: 'tools/list' }).expect(401);
    assert.match(res.headers['www-authenticate'], new RegExp(`resource_metadata="${ORIGIN}/\\.well-known/oauth-protected-resource/api/mcp"`));
  });

  test('registration accepts Claude\'s callback and loopback, and refuses anything else', async () => {
    const pub = (await register().expect(201)).body;
    assert.match(pub.client_id, /^ctzclient_/);
    assert.equal(pub.client_secret, undefined);
    const conf = (await register({ token_endpoint_auth_method: 'client_secret_post' }).expect(201)).body;
    assert.match(conf.client_secret, /^ctzs_/);
    const { rows: [stored] } = await db.query('SELECT client_secret_hash FROM oauth_clients WHERE client_id = $1', [conf.client_id]);
    assert.notEqual(stored.client_secret_hash, conf.client_secret, 'only the hash is kept');
    await register({ redirect_uris: ['http://127.0.0.1:33418/callback'] }).expect(201);
    const evil = await register({ redirect_uris: ['https://evil.example/callback'] }).expect(400);
    assert.equal(evil.body.error, 'invalid_redirect_uri');
  });

  test('authorize refuses a missing or plain PKCE challenge, an unknown client and a foreign resource', async () => {
    const client = (await register().expect(201)).body;
    const unknown = await authorize({ client_id: 'nobody', code_challenge: pkce().challenge }).expect(400);
    assert.equal(unknown.body.error, 'invalid_client');
    const wrongRedirect = await authorize({ client_id: client.client_id, redirect_uri: 'https://claude.com/api/mcp/auth_callback', code_challenge: pkce().challenge }).expect(400);
    assert.equal(wrongRedirect.body.error, 'invalid_request');
    for (const [query, error] of [
      [{ code_challenge: undefined }, 'invalid_request'],
      [{ code_challenge: pkce().challenge, code_challenge_method: 'plain' }, 'invalid_request'],
      [{ code_challenge: pkce().challenge, resource: 'https://elsewhere.example/mcp' }, 'invalid_target'],
      [{ code_challenge: pkce().challenge, scope: 'tracker:everything' }, 'invalid_scope'],
    ]) {
      const res = await authorize({ client_id: client.client_id, ...query }).expect(302);
      const back = new URL(res.headers.location);
      assert.equal(back.searchParams.get('error'), error);
      assert.equal(back.searchParams.get('state'), 'st-1');
    }
    const ok = await authorize({ client_id: client.client_id, code_challenge: pkce().challenge }).expect(302);
    assert.match(ok.headers.location, /^\/oauth\/consent\?request=ctzq_/);
  });

  test('the consent screen needs a session, and says what is asking', async () => {
    const client = (await register().expect(201)).body;
    const a = await authorize({ client_id: client.client_id, code_challenge: pkce().challenge }).expect(302);
    await request(app).get(`/api/oauth/requests/${requestId(a)}`).expect(401);
    const res = await request(app).get(`/api/oauth/requests/${requestId(a)}`).set('Cookie', cookies.asha).expect(200);
    assert.equal(res.body.data.client_name, 'Claude');
    assert.equal(res.body.data.redirect_host, 'claude.ai');
    assert.equal(res.body.data.sees, 'own');
    assert.equal(res.body.data.refused, null);
  });

  test('deny sends access_denied back to Claude and issues nothing', async () => {
    const client = (await register().expect(201)).body;
    const a = await authorize({ client_id: client.client_id, code_challenge: pkce().challenge }).expect(302);
    const res = await request(app).post(`/api/oauth/requests/${requestId(a)}`).set('Cookie', cookies.asha).send({ allow: false }).expect(200);
    assert.equal(new URL(res.body.data.redirect).searchParams.get('error'), 'access_denied');
    await request(app).post(`/api/oauth/requests/${requestId(a)}`).set('Cookie', cookies.asha).send({ allow: true }).expect(404);
  });

  test('a sales person\'s connector sees only their records, and reads only unless they allowed writing', async () => {
    const { tokens } = await connect('asha');
    assert.match(tokens.access_token, /^ctzo_/);
    assert.equal(tokens.scope, 'tracker:read');
    const listed = await rpc(tokens.access_token, 'tools/list').expect(200);
    const names = listed.body.result.tools.map((t) => t.name);
    assert.ok(names.includes('get_quotation'));
    assert.ok(!names.includes('add_note'), 'a read-only connection is not offered the write tools');
    const own = await rpc(tokens.access_token, 'tools/call', { name: 'get_quotation', arguments: { quotation_no: 'QT-ASHA' } }).expect(200);
    assert.ok(!own.body.result.isError);
    const other = await rpc(tokens.access_token, 'tools/call', { name: 'get_quotation', arguments: { quotation_no: 'QT-RAVI' } }).expect(200);
    assert.ok(other.body.result.isError, 'another sales person\'s quotation is not found');
    const { rows: [log] } = await db.query('SELECT token_id, grant_id FROM api_token_log ORDER BY id DESC LIMIT 1');
    assert.equal(log.token_id, null);
    assert.ok(log.grant_id, 'the call is logged against the connection');

    const writer = await connect('asha', { canWrite: true });
    assert.equal(writer.tokens.scope, 'tracker:read tracker:write');
    const w = await rpc(writer.tokens.access_token, 'tools/call', { name: 'add_note', arguments: { entity: 'quotation', id: 'QT-ASHA', text: 'Called the buyer' } }).expect(200);
    assert.ok(!w.body.result.isError, w.body.result.content?.[0]?.text);
    const { rows: [note] } = await db.query(`SELECT author FROM notes ORDER BY id DESC LIMIT 1`);
    assert.equal(note.author, 'Asha (via MCP)');
  });

  test('an admin\'s connector sees everything', async () => {
    const { tokens } = await connect('admin');
    const other = await rpc(tokens.access_token, 'tools/call', { name: 'get_quotation', arguments: { quotation_no: 'QT-RAVI' } }).expect(200);
    assert.ok(!other.body.result.isError);
  });

  test('a code works once, needs its verifier, and a second use revokes what it issued', async () => {
    const client = (await register().expect(201)).body;
    const { verifier, challenge } = pkce();
    const a = await authorize({ client_id: client.client_id, code_challenge: challenge }).expect(302);
    const decided = await request(app).post(`/api/oauth/requests/${requestId(a)}`).set('Cookie', cookies.asha).send({ allow: true }).expect(200);
    const code = new URL(decided.body.data.redirect).searchParams.get('code');
    const wrong = await token({ grant_type: 'authorization_code', client_id: client.client_id, code, code_verifier: pkce().verifier }).expect(400);
    assert.equal(wrong.body.error, 'invalid_grant');
    const good = await token({ grant_type: 'authorization_code', client_id: client.client_id, code, code_verifier: verifier }).expect(200);
    const again = await token({ grant_type: 'authorization_code', client_id: client.client_id, code, code_verifier: verifier }).expect(400);
    assert.equal(again.body.error, 'invalid_grant');
    await rpc(good.body.access_token, 'tools/list').expect(401);
  });

  test('a refresh token is replaced on use, and reusing the old one ends the connection', async () => {
    const { client, tokens } = await connect('asha');
    const next = await token({ grant_type: 'refresh_token', client_id: client.client_id, refresh_token: tokens.refresh_token }).expect(200);
    assert.notEqual(next.body.refresh_token, tokens.refresh_token);
    await rpc(next.body.access_token, 'tools/list').expect(200);
    const reuse = await token({ grant_type: 'refresh_token', client_id: client.client_id, refresh_token: tokens.refresh_token }).expect(400);
    assert.equal(reuse.body.error, 'invalid_grant');
    await rpc(next.body.access_token, 'tools/list').expect(401);
    await token({ grant_type: 'refresh_token', client_id: client.client_id, refresh_token: next.body.refresh_token }).expect(400);
  });

  test('a confidential client must present its secret', async () => {
    const client = (await register({ token_endpoint_auth_method: 'client_secret_post' }).expect(201)).body;
    const res = await token({ grant_type: 'refresh_token', client_id: client.client_id, refresh_token: 'ctzr_x' }).expect(401);
    assert.equal(res.body.error, 'invalid_client');
    await token({ grant_type: 'refresh_token', client_id: client.client_id, client_secret: client.client_secret, refresh_token: 'ctzr_x' }).expect(400);
  });

  test('disconnecting in Connected apps stops the connector on the next call', async () => {
    const { tokens } = await connect('asha');
    const mine = await request(app).get('/api/oauth/grants').set('Cookie', cookies.asha).expect(200);
    assert.equal(mine.body.connector_url, `${ORIGIN}/api/mcp`);
    assert.ok(mine.body.data.every((g) => g.user_name === 'Asha'));
    const live = mine.body.data.find((g) => !g.revoked_at);
    // Somebody else's connection is not theirs to end.
    const theirs = (await request(app).get('/api/oauth/grants?all=1').set('Cookie', cookies.admin).expect(200)).body.data.find((g) => g.user_name === 'Alice');
    await request(app).delete(`/api/oauth/grants/${theirs.id}`).set('Cookie', cookies.asha).expect(404);
    await rpc(tokens.access_token, 'tools/list').expect(200);
    await request(app).delete(`/api/oauth/grants/${live.id}`).set('Cookie', cookies.asha).expect(200);
    const { rows: [g] } = await db.query('SELECT revoked_at FROM oauth_grants WHERE id = $1', [live.id]);
    assert.ok(g.revoked_at);
  });

  test('an account switched off, a role closed in Settings, and the HR role cannot use the connector', async () => {
    const { tokens } = await connect('asha');
    await rpc(tokens.access_token, 'tools/list').expect(200);

    await db.query(`UPDATE settings SET value = 'admin' WHERE key = 'mcp_connector_roles'`);
    await rpc(tokens.access_token, 'tools/list').expect(401);
    const client = (await register().expect(201)).body;
    const a = await authorize({ client_id: client.client_id, code_challenge: pkce().challenge }).expect(302);
    const shown = await request(app).get(`/api/oauth/requests/${requestId(a)}`).set('Cookie', cookies.asha).expect(200);
    assert.match(shown.body.data.refused, /not opened the Claude connector to the sales role/);
    await request(app).post(`/api/oauth/requests/${requestId(a)}`).set('Cookie', cookies.asha).send({ allow: true }).expect(403);
    await db.query(`UPDATE settings SET value = 'admin,sales' WHERE key = 'mcp_connector_roles'`);
    await rpc(tokens.access_token, 'tools/list').expect(200);

    const hr = await authorize({ client_id: client.client_id, code_challenge: pkce().challenge }).expect(302);
    await request(app).post(`/api/oauth/requests/${requestId(hr)}`).set('Cookie', cookies.hr).send({ allow: true }).expect(403);

    await db.query('UPDATE users SET active = false WHERE id = $1', [users.asha.id]);
    await rpc(tokens.access_token, 'tools/list').expect(401);
  });

  test('the connector setting accepts only roles it knows', async () => {
    await request(app).patch('/api/settings/mcp_connector_roles').set('Cookie', cookies.admin).send({ value: 'Sales, admin' }).expect(200);
    const { rows: [s] } = await db.query(`SELECT value FROM settings WHERE key = 'mcp_connector_roles'`);
    assert.equal(s.value, 'admin,sales');
    await request(app).patch('/api/settings/mcp_connector_roles').set('Cookie', cookies.admin).send({ value: 'hr' }).expect(422);
  });

  test('an API token still works as before', async () => {
    const t = await request(app).post('/api/api-tokens').set('Cookie', cookies.admin).send({ name: 'Laptop', role: 'admin' }).expect(201);
    await rpc(t.body.data.token, 'tools/list').expect(200);
    const log = await request(app).get('/api/api-tokens').set('Cookie', cookies.admin).expect(200);
    assert.ok(log.body.log.some((l) => /Claude/.test(l.name)), 'connector calls appear in the call log, named for the person and app');
  });
});
