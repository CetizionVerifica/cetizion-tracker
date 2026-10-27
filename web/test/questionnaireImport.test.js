import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MAX_IMPORT_BYTES, questionCount, readDefinitionFile } from '../src/lib/questionnaireImport.js';

/** The builder's "Import from file" (#208 phase 1b): the first look at a file, before anything is sent. */
const raw = (name) => readFileSync(new URL(`../../docs/questionnaires/${name}.json`, import.meta.url), 'utf8');

test('the two first questionnaires read as they are, unchanged', () => {
  for (const [name, count] of [['iso-audits', 60], ['ecovadis', 36]]) {
    const { definition, error } = readDefinitionFile(raw(name));
    assert.equal(error, undefined, name);
    assert.deepEqual(definition, JSON.parse(raw(name)));
    assert.equal(questionCount(definition), count, name);
  }
});

test('a byte-order mark at the start is fine', () => {
  assert.deepEqual(readDefinitionFile('\uFEFF{"steps":[]}').definition, { steps: [] });
});

test('anything that is not a form is turned away with a sentence', () => {
  assert.match(readDefinitionFile('').error, /empty/);
  assert.match(readDefinitionFile('{"steps": [').error, /not valid JSON/);
  assert.match(readDefinitionFile('[1, 2]').error, /not a questionnaire/);
  assert.match(readDefinitionFile('{"questions": []}').error, /needs a list of steps/);
  assert.match(readDefinitionFile('"steps"').error, /not a questionnaire/);
  assert.match(readDefinitionFile(JSON.stringify({ steps: [], note: 'x'.repeat(MAX_IMPORT_BYTES) })).error, /too large/);
  assert.deepEqual(readDefinitionFile(' '.repeat(MAX_IMPORT_BYTES + 1) + '{"steps":[]}').definition, { steps: [] }, 'indentation does not count, as on the server');
});
