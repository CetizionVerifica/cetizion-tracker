/**
 * A list that is one screen tall (#250): as many rows as the box has room
 * for, and the pager for the rest, so the inbox never scrolls.
 *
 * Pure, so the arithmetic is tested without a browser; the hook that
 * measures the box is `useRowsThatFit` in hooks.js.
 */

/**
 * Fewest rows a page shows. Below this the window is too short to be a mail
 * list at all, and the pane scrolls rather than showing one email at a time.
 */
export const MIN_ROWS = 3;

/** How many rows of `rowHeight` fit in `height`, never fewer than `min`. */
export function rowsThatFit(height, rowHeight, min = MIN_ROWS) {
  if (!(height > 0) || !(rowHeight > 0)) return min;
  return Math.max(min, Math.floor(height / rowHeight));
}

/**
 * The page that still shows the conversation that was at the top, once the
 * page size changes from `oldSize` to `newSize`.
 *
 * Resizing the window changes how many rows a page holds, and without this
 * page 3 of 8 rows (rows 17–24) would become page 3 of 12 (rows 25–36): the
 * list would jump past what you were reading.
 */
export function keepPlace(page, oldSize, newSize) {
  if (!(oldSize > 0) || !(newSize > 0) || oldSize === newSize) return page;
  return Math.floor(((page - 1) * oldSize) / newSize) + 1;
}
