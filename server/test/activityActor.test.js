import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { actorFromToken } from '../src/lib/activity.js';

/**
 * Who an MCP call is recorded as (#18 §3).
 *
 * Pure, and in its own file: importing activity.js reaches db.js, which
 * builds its pool from DATABASE_URL at import time. Nothing here queries,
 * so that is harmless — but it is the reason this is not folded into a file
 * that creates a throwaway database, where the import would happen before
 * the `before()` hook had pointed DATABASE_URL anywhere.
 *
 * The sales branch is tested here rather than through the MCP surface
 * because `import_records` is admin-only, so no sales token reaches the
 * shared writers today. If that ever changes, this is the behaviour it will
 * get, and this test is what says so.
 */
describe('the actor behind an MCP token', () => {
  test('a sales token is recorded as its own account', () => {
    assert.deepEqual(
      actorFromToken({ role: 'sales', user_id: 42, person: 'Ramesh Kumar', name: 'Ramesh laptop' }),
      { type: 'user', userId: 42, name: 'Ramesh Kumar' },
      'since 063 every live sales token names a users row; that id is the actor'
    );
  });

  test('an admin token has no account, and none is invented for it', () => {
    assert.deepEqual(
      actorFromToken({ role: 'admin', user_id: null, name: 'Reporting' }),
      { type: 'shared_admin', userId: null, name: 'Reporting' },
      'the same classification the legacy shared login gets, for the same reason'
    );
  });

  test('the token name distinguishes one integration from another', () => {
    assert.equal(actorFromToken({ role: 'admin', name: 'Claude desktop' }).name, 'Claude desktop');
    assert.equal(actorFromToken({ role: 'admin', name: 'Nightly export' }).name, 'Nightly export');
  });

  test('a user id is only believed when it is really one', () => {
    for (const bad of [0, -1, 1.5, '42', null, undefined, NaN]) {
      const actor = actorFromToken({ role: 'sales', user_id: bad, person: 'Whoever', name: 'A token' });
      assert.equal(actor.type, 'shared_admin', `user_id ${String(bad)} must not become an identity`);
      assert.equal(actor.userId, null,
        'activity_log CHECKs that only an actor_type of user carries an id');
    }
  });

  test('no token at all records nothing, rather than failing', () => {
    assert.equal(actorFromToken(null), null);
    assert.equal(actorFromToken(undefined), null);
    // Unlike actorFrom(), which throws: every audited HTTP route is behind
    // requireAuth, so an unrecognised session there is a bug. An MCP writer
    // can legitimately be called with no token — the importer's own tests
    // drive it directly — and the writers read a null actor as "do not
    // record" rather than as a failure.
  });
});
