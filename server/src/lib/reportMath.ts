/**
 * The arithmetic every report does: rounding money to paise, and turning a
 * part and a whole into a rate. Kept in one place so the sales reports, the
 * revenue report and the review PDF cannot drift apart. No imports, so any
 * report module can use it.
 */

/** Two decimal places — money, and averages of money. */
export const r2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * part ÷ whole, or null when there is nothing to divide by. A rate out of
 * nothing is not 0%, it is unknown, and the reports print it as "—".
 */
export const share = (part: number, whole: number): number | null => (whole > 0 ? part / whole : null);
