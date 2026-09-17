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
  const na = compact(a); const nb = compact(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if ((na.length >= 5 && nb.includes(na)) || (nb.length >= 5 && na.includes(nb))) return true;
  const ta = tokens(a); const tb = tokens(b);
  if (!ta.length || !tb.length) return false;
  const shared = ta.filter((t) => tb.includes(t));
  return shared.length >= 1 && shared.some((t) => t.length >= 4) && shared.length / Math.min(ta.length, tb.length) >= 0.5;
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
