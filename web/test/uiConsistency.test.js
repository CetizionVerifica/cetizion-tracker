/**
 * The rules of web/CLAUDE.md that a machine can check, so a screen cannot
 * drift from the design without a red test:
 *
 *   §1  colours come from tokens: no hex or Tailwind palette colours in
 *       components, and every token is defined for both themes;
 *   §1  the token pairs that carry text meet their contrast in both themes;
 *   §1  corners come from the radius scale;
 *   §4  every record page draws its progress with the shared process rail;
 *   §3  the app carries no company name.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const WEB = new URL('..', import.meta.url).pathname;
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

// Files that draw something that is deliberately not themed.
const COLOUR_EXCEPTIONS = new Set([
  'pages/Login.jsx',            // the Microsoft and Google marks, in their owners' colours
  'pages/CompanyProfile.jsx',   // a preview of the quotation PDF, which is always on paper
  'lib/mailFrame.js',           // client email, rendered in its own sandboxed frame
  'components/EmailThread.jsx', // the same
  'components/ui/chart.tsx',    // selectors that match Recharts' own default colours, to override them
]);

test('components use colour tokens, never hex or rgb values', () => {
  const hits = [];
  for (const path of files(SRC)) {
    const rel = relative(SRC, path);
    if (COLOUR_EXCEPTIONS.has(rel)) continue;
    for (const { line, n } of codeLines(path)) {
      if (/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b(?![\w-])/.test(line) && /['"`[]#|fill="#|color:\s*#/.test(line)) hits.push(`${rel}:${n}`);
    }
  }
  assert.deepEqual(hits, [], `Use a token from globals.css instead (web/CLAUDE.md §1):\n${hits.join('\n')}`);
});

test('components never use Tailwind palette colours', () => {
  const palette = /\b(?:bg|text|border|ring|fill|stroke|from|to|via|outline|decoration)-(?:red|blue|green|yellow|orange|amber|emerald|rose|slate|gray|zinc|neutral|stone|sky|indigo|violet|purple|pink|teal|cyan|lime|fuchsia)-\d{2,3}\b/;
  const hits = [];
  for (const path of files(SRC)) {
    for (const { line, n } of codeLines(path)) if (palette.test(line)) hits.push(`${relative(SRC, path)}:${n}`);
  }
  assert.deepEqual(hits, [], `Use a token class such as text-late or bg-primary (web/CLAUDE.md §1):\n${hits.join('\n')}`);
});

test('corners come from the radius scale (6, 8, 12, 16, or 2 and 4 for tiny marks)', () => {
  const allowed = new Set(['2', '4', '6', '8', '12', '16']);
  const hits = [];
  for (const path of files(SRC)) {
    for (const { line, n } of codeLines(path)) {
      for (const m of line.matchAll(/rounded(?:-[a-z]{1,2})?-\[([\d.]+)px\]/g)) {
        if (!allowed.has(m[1])) hits.push(`${relative(SRC, path)}:${n} ${m[0]}`);
      }
    }
  }
  assert.deepEqual(hits, [], `Use rounded-sm (6), rounded-md (8), rounded-lg (12) or rounded-xl (16) (web/CLAUDE.md §1):\n${hits.join('\n')}`);
});

test('the stylesheet keeps to the same radius scale', () => {
  const css = readFileSync(join(SRC, 'styles/globals.css'), 'utf8');
  const bad = [...css.matchAll(/border-radius:\s*([^;]+);/g)]
    .map((m) => m[1].trim())
    .filter((v) => !v.split(/\s+/).every((part) => /^(0|2px|4px|6px|8px|12px|16px|999px|50%|var\(--[\w-]+\))$/.test(part)));
  assert.deepEqual(bad, []);
});

test('records that move through a process show it with the shared rail (web/CLAUDE.md §4)', () => {
  for (const page of ['QuotationDetail.jsx', 'PurchaseOrderDetail.jsx', 'ProjectDetail.jsx', 'TripDetail.jsx']) {
    const text = readFileSync(join(SRC, 'pages', page), 'utf8');
    assert.match(text, /<RecordFlow\b/, `${page} has no process rail`);
    assert.match(text, /flowSteps\(/, `${page} works out its rail by hand instead of with flowSteps`);
  }
  const deal = readFileSync(join(SRC, 'pages/QuotationDetail.jsx'), 'utf8');
  const labels = [...deal.matchAll(/\{ label: '([^']+)', done:/g)].map((m) => m[1]);
  assert.deepEqual(labels, ['Enquiry', 'Quoted', 'Sent', 'Negotiation', 'Won', 'Project', 'Order', 'Invoiced', 'Paid']);
});

// ------------------------------------------------------------------ tokens

const CSS = readFileSync(join(SRC, 'styles/globals.css'), 'utf8');

function block(selector) {
  const start = CSS.indexOf(`${selector} {`);
  assert.ok(start >= 0, `${selector} block missing`);
  const body = CSS.slice(start, CSS.indexOf('\n}', start));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\b/g)].map((m) => [m[1], m[2]]));
}

const LIGHT = block(':root');
const DARK = block('.dark');

test('every colour token is defined for both themes', () => {
  const onlyLight = Object.keys(LIGHT).filter((k) => !(k in DARK));
  const onlyDark = Object.keys(DARK).filter((k) => !(k in LIGHT));
  assert.deepEqual({ onlyLight, onlyDark }, { onlyLight: [], onlyDark: [] });
});

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// [text, ground, minimum]: the pairs the UI actually draws text with.
const PAIRS = [
  ...['foreground', 'secondary-text', 'muted-foreground', 'primary', 'late', 'waiting', 'settled', 'info']
    .flatMap((t) => [[t, 'card', 4.5], [t, 'background', 4.5]]),
  ['primary-foreground', 'primary', 4.5],
  ['primary-foreground', 'settled', 4.5], // the tick and number on a done rail step
  ['late-foreground', 'late', 4.5],
  ['destructive-foreground', 'destructive', 4.5],
  ['sidebar-foreground', 'sidebar', 4.5],
  ['sidebar-accent-foreground', 'sidebar-accent', 4.5],
  ['sidebar-muted', 'sidebar', 4.5],
  ['input', 'card', 3],
  ['ring', 'card', 3],
];

for (const [name, theme] of [['light', LIGHT], ['dark', DARK]]) {
  test(`text tokens meet their contrast in the ${name} theme`, () => {
    const fails = PAIRS
      .map(([fg, bg, min]) => ({ fg, bg, min, ratio: contrast(theme[fg], theme[bg]) }))
      .filter((p) => !(p.ratio >= p.min))
      .map((p) => `${p.fg} on ${p.bg}: ${p.ratio.toFixed(2)} < ${p.min}`);
    assert.deepEqual(fails, []);
  });
}

test('every CSS variable a component reads is defined in globals.css', () => {
  const defined = new Set([...CSS.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
  // Set by Tailwind or Radix at runtime, not by us.
  const runtime = /^--(spacing|radix-[\w-]+|tw-[\w-]+)$/;
  const hits = [];
  for (const path of [...files(SRC), join(SRC, 'styles/globals.css')]) {
    for (const { line, n } of codeLines(path)) {
      for (const m of line.matchAll(/var\((--[\w-]+)/g)) {
        if (!defined.has(m[1]) && !runtime.test(m[1])) hits.push(`${relative(SRC, path)}:${n} ${m[1]}`);
      }
    }
  }
  assert.deepEqual(hits, [], `An undefined variable draws nothing; use a token from globals.css:\n${hits.join('\n')}`);
});

test('every sidebar entry opens a page with the same name (web/CLAUDE.md §3)', () => {
  const app = readFileSync(join(SRC, 'App.jsx'), 'utf8');
  const imports = Object.fromEntries([
    ...app.matchAll(/^import (\w+) from '\.\/pages\/([\w/]+\.jsx)';/gm),
    ...app.matchAll(/^const (\w+) = lazy\(\(\) => import\('\.\/pages\/([\w/]+\.jsx)'\)\);/gm),
  ].map((m) => [m[1], m[2]]));
  // The page is the innermost component on the route (inside AdminOnly or Suspense).
  const routes = Object.fromEntries([...app.matchAll(/<Route path="([^"]+)" element=\{(.*)\} \/>/g)]
    .map((m) => [m[1], [...m[2].matchAll(/<([A-Z]\w+) \/>/g)].pop()?.[1]]));
  const entries = [...app.matchAll(/\{ to: '([^']+)', icon: \w+, label: '([^']+)'/g)].map((m) => ({ to: m[1], label: m[2] }));
  assert.ok(entries.length > 15, 'sidebar entries not found');
  // Today greets the person and Inbox draws its own header (§3).
  const own = new Set(['/', '/inbox']);
  // A tab that is a different list under the same sidebar entry.
  const tabs = new Set(['Credit and cancellation notes']);
  const wrong = [];
  for (const { to, label } of entries) {
    if (own.has(to)) continue;
    const page = imports[routes[to]];
    assert.ok(page, `no page found for ${to}`);
    const text = readFileSync(join(SRC, 'pages', page), 'utf8');
    // Every header the page draws (its error and loading states included).
    const titles = [...text.matchAll(/<(?:PageHeader|ListPage)\s[^>]*?\btitle="([^"]+)"/g)].map((m) => m[1]);
    if (!titles.length || titles.some((t) => t !== label && !tabs.has(t))) wrong.push(`${label} (${to}) -> pages/${page}: ${titles.join(', ') || 'no title'}`);
  }
  assert.deepEqual(wrong, [], 'The page title should be the sidebar name');
});

// ---------------------------------------------------------------- branding

test('the app carries no company name (web/CLAUDE.md §3)', () => {
  const hits = [];
  for (const path of [...files(SRC), join(WEB, 'index.html')]) {
    for (const { line, n } of codeLines(path)) if (/Cetizion Verifica|CETIZION(?!_)/.test(line)) hits.push(`${relative(WEB, path)}:${n}`);
  }
  assert.deepEqual(hits, []);
});
