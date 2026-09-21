import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { readFileSync } from 'node:fs';

/**
 * What the daily purge counts as an abandoned upload (#5, #22).
 *
 * The rule is one SQL fragment reused in three places, and it has to name
 * every table that can hold a document_id. When attachments were added the
 * fragment was not, so the purge saw every file on a record as an orphan,
 * destroyed it in Cloudinary a day later and left the row pointing at
 * nothing. Silent, and not recoverable.
 *
 * This reads the source rather than the database: the failure was a missing
 * clause, and a clause is what is asserted.
 */

const source = readFileSync(new URL('../src/lib/documents.js', import.meta.url), 'utf8');
const schema = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');

const unattached = source.slice(source.indexOf('const UNATTACHED'), source.indexOf('`;', source.indexOf('const UNATTACHED')));

describe('the purge rule for abandoned uploads', () => {
  test('every table that can hold a document is checked before a file is destroyed', () => {
    // Whatever declares a document_id column in schema.sql must appear in
    // the rule. This is the assertion that would have caught attachments.
    const tables = [...schema.matchAll(/CREATE TABLE(?: IF NOT EXISTS)? (\w+) \(([\s\S]*?)\n\);/g)]
      .filter(([, , body]) => /^\s*document_id\s/m.test(body))
      .map(([, name]) => name);

    assert.ok(tables.length >= 4, `expected several tables with a document, found ${tables.join(', ')}`);
    for (const t of tables) {
      assert.ok(unattached.includes(`FROM ${t} `), `${t} holds a document_id but the purge does not check it, so its files are destroyed a day after upload`);
    }
  });

  test('attachments in particular, which is the one that was missed', () => {
    assert.match(unattached, /FROM attachments a WHERE a\.document_id = d\.id/);
  });

  test('the rule is used for the purge as well as for claiming', () => {
    // Three call sites: claim, detach and the daily sweep. If the sweep ever
    // stops using it, this class of bug comes back without a failing test.
    const uses = source.split('${UNATTACHED}').length - 1;
    assert.ok(uses >= 3, `expected the rule to be reused, found ${uses} uses`);
    assert.match(source, /created_at < now\(\) - interval '1 day' AND \$\{UNATTACHED\}/);
  });
});
