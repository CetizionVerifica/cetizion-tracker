#!/usr/bin/env node
/**
 * Which high and critical advisories a pull request brings in (#37).
 *
 *   node scripts/ci/new-advisories.mjs <base-audit.json> <head-audit.json>
 *
 * Both files are `npm audit --omit=dev --json`: the base branch's lock file
 * and the pull request's. An advisory published against a package the base
 * already has is not the pull request's doing: it is reported as a warning,
 * and Dependabot's security update (or the weekly run on main, which still
 * fails) is what fixes it. One the pull request adds, by adding or changing
 * a dependency, fails the check.
 *
 * Without this, every pull request failed the day an advisory was published
 * against an existing package, documentation-only ones included, until
 * someone updated that package (vite and the MCP SDK in #242, dompurify in
 * #245).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SERIOUS = new Set(['high', 'critical']);

/** The high and critical advisories in an `npm audit --json` report, by URL. */
export function seriousAdvisories(report) {
  const found = new Map();
  for (const [pkg, v] of Object.entries(report?.vulnerabilities || {})) {
    for (const via of v.via || []) {
      // A string names another vulnerable package; its own entry carries the advisory.
      if (typeof via !== 'object' || !SERIOUS.has(via.severity)) continue;
      const id = via.url || `${via.name}#${via.source}`;
      if (!found.has(id)) found.set(id, { id, package: via.name || pkg, severity: via.severity, title: via.title || '' });
    }
  }
  return found;
}

/** { added, existing }: advisories only the head has, and those the base has too. */
export function compare(base, head) {
  const before = seriousAdvisories(base);
  const after = [...seriousAdvisories(head).values()];
  return { added: after.filter((a) => !before.has(a.id)), existing: after.filter((a) => before.has(a.id)) };
}

const line = (a) => `${a.severity.toUpperCase()} ${a.package}: ${a.title} (${a.id})`;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [baseFile, headFile] = process.argv.slice(2);
  const read = (f) => {
    const report = JSON.parse(readFileSync(f, 'utf8'));
    // An audit that could not run (no registry, a broken lock file) must not pass as clean.
    if (report.error || !report.vulnerabilities) { console.log(`::error title=Audit did not run::${f}: ${report.error?.summary || 'no vulnerabilities section'}`); process.exit(1); }
    return report;
  };
  const { added, existing } = compare(read(baseFile), read(headFile));
  for (const a of existing) console.log(`::warning title=Already on the base branch::${line(a)}. Not caused by this pull request; update the package separately.`);
  if (added.length) {
    for (const a of added) console.log(`::error title=Added by this pull request::${line(a)}`);
    console.log(`${added.length} high or critical advisor${added.length === 1 ? 'y' : 'ies'} added by this pull request.`);
    process.exit(1);
  }
  console.log(existing.length
    ? `No advisory added by this pull request; ${existing.length} already on the base branch (warnings above).`
    : 'No high or critical advisories.');
}
