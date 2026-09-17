import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { claimAttachment } from '../src/lib/documents.js';

/**
 * The rule both save paths follow when a record carries a document: the
 * generic CRUD router and the payment stage's invoice action.
 *
 * lockAttachableDocument only talks to its client, so a client that answers
 * with canned row counts exercises every branch — including "upload already
 * used" and "upload being purged" — without a database.
 */

/** A client whose two lock queries answer with the given row counts, recording every call. */
function fakeClient({ exists = 1, unattached = 1 } = {}) {
  const calls = [];
  return {
    calls,
    query(text, params) {
      calls.push({ text, params });
      // documents.js asks twice: is the row there and not being purged, then is it free.
      const rowCount = /purging_at IS NULL/.test(text) ? exists : unattached;
      return Promise.resolve({ rowCount, rows: rowCount ? [{}] : [] });
    },
  };
}

const REFUSED = 'That upload has expired or is already in use — choose the file again';

describe('claimAttachment — when nothing new was chosen', () => {
  test('A. an omitted document_id keeps the one attached, without claiming it', async () => {
    const client = fakeClient();

    const result = await claimAttachment(client, { current: 10, requested: undefined });

    assert.deepEqual(result, { documentId: 10, replaced: null });
    assert.equal(client.calls.length, 0, 'must not try to lock a document it is keeping');
  });

  test('B. a null document_id keeps the one attached — null means keep, never detach', async () => {
    const client = fakeClient();

    const result = await claimAttachment(client, { current: 10, requested: null });

    assert.deepEqual(result, { documentId: 10, replaced: null });
    assert.equal(client.calls.length, 0);
  });

  test('C. the same id sent back is not re-claimed', async () => {
    const client = fakeClient();

    const result = await claimAttachment(client, { current: 10, requested: 10 });

    assert.deepEqual(result, { documentId: 10, replaced: null });
    assert.equal(client.calls.length, 0);
  });

  test('a record with no document and no file chosen stays empty', async () => {
    const client = fakeClient();

    const result = await claimAttachment(client, { current: null, requested: null });

    assert.deepEqual(result, { documentId: null, replaced: null });
    assert.equal(client.calls.length, 0);
  });
});

describe('claimAttachment — when a file was chosen', () => {
  test('D. a first document is attached, replacing nothing', async () => {
    const client = fakeClient();

    const result = await claimAttachment(client, { current: null, requested: 20 });

    assert.deepEqual(result, { documentId: 20, replaced: null });
    assert.ok(client.calls.length > 0, 'a new document must be locked');
    assert.deepEqual(client.calls[0].params, [20]);
  });

  test('E. a replacement names the document it displaced, for the caller to purge', async () => {
    const client = fakeClient();

    const result = await claimAttachment(client, { current: 10, requested: 20 });

    assert.deepEqual(result, { documentId: 20, replaced: 10 });
  });
});

describe('claimAttachment — when the upload cannot be used', () => {
  const refusal = async (client) => {
    const err = await claimAttachment(client, { current: 10, requested: 20 }).catch((e) => e);
    assert.equal(err.status, 422);
    assert.equal(err.message, 'Please check the highlighted fields');
    assert.equal(err.extra.fields.document_id, REFUSED);
    return err;
  };

  test('F. an upload that cannot be locked is refused with the field message', async () => {
    await refusal(fakeClient({ exists: 0 }));
  });

  test('an upload another record already holds is refused', async () => {
    await refusal(fakeClient({ exists: 1, unattached: 0 }));
  });

  test('an upload already on its way out is refused', async () => {
    // purging_at set, so the first query finds nothing to lock.
    await refusal(fakeClient({ exists: 0, unattached: 1 }));
  });

  test('the document being replaced is left alone when the new one is refused', async () => {
    const client = fakeClient({ exists: 0 });

    await claimAttachment(client, { current: 10, requested: 20 }).catch(() => {});

    assert.ok(client.calls.every((call) => !call.params.includes(10)), 'must not touch the current document');
  });
});
