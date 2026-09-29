import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import test, { before, describe } from 'node:test';

/**
 * The access policy covers every route this application mounts (#89).
 *
 * Two independent lists meet here. One is discovered from the Express
 * application itself; the other is the table somebody wrote in
 * `lib/authz/policy.js`. Neither is generated from the other, which is the
 * only arrangement in which a route added without a decision can be noticed.
 *
 * No database: discovery builds the router tree and reads it. Nothing in
 * this file makes a query or runs a handler.
 */

// Must be imported before the application, so the mount recorder is in place.
const { loadApp, routeInventory, expressVersion } = await import('../src/lib/authz/routeInventory.js');

describe('the access policy covers every mounted route', () => {
  let app;
  let discovered;
  let declared;
  let policy;
  let check;

  before(async () => {
    app = await loadApp();
    discovered = routeInventory(app);
    policy = await import('../src/lib/authz/policy.js');
    check = await import('../src/lib/authz/check.js');

    // The single-page app is mounted only when there is a build to serve, so
    // the expected set follows the build rather than guessing at it.
    const { webDistDir } = await import('../src/web.js');
    const built = existsSync(join(webDistDir, 'index.html'));
    declared = policy.policyRoutes().filter((r) => !r.onlyWhenWebBuilt || built);
  });

  // ------------------------------------------------------------ discovery

  test('route discovery works against the Express version in use', () => {
    // Guards the enumeration itself: if a future Express changes how routes
    // are stored, this fails here rather than quietly reporting no routes
    // and letting the coverage checks below pass over an empty list.
    assert.ok(discovered.length > 100, `only ${discovered.length} routes discovered from express@${expressVersion()}`);
    const keys = new Set(discovered.map(check.keyOf));
    for (const anchor of ['GET /api/health', 'POST /api/auth/login', 'POST /api/users', 'GET /metrics', 'DELETE /api/quotations/:id']) {
      assert.ok(keys.has(anchor), `discovery missed ${anchor} (express@${expressVersion()})`);
    }
    // Nested routers, parameterised paths and the generated CRUD routers all
    // have to come through, not just the top-level ones.
    assert.ok(keys.has('POST /api/quotations/:key/approval/decide'), 'nested two-segment route missing');
    assert.ok(keys.has('GET /api/public/accept/:token/pdf'), 'public nested route missing');
    assert.ok(keys.has('PATCH /api/exchange-rates/:id'), 'generated CRUD route missing');
  });

  // ------------------------------------------------------------- coverage

  test('every mounted route is declared', () => {
    const { undeclared } = check.compareRoutes(discovered, declared);
    assert.equal(undeclared.length, 0, `\n${check.undeclaredMessage(undeclared)}\n`);
  });

  test('every declared route is mounted', () => {
    const { stale } = check.compareRoutes(discovered, declared);
    assert.equal(stale.length, 0, `\n${check.staleMessage(stale)}\n`);
  });

  test('no route is declared twice', () => {
    const { duplicates } = check.compareRoutes(discovered, declared);
    assert.equal(duplicates.length, 0, `\n${check.duplicateMessage(duplicates)}\n`);
  });

  test('every entry is a valid decision', () => {
    const problems = check.validateEntries(declared);
    assert.equal(problems.length, 0, `\n${problems.join('\n')}\n`);
  });

  // ------------------------------------------------------- public routes

  test('every public route names a real authentication mechanism', () => {
    const problems = [];
    for (const entry of declared.filter((r) => r.access === 'public')) {
      const mechanism = policy.AUTH_MECHANISMS[entry.mechanism];
      assert.ok(mechanism, `${check.keyOf(entry)} names an unknown mechanism`);
      if (mechanism.authenticates) {
        assert.ok(mechanism.proof?.length > 40, `${check.keyOf(entry)}: "${entry.mechanism}" must say what it verifies`);
      } else if (!entry.openBecause) {
        problems.push(`${check.keyOf(entry)} is open with nothing authenticating it and no reason given.`);
      }
    }
    assert.equal(problems.length, 0, `\n${problems.join('\n')}\n`);
  });

  test('rate limiting is never counted as authentication', () => {
    // The mistake this exists to stop: a route "protected" by a limiter.
    // A limiter bounds how fast a stranger knocks, never who they are.
    for (const [name, mechanism] of Object.entries(policy.AUTH_MECHANISMS)) {
      if (!mechanism.authenticates) continue;
      assert.doesNotMatch(
        `${name} ${mechanism.proof}`,
        /rate limit|rate-limit|throttl/i,
        `mechanism "${name}" leans on rate limiting; that is not authentication`
      );
      assert.match(
        mechanism.proof,
        /token|secret|signature|password|cookie|session/i,
        `mechanism "${name}" must verify something the caller presents`
      );
    }
  });

  // ---------------------------------------------------------- resources

  test('every CRUD resource has a declared policy', () => {
    const { undeclared } = check.compareResources(policy.resourceAccess);
    assert.equal(undeclared.length, 0, `\n${check.undeclaredResourceMessage(undeclared)}\n`);
  });

  test('the policy declares no resource that does not exist', () => {
    const { stale } = check.compareResources(policy.resourceAccess);
    assert.equal(stale.length, 0, `\n${check.staleResourceMessage(stale)}\n`);
  });

  test('no resource has drifted from its declared policy', () => {
    const { drift } = check.compareResources(policy.resourceAccess);
    assert.equal(drift.length, 0, `\n${drift.join('\n')}\n`);
  });

  // ------------------------------------------------------ the count itself

  test('the inventory is reported, not assumed', () => {
    const byAccess = { public: 0, any: 0, admin: 0 };
    for (const entry of declared) byAccess[entry.access] += 1;
    // Printed rather than asserted against a number somebody wrote down:
    // a hard-coded count is a test that fails for the wrong reason.
    console.log(
      `[#89] express@${expressVersion()}: ${discovered.length} routes mounted, ` +
      `${Object.keys(policy.resourceAccess).length} CRUD resources; ` +
      `public ${byAccess.public}, any ${byAccess.any}, admin ${byAccess.admin}`
    );
    assert.equal(discovered.length, declared.length);
  });
});

// ---------------------------------------------------------------------
// The check itself
// ---------------------------------------------------------------------

describe('the coverage check fails when it should', () => {
  let check;
  before(async () => { check = await import('../src/lib/authz/check.js'); });

  test('a route nobody declared is caught, with a message saying what to do', () => {
    const mounted = [{ method: 'POST', path: '/api/example' }, { method: 'GET', path: '/api/example' }];
    const policy = [{ method: 'GET', path: '/api/example', access: 'any' }];

    const { undeclared } = check.compareRoutes(mounted, policy);
    assert.deepEqual(undeclared, ['POST /api/example']);
    assert.equal(
      check.undeclaredMessage(undeclared),
      'POST /api/example is not in the access policy. Declare it in server/src/lib/authz/policy.js as public, any, or admin.'
    );
  });

  test('a declared route that is not mounted is caught', () => {
    const { stale } = check.compareRoutes(
      [{ method: 'GET', path: '/api/example' }],
      [{ method: 'GET', path: '/api/example', access: 'any' }, { method: 'GET', path: '/api/gone', access: 'any' }]
    );
    assert.deepEqual(stale, ['GET /api/gone']);
    assert.match(check.staleMessage(stale), /the application does not mount it/);
  });

  test('a duplicate entry is caught', () => {
    const { duplicates } = check.compareRoutes(
      [{ method: 'GET', path: '/api/example' }],
      [{ method: 'GET', path: '/api/example', access: 'any' }, { method: 'GET', path: '/api/example', access: 'admin' }]
    );
    assert.deepEqual(duplicates, ['GET /api/example']);
    assert.match(check.duplicateMessage(duplicates), /declared more than once/);
  });

  test('an invalid or missing access level is caught', () => {
    const problems = check.validateEntries([
      { method: 'GET', path: '/api/a' },
      { method: 'GET', path: '/api/b', access: 'sometimes' },
      { method: 'GET', path: '/api/c', access: 'admin' },
      { method: 'GET', path: '/api/d', access: 'public' },
      { method: 'GET', path: '/api/e', access: 'public', mechanism: 'none' },
      { method: 'GET', path: '/api/f', access: 'any', restrictions: ['not-a-restriction'] },
    ]);
    assert.match(problems.join('\n'), /GET \/api\/a: access is undefined/);
    assert.match(problems.join('\n'), /GET \/api\/b: access is "sometimes"/);
    assert.match(problems.join('\n'), /GET \/api\/c: an admin-only route must say why/);
    assert.match(problems.join('\n'), /GET \/api\/d: a public route must name how it is authenticated/);
    assert.match(problems.join('\n'), /GET \/api\/e: a public route must say why it is open/);
    assert.match(problems.join('\n'), /GET \/api\/f: unknown restriction/);
  });

  test('a public route guarded by nothing but a rate limit is not accepted as authenticated', () => {
    const problems = check.validateEntries([
      { method: 'POST', path: '/api/open', access: 'public', mechanism: 'rate-limited' },
    ]);
    assert.match(problems.join('\n'), /rate limiting is not one of them/);
  });

  test('a new CRUD resource with no policy is caught', () => {
    const registry = { widgets: { columns: [] }, gadgets: { columns: [], adminOnlyWrites: true } };
    const { undeclared } = check.compareResources({ gadgets: { read: 'any', write: 'admin', delete: 'admin' } }, registry);
    assert.deepEqual(undeclared, ['widgets']);
    assert.match(check.undeclaredResourceMessage(undeclared), /has no authorization policy/);
  });

  test('a resource whose permissions drift from the policy is caught', () => {
    const registry = { widgets: { columns: [] } }; // no admin flags
    const { drift } = check.compareResources({ widgets: { read: 'any', write: 'admin', delete: 'admin' } }, registry);
    assert.equal(drift.length, 2);
    assert.match(drift.join('\n'), /the policy says write is "admin" but lib\/resources.js enforces "any"/);
    assert.match(drift.join('\n'), /Set adminOnlyWrites: true/);
  });
});

// ---------------------------------------------------------------------
// Fields that must not move through ordinary CRUD (#85)
// ---------------------------------------------------------------------

describe('protected fields cannot be written through ordinary CRUD', () => {
  let policy;
  let check;
  before(async () => {
    policy = await import('../src/lib/authz/policy.js');
    check = await import('../src/lib/authz/check.js');
  });

  test('the policy declares protected fields for the travel finance resources', () => {
    // The declaration is this branch's own work and must hold regardless of
    // whether the enforcement has landed.
    assert.deepEqual(policy.resourceAccess['expense-claims'].protectedFields,
      ['approval_status', 'approved_by', 'amount_reimbursed', 'reimbursement_date']);
    assert.deepEqual(policy.resourceAccess['vendor-invoices'].protectedFields,
      ['amount_paid', 'payment_date']);
  });

  test('every protected field is actually protected', () => {
    // A field counts as protected when the resource either does not accept
    // it as a writable column at all, or lists it in `protectedFields` for
    // lib/crud.js to refuse. Until #85 is integrated neither is true of the
    // travel finance columns, so this fails — deliberately. Weakening it to
    // make the suite green would be declaring an approval anybody can grant
    // themselves to be the intended design.
    const gaps = check.unenforcedProtectedFields(policy.resourceAccess);
    const detail = gaps
      .map((g) => `${g.resource}: ${g.fields.join(', ')} can still be written by PATCH /api/${g.resource}/:id. ${g.protectedBecause ?? g.policy.protectedBecause}`)
      .join('\n');
    assert.equal(
      gaps.length, 0,
      `\n${detail}\n\nThis is the Issue #${policy.BLOCKED_BY_ISSUE_85} fix, which is implemented in its own workspace and not yet integrated here. ` +
      'Integrate it; do not relax this test.\n'
    );
  });
});
