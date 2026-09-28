/**
 * Clients, sectors and sales people are free text, so they are grouped by
 * spelling: case and stray spaces are ignored, any other difference is a
 * different name. "Hetero" and "hetero " are one client, "Hindalco" and
 * "Hindalco - Kuppam" are two.
 */

/** SQL grouping key for a free-text name column or expression. */
export const nameKey = (column: string): string => `lower(regexp_replace(btrim(${column}), '\\s+', ' ', 'g'))`;

/** The same key in JavaScript, for values compared against nameKey(). */
export const normalizeName = (value: unknown): string => String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

export const compact = (s: unknown): string => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
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
const tokens = (s: unknown): string[] => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !GENERIC.has(t));

/**
 * Loose match for two spellings of what is probably one client:
 * "Hindalco Alupuram" ~ "Hindalco - Alupuram" ~ "Hindalco Industries Alupuram unit".
 * Used to suggest duplicates, never to merge on its own.
 */
export function similarName(a: unknown, b: unknown): boolean {
  return alike(profile(a), profile(b));
}

/** A name reduced to what matching looks at, worked out once per name. */
type NameProfile = { c: string; t: string[] };
const profile = (name: unknown): NameProfile => ({ c: compact(name), t: tokens(name) });

function alike(a: NameProfile, b: NameProfile): boolean {
  if (!a.c || !b.c) return false;
  if (a.c === b.c) return true;
  if ((a.c.length >= 5 && b.c.includes(a.c)) || (b.c.length >= 5 && a.c.includes(b.c))) return true;
  if (!a.t.length || !b.t.length) return false;
  // Each side carrying its own distinguishing word means two things, not two
  // spellings of one: "Hindalco - Belur", "Hindalco FRP" and "Hindalco -
  // Kuppam" share a brand and are three plants. They were all being offered
  // as merges of each other, and a merge rewrites the client name on every
  // record of both and then deletes one of them.
  //
  // One side having extra words is still a match, because that is what a
  // fuller spelling of the same thing looks like: "Hindalco" inside "Aditya
  // Birla - Hindalco", "Hindalco Industries Alupuram unit" beside "Hindalco
  // Alupuram".
  //
  // It sits in alike() rather than in similarName because the bucketing
  // below shortlists candidates and then asks alike() to decide; a rule
  // added anywhere else would not be applied to the fast path.
  const onlyA = a.t.filter((t) => !b.t.includes(t));
  const onlyB = b.t.filter((t) => !a.t.includes(t));
  if (onlyA.length && onlyB.length) return false;
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
export function similarNamePairs(names: unknown[]): Array<[number, number]> {
  const profiles = names.map(profile);
  const keysFor = (p: NameProfile): string[] => {
    if (!p.c) return [];
    const keys = [`=${p.c}`];                                              // the same spelling
    for (let k = 0; k + GRAM <= p.c.length; k++) keys.push(`~${p.c.slice(k, k + GRAM)}`); // one name inside the other
    for (const t of p.t) if (t.length >= 4) keys.push(`#${t}`);            // a distinctive word in common
    return keys;
  };

  const buckets = new Map<string, number[]>();
  const keys = profiles.map((p, i) => {
    const ks = keysFor(p);
    for (const key of ks) {
      const bucket = buckets.get(key);
      if (bucket) bucket.push(i);
      else buckets.set(key, [i]);
    }
    return ks;
  });

  const pairs: Array<[number, number]> = [];
  const candidates = new Set<number>();
  for (let i = 0; i < profiles.length; i++) {
    candidates.clear();
    for (const key of keys[i]!) {
      for (const j of buckets.get(key)!) if (j > i) candidates.add(j);
    }
    for (const j of [...candidates].sort((x, y) => x - y)) {
      if (alike(profiles[i]!, profiles[j]!)) pairs.push([i, j]);
    }
  }
  return pairs;
}

const SERVICE_FILLER = new Set(['proposal', 'for', 'of', 'and', 'the', 'assessment', 'audit', 'service', 'services', 'report', 'project', 'work', 'quote', 'quotation']);
const serviceTokens = (s: unknown): string[] => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2 && !SERVICE_FILLER.has(t));

/** "LCA" ~ "LCA proposal" ~ "LCA (Life cycle assessment)"; "ASI Surveillance Audit" !~ "ASI Recertification". */
export function sameService(a: unknown, b: unknown): boolean {
  const na = compact(a); const nb = compact(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const ta = serviceTokens(a); const tb = serviceTokens(b);
  if (!ta.length || !tb.length) return false;
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  return short.every((t) => long.includes(t));
}
