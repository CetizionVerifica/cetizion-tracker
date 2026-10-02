import assert from 'node:assert/strict';
import test, { afterEach, describe } from 'node:test';
import { microsoftProvider } from '../src/lib/mailbox/microsoft.js';

/**
 * Graph's delta paging (src/lib/mailbox/microsoft.js). A round cut off at
 * the page limit must hand back where it stopped, or the next sync starts
 * the round over and never reaches new mail.
 */

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const tokens = { access_token: 'token', refresh_token: 'refresh', expires_at: new Date(Date.now() + 3600e3).toISOString() };
const graphMessage = (id) => ({
  id, conversationId: `conv-${id}`, subject: `Message ${id}`, body: { contentType: 'html', content: '<p>x</p>' },
  from: { emailAddress: { address: 'a@client.example', name: 'A' } }, toRecipients: [], ccRecipients: [], sentDateTime: new Date().toISOString(),
});

/** A Graph that serves `pages` pages of one message each, then a delta link. */
function fakeGraph(pages) {
  const asked = [];
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    const at = Number(new URL(url).searchParams.get('page') || 0);
    const body = { value: [graphMessage(`m${at}`)] };
    if (at + 1 < pages) body['@odata.nextLink'] = `https://graph.microsoft.com/v1.0/next?page=${at + 1}`;
    else body['@odata.deltaLink'] = 'https://graph.microsoft.com/v1.0/delta?token=done';
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return asked;
}

describe('Microsoft Graph delta paging', () => {
  test('a round that fits returns its delta link', async () => {
    fakeGraph(3);
    const r = await microsoftProvider({ email: 'box@example.test' }, tokens).delta('inbox', null, new Date().toISOString());
    assert.deepEqual(r.messages.map((m) => m.provider_id), ['m0', 'm1', 'm2']);
    assert.equal(r.deltaLink, 'https://graph.microsoft.com/v1.0/delta?token=done');
    assert.equal(r.more, false);
  });

  test('a round cut off at the page limit resumes where it stopped, not from the start', async () => {
    const asked = fakeGraph(5);
    const provider = microsoftProvider({ email: 'box@example.test' }, tokens);
    const first = await provider.delta('inbox', null, new Date().toISOString(), { maxPages: 2 });
    assert.deepEqual(first.messages.map((m) => m.provider_id), ['m0', 'm1']);
    assert.equal(first.deltaLink, 'https://graph.microsoft.com/v1.0/next?page=2', 'the next page, not null');
    assert.equal(first.more, true);

    const second = await provider.delta('inbox', first.deltaLink, null, { maxPages: 2 });
    assert.deepEqual(second.messages.map((m) => m.provider_id), ['m2', 'm3']);
    const third = await provider.delta('inbox', second.deltaLink, null, { maxPages: 2 });
    assert.deepEqual(third.messages.map((m) => m.provider_id), ['m4']);
    assert.equal(third.deltaLink, 'https://graph.microsoft.com/v1.0/delta?token=done');
    assert.equal(asked.length, 5, 'every page asked for once');
  });

  test('an incremental round cut off does not fall back to the old delta link', async () => {
    fakeGraph(4);
    const old = 'https://graph.microsoft.com/v1.0/next?page=0';
    const r = await microsoftProvider({ email: 'box@example.test' }, tokens).delta('inbox', old, null, { maxPages: 2 });
    assert.notEqual(r.deltaLink, old);
    assert.equal(r.deltaLink, 'https://graph.microsoft.com/v1.0/next?page=2');
  });
});
