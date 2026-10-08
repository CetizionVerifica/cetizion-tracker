import assert from 'node:assert/strict';
import test, { afterEach, describe } from 'node:test';
import { microsoftProvider } from '../src/lib/mailbox/microsoft.js';

/**
 * Listing a message's attachments (src/lib/mailbox/microsoft.js).
 *
 * This exists because of a bug that was invisible for as long as the
 * feature had shipped: the list asked Graph for `contentId`, which is not
 * a property of the type that endpoint returns, so Graph refused every
 * request. storeAttachmentList swallowed the error, attachments_listed_at
 * stayed empty, the sync retried the same messages for ever, and the only
 * symptom anyone could see was an Inbox where no attachment ever appeared
 * — on top of which the PowerPoint converter was then built and blamed.
 *
 * GET /messages/{id}/attachments returns a collection of the *base*
 * `attachment` type, because a message may hold a fileAttachment, an
 * itemAttachment or a referenceAttachment. Microsoft documents the base as
 * having exactly six properties. Anything outside that set is a 400 for
 * the whole request, not a null field on one row.
 */

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const tokens = { access_token: 'token', refresh_token: 'refresh', expires_at: new Date(Date.now() + 3600e3).toISOString() };

/** Every property of microsoft.graph.attachment, and nothing else. */
const BASE_PROPERTIES = new Set(['contentType', 'id', 'isInline', 'lastModifiedDateTime', 'name', 'size']);

/** A Graph that records what was asked and answers with one of each kind. */
function fakeGraph() {
  const asked = [];
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    return new Response(JSON.stringify({
      value: [
        { '@odata.type': '#microsoft.graph.fileAttachment', id: 'a1', name: 'Deck.pptx', contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', size: 2048, isInline: false },
        { '@odata.type': '#microsoft.graph.itemAttachment', id: 'a2', name: 'Forwarded mail', contentType: null, size: 512, isInline: false },
        { '@odata.type': '#microsoft.graph.referenceAttachment', id: 'a3', name: 'Shared file', contentType: null, size: null, isInline: false },
        { '@odata.type': '#microsoft.graph.fileAttachment', id: 'a4', name: 'logo.png', contentType: 'image/png', size: 64, isInline: true },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return asked;
}

describe('listing the attachments of a message', () => {
  test('asks only for properties the base attachment type has', async () => {
    const asked = fakeGraph();
    await microsoftProvider({ email: 'box@example.test' }, tokens).attachmentList('msg-1');

    assert.equal(asked.length, 1, 'one call per message');
    const select = new URL(asked[0]).searchParams.get('$select');
    assert.ok(select, '$select is sent: without it Graph returns contentBytes, the whole file, for every attachment');

    for (const property of select.split(',')) {
      assert.ok(
        BASE_PROPERTIES.has(property),
        `$select asks for "${property}", which microsoft.graph.attachment does not have. `
        + 'Graph refuses the whole request, so no attachment of any message is ever stored.'
      );
    }
  });

  test('contentBytes is never asked for: it is the entire file', async () => {
    const asked = fakeGraph();
    await microsoftProvider({ email: 'box@example.test' }, tokens).attachmentList('msg-1');
    assert.ok(!asked[0].includes('contentBytes'), 'the file stays in Outlook; the tracker lists it, it does not fetch it');
  });

  test('each kind is named by the type Graph gives it', async () => {
    fakeGraph();
    const list = await microsoftProvider({ email: 'box@example.test' }, tokens).attachmentList('msg-1');

    assert.deepEqual(list.map((a) => a.kind), ['file', 'item', 'reference', 'file']);
    assert.deepEqual(list.map((a) => a.is_inline), [false, false, false, true]);
    assert.deepEqual(list.map((a) => a.provider_id), ['a1', 'a2', 'a3', 'a4']);
    assert.equal(list[0].name, 'Deck.pptx');
    assert.equal(list[0].size_bytes, 2048);
    // A missing content type is null rather than the empty string, so the
    // viewer falls back to the file's name to decide how to show it.
    assert.equal(list[1].content_type, null);
    assert.equal(list[2].size_bytes, null);
  });

  test('a refusal from Graph is raised, not returned as an empty list', async () => {
    globalThis.fetch = async () => new Response(
      JSON.stringify({ error: { code: 'BadRequest', message: "Could not find a property named 'contentId' on type 'microsoft.graph.attachment'." } }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );

    // "No attachments" and "the request was refused" must not look the
    // same to the caller: one is a fact about the message, the other is a
    // fault that needs to reach a log.
    await assert.rejects(
      () => microsoftProvider({ email: 'box@example.test' }, tokens).attachmentList('msg-1'),
      'a 400 throws rather than resolving to nothing'
    );
  });
});
