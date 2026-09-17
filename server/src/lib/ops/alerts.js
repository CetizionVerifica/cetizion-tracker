/**
 * Alerts that matter (#38): a failed job or backup, a burst of failed
 * sign-ins, a certificate about to expire, a disk filling up. Each goes to
 * the notification centre, to the alert email, and to error tracking, at
 * most once an hour per kind and subject.
 */
import fs from 'node:fs/promises';
import tls from 'node:tls';
import { query } from '../../db.js';
import { sendMail } from '../mail.js';
import { notify } from '../notify.js';
import { reportError } from './errors.js';
import { alertsRaised } from './metrics.js';

export async function raiseAlert(kind, subject, detail = '', { level = 'error' } = {}) {
  const hour = new Date().toISOString().slice(0, 13);
  const n = await notify({ kind: 'alert', title: `Alert: ${subject}`, body: String(detail).slice(0, 500), link: '/emails', dedupeKey: `alert:${kind}:${subject}:${hour}` }).catch(() => null);
  if (!n) return false; // already raised this hour
  alertsRaised.inc({ kind });
  const { rows: [s] } = await query(`SELECT value FROM settings WHERE key = 'alert_email'`).catch(() => ({ rows: [] }));
  const to = (s?.value || process.env.ALERT_EMAIL || '').trim();
  if (to) {
    await sendMail({ to, subject: `[Tracker alert] ${subject}`, text: `${subject}\n\n${detail}\n\n${process.env.APP_ENV || process.env.NODE_ENV || ''} · ${new Date().toISOString()}`, html: `<p><strong>${subject}</strong></p><pre>${String(detail).replace(/</g, '&lt;')}</pre>`, template: 'alert', entity: 'ops', entityId: kind, sentBy: 'system' }).catch(() => {});
  }
  await reportError(new Error(`${subject}${detail ? `: ${String(detail).slice(0, 200)}` : ''}`), { source: 'alert', level, tags: { alert: kind } });
  return true;
}

/** Days until a host's TLS certificate expires. */
export function certificateDaysLeft(host, port = 443) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, servername: host, timeout: 10_000 }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      if (!cert?.valid_to) return reject(new Error('No certificate'));
      resolve(Math.floor((new Date(cert.valid_to) - Date.now()) / 864e5));
    });
    socket.on('error', reject);
    socket.on('timeout', () => { socket.destroy(); reject(new Error('Timed out')); });
  });
}

/** The quarter-hourly watch: certificate, disk, backups, stuck jobs. */
export async function runOpsWatch() {
  const out = {};
  const { rows } = await query(`SELECT key, value FROM settings WHERE key IN ('public_app_url','backup_max_age_hours','backup_verify_max_age_days')`);
  const set = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  if (set.public_app_url) {
    try {
      const host = new URL(set.public_app_url).hostname;
      out.certificate_days_left = await certificateDaysLeft(host);
      if (out.certificate_days_left < 14) await raiseAlert('certificate', `TLS certificate for ${host} expires in ${out.certificate_days_left} days`);
    } catch (err) { out.certificate = `not checked: ${err.message}`; }
  }
  try {
    const st = await fs.statfs(process.env.DISK_WATCH_PATH || '/');
    out.disk_used_percent = Math.round(100 * (1 - st.bavail / st.blocks));
    if (out.disk_used_percent > 80) await raiseAlert('disk', `Disk ${out.disk_used_percent}% full`, `Path ${process.env.DISK_WATCH_PATH || '/'}`);
  } catch (err) { out.disk = `not checked: ${err.message}`; }
  const { rows: [b] } = await query(`SELECT to_regclass('backup_runs') IS NOT NULL AS present`);
  if (b.present) {
    const { rows: [last] } = await query(`SELECT MAX(finished_at) FILTER (WHERE kind = 'backup' AND ok) AS backup, MAX(finished_at) FILTER (WHERE kind = 'verify' AND ok) AS verify FROM backup_runs`);
    const maxHours = Number(set.backup_max_age_hours || 8);
    const maxDays = Number(set.backup_verify_max_age_days || 8);
    out.last_backup = last.backup; out.last_verify = last.verify;
    const { rows: failed } = await query(`SELECT kind, error, finished_at FROM backup_runs WHERE NOT ok AND finished_at > now() - interval '1 day' ORDER BY finished_at DESC LIMIT 3`);
    for (const f of failed) await raiseAlert(`backup_${f.kind}_failed`, f.kind === 'verify' ? 'The backup restore check failed' : 'A database backup failed', `${f.error || 'no detail'} (${f.finished_at})`);
    if (!last.backup || Date.now() - new Date(last.backup) > maxHours * 3600e3) await raiseAlert('backup', 'No successful database backup recorded recently', `Last: ${last.backup || 'never'}; expected every ${maxHours} hours`);
    if (!last.verify || Date.now() - new Date(last.verify) > maxDays * 864e5) await raiseAlert('backup_verify', 'The backup restore check has not passed recently', `Last passed: ${last.verify || 'never'}`, { level: 'warning' });
  }
  const { rows: stuck } = await query(`SELECT name, started_at FROM job_runs WHERE status = 'running' AND started_at < now() - interval '1 hour'`);
  for (const j of stuck) await raiseAlert('job_stuck', `Job ${j.name} has been running for over an hour`, `Started ${j.started_at}`);
  out.stuck_jobs = stuck.length;
  return out;
}
