import { config } from '../config.js';

/**
 * Today's date (YYYY-MM-DD) where the business is, not where the server
 * clock is. The container runs on UTC, so between 00:00 and 05:30 IST the
 * server's own date is still yesterday — and on 1 January, last year.
 */
export function businessToday(now = new Date(), timeZone = config.businessTimeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(now)
      .map((part) => [part.type, part.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export const businessYear = (now, timeZone) => Number(businessToday(now, timeZone).slice(0, 4));
