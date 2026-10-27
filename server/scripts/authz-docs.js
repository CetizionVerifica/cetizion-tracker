#!/usr/bin/env node
/**
 * Write the generated access-policy tables into docs/issue-18-authorization.md.
 *
 *   node scripts/authz-docs.js           rewrite the document
 *   node scripts/authz-docs.js --check   fail if it is out of date
 *
 * The --check form is what `authzDocs.test.js` runs, so a policy change that
 * leaves the document behind fails the build rather than being noticed a
 * release later.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from '../src/lib/authz/docs.js';

export const DOC_PATH = join(
  dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'issue-18-authorization.md'
);

export const currentDocument = () => readFileSync(DOC_PATH, 'utf8');
export const expectedDocument = () => render(currentDocument());

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const current = currentDocument();
  const expected = expectedDocument();
  if (process.argv.includes('--check')) {
    if (current === expected) {
      console.log('docs/issue-18-authorization.md matches the access policy.');
      process.exit(0);
    }
    console.error('docs/issue-18-authorization.md is out of date. Run `npm run authz:docs` from server/.');
    process.exit(1);
  }
  if (current === expected) {
    console.log('docs/issue-18-authorization.md was already up to date.');
  } else {
    writeFileSync(DOC_PATH, expected);
    console.log('Wrote docs/issue-18-authorization.md from the access policy.');
  }
}
