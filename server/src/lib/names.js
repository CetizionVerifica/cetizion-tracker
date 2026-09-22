/**
 * Clients, sectors and sales people are free text, so they are grouped by
 * spelling: case and stray spaces are ignored, any other difference is a
 * different name. "Hetero" and "hetero " are one client, "Hindalco" and
 * "Hindalco - Kuppam" are two.
 */

/** SQL grouping key for a free-text name column or expression. */
export const nameKey = (column) => `lower(regexp_replace(btrim(${column}), '\\s+', ' ', 'g'))`;

/** The same key in JavaScript, for values compared against nameKey(). */
export const normalizeName = (value) => String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

const compact = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
// Words that say what kind of company it is, not which one: two clients
// sharing only "Labs" or "Aluminium" are not the same client.
const GENERIC = new Set([
  'ltd', 'limited', 'pvt', 'private', 'india', 'inc', 'llp', 'co', 'company', 'the', 'and', 'of', 'unit', 'plant', 'site', 'pte',
  'labs', 'lab', 'laboratories', 'laboratory', 'pharma', 'pharmaceuticals', 'pharmaceutical', 'chemicals', 'chemical', 'industries',
  'industry', 'industrial', 'aluminium', 'aluminum', 'metals', 'metal', 'steel', 'steels', 'motors', 'foods', 'polymers', 'textiles',
  'organics', 'lifesciences', 'sciences', 'cables', 'group', 'corporation', 'corp', 'solutions', 'technologies', 'technology', 'tech',
  'enterprises', 'enterprise', 'international', 'global', 'services', 'systems', 'products', 'cements', 'cement', 'agro', 'exports',
  'copper', 'alloys', 'power', 'energy', 'green', 'auto', 'automotive', 'engineering', 'infra', 'infrastructure', 'projects',
]);
const tokens = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !GENERIC.has(t));

/**
 * Loose match for two spellings of what is probably one client:
 * "Hindalco Alupuram" ~ "Hindalco - Alupuram" ~ "Hindalco Industries Alupuram unit".
 * Used to suggest duplicates, never to merge on its own.
 */
export function similarName(a, b) {
  return alike(profile(a), profile(b));
}

/** A name reduced to what matching looks at, worked out once per name. */
const profile = (name) => ({ c: compact(name), t: tokens(name) });

function alike(a, b) {
  if (!a.c || !b.c) return false;
  if (a.c === b.c) return true;
  if ((a.c.length >= 5 && b.c.includes(a.c)) || (b.c.length >= 5 && a.c.includes(b.c))) return true;
  if (!a.t.length || !b.t.length) return false;
  const shared = a.t.filter((t) => b.t.includes(t));
  return shared.length >= 1 && shared.some((t) => t.length >= 4) && shared.length / Math.min(a.t.length, b.t.length) >= 0.5;
}

/**
 * Every pair of names that look like one client, as [i, j] index pairs.
 *
 * Comparing all names with all others is a square: 77 companies is 2,926
 * comparisons on every page load, 500 would be 125,000. Instead each name is
 * filed under what a match would have to share — the whole name, any run of
 * five letters, any distinctive word — and only names filed together are
 * compared. similarName still decides, so the answer is the same list.
 */
const GRAM = 5;
export function similarNamePairs(names) {
  const profiles = names.map(profile);
  const keysFor = (p) => {
    if (!p.c) return [];
    const keys = [`=${p.c}`];                                              // the same spelling
    for (let k = 0; k + GRAM <= p.c.length; k++) keys.push(`~${p.c.slice(k, k + GRAM)}`); // one name inside the other
    for (const t of p.t) if (t.length >= 4) keys.push(`#${t}`);            // a distinctive word in common
    return keys;
  };

  const buckets = new Map();
  const keys = profiles.map((p, i) => {
    const ks = keysFor(p);
    for (const key of ks) {
      const bucket = buckets.get(key);
      if (bucket) bucket.push(i);
      else buckets.set(key, [i]);
    }
    return ks;
  });

  const pairs = [];
  const candidates = new Set();
  for (let i = 0; i < profiles.length; i++) {
    candidates.clear();
    for (const key of keys[i]) {
      for (const j of buckets.get(key)) if (j > i) candidates.add(j);
    }
    for (const j of [...candidates].sort((x, y) => x - y)) {
      if (alike(profiles[i], profiles[j])) pairs.push([i, j]);
    }
  }
  return pairs;
}

const SERVICE_FILLER = new Set(['proposal', 'for', 'of', 'and', 'the', 'assessment', 'audit', 'service', 'services', 'report', 'project', 'work', 'quote', 'quotation']);
const serviceTokens = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2 && !SERVICE_FILLER.has(t));

/** "LCA" ~ "LCA proposal" ~ "LCA (Life cycle assessment)"; "ASI Surveillance Audit" !~ "ASI Recertification". */
export function sameService(a, b) {
  const na = compact(a); const nb = compact(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const ta = serviceTokens(a); const tb = serviceTokens(b);
  if (!ta.length || !tb.length) return false;
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  return short.every((t) => long.includes(t));
}
