/**
 * Holding the declared access policy against the routes the application
 * actually mounts (#89).
 *
 * Pure functions, no Express and no database, so the coverage test can feed
 * them a fabricated route list and prove the check itself fails when it
 * should — a coverage check nobody has seen fail is not evidence of anything.
 */
import { ACCESS_LEVELS, AUTH_MECHANISMS, RESTRICTIONS, policyRoutes } from './policy.js';
import { resources } from '../resources.js';

export const keyOf = (route) => `${route.method} ${route.path}`;

const DECLARE = 'Declare it in server/src/lib/authz/policy.js as public, any, or admin.';

/**
 * @param {{method: string, path: string}[]} discovered  routes the app mounts
 * @param {object[]} declared  entries from the policy
 * @returns {{undeclared: string[], stale: string[], duplicates: string[], problems: string[]}}
 */
export function compareRoutes(discovered, declared) {
  const declaredKeys = new Map();
  const duplicates = [];
  for (const entry of declared) {
    const key = keyOf(entry);
    if (declaredKeys.has(key)) duplicates.push(key);
    else declaredKeys.set(key, entry);
  }

  const discoveredKeys = new Set(discovered.map(keyOf));

  const undeclared = [...discoveredKeys].filter((k) => !declaredKeys.has(k)).sort();
  const stale = [...declaredKeys.keys()].filter((k) => !discoveredKeys.has(k)).sort();

  return { undeclared, stale, duplicates: [...new Set(duplicates)].sort(), declaredKeys, discoveredKeys };
}

export function undeclaredMessage(undeclared) {
  return undeclared.map((k) => `${k} is not in the access policy. ${DECLARE}`).join('\n');
}

export function staleMessage(stale) {
  return stale
    .map((k) => `${k} is in the access policy but the application does not mount it. Remove it from server/src/lib/authz/policy.js, or restore the route.`)
    .join('\n');
}

export function duplicateMessage(duplicates) {
  return duplicates
    .map((k) => `${k} is declared more than once in the access policy. Keep one entry; two entries mean two answers to one question.`)
    .join('\n');
}

/** Structural faults in the policy itself, independent of what is mounted. */
export function validateEntries(declared) {
  const problems = [];
  for (const entry of declared) {
    const key = keyOf(entry);
    if (!entry.method || !entry.path) {
      problems.push(`A policy entry is missing a method or a path: ${JSON.stringify(entry)}`);
      continue;
    }
    if (!entry.path.startsWith('/')) problems.push(`${key}: path must start with "/".`);
    if (!ACCESS_LEVELS.includes(entry.access)) {
      problems.push(`${key}: access is ${JSON.stringify(entry.access)}. ${DECLARE}`);
    }
    if (entry.access === 'admin' && !entry.why) {
      problems.push(`${key}: an admin-only route must say why. Add a "why" to its policy entry.`);
    }
    if (entry.access === 'public') {
      const mechanism = AUTH_MECHANISMS[entry.mechanism];
      if (!mechanism) {
        problems.push(
          `${key}: a public route must name how it is authenticated. Set "mechanism" to one of: ${Object.keys(AUTH_MECHANISMS).join(', ')} — and note that rate limiting is not one of them.`
        );
      } else if (!entry.openBecause) {
        problems.push(`${key}: a public route must say why it is open. Add an "openBecause" to its policy entry.`);
      } else if (mechanism.authenticates && !mechanism.proof) {
        problems.push(`${key}: mechanism "${entry.mechanism}" claims to authenticate but does not say what it checks. Give it a "proof".`);
      }
    }
    if (entry.access !== 'public' && entry.mechanism) {
      problems.push(`${key}: "mechanism" describes how a public route is guarded; a ${entry.access} route is guarded by the session.`);
    }
    for (const restriction of entry.restrictions || []) {
      if (!RESTRICTIONS[restriction]) {
        problems.push(`${key}: unknown restriction "${restriction}". Known ones: ${Object.keys(RESTRICTIONS).join(', ')}.`);
      }
    }
  }
  return problems;
}

/**
 * The resource table against the registry, in both directions, and against
 * what `crudRouter()` will actually enforce from the flags it reads.
 */
export function compareResources(resourceAccess, registry = resources) {
  const declared = new Set(Object.keys(resourceAccess));
  const registered = new Set(Object.keys(registry));

  const undeclared = [...registered].filter((n) => !declared.has(n)).sort();
  const stale = [...declared].filter((n) => !registered.has(n)).sort();
  const drift = [];

  for (const name of [...registered].filter((n) => declared.has(n)).sort()) {
    const def = registry[name];
    const policy = resourceAccess[name];
    // What lib/crud.js does with the flags, restated here so drift shows up
    // as a difference rather than as a passing test.
    const enforced = {
      read: 'any',
      write: def.adminOnlyWrites ? 'admin' : 'any',
      delete: def.adminOnlyWrites || def.adminOnlyDeletes ? 'admin' : 'any',
    };
    // The HR role (#196): writing an admin-curated list takes hrWrites on the resource.
    if (def.adminOnlyWrites && Boolean(policy.hr?.write) !== Boolean(def.hrWrites)) {
      drift.push(`${name}: the policy says HR ${policy.hr?.write ? 'may' : 'may not'} write it, but lib/resources.js ${def.hrWrites ? 'sets' : 'does not set'} hrWrites.`);
    }
    for (const operation of ['read', 'write', 'delete']) {
      if (policy[operation] !== enforced[operation]) {
        drift.push(
          `${name}: the policy says ${operation} is "${policy[operation]}" but lib/resources.js enforces "${enforced[operation]}". ` +
          (policy[operation] === 'admin'
            ? `Set ${operation === 'write' ? 'adminOnlyWrites' : 'adminOnlyDeletes'}: true on the resource, or change the policy.`
            : 'Remove the admin flag from the resource, or change the policy.')
        );
      }
    }
  }

  return { undeclared, stale, drift };
}

export function undeclaredResourceMessage(undeclared) {
  return undeclared
    .map((n) => `The CRUD resource "${n}" has no authorization policy. Add it to resourceAccess in server/src/lib/authz/policy.js with a read, write and delete level.`)
    .join('\n');
}

export function staleResourceMessage(stale) {
  return stale
    .map((n) => `The access policy declares a CRUD resource "${n}" that lib/resources.js does not register. Remove it, or restore the resource.`)
    .join('\n');
}

/**
 * Columns a resource's schema accepts that the policy says must not be
 * writable through ordinary CRUD. Returns the ones nothing stops today.
 */
export function unenforcedProtectedFields(resourceAccess, registry = resources) {
  const gaps = [];
  for (const [name, policy] of Object.entries(resourceAccess)) {
    if (!policy.protectedFields?.length) continue;
    const def = registry[name];
    if (!def) continue;
    const writable = new Set(def.columns || []);
    const enforced = new Set(def.protectedFields || []);
    const open = policy.protectedFields.filter((f) => writable.has(f) && !enforced.has(f));
    if (open.length) gaps.push({ resource: name, fields: open, policy });
  }
  return gaps;
}

/** Every route the whole policy declares, for callers that want one list. */
export const declaredRoutes = policyRoutes;
