/**
 * Visit scheduling rules (#42): which days a visit covers, clashes, and
 * how loaded each person is in a month.
 */
import { query } from '../db.js';
import { businessToday } from './businessDate.js';
import { config } from '../config.js';
import { sendMail } from './mail.js';
import { notify } from './notify.js';

const TZ = config.businessTimeZone;
const localDay = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(d));

/** Calendar days (business time zone) a visit touches. */
export function visitDays(startsAt, endsAt) {
  const out = [];
  let day = localDay(startsAt);
  const last = localDay(endsAt);
  for (let i = 0; i < 366 && day <= last; i += 1) {
    out.push(day);
    const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1);
    day = d.toISOString().slice(0, 10);
  }
  return out;
}

/** ISO weekday of a YYYY-MM-DD, Monday = 1. */
export const isoWeekday = (day) => ((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;

/**
 * What stands in the way of booking these people for these times.
 * Returns [{ staff_id, name, kind: 'visit'|'leave'|'day_off', detail }].
 */
export async function findConflicts({ staffIds, startsAt, endsAt, excludeVisitId = null }, db = { query }) {
  if (!staffIds?.length) return [];
  const conflicts = [];
  const { rows: people } = await db.query('SELECT id, name, working_days FROM staff WHERE id = ANY($1)', [staffIds]);
  const { rows: clashes } = await db.query(
    `SELECT va.staff_id, v.id, v.title, v.starts_at, v.ends_at, v.project_id
       FROM visit_assignees va JOIN visits v ON v.id = va.visit_id
      WHERE va.staff_id = ANY($1) AND v.status NOT IN ('cancelled','rescheduled')
        AND v.starts_at < $3 AND v.ends_at > $2 AND ($4::int IS NULL OR v.id <> $4)`,
    [staffIds, startsAt, endsAt, excludeVisitId]);
  const { rows: leave } = await db.query(
    `SELECT staff_id, starts_on, ends_on, reason FROM staff_leave
      WHERE staff_id = ANY($1) AND starts_on <= ($3::timestamptz AT TIME ZONE '${TZ}')::date AND ends_on >= ($2::timestamptz AT TIME ZONE '${TZ}')::date`,
    [staffIds, startsAt, endsAt]);
  const days = visitDays(startsAt, endsAt);
  for (const p of people) {
    for (const c of clashes.filter((x) => x.staff_id === p.id)) {
      conflicts.push({ staff_id: p.id, name: p.name, kind: 'visit', visit_id: c.id, detail: `already on "${c.title}"${c.project_id ? ` (${c.project_id})` : ''}, ${localDay(c.starts_at)} to ${localDay(c.ends_at)}` });
    }
    for (const l of leave.filter((x) => x.staff_id === p.id)) {
      conflicts.push({ staff_id: p.id, name: p.name, kind: 'leave', detail: `on leave ${l.starts_on} to ${l.ends_on}${l.reason ? ` (${l.reason})` : ''}` });
    }
    const off = days.filter((d) => !p.working_days.includes(isoWeekday(d)));
    if (off.length) conflicts.push({ staff_id: p.id, name: p.name, kind: 'day_off', detail: `does not work on ${off.join(', ')}` });
  }
  return conflicts;
}

/** Working days, leave days and visit days per person for a month. */
export async function capacity(month, db = { query }) {
  const first = `${month}-01`;
  const end = new Date(`${first}T00:00:00Z`); end.setUTCMonth(end.getUTCMonth() + 1); end.setUTCDate(0);
  const last = end.toISOString().slice(0, 10);
  const monthDays = visitDays(`${first}T12:00:00Z`, `${last}T12:00:00Z`);
  const { rows: people } = await db.query('SELECT id, name, working_days FROM staff WHERE active ORDER BY name');
  const { rows: leave } = await db.query('SELECT staff_id, starts_on, ends_on FROM staff_leave WHERE starts_on <= $2 AND ends_on >= $1', [first, last]);
  const { rows: visits } = await db.query(
    `SELECT va.staff_id, v.id, v.starts_at, v.ends_at, v.status FROM visit_assignees va JOIN visits v ON v.id = va.visit_id
      WHERE v.status NOT IN ('cancelled','rescheduled') AND v.starts_at < ($2::date + 1) AND v.ends_at >= $1::date`, [first, last]);
  return people.map((p) => {
    const working = monthDays.filter((d) => p.working_days.includes(isoWeekday(d)));
    const onLeave = new Set();
    for (const l of leave.filter((x) => x.staff_id === p.id)) for (const d of working) if (d >= String(l.starts_on) && d <= String(l.ends_on)) onLeave.add(d);
    const busy = new Set();
    const mine = visits.filter((v) => v.staff_id === p.id);
    for (const v of mine) for (const d of visitDays(v.starts_at, v.ends_at)) if (d >= first && d <= last) busy.add(d);
    const available = working.length - onLeave.size;
    return {
      staff_id: p.id, name: p.name, working_days: working.length, leave_days: onLeave.size, available_days: available,
      visit_days: busy.size, visits: mine.length, load_percent: available > 0 ? Math.round((100 * busy.size) / available) : null,
    };
  });
}

/** Daily: remind the team (and the client, if chosen) before a visit. */
export async function runVisitReminders({ today = businessToday() } = {}) {
  const { rows: [{ value }] } = await query(`SELECT COALESCE((SELECT value FROM settings WHERE key = 'visit_reminder_days'), '1') AS value`);
  const ahead = Math.max(0, Number(value) || 1);
  const { rows } = await query(
    `SELECT v.*, p.client_name, ct.name AS contact_name, ct.email AS contact_email, ct.do_not_contact,
            (SELECT json_agg(json_build_object('name', s.name, 'email', s.email, 'role', va.role)) FROM visit_assignees va JOIN staff s ON s.id = va.staff_id WHERE va.visit_id = v.id) AS team
       FROM visits v LEFT JOIN projects p ON p.project_id = v.project_id LEFT JOIN contacts ct ON ct.id = v.contact_id
      WHERE v.status IN ('planned','confirmed') AND v.reminder_sent_at IS NULL
        AND (v.starts_at AT TIME ZONE '${TZ}')::date BETWEEN $1::date AND $1::date + $2::int`, [today, ahead]);
  const sent = [];
  for (const v of rows) {
    const when = `${localDay(v.starts_at)}${v.all_day ? '' : ` ${new Date(v.starts_at).toLocaleTimeString('en-IN', { timeZone: TZ, hour: '2-digit', minute: '2-digit' })}`}`;
    const where = [v.location, v.city].filter(Boolean).join(', ') || 'the site';
    const team = v.team || [];
    const subject = `Visit on ${when}: ${v.title}${v.client_name ? ` at ${v.client_name}` : ''}`;
    const text = `${v.title}\nWhen: ${when}${localDay(v.ends_at) !== localDay(v.starts_at) ? ` to ${localDay(v.ends_at)}` : ''}\nWhere: ${where}\nTeam: ${team.map((t) => `${t.name}${t.role === 'lead' ? ' (lead)' : ''}`).join(', ') || 'not assigned'}\n${v.notes ? `\n${v.notes}\n` : ''}`;
    const to = team.map((t) => t.email).filter(Boolean);
    if (to.length) await sendMail({ to: to.join(', '), subject, text, html: `<pre style="font:13px system-ui">${text.replace(/</g, '&lt;')}</pre>`, template: 'visit_reminder', entity: 'project', entityId: v.project_id, sentBy: 'schedule' });
    if (v.notify_client && v.contact_email && !v.do_not_contact) {
      const clientText = `Dear ${v.contact_name || 'Sir/Madam'},\n\nThis is to confirm our ${v.type.replace('_', ' ')} visit on ${when} at ${where}. Our team: ${team.map((t) => t.name).join(', ') || 'to be confirmed'}.\n\nRegards,\nCetizion Verifica`;
      await sendMail({ to: v.contact_email, subject: `Our visit on ${when}`, text: clientText, html: `<p>${clientText.replace(/</g, '&lt;').replace(/\n/g, '<br>')}</p>`, template: 'visit_client_reminder', entity: 'company', entityId: String(v.company_id), sentBy: 'schedule' });
    }
    await notify({ kind: 'visit', title: `Visit ${when}: ${v.title}`, body: `${v.client_name || ''} · ${team.map((t) => t.name).join(', ') || 'nobody assigned'}`, entity: 'project', entityId: v.project_id, link: `/schedule?visit=${v.id}`, dedupeKey: `visit:${v.id}:${localDay(v.starts_at)}` });
    await query('UPDATE visits SET reminder_sent_at = now() WHERE id = $1', [v.id]);
    sent.push(v.id);
  }
  return { today, reminded: sent };
}
