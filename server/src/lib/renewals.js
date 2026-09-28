/**
 * Renewals for recurring services (#28).
 *
 *   discoverEngagements  a delivered PO whose service renews becomes an
 *                        engagement due one interval after delivery
 *   openRenewals         an engagement inside its lead time gets a draft
 *                        renewal quotation, copied from the original, and a
 *                        task for its owner
 *   settleEngagements    a renewal quotation won closes the engagement as
 *                        renewed; one lost, or long overdue, lapses it
 */
import { query, transaction } from '../db.js';
import { businessToday } from './businessDate.ts';
import { claimNextId } from './sequences.js';

const plusMonths = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); };

export async function discoverEngagements({ db = { query } } = {}) {
  const { rows } = await db.query(`
    SELECT po.po_number, po.project_id, po.actual_delivery_date, pr.company_id, pr.client_name, pr.sales_person,
           s.service AS service_name, sv.id AS service_id, sv.renewal_interval_months,
           q.id AS quotation_id
      FROM purchase_orders po
      JOIN projects pr ON pr.project_id = po.project_id
      JOIN po_services s ON s.po_number = po.po_number
      JOIN services sv ON name_key(sv.name) = name_key(s.service) AND sv.renewal_interval_months IS NOT NULL
      LEFT JOIN quotations q ON q.quotation_no = po.quotation_no
     WHERE po.actual_delivery_date IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM engagements e WHERE e.po_number = po.po_number AND e.service_name = s.service)`);
  const created = [];
  for (const r of rows) {
    const { rows: [{ n: cycle }] } = await db.query('SELECT COUNT(*)::int + 1 AS n FROM engagements WHERE company_id IS NOT DISTINCT FROM $1 AND name_key(service_name) = name_key($2)', [r.company_id, r.service_name]);
    const due = plusMonths(r.actual_delivery_date, r.renewal_interval_months);
    const { rows: [e] } = await db.query(
      `INSERT INTO engagements (company_id, client_name, service_id, service_name, project_id, po_number, quotation_id, cycle, started_on, valid_until, next_due_on, owner)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11) RETURNING id`,
      [r.company_id, r.client_name, r.service_id, r.service_name, r.project_id, r.po_number, r.quotation_id, cycle, r.actual_delivery_date, due, r.sales_person]);
    created.push({ id: e.id, client: r.client_name, service: r.service_name, due });
  }
  return created;
}

/** Open the renewal for one engagement now: a draft quotation copied from the original, and a task. */
export async function openRenewal(engagementId, { today = businessToday(), by = 'system' } = {}) {
  return transaction(async (client) => {
    const { rows: [e] } = await client.query('SELECT * FROM engagements WHERE id = $1 FOR UPDATE', [engagementId]);
    if (!e) throw new Error('engagement not found');
    if (e.status !== 'active') throw new Error(`engagement is ${e.status}`);
    const { rows: [orig] } = e.quotation_id ? await client.query('SELECT * FROM quotations WHERE id = $1', [e.quotation_id]) : { rows: [null] };
    const no = await claimNextId('quotation', client);
    const { rows: [q] } = await client.query(
      `INSERT INTO quotations (quotation_no, client_name, contact_person, service_quoted, sector, sales_person, sales_person_email, quotation_date,
                               quotation_value, currency, status, remarks)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'Draft',$11) RETURNING id, quotation_no`,
      [no, e.client_name, orig?.contact_person ?? null, e.service_name, orig?.sector ?? null, e.owner || orig?.sales_person || null, orig?.sales_person_email ?? null, today,
       orig?.total ?? orig?.quotation_value ?? null, orig?.currency || 'INR',
       `Renewal of ${orig?.quotation_no || e.po_number || 'a previous engagement'} · cycle ${e.cycle + 1} · due ${e.next_due_on}`]);
    if (orig) {
      await client.query(
        `INSERT INTO quotation_lines (quotation_id, service_id, description, qty, unit, rate, discount_percent, gst_rate, sort_order)
         SELECT $1, service_id, description, qty, unit, rate, discount_percent, gst_rate, sort_order FROM quotation_lines WHERE quotation_id = $2`, [q.id, orig.id]);
    }
    await client.query(`UPDATE engagements SET status = 'renewal_open', renewal_quotation_id = $2, renewal_opened_at = now() WHERE id = $1`, [e.id, q.id]);
    await client.query(
      `INSERT INTO tasks (entity, entity_id, title, description, due_at, type, priority, assignee, created_by)
       VALUES ('quotation', $1, $2, $3, $4, 'follow_up', 'high', $5, $6)`,
      [q.quotation_no, `Send renewal quotation to ${e.client_name}`, `${e.service_name} is due on ${e.next_due_on}. The draft copies the last quotation; check the price and send it.`, today, e.owner, by]);
    return { engagement_id: e.id, quotation_no: q.quotation_no, client: e.client_name, service: e.service_name, due: e.next_due_on };
  });
}

export async function openRenewals({ db = { query }, today = businessToday() } = {}) {
  // Inside the lead window, and not long past it. Without the lower bound,
  // an engagement discovered from a delivery two years old is "due" and a
  // quotation is minted for work nobody is renewing.
  const { rows } = await db.query(`
    SELECT e.id FROM engagements e
      LEFT JOIN services sv ON sv.id = e.service_id
     WHERE e.status = 'active'
       AND e.next_due_on - COALESCE(sv.renewal_lead_days, 60) <= $1::date
       AND e.next_due_on + 90 >= $1::date`, [today]);
  const opened = [];
  for (const r of rows) opened.push(await openRenewal(r.id, { today }));
  return opened;
}

export async function settleEngagements({ db = { query }, today = businessToday() } = {}) {
  const { rows: renewed } = await db.query(`
    UPDATE engagements e SET status = 'renewed'
      FROM quotations q WHERE q.id = e.renewal_quotation_id AND e.status = 'renewal_open' AND q.status = 'Won - PO Received'
    RETURNING e.id, e.client_name, e.service_name`);
  const { rows: lapsed } = await db.query(`
    UPDATE engagements e SET status = 'lapsed'
      FROM quotations q WHERE q.id = e.renewal_quotation_id AND e.status = 'renewal_open'
       AND (q.status = 'Lost' OR e.next_due_on + 90 < $1::date)
    RETURNING e.id, e.client_name, e.service_name`, [today]);
  const { rows: lapsedActive } = await db.query(`
    UPDATE engagements SET status = 'lapsed' WHERE status = 'active' AND next_due_on + 90 < $1::date
    RETURNING id, client_name, service_name`, [today]);
  return { renewed, lapsed: [...lapsed, ...lapsedActive] };
}

/**
 * The daily job: settle first, then discover, then open.
 *
 * The order matters on the first run. Discovery back-dates next_due_on from
 * deliveries that may be more than a year old, and opening a renewal mints
 * a real quotation against real numbers. Running open before settle meant
 * the first morning would open renewals for engagements that were already
 * dead, and only then mark them lapsed -- leaving the quotations behind.
 * Settling first retires them before anything is minted for them.
 */
export async function runRenewals({ today = businessToday() } = {}) {
  const settled = await settleEngagements({ today });
  const discovered = await discoverEngagements();
  const opened = await openRenewals({ today });
  return { today, discovered, opened, ...settled };
}

/**
 * Every engagement with its renewal state, and the counts behind the
 * summary cards. Lifted out of the route because the MCP server answers
 * "what is up for renewal?" from the same rows (#140).
 */
export async function renewalsList({ status, company_id: companyId, owner } = {}) {
  const params = []; const where = [];
  if (status) { params.push(String(status).split(',')); where.push(`e.status = ANY($${params.length})`); }
  if (companyId) { params.push(Number(companyId)); where.push(`e.company_id = $${params.length}`); }
  // Whose renewal it is: the engagement's own owner, or failing that the
  // salesperson on the quotation it came from — an engagement is created
  // from a won deal and inherits that relationship. In SQL rather than by
  // filtering rows afterwards, which is the rule everywhere else here.
  if (owner) {
    params.push(owner);
    const p = `$${params.length}`;
    where.push(`(lower(btrim(e.owner)) = lower(btrim(${p})) OR lower(btrim(oq.sales_person)) = lower(btrim(${p})))`);
  }
  const { rows } = await query(`
    SELECT e.*, c.name AS company_name, sv.renewal_lead_days, sv.renewal_interval_months,
           oq.sales_person AS quotation_owner,
           oq.quotation_no AS original_quotation_no, rq.quotation_no AS renewal_quotation_no, rq.status AS renewal_status,
           rq.quotation_value AS renewal_value, rq.currency AS renewal_currency,
           (e.next_due_on - CURRENT_DATE)::int AS days_to_due
      FROM engagements e
      LEFT JOIN companies c ON c.id = e.company_id
      LEFT JOIN services sv ON sv.id = e.service_id
      LEFT JOIN quotations oq ON oq.id = e.quotation_id
      LEFT JOIN quotations rq ON rq.id = e.renewal_quotation_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY CASE e.status WHEN 'renewal_open' THEN 0 WHEN 'active' THEN 1 ELSE 2 END, e.next_due_on`, params);
  const { rows: [totals] } = await query(`
    SELECT COUNT(*) FILTER (WHERE status = 'active')::int AS active,
           COUNT(*) FILTER (WHERE status = 'renewal_open')::int AS open,
           COUNT(*) FILTER (WHERE status = 'active' AND next_due_on <= CURRENT_DATE + 30)::int AS due_30,
           COUNT(*) FILTER (WHERE status = 'active' AND next_due_on <= CURRENT_DATE + 90)::int AS due_90,
           COUNT(*) FILTER (WHERE status = 'renewed')::int AS renewed,
           COUNT(*) FILTER (WHERE status = 'lapsed')::int AS lapsed
      FROM engagements`);
  return { rows, totals };
}
