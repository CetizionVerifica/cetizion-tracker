import assert from 'node:assert/strict';
import test from 'node:test';
import { compare, seriousAdvisories } from '../../scripts/ci/new-advisories.mjs';

/**
 * The pull-request dependency audit (#37, scripts/ci/new-advisories.mjs):
 * only a high or critical advisory the pull request adds fails it. Made-up
 * reports in `npm audit --json`'s shape.
 */
const advisory = (name, severity, n) => ({ source: n, name, dependency: name, title: `${name} problem ${n}`, url: `https://github.com/advisories/GHSA-${n}`, severity, range: '<9' });
const report = (...vias) => {
  const vulnerabilities = {};
  for (const v of vias) {
    const pkg = typeof v === 'string' ? v : v.name;
    vulnerabilities[pkg] ??= { name: pkg, severity: typeof v === 'string' ? 'high' : v.severity, via: [] };
    vulnerabilities[pkg].via.push(v);
  }
  return { auditReportVersion: 2, vulnerabilities, metadata: {} };
};

test('only high and critical advisories count, each once, and a package that is vulnerable through another adds nothing', () => {
  const r = report(advisory('dompurify', 'critical', 1), advisory('dompurify', 'high', 2), advisory('ip-address', 'moderate', 3));
  r.vulnerabilities.wrapper = { name: 'wrapper', severity: 'critical', via: ['dompurify'] };
  assert.deepEqual([...seriousAdvisories(r).keys()], ['https://github.com/advisories/GHSA-1', 'https://github.com/advisories/GHSA-2']);
});

test('an advisory main already has is not the pull request\'s; one it adds is', () => {
  const main = report(advisory('dompurify', 'critical', 1));
  assert.deepEqual(compare(main, main).added, [], 'a docs-only pull request passes');
  assert.equal(compare(main, main).existing.length, 1, '…with the advisory still reported');
  assert.deepEqual(compare(main, report()).added, [], 'the pull request that fixes it passes');
  const adds = compare(report(), main);
  assert.equal(adds.added.length, 1, 'a pull request bringing the vulnerable version in fails');
  assert.equal(adds.added[0].package, 'dompurify');
  assert.equal(compare(main, report(advisory('dompurify', 'critical', 1), advisory('vite', 'high', 4))).added[0].package, 'vite');
});
