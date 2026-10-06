import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addresses, recipientLists, uniqueAddresses } from '../src/lib/addresses.js';

/**
 * The Scheduled reports screen shows and saves the To and Cc lists the way
 * the server sends them (#195): each address once whatever its case, and
 * nobody in Cc who is already in To.
 */

test('the issue\'s example: five entries for two people become two', () => {
  const r = recipientLists('md@x.com, MD@x.com; sales@x.com, md@x.com', 'sales@x.com');
  assert.deepEqual(r, { to: ['md@x.com', 'sales@x.com'], cc: [] });
});

test('the first spelling is kept; "none" and blanks are nobody', () => {
  assert.deepEqual(uniqueAddresses(['Meera@QA.example', 'meera@qa.example', 'md@qa.example']), ['Meera@QA.example', 'md@qa.example']);
  assert.deepEqual(addresses('none'), []);
  assert.deepEqual(addresses(' ; , '), []);
  assert.deepEqual(addresses(null), []);
});

test('Cc keeps the people who are not in To, once each', () => {
  assert.deepEqual(recipientLists('md@x.com', 'OPS@x.com; ops@x.com, MD@X.COM, cfo@x.com'), { to: ['md@x.com'], cc: ['OPS@x.com', 'cfo@x.com'] });
});
