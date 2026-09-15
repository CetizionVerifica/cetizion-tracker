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
