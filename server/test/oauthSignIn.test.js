import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import request from 'supertest';

/**
 * Sign in with a provider (C18) — the parts that decide whether somebody
 * gets a session.
 *
 * None of these reach Postgres or the network: every case here is refused
 * before the token exchange, which is the point. The handshake is what
 * stops a code obtained elsewhere being replayed at this endpoint, so the
 * tests are about the handshake.
 */
process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'database';
process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-to-pass';
process.env.GOOGLE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
process.env.GOOGLE_REDIRECT_URI = 'https://tracker.example.com/api/auth/oauth/google/callback';
// Microsoft is deliberately left unconfigured.

const { default: app } = await import('../src/app.js');
const { verifySession } = await import('../src/auth/session.js');

const handshakeFrom = (response) => {
  const raw = [].concat(response.headers['set-cookie'] || []).find((c) => c.startsWith('cetizion_oauth='));
  if (!raw) return null;
  return verifySession(decodeURIComponent(raw.split(';')[0].slice('cetizion_oauth='.length)), process.env.SESSION_SECRET);
};

describe('provider sign-in', () => {
  test('offers only the providers that are completely configured', async () => {
    const response = await request(app).get('/api/auth/config');
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data.providers, [{ id: 'google', label: 'Google' }]);
  });

  test('a provider with no credentials is not a route, not a dead button', async () => {
    const response = await request(app).get('/api/auth/oauth/microsoft/start');
    assert.equal(response.status, 404);
  });

  test('start sends the browser to the provider with a state and a PKCE challenge', async () => {
    const response = await request(app).get('/api/auth/oauth/google/start');
    assert.equal(response.status, 302);

    const url = new URL(response.headers.location);
    assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.equal(url.searchParams.get('client_id'), process.env.GOOGLE_CLIENT_ID);
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(url.searchParams.get('code_challenge'), 'a challenge is sent');
    // Always ask which account: on a shared machine, silently reusing the
    // last one is the difference between signing in and signing in as
    // somebody else.
    assert.equal(url.searchParams.get('prompt'), 'select_account');

    const handshake = handshakeFrom(response);
    assert.ok(handshake, 'the handshake cookie is set and signed');
    assert.equal(handshake.state, url.searchParams.get('state'));
    // The verifier stays on this server; only its hash goes to Google.
    assert.notEqual(handshake.verifier, url.searchParams.get('code_challenge'));
  });

  test('an off-site ?next is not carried into the handshake', async () => {
    for (const next of ['https://evil.example/steal', '//evil.example/steal', 'javascript:alert(1)']) {
      const response = await request(app).get('/api/auth/oauth/google/start').query({ next });
      assert.equal(handshakeFrom(response).next, '/', `refused ${next}`);
    }
    const kept = await request(app).get('/api/auth/oauth/google/start').query({ next: '/projects/PRJ-2026-001' });
    assert.equal(handshakeFrom(kept).next, '/projects/PRJ-2026-001');
  });

  test('a callback with no handshake cookie is refused, not exchanged', async () => {
    const response = await request(app)
      .get('/api/auth/oauth/google/callback')
      .query({ code: 'whatever', state: 'whatever' });
    assert.equal(response.status, 302);
    assert.match(response.headers.location, /sso=refused/);
    assert.ok(!(response.headers['set-cookie'] || []).some((c) => c.startsWith('cetizion_session=')));
  });

  test('a callback whose state does not match the cookie is refused', async () => {
    const start = await request(app).get('/api/auth/oauth/google/start');
    const cookie = [].concat(start.headers['set-cookie']).find((c) => c.startsWith('cetizion_oauth='));

    const response = await request(app)
      .get('/api/auth/oauth/google/callback')
      .set('Cookie', cookie.split(';')[0])
      .query({ code: 'a-code-from-somewhere-else', state: 'not-the-state-we-issued' });

    assert.equal(response.status, 302);
    assert.match(response.headers.location, /sso=refused/);
  });

  test('the handshake cookie is cleared even when the callback is refused', async () => {
    const response = await request(app).get('/api/auth/oauth/google/callback').query({ state: 'x' });
    const cleared = [].concat(response.headers['set-cookie'] || []).find((c) => c.startsWith('cetizion_oauth='));
    assert.ok(cleared, 'the cookie is written');
    assert.match(cleared, /Expires=Thu, 01 Jan 1970|Max-Age=0/);
  });
});
