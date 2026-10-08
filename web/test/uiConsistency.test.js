/**
 * The rules of web/CLAUDE.md that a machine can check and that still hold
 * under the Mocha Glass redesign (which supersedes the guide's visual rules:
 * palette, radii, sidebar groups and the process rail are Mocha Glass's,
 * see src/styles/mocha/):
 *
 *   §1  no Tailwind palette colours in components;
 *   §1  every CSS variable a component or stylesheet reads is defined;
 *   §3  an administrator, and the travel desk, see Vendor invoices (#214, #196);
 *   §3  the app carries no company name.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(WEB, 'src');

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(jsx?|tsx?)$/.test(name) ? [path] : [];
  });
}

/** Lines of code with comments stripped, so a note about a colour is not a colour. */
function codeLines(path) {
  const text = readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''));
  return text.split('\n').map((line, i) => ({ line: line.replace(/(^|[^:])\/\/.*$/, '$1'), n: i + 1 }));
}


test('components never use Tailwind palette colours', () => {
  const palette = /\b(?:bg|text|border|ring|fill|stroke|from|to|via|outline|decoration)-(?:red|blue|green|yellow|orange|amber|emerald|rose|slate|gray|zinc|neutral|stone|sky|indigo|violet|purple|pink|teal|cyan|lime|fuchsia)-\d{2,3}\b/;
  const hits = [];
  for (const path of files(SRC)) {
    for (const { line, n } of codeLines(path)) if (palette.test(line)) hits.push(`${relative(SRC, path)}:${n}`);
  }
  assert.deepEqual(hits, [], `Use a token class such as text-late or bg-primary (web/CLAUDE.md §1):\n${hits.join('\n')}`);
});

// ------------------------------------------------------------------ tokens

const STYLES = join(SRC, 'styles');
const sheets = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  if (statSync(path).isDirectory()) return sheets(path);
  return name.endsWith('.css') ? [path] : [];
});
const CSS = sheets(STYLES).map((path) => readFileSync(path, 'utf8')).join('\n');

test('every CSS variable a component or stylesheet reads is defined', () => {
  const defined = new Set([...CSS.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
  // Set by Tailwind, Radix or a component's inline style at runtime, not by a stylesheet.
  const runtime = /^--(spacing$|radix-|tw-|mg-vt-)/; // the theme shockwave sets --mg-vt-* from motion.js
  const inline = new Set();
  for (const path of files(SRC)) {
    for (const m of readFileSync(path, 'utf8').matchAll(/['"](--[\w-]+)['"]\s*:/g)) inline.add(m[1]);
    for (const m of readFileSync(path, 'utf8').matchAll(/setProperty\(\s*['"`](--[\w-]+)/g)) inline.add(m[1]);
  }
  const hits = [];
  for (const path of [...files(SRC), ...sheets(STYLES)]) {
    for (const { line, n } of codeLines(path)) {
      for (const m of line.matchAll(/var\((--[\w-]+)\s*([,)])/g)) {
        if (m[2] === ',') continue; // has its own fallback
        if (!defined.has(m[1]) && !inline.has(m[1]) && !runtime.test(m[1])) hits.push(`${relative(SRC, path)}:${n} ${m[1]}`);
      }
    }
  }
  assert.deepEqual(hits, [], `An undefined variable draws nothing; use a Mocha Glass token:\n${hits.join('\n')}`);
});

// ------------------------------------------------------------- the sidebar

/**
 * Who sees which sidebar entry (#214 decision 8). The shell's lists are plain
 * data in components/shell/nav.js: NAV_RECORDS for an administrator and a
 * sales user (an `adminOnly` entry is filtered out for anyone else), and
 * NAV_HR_RECORDS for the travel desk.
 */
function navEntries(listName) {
  const source = readFileSync(join(SRC, 'components/shell/nav.js'), 'utf8');
  const list = source.match(new RegExp(`const ${listName} = \\[[\\s\\S]*?\\n\\];`));
  assert.ok(list, `${listName} not found in nav.js`);
  return [...list[0].matchAll(/\{ to: '([^']+)', icon: \w+, label: '([^']+)'([^}]*)\}/g)]
    .map((m) => ({ to: m[1], label: m[2], adminOnly: /adminOnly:\s*true/.test(m[3]) }));
}

test('an administrator sees Vendor invoices in the sidebar, a sales user does not (#214)', () => {
  const entry = navEntries('NAV_RECORDS').filter((e) => e.to === '/vendor-invoices');
  assert.equal(entry.length, 1, 'NAV_RECORDS should carry exactly one Vendor invoices entry');
  assert.equal(entry[0].label, 'Vendor invoices');
  assert.equal(entry[0].adminOnly, true, 'paying a travel agency is not a salesperson’s work (#214 decision 8)');
  const nav = readFileSync(join(SRC, 'components/shell/nav.js'), 'utf8');
  assert.match(nav, /NAV_RECORDS\.filter\(\(n\) => !n\.adminOnly \|\| isAdmin\)/, 'navFor must drop adminOnly entries for a non-admin');
});

test('the travel desk keeps its own Vendor invoices entry, unflagged (#196)', () => {
  const entry = navEntries('NAV_HR_RECORDS').filter((e) => e.to === '/vendor-invoices');
  assert.equal(entry.length, 1, 'HR must keep its Vendor invoices entry');
  assert.equal(entry[0].adminOnly, false);
});

// ---------------------------------------------------------------- branding

test('the app carries no company name (web/CLAUDE.md §3)', () => {
  const hits = [];
  for (const path of [...files(SRC), join(WEB, 'index.html')]) {
    for (const { line, n } of codeLines(path)) if (/Cetizion Verifica|CETIZION(?!_)/.test(line)) hits.push(`${relative(WEB, path)}:${n}`);
  }
  assert.deepEqual(hits, []);
});
