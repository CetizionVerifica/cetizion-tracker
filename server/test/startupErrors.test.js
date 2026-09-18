import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { BootstrapConfigError, readBootstrapConfig } from '../src/auth/bootstrap.js';
import { bootstrapFailureLines } from '../src/startupErrors.js';

/**
 * What start.js prints when bootstrapping the first admin fails (#18,
 * PR #71 review). Nothing here touches Postgres.
 *
 * The distinction under test is the whole point: a broken BOOTSTRAP_ADMIN_*
 * block is the operator's to fix, and a database that would not answer is
 * not — telling them to go and edit variables that were never wrong is how
 * an outage gets longer.
 */

const VARS = /BOOTSTRAP_ADMIN_/;
const text = (err) => bootstrapFailureLines(err).join('\n');

describe('bootstrapFailureLines — a bad configuration', () => {
  test('names the variables, because they really are the problem', () => {
    const lines = bootstrapFailureLines(new BootstrapConfigError('BOOTSTRAP_ADMIN_EMAIL is not an email address.'));

    assert.equal(lines.length, 2);
    assert.equal(lines[0], '[bootstrap] BOOTSTRAP_ADMIN_EMAIL is not an email address.');
    assert.match(lines[1], VARS);
    assert.match(lines[1], /configuration is invalid/);
    assert.match(lines[1], /not started/);
  });

  test('says the same for every configuration fault the reader can raise', () => {
    const faults = [
      { BOOTSTRAP_ADMIN_NAME: 'Shivam' },                                    // half set
      { BOOTSTRAP_ADMIN_NAME: 'Shivam', BOOTSTRAP_ADMIN_EMAIL: 'nope', BOOTSTRAP_ADMIN_PASSWORD: 'a-good-long-password' },
      { BOOTSTRAP_ADMIN_NAME: 'Shivam', BOOTSTRAP_ADMIN_EMAIL: 'a@b.co', BOOTSTRAP_ADMIN_PASSWORD: 'short' },
    ];

    for (const env of faults) {
      let thrown;
      try {
        readBootstrapConfig(env);
      } catch (err) {
        thrown = err;
      }
      assert.ok(thrown instanceof BootstrapConfigError, JSON.stringify(env));

      const lines = bootstrapFailureLines(thrown);
      assert.equal(lines[0], `[bootstrap] ${thrown.message}`, 'the real message is printed');
      assert.match(lines[1], VARS);
    }
  });

  test('still never prints what a variable held', () => {
    const secret = 'hunter2';
    let thrown;
    try {
      readBootstrapConfig({
        BOOTSTRAP_ADMIN_NAME: 'Shivam',
        BOOTSTRAP_ADMIN_EMAIL: 'shivam@example.com',
        BOOTSTRAP_ADMIN_PASSWORD: secret,
      });
    } catch (err) {
      thrown = err;
    }

    assert.ok(thrown instanceof BootstrapConfigError);
    assert.ok(!text(thrown).includes(secret), 'the password is not in the lines');
  });
});

describe('bootstrapFailureLines — anything else', () => {
  // The failures a deployment actually hits: Postgres down, a refused
  // connection, a query that blew up, a plain unexpected throw.
  const others = [
    Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' }),
    Object.assign(new Error('password authentication failed for user "tracker"'), { code: '28P01' }),
    Object.assign(new Error('relation "users" does not exist'), { code: '42P01' }),
    Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' }),
    new TypeError('client.query is not a function'),
    new Error('something nobody predicted'),
  ];

  test('does not blame the variables', () => {
    for (const err of others) {
      assert.doesNotMatch(text(err), VARS, err.message);
    }
  });

  test('prints the real error and says startup failed', () => {
    for (const err of others) {
      const lines = bootstrapFailureLines(err);

      assert.equal(lines.length, 2);
      assert.equal(lines[0], `[bootstrap] ${err.message}`);
      assert.match(lines[1], /not started/);
      assert.match(lines[1], /failed/);
    }
  });

  test('an Error subclass that is not BootstrapConfigError is not treated as one', () => {
    class DatabaseError extends Error {}

    assert.doesNotMatch(text(new DatabaseError('BOOTSTRAP_ADMIN_EMAIL is not an email address.')), /variables/);
  });

  test('survives a thrown value that is not an Error at all', () => {
    for (const thrown of ['just a string', null, undefined, 42, {}]) {
      const lines = bootstrapFailureLines(thrown);

      assert.equal(lines.length, 2);
      assert.ok(lines[0].startsWith('[bootstrap] '), JSON.stringify(thrown));
      assert.doesNotMatch(lines.join('\n'), VARS, JSON.stringify(thrown));
    }
  });

  test('says something even when the error carried no message', () => {
    const lines = bootstrapFailureLines(new Error(''));

    assert.match(lines[0], /\[bootstrap\] \S/);
    assert.doesNotMatch(lines.join('\n'), VARS);
  });
});
