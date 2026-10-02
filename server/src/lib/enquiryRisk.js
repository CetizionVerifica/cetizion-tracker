/**
 * Enquiries at risk (docs/insights-dashboard-plan.md §4.3): which open
 * enquiries need handling before it is too late.
 *
 * Pure: the rows, the activity dates and the settings come in, the reasons
 * come out, so the rule is tested without a database. Nothing is stored
 * (design rule 1); every reason is worked out on each read.
 *
 *   no_reply          nobody has answered, and the enquiry is older than
 *                     `enquiry_reply_days` working days
 *   follow_up_missed  a follow-up date (the enquiry's own, or its next open
 *                     task) has come with nothing logged since; the same
 *                     scheduleState() quotations use
 *   decision_near     the client decides within `enquiry_decision_warn_days`
 *                     working days, or already has, and there is no
 *                     quotation yet
 *   idle              answered once, then quiet for the follow-up idle limit
 *                     (followup_enquiry_idle_days)
 */
import { workingDaysBetween } from './businessDate.ts';
import { DEFAULTS as FOLLOW_UP_DEFAULTS, OPEN_ENQUIRY_STATUSES, dateOf, dueInfo, readSettings, scheduleState } from './followUps.js';

export const RISK_REASONS = Object.freeze(['decision_near', 'no_reply', 'follow_up_missed', 'idle']);

export const RISK_LABELS = Object.freeze({
  decision_near: 'Decision near, no quotation',
  no_reply: 'No reply yet',
  follow_up_missed: 'Follow-up date missed',
  idle: 'Gone quiet',
});

export const RISK_DEFAULTS = Object.freeze({
  enquiry_reply_days: 1,
  enquiry_decision_warn_days: 5,
});

/**
 * The risk settings and the follow-up settings they lean on, as numbers. A
 * blank or nonsense value falls back to its default, as readSettings() does.
 */
export function readRiskSettings(raw = {}) {
  const out = { ...readSettings(raw) };
  for (const [key, fallback] of Object.entries(RISK_DEFAULTS)) {
    const v = String(raw[key] ?? '').trim();
    const n = Number(v);
    out[key] = v !== '' && Number.isInteger(n) && n >= 0 ? n : fallback;
  }
  return out;
}

/**
 * Why an open enquiry is at risk today, or null when it is not.
 *
 *   rec              a loadRecords() enquiry row (status, enquiry_date,
 *                    created_at, next_follow_up_at, next_task_due,
 *                    first_responded_at, expected_decision_date, quotation_no)
 *   lastActivityOn   business date of the latest activity, or null
 *   firstOutboundOn  business date of the first thing we sent or did, or null
 *
 * Returns { reasons: [{ reason, since_on, days_late, days_left? }], days_late,
 * decision_near } where days_late is the worst of the reasons, in working days.
 */
export function enquiryRisk(rec, { lastActivityOn = null, firstOutboundOn = null, today, settings: raw = {}, holidays = [] }) {
  if (!rec || !OPEN_ENQUIRY_STATUSES.includes(rec.status)) return null;
  const settings = typeof raw.enquiry_reply_days === 'number' ? raw : readRiskSettings(raw);
  const reasons = [];
  const start = rec.enquiry_date ?? dateOf(rec.created_at);

  // Answered at all? first_responded_at is kept by the database triggers;
  // the first outbound activity covers what they cannot see.
  const answered = Boolean(rec.first_responded_at || firstOutboundOn);
  if (!answered && start) {
    const waited = workingDaysBetween(start, today, holidays);
    if (waited > settings.enquiry_reply_days) {
      reasons.push({ reason: 'no_reply', since_on: start, days_late: waited - settings.enquiry_reply_days });
    }
  }

  const { missed } = scheduleState({ ...rec, entity: 'enquiry' }, lastActivityOn, today);
  if (missed) reasons.push({ reason: 'follow_up_missed', since_on: missed, days_late: workingDaysBetween(missed, today, holidays) });

  const decision = rec.expected_decision_date;
  if (decision && !rec.quotation_no) {
    const left = decision >= today ? workingDaysBetween(today, decision, holidays) : -workingDaysBetween(decision, today, holidays);
    if (left <= settings.enquiry_decision_warn_days) {
      reasons.push({ reason: 'decision_near', since_on: decision, days_left: left, days_late: Math.max(0, -left) });
    }
  }

  // Never answered is already said by no_reply; "gone quiet" is about an
  // enquiry somebody once picked up. Counting both would put one silent
  // enquiry in two bars for the same silence.
  if (answered) {
    const due = dueInfo({ ...rec, entity: 'enquiry' }, lastActivityOn, {
      today, holidays,
      settings: { ...FOLLOW_UP_DEFAULTS, ...settings },
    });
    if (due?.why === 'idle') reasons.push({ reason: 'idle', since_on: due.since_on, days_late: workingDaysBetween(due.due_on, today, holidays) });
  }

  if (!reasons.length) return null;
  reasons.sort((a, b) => RISK_REASONS.indexOf(a.reason) - RISK_REASONS.indexOf(b.reason));
  return {
    reasons,
    days_late: Math.max(...reasons.map((r) => r.days_late)),
    decision_near: reasons.some((r) => r.reason === 'decision_near'),
  };
}

/**
 * Worst first: a decision coming with no quotation, soonest first; then days
 * late × estimated value in INR (an enquiry with no value counts as ₹1, so
 * days still order it); then days late.
 */
export function compareRisk(a, b) {
  if (a.decision_near !== b.decision_near) return a.decision_near ? -1 : 1;
  if (a.decision_near) {
    const left = (x) => x.reasons.find((r) => r.reason === 'decision_near').days_left;
    if (left(a) !== left(b)) return left(a) - left(b);
  }
  const weight = (x) => (x.days_late + 1) * Math.max(Number(x.value_inr) || 0, 1);
  return weight(b) - weight(a) || b.days_late - a.days_late || String(a.number).localeCompare(String(b.number));
}
