/**
 * Certificates and deliverables (#43), and how they drive renewals (#28).
 *
 *   syncEngagement(id)         an issued deliverable with an expiry sets its
 *                              engagement's valid_until and next_due_on,
 *                              creating the engagement if there is none;
 *                              a withdrawn one marks the engagement lapsed.
 *   runDeliverableReminders()  expire what has passed; remind the owner at
 *                              the configured days before expiry, with a task.
 */
import { query } from '../db.js';
import { businessToday } from './businessDate.js';
import { notify } from './notify.js';

const OPEN = ['active', 'renewal_open'];

export async function syncEngagement(id, db = { query }) {
  const { rows: [d] } = await db.query('SELECT * FROM deliverables WHERE id = $1', [id]);
  if (!d) return null;
  let e = null;
  if (d.engagement_id) {
    ({ rows: [e] } = await db.query('SELECT * FROM engagements WHERE id = $1', [d.engagement_id]));
  }
  if (!e && d.po_number && d.service_name) {
    ({ rows: [e] } = await db.query('SELECT * FROM engagements WHERE po_number = $1 AND name_key(service_name) = name_key($2) ORDER BY id DESC LIMIT 1', [d.po_number, d.service_name]));
  }
  if (!e && d.company_id && d.service_name) {
    ({ rows: [e] } = await db.query(`SELECT * FROM engagements WHERE company_id = $1 AND name_key(service_name) = name_key($2) AND status = ANY($3) ORDER BY next_due_on DESC LIMIT 1`, [d.company_id, d.service_name, OPEN]));
  }

  if (d.status === 'withdrawn') {
    if (e && OPEN.includes(e.status)) await db.query(`UPDATE engagements SET status = 'lapsed', notes = concat_ws(E'\\n', notes, $2::text) WHERE id = $1`, [e.id, `Lapsed: ${d.type} ${d.reference || d.title} withdrawn`]);
    return e?.id ?? null;
  }
  if (d.status !== 'issued' || !d.valid_until) return e?.id ?? null;

  if (e) {
    if (OPEN.includes(e.status)) {
      await db.query('UPDATE engagements SET valid_until = $2, next_due_on = $2, started_on = COALESCE(started_on, $3) WHERE id = $1', [e.id, d.valid_until, d.valid_from || d.issued_on]);
    }
  } else {
    const { rows: [{ n: cycle }] } = await db.query('SELECT COUNT(*)::int + 1 AS n FROM engagements WHERE company_id IS NOT DISTINCT FROM $1 AND name_key(service_name) = name_key($2)', [d.company_id, d.service_name || d.title]);
    const { rows: [q] } = d.po_number ? await db.query('SELECT q.id FROM purchase_orders po JOIN quotations q ON q.quotation_no = po.quotation_no WHERE po.po_number = $1', [d.po_number]) : { rows: [] };
    ({ rows: [e] } = await db.query(
      `INSERT INTO engagements (company_id, client_name, service_id, service_name, project_id, po_number, quotation_id, cycle, started_on, valid_until, next_due_on, owner, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11,$12)
       ON CONFLICT (po_number, service_name) WHERE po_number IS NOT NULL DO UPDATE SET valid_until = EXCLUDED.valid_until, next_due_on = EXCLUDED.next_due_on
       RETURNING *`,
      [d.company_id, d.client_name, d.service_id, d.service_name || d.title, d.project_id, d.po_number, q?.id ?? null, cycle, d.valid_from || d.issued_on, d.valid_until, d.owner, `From ${d.type} ${d.reference || d.title}`]));
  }
  if (e && d.engagement_id !== e.id) await db.query('UPDATE deliverables SET engagement_id = $2 WHERE id = $1', [d.id, e.id]);
  return e?.id ?? null;
}

export async function runDeliverableReminders({ today = businessToday(), db = { query } } = {}) {
  const { rowCount: expired } = await db.query(`UPDATE deliverables SET status = 'expired' WHERE status = 'issued' AND valid_until < $1::date`, [today]);
  const { rows: [{ value }] } = await db.query(`SELECT COALESCE((SELECT value FROM settings WHERE key = 'deliverable_reminder_days'), '120,90,30') AS value`);
  const levels = String(value).split(',').map((n) => Number(n.trim())).filter((n) => n > 0).sort((a, b) => b - a);
  const { rows } = await db.query(
    `SELECT d.*, (d.valid_until - $1::date) AS days_left, p.sales_person
       FROM deliverables d LEFT JOIN projects p ON p.project_id = d.project_id
      WHERE d.status = 'issued' AND d.valid_until IS NOT NULL AND d.valid_until >= $1::date`, [today]);
  const reminded = [];
  for (const d of rows) {
    // The deepest level already due; an item first seen at 20 days left gets one reminder, not three.
    let level = d.reminder_level;
    while (level < levels.length && d.days_left <= levels[level]) level += 1;
    if (level === d.reminder_level) continue;
    const owner = d.owner || d.sales_person || null;
    const label = `${d.type.replace('_', ' ')} ${d.reference || d.title}`;
    const entity = d.project_id ? 'project' : 'company';
    const entityId = d.project_id || (d.company_id ? String(d.company_id) : null);
    if (entityId) {
      await db.query(`INSERT INTO tasks (entity, entity_id, title, description, due_at, type, priority, assignee, created_by)
                      VALUES ($1,$2,$3,$4,$5,'follow_up',$6,$7,'system')`,
        [entity, entityId, `Renew ${label} for ${d.client_name}`, `Expires on ${d.valid_until} (${d.days_left} days). ${d.engagement_id ? 'The renewal is tracked under Renewals.' : ''}`.trim(), d.valid_until, d.days_left <= 30 ? 'high' : 'normal', owner]);
    }
    await notify({ kind: 'expiring', title: `${d.client_name}: ${label} expires in ${d.days_left} days`, body: `${d.service_name || d.title} · valid until ${d.valid_until}${owner ? ` · ${owner}` : ''}`, entity, entityId, link: '/deliverables?expiring=120', dedupeKey: `deliverable:${d.id}:${level}` }, db);
    await db.query('UPDATE deliverables SET reminder_level = $2 WHERE id = $1', [d.id, level]);
    reminded.push({ id: d.id, client: d.client_name, days_left: d.days_left });
  }
  return { today, expired, reminded };
}
