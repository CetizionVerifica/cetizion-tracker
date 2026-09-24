import { config } from '../config.js';

/**
 * Today's date (YYYY-MM-DD) where the business is, not where the server
 * clock is. The container runs on UTC, so between 00:00 and 05:30 IST the
 * server's own date is still yesterday — and on 1 January, last year.
 */
export function businessToday(now: Date = new Date(), timeZone: string = config.businessTimeZone): string {
  const parts: Record<string, string> = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(now)
      .map((part) => [part.type, part.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export const businessYear = (now?: Date, timeZone?: string): number => Number(businessToday(now, timeZone).slice(0, 4));

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * The day of the week where the business is, 0 for Sunday.
 *
 * The same trap as businessToday: between 18:30 and midnight UTC it is
 * already tomorrow in Mumbai, so an hour on Saturday evening UTC is Sunday
 * to everyone who works here.
 */
export function businessWeekday(now: Date = new Date(), timeZone: string = config.businessTimeZone): number {
  return WEEKDAYS.indexOf(new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short' }).format(now));
}

/**
 * Working days (#73): not Saturday, not Sunday, not a holiday.
 *
 * Dates are plain `YYYY-MM-DD` strings, the form the database hands back,
 * and all arithmetic is on the UTC calendar, so no server clock or time
 * zone can move a day. The holiday list is an argument rather than a
 * query: these stay pure, and a test needs no database to try them.
 */
type Holidays = Iterable<string>;

const DAY_MS = 86_400_000;
const toDay = (date: string): number => Date.parse(`${date}T00:00:00Z`) / DAY_MS;
const fromDay = (day: number): string => new Date(day * DAY_MS).toISOString().slice(0, 10);
const asSet = (holidays: Holidays): Set<string> => (holidays instanceof Set ? holidays : new Set(holidays));

function working(day: number, holidays: Set<string>): boolean {
  // 1 January 1970 was a Thursday, so day 0 is weekday 4.
  const weekday = (((day + 4) % 7) + 7) % 7;
  return weekday !== 0 && weekday !== 6 && !holidays.has(fromDay(day));
}

export function isWorkingDay(date: string, holidays: Holidays = []): boolean {
  return working(toDay(date), asSet(holidays));
}

/**
 * The date `n` working days after `date` (before it, for a negative n).
 * The start itself is not counted, the way a spreadsheet's WORKDAY works:
 * three working days from a Friday is Wednesday, or Thursday when Monday
 * is a holiday. n = 0 returns the date unchanged, working day or not.
 */
export function addWorkingDays(date: string, n: number, holidays: Holidays = []): string {
  const set = asSet(holidays);
  const step = n < 0 ? -1 : 1;
  let day = toDay(date);
  for (let left = Math.abs(n); left > 0;) {
    day += step;
    if (working(day, set)) left -= 1;
  }
  return fromDay(day);
}

/**
 * Working days after `from`, up to and including `to`; 0 when `to` is not
 * later. So a bill due on Friday and paid on Monday is one working day
 * late, and workingDaysBetween(d, addWorkingDays(d, n)) is n.
 */
export function workingDaysBetween(from: string, to: string, holidays: Holidays = []): number {
  const set = asSet(holidays);
  let count = 0;
  for (let day = toDay(from) + 1, end = toDay(to); day <= end; day += 1) {
    if (working(day, set)) count += 1;
  }
  return count;
}
