/**
 * Indian financial quarters: Q1 is April to June.
 *
 * Its own file, and importing nothing, so a test can exercise the date
 * arithmetic without a database. A test that reaches this through a route
 * module would pull in db.js, and db.js binds its pool the moment it is
 * imported — before a test's `before()` has had a chance to point it at a
 * throwaway database.
 */
const QUARTERS_PER_YEAR = 4;
const MONTHS_PER_QUARTER = 3;
const FY_FIRST_MONTH = 4;

/** Quarters counted from year 0, so stepping across a year boundary is a subtraction. */
const indexOf = (startYear, q) => startYear * QUARTERS_PER_YEAR + (q - 1);

/** `{ key, fy, q, label, starts_on }` for a quarter index. */
function describe(index) {
  const startYear = Math.floor(index / QUARTERS_PER_YEAR);
  const q = (index % QUARTERS_PER_YEAR) + 1;
  const fy = `${String(startYear % 100).padStart(2, '0')}-${String((startYear + 1) % 100).padStart(2, '0')}`;
  // Q4 is January to March, which is the *next* calendar year: counting
  // months from April gives 13 for it, not 1.
  const counted = FY_FIRST_MONTH + (q - 1) * MONTHS_PER_QUARTER;
  const month = counted > 12 ? counted - 12 : counted;
  const calendarYear = counted > 12 ? startYear + 1 : startYear;
  return { key: `${startYear}Q${q}`, fy, q, label: `Q${q} FY${fy}`, starts_on: `${calendarYear}-${String(month).padStart(2, '0')}-01` };
}

/** The financial quarter a YYYY-MM-DD falls in. */
export function financialQuarter(isoDate) {
  const [year, month] = String(isoDate).slice(0, 10).split('-').map(Number);
  const startYear = month >= FY_FIRST_MONTH ? year : year - 1;
  const q = Math.floor(((month - FY_FIRST_MONTH + 12) % 12) / MONTHS_PER_QUARTER) + 1;
  return describe(indexOf(startYear, q));
}

/** The `count` quarters ending with the one `isoDate` falls in, oldest first. */
export function recentQuarters(isoDate, count) {
  const here = financialQuarter(isoDate);
  const last = indexOf(Number(`20${here.fy.slice(0, 2)}`), here.q);
  return Array.from({ length: count }, (_, i) => describe(last - (count - 1 - i)));
}
