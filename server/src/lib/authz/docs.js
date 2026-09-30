/**
 * The policy tables in docs/issue-18-authorization.md, rendered from the
 * policy itself (#89).
 *
 * The document is not the source of truth and is not maintained by hand:
 * `npm run authz:docs` writes these sections, and `authzDocs.test.js` fails
 * the build when the file on disk no longer matches what the policy says.
 */
import { AUTH_MECHANISMS, resourceAccess, routes } from './policy.js';

export const MARKERS = {
  routes: 'generated:routes',
  resources: 'generated:resources',
  public: 'generated:public-routes',
};

const begin = (name) => `<!-- ${name} -->`;
const end = (name) => `<!-- /${name} -->`;

const cell = (text) => String(text ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim();

const LABEL = { public: 'public', any: 'any', admin: '**admin**' };

/** The prefix a route is filed under, e.g. /api/quotations. */
function group(path) {
  if (!path.startsWith('/api/')) return path === '/metrics' ? '/metrics' : 'the web app';
  return `/api/${path.split('/')[2]}`;
}

export function renderRouteTable() {
  const rows = [];
  let current = null;
  for (const entry of [...routes].sort((a, b) => {
    const byGroup = group(a.path).localeCompare(group(b.path));
    return byGroup || `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`);
  })) {
    const heading = group(entry.path);
    if (heading !== current) {
      current = heading;
      rows.push(`| **${cell(heading)}** | | |`);
    }
    const note = entry.access === 'admin' ? entry.why
      : entry.access === 'public' ? `${entry.mechanism} — ${entry.openBecause}`
        : entry.note || (entry.restrictions?.length ? `Scoped: ${entry.restrictions.join(', ')}.` : '');
    rows.push(`| \`${cell(`${entry.method} ${entry.path}`)}\` | ${LABEL[entry.access]} | ${cell(note)} |`);
  }
  return [
    '| Route | Access | Why, or what narrows it |',
    '| --- | :--: | --- |',
    ...rows,
  ].join('\n');
}

export function renderResourceTable() {
  const rows = Object.entries(resourceAccess)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, access]) => {
      const protectedNote = access.protectedFields?.length
        ? `Protected fields: ${access.protectedFields.map((f) => `\`${f}\``).join(', ')}.`
        : '';
      return `| \`${cell(name)}\` | ${LABEL[access.read]} | ${LABEL[access.write]} | ${LABEL[access.delete]} | ${cell(`${access.why} ${protectedNote}`)} |`;
    });
  return [
    '| Resource | GET | POST / PATCH | DELETE | Why |',
    '| --- | :--: | :--: | :--: | --- |',
    ...rows,
  ].join('\n');
}

export function renderPublicTable() {
  const used = [...new Set(routes.filter((r) => r.access === 'public').map((r) => r.mechanism))];
  const rows = used.sort().flatMap((name) => {
    const mechanism = AUTH_MECHANISMS[name];
    const paths = routes.filter((r) => r.access === 'public' && r.mechanism === name)
      .map((r) => `\`${r.method} ${r.path}\``).join('<br>');
    return [`| ${paths} | ${mechanism.authenticates ? '**yes**' : 'no'} | ${cell(mechanism.proof ?? mechanism.description)} |`];
  });
  return [
    '| Public route | Authenticated? | What is checked |',
    '| --- | :--: | --- |',
    ...rows,
  ].join('\n');
}

const SECTIONS = {
  [MARKERS.routes]: renderRouteTable,
  [MARKERS.resources]: renderResourceTable,
  [MARKERS.public]: renderPublicTable,
};

/**
 * Replace every generated section in `document` with what the policy says
 * now. Throws when a marker pair is missing, rather than silently leaving a
 * section stale.
 */
export function render(document) {
  let out = document;
  for (const [name, renderer] of Object.entries(SECTIONS)) {
    const pattern = new RegExp(`${begin(name)}[\\s\\S]*?${end(name)}`);
    if (!pattern.test(out)) {
      throw new Error(`The document has no ${begin(name)} ... ${end(name)} section to fill.`);
    }
    out = out.replace(pattern, `${begin(name)}\n${renderer()}\n${end(name)}`);
  }
  return out;
}
