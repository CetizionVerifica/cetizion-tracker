/**
 * When the scheduled sales reports are due, whether they went, and the
 * API's own safety net for the days the worker did not send them
 * (docs/mis-briefing-fix-plan.md §1).
 *
 * The briefing used to go only when somebody pressed Send now: the schedule
 * lives in the worker, a second Dokploy application with its own image and
 * environment, and when that application is missing, out of date or
 * misconfigured nothing in the API notices. So, as with mail (autoSync.js),
 * the API now checks for itself:
 *
 *   startReportSchedule()    from index.js, every few minutes: a report due
 *                            today whose time has passed by CATCH_UP_MINUTES
 *                            with no scheduled run recorded for its period is
 *                            run here, with the schedule's guards
 *   checkMissedReports()     a report switched on and not sent by
 *                            MISSED_AFTER_MINUTES past its time: an alert
 *   checkWorker()            the worker has written no job_runs row lately:
 *                            an alert (production only)
 *   scheduleStatus()         what the Scheduled reports page shows about it
 *
 * misSend.js holds a lock per report and period while a guarded run builds
 * and sends, so the worker and this net cannot both send the same day.
 */
import { config } from '../config.js';
import { query } from '../db.js';
import { isStaging } from './ops/environment.js';
import { raiseAlert } from './ops/alerts.js';
import { KINDS, misSettings, periodFor } from './misReports.js';
import { REPORT_TITLE } from './misPdf.js';
import { runReport } from './misSend.js';

/** The jobs and their cron lines (jobs.js reads them from here). Every day, weekends and holidays included, for the briefing. */
export const REPORT_JOBS = {
  daily_briefing: { job: 'reports.daily_briefing', cron: '56 8 * * *' },
  weekly_mis: { job: 'reports.weekly_mis', cron: '54 8 * * 1' },
};

/** How long after its time the API runs a report the worker did not. */
export const CATCH_UP_MINUTES = 20;
/** How long after its time a report not yet sent is an alert. */
export const MISSED_AFTER_MINUTES = 34;
/** The worker's ops.watch records a run every 15 minutes; longer than this without any is a worker down. */
export const WORKER_SILENT_MINUTES = 35;

// ---------------------------------------------------------------------
// Time in the business time zone
// ---------------------------------------------------------------------

/** The wall clock in `timeZone`: date, weekday (0 Sunday), hour, minute. */
export function wallClock(now, timeZone = config.businessTimeZone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23',
  }).formatToParts(now).map((x) => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday),
    minutes: Number(p.hour) * 60 + Number(p.minute),
  };
}

/** A cron line of the form the reports use ("M H * * DOW"), read. Null for anything else. */
export function parseCron(cron) {
  const m = /^(\d{1,2}) (\d{1,2}) \* \* (\*|[0-6](?:,[0-6])*)$/.exec(String(cron).trim());
  if (!m) return null;
  return { minutes: Number(m[2]) * 60 + Number(m[1]), weekdays: m[3] === '*' ? null : m[3].split(',').map(Number) };
}

const DAY_MS = 86_400_000;
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const weekdayOf = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();

/** The instant a wall-clock time on `date` in `timeZone` is. */
export function instantOf(date, minutes, timeZone = config.businessTimeZone) {
  const guess = Date.parse(`${date}T00:00:00Z`) + minutes * 60_000;
  // The zone's offset at that moment, read back from the wall clock it shows.
  const shown = wallClock(new Date(guess), timeZone);
  const shownAt = Date.parse(`${shown.date}T00:00:00Z`) + shown.minutes * 60_000;
  return new Date(guess - (shownAt - guess));
}

/** The next time a cron line fires after `now`, as a Date. */
export function nextRun(cron, now = new Date(), timeZone = config.businessTimeZone) {
  const c = parseCron(cron);
  if (!c) return null;
  const today = wallClock(now, timeZone).date;
  for (let i = 0; i <= 7; i += 1) {
    const date = addDays(today, i);
    if (c.weekdays && !c.weekdays.includes(weekdayOf(date))) continue;
    const at = instantOf(date, c.minutes, timeZone);
    if (at > now) return at;
  }
  return null;
}

/**
 * Whether a report is due today and its time passed `graceMinutes` ago, at
 * `now` in the business time zone. Returns the business date ("today" for
 * the report) when it is, else null.
 */
export function dueToday(kind, now, { graceMinutes = CATCH_UP_MINUTES, timeZone = config.businessTimeZone } = {}) {
  const c = parseCron(REPORT_JOBS[kind].cron);
  const clock = wallClock(now, timeZone);
  if (c.weekdays && !c.weekdays.includes(clock.weekday)) return null;
  if (clock.minutes < c.minutes + graceMinutes) return null;
  return clock.date;
}

// ---------------------------------------------------------------------
// The safety net
// ---------------------------------------------------------------------

const enabledFor = (kind, s) => (kind === 'daily_briefing' ? s.dailyEnabled : s.weeklyEnabled);

/**
 * Run each report due today that the schedule has not run for its period.
 * "Has run" is any report_runs row from the schedule for the period, sent,
 * failed or skipped (misSend.js records guarded skips), so a report that is
 * switched off is looked at once a day, not every few minutes.
 */
export async function catchUpReports({ now = new Date(), db = { query }, run = runReport, log = console } = {}) {
  const out = [];
  for (const kind of KINDS) {
    const today = dueToday(kind, now);
    if (!today) continue;
    const period = periodFor(kind, today);
    const { rows: [seen] } = await db.query(
      `SELECT id FROM report_runs WHERE kind = $1 AND period_from = $2 AND triggered_by = 'schedule' LIMIT 1`, [kind, period.from]);
    if (seen) continue;
    log.warn?.(`[reports] ${kind} for ${period.from} has no scheduled run by ${CATCH_UP_MINUTES} minutes past its time; running it from the API`);
    const r = await run(kind, { today, startedBy: 'schedule', guarded: true, db });
    await db.query(
      `INSERT INTO job_runs (name, started_by, status, finished_at, result) VALUES ($1, 'api catch-up', 'done', now(), $2)`,
      [REPORT_JOBS[kind].job, JSON.stringify({ status: r.status, id: r.id ?? null, skipped: r.skipped ?? null, error: r.error ?? null, period })]).catch(() => {});
    out.push({ kind, period, status: r.status, reason: r.skipped || r.error || null });
  }
  return out;
}

/**
 * A report switched on, past its time by MISSED_AFTER_MINUTES, with nothing
 * delivered for its period: an alert naming the last attempt, once a day.
 */
export async function checkMissedReports({ now = new Date(), db = { query } } = {}) {
  const settings = await misSettings(db);
  const out = [];
  for (const kind of KINDS) {
    if (!enabledFor(kind, settings)) continue;
    const today = dueToday(kind, now, { graceMinutes: MISSED_AFTER_MINUTES });
    if (!today) continue;
    const period = periodFor(kind, today);
    const { rows: [sent] } = await db.query(
      `SELECT id FROM report_runs WHERE kind = $1 AND period_from = $2 AND status = 'sent' AND sent_via <> 'log' LIMIT 1`, [kind, period.from]);
    if (sent) continue;
    const { rows: [last] } = await db.query(
      `SELECT status, error, triggered_by, created_at FROM report_runs WHERE kind = $1 AND period_from = $2 ORDER BY created_at DESC, id DESC LIMIT 1`, [kind, period.from]);
    const detail = last
      ? `The last attempt (${last.triggered_by}) was ${last.status}${last.error ? `: ${last.error}` : ''}.`
      : 'Nothing has tried to send it: neither the worker nor the API ran the job. Check that the worker application is running on the current image.';
    await raiseAlert('mis', `${REPORT_TITLE[kind]} for ${period.from} was not sent`, detail, { every: 'day' }).catch(() => {});
    out.push({ kind, period, last: last?.status ?? null });
  }
  return out;
}

/** When the worker last wrote a job_runs row: ops.watch records every run, every 15 minutes. */
export async function workerLastSeen(db = { query }) {
  const { rows: [r] } = await db.query(`SELECT max(started_at) AS at FROM job_runs WHERE started_by = 'schedule'`);
  return r.at ? new Date(r.at) : null;
}

/** No job_runs row from the worker for WORKER_SILENT_MINUTES: an alert, once a day. */
export async function checkWorker({ now = new Date(), db = { query } } = {}) {
  const seen = await workerLastSeen(db);
  if (seen && now - seen < WORKER_SILENT_MINUTES * 60_000) return { ok: true, last_seen: seen };
  await raiseAlert('worker', 'The worker is not running its scheduled jobs',
    `No scheduled job has run since ${seen ? seen.toISOString() : 'ever'}. The Daily Sales Briefing is sent by the API's catch-up instead, ${CATCH_UP_MINUTES} minutes late, but follow-ups, reminders and the other jobs wait for the worker. Start it (node server/src/worker.js) from the current image with the API's environment.`,
    { every: 'day' }).catch(() => {});
  return { ok: false, last_seen: seen };
}

/** One sweep of the API's timer. Never throws. */
export async function reportScheduleTick({ now = new Date(), log = console, watchWorker = config.nodeEnv === 'production' } = {}) {
  try {
    const caught = await catchUpReports({ now, log });
    const missed = await checkMissedReports({ now });
    const worker = watchWorker ? await checkWorker({ now }) : null;
    return { caught, missed, worker };
  } catch (err) {
    log.error?.(`[reports] schedule check failed: ${err.message}`);
    return { error: err.message };
  }
}

/** The API's timer. Off in tests and on staging, as autoSync is. */
export function startReportSchedule({ minutes = 5, log = console } = {}) {
  if (config.nodeEnv === 'test' || isStaging()) return () => {};
  const tick = () => { reportScheduleTick({ log }); };
  const first = setTimeout(tick, 60_000);
  const timer = setInterval(tick, minutes * 60_000);
  first.unref();
  timer.unref();
  log.info?.(`[reports] the API checks every ${minutes} min that the scheduled reports went`);
  return () => { clearTimeout(first); clearInterval(timer); };
}

// ---------------------------------------------------------------------
// What the Scheduled reports page shows
// ---------------------------------------------------------------------

/**
 * Per report: on or off, the next run, whether the worker registered the
 * job (pgboss.schedule), the job's last run and the last scheduled report
 * run; and the worker's last sign of life. Warnings in plain words.
 */
export async function scheduleStatus({ now = new Date(), db = { query } } = {}) {
  const settings = await misSettings(db);
  const { rows: [pg] } = await db.query(`SELECT to_regclass('pgboss.schedule') IS NOT NULL AS present`);
  const registered = new Map();
  if (pg.present) {
    const { rows } = await db.query(`SELECT name, cron, timezone FROM pgboss.schedule WHERE name LIKE 'reports.%'`).catch(() => ({ rows: [] }));
    for (const r of rows) registered.set(r.name, r);
  }
  const seen = await workerLastSeen(db);
  const workerOk = Boolean(seen && now - seen < WORKER_SILENT_MINUTES * 60_000);
  const reports = [];
  for (const kind of KINDS) {
    const { job, cron } = REPORT_JOBS[kind];
    const enabled = enabledFor(kind, settings);
    const [{ rows: [lastJob] }, { rows: [lastRun] }] = await Promise.all([
      db.query(`SELECT started_by, started_at, status, result, error FROM job_runs WHERE name = $1 ORDER BY started_at DESC, id DESC LIMIT 1`, [job]),
      db.query(`SELECT id, period_from, status, sent_via, error, created_at FROM report_runs WHERE kind = $1 AND triggered_by = 'schedule' ORDER BY created_at DESC, id DESC LIMIT 1`, [kind]),
    ]);
    const warnings = [];
    if (!enabled && settings.to.length) warnings.push('Switched off, so the schedule does not send it, though recipients are set. Send now still works.');
    if (enabled && !settings.to.length) warnings.push('Switched on, but no recipients are set: each scheduled run will fail.');
    if (pg.present && !registered.has(job)) warnings.push('The worker has not registered this job: it is running an image from before the reports, or has not started. The API sends it as a catch-up instead.');
    reports.push({
      kind, job, cron, enabled, timezone: config.businessTimeZone,
      next_run: nextRun(cron, now)?.toISOString() ?? null,
      catch_up_minutes: CATCH_UP_MINUTES,
      registered: pg.present ? registered.has(job) : null,
      last_job: lastJob || null, last_scheduled_run: lastRun || null, warnings,
    });
  }
  return {
    worker: { seen: Boolean(pg.present), last_seen: seen?.toISOString() ?? null, ok: workerOk },
    reports,
  };
}
