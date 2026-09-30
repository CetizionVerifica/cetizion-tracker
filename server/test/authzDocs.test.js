import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

/**
 * docs/issue-18-authorization.md is written from the access policy (#89).
 *
 * The document is a reference people act on. A reference that drifts from
 * what the code does is worse than none, so it is generated rather than
 * maintained, and this fails the build the moment the two differ.
 */
describe('the authorization document matches the policy', () => {
  test('it is up to date', async () => {
    const { currentDocument, expectedDocument } = await import('../scripts/authz-docs.js');
    assert.equal(
      currentDocument(),
      expectedDocument(),
      '\ndocs/issue-18-authorization.md no longer matches src/lib/authz/policy.js.\nRun `npm run authz:docs` from server/ and commit the result.\n'
    );
  });

  test('every generated section is filled', async () => {
    const { currentDocument } = await import('../scripts/authz-docs.js');
    const document = currentDocument();
    for (const marker of ['generated:routes', 'generated:resources', 'generated:public-routes']) {
      const section = document.match(new RegExp(`<!-- ${marker} -->([\\s\\S]*?)<!-- /${marker} -->`));
      assert.ok(section, `the document has no ${marker} section`);
      assert.ok(section[1].includes('| --- |'), `the ${marker} section holds no table`);
    }
  });
});
