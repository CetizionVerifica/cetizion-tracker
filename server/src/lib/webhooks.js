/**
 * Outgoing webhooks (#49): fan events out to endpoints, deliver them
 * signed, retry with back-off for about a day, keep the history.
 *
 * Signature: header X-Cetizion-Signature = "t=<unix seconds>,v1=<hex>",
 * where hex = HMAC-SHA256(secret, "<t>.<raw body>"). Receivers should
 * reject a timestamp older than five minutes.
 */
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { query } from '../db.js';
import { config } from '../config.js';
import { isStaging } from './ops/environment.js';

export const EVENT_TYPES = [
  'enquiry.created', 'quotation.sent', 'quotation.stage_changed', 'quotation.won', 'quotation.lost',
  'po.received', 'project.delivered', 'invoice.issued', 'invoice.overdue', 'payment.received',
  'visit.scheduled', 'renewal.opened', 'task.overdue', 'follow_up.escalated',
  // From the travel importer (#196 §7).
  'trip.created', 'vendor_invoice.created',
];

// Minutes to wait after each failed attempt: about 22 hours in all.
export const BACKOFF_MINUTES = [1, 5, 15, 60, 180, 360, 720];

const PERSONAL = /(^|_)(contact_person|contact_name|email|phone|mobile|whatsapp|employee_name|sales_person|owner|assignee|accepted_by_name)$/;

/** Drop people's names and contact details unless the endpoint may have them. */
export function stripPersonal(data) {
  if (Array.isArray(data)) return data.map(stripPersonal);
  if (!data || typeof data !== 'object') return data;
  return Object.fromEntries(Object.entries(data).filter(([k]) => !PERSONAL.test(k)).map(([k, v]) => [k, stripPersonal(v)]));
}

export function sign(secret, timestamp, body) {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export function verify(secret, header, body, { toleranceSeconds = 300, now = Date.now() } = {}) {
  const parts = Object.fromEntries(String(header || '').split(',').map((p) => p.split('=')));
  if (!parts.t || !parts.v1) return false;
  if (Math.abs(now / 1000 - Number(parts.t)) > toleranceSeconds) return false;
  const expected = sign(secret, parts.t, body);
  return expected.length === parts.v1.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1));
}

export const newSecret = () => `whsec_${crypto.randomBytes(24).toString('base64url')}`;

/** Emit from application code (events the database cannot see). */
export async function emit(event, { entity = null, entityId = null, value = null, companyId = null, data = {} } = {}, db = { query }) {
  await db.query('SELECT webhook_emit($1,$2,$3,$4,$5,$6)', [event, entity, entityId === null ? null : String(entityId), value, companyId, JSON.stringify(data)]);
}

/** New events become deliveries for every endpoint that wants them. */
export async function fanOut(db = { query }) {
  const { rows: events } = await db.query(
    `SELECT e.*, c.sector FROM webhook_events e LEFT JOIN companies c ON c.id = e.company_id
      WHERE e.dispatched_at IS NULL ORDER BY e.id LIMIT 500`);
  if (!events.length) return 0;
  const { rows: endpoints } = await db.query('SELECT * FROM webhook_endpoints');
  let created = 0;
  for (const e of events) {
    for (const ep of endpoints) {
      if (!ep.events.includes(e.event)) continue;
      if (!ep.active && ep.when_inactive === 'drop') continue;
      if (ep.min_value != null && (e.value == null || Number(e.value) < Number(ep.min_value))) continue;
      if (ep.sector && (e.sector || '').toLowerCase() !== ep.sector.toLowerCase()) continue;
      const { rowCount } = await db.query(
        `INSERT INTO webhook_deliveries (endpoint_id, event_id, idempotency_key, status)
         VALUES ($1, $2, $3, $4) ON CONFLICT (endpoint_id, event_id) DO NOTHING`,
        [ep.id, e.id, `evt_${e.id}_ep_${ep.id}`, ep.active ? 'pending' : 'held']);
      created += rowCount;
    }
    await db.query('UPDATE webhook_events SET dispatched_at = now() WHERE id = $1', [e.id]);
  }
  return created;
}

function payloadFor(delivery, event, endpoint) {
  const data = endpoint.include_personal_data ? event.data : stripPersonal(event.data);
  return JSON.stringify({ id: delivery.idempotency_key, event: event.event, occurred_at: event.occurred_at, entity: event.entity, entity_id: event.entity_id, data });
}

/**
 * Addresses a webhook may never be sent to: this machine, the private
 * network it sits on, the link-local range the cloud platforms put their
 * metadata on, and the ranges reserved for documentation and multicast.
 * Anything that is not an address at all is refused as well.
 */
export function isPrivateAddress(ip) {
  const version = net.isIP(ip);
  if (version === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true;          // this host, private, loopback
    if (a === 169 && b === 254) return true;                    // link local, incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;           // private
    if (a === 192 && b === 168) return true;                    // private
    if (a === 100 && b >= 64 && b <= 127) return true;          // carrier NAT
    if (a === 192 && (b === 0 || b === 2)) return true;         // protocol assignments, documentation
    if (a === 198 && (b === 18 || b === 19 || b === 51)) return true;
    if (a === 203 && b === 0) return true;                      // documentation
    if (a >= 224) return true;                                  // multicast and reserved
    return false;
  }
  if (version !== 6) return true;
  const s = ip.toLowerCase().split('%')[0];
  if (s === '::1' || s === '::') return true;
  const mapped = /^(?:::ffff:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (mapped) return isPrivateAddress(mapped[1]);
  if (/^f[cd]/.test(s)) return true;                            // unique local
  if (/^fe[89ab]/.test(s)) return true;                         // link local
  if (/^ff/.test(s)) return true;                               // multicast
  return false;
}

/**
 * Where a delivery is allowed to go. Returns null when it may proceed, or
 * the reason to record against the delivery.
 *
 * The scheme check on its own was not enough: loopback, the private ranges
 * and a bare container hostname were all accepted, and the response status
 * and first 2 KB of the body come back through the deliveries API — so an
 * endpoint was a readable probe of everything the container can reach.
 * The host is resolved and the ADDRESS is judged, not the name, because a
 * name anyone can register may point wherever they like.
 */
export async function checkDestination(url, { resolve = (host) => dns.lookup(host, { all: true, verbatim: true }), requireResolvable = true } = {}) {
  let u;
  try { u = new URL(url); } catch { return 'The endpoint URL is not a valid address'; }
  const httpAllowed = config.nodeEnv !== 'production' && u.protocol === 'http:';
  if (u.protocol !== 'https:' && !httpAllowed) return 'The endpoint URL must use https';
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return isPrivateAddress(host) ? `${host} is a private address` : null;
  if (!host.includes('.') || /\.(local|internal|localdomain|home|lan)$/i.test(host)) {
    return `${host} is not a public host name`;                 // container and service names
  }
  let addresses;
  // A name that does not resolve is refused at delivery but allowed when an
  // endpoint is saved: a receiver can be configured before it exists, and
  // the delivery checks again anyway.
  try { addresses = await resolve(host); } catch { return requireResolvable ? `${host} does not resolve` : null; }
  if (!addresses.length) return requireResolvable ? `${host} does not resolve` : null;
  const blocked = addresses.find((a) => isPrivateAddress(a.address));
  if (blocked) return `${host} resolves to ${blocked.address}, which is on a private network`;
  return null;
}

export async function deliverOne(deliveryId, { fetchImpl = fetch } = {}) {
  const { rows: [d] } = await query(
    `SELECT d.*, row_to_json(e) AS ev, row_to_json(ep) AS ep FROM webhook_deliveries d
       JOIN webhook_events e ON e.id = d.event_id JOIN webhook_endpoints ep ON ep.id = d.endpoint_id WHERE d.id = $1`, [deliveryId]);
  if (!d) return null;
  if (isStaging()) return { id: d.id, status: 'held', error: 'staging: webhooks are off' };
  if (!d.ep.active) {
    await query(`UPDATE webhook_deliveries SET status = 'held' WHERE id = $1 AND status = 'pending'`, [d.id]);
    return { id: d.id, status: 'held' };
  }
  const body = payloadFor(d, d.ev, d.ep);
  const t = Math.floor(Date.now() / 1000);
  let code = null; let text = null; let error = null;
  const refused = await checkDestination(d.ep.url);
  if (refused) error = refused;
  else {
    try {
      const r = await fetchImpl(d.ep.url, {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10_000),
        headers: {
          'Content-Type': 'application/json', 'User-Agent': 'Cetizion-Tracker-Webhooks/1',
          'X-Cetizion-Event': d.ev.event, 'X-Cetizion-Delivery': d.idempotency_key, 'Idempotency-Key': d.idempotency_key,
          'X-Cetizion-Signature': `t=${t},v1=${sign(d.ep.secret, t, body)}`,
        },
        body,
      });
      code = r.status;
      text = (await r.text().catch(() => '')).slice(0, 2000);
    } catch (err) { error = err.name === 'TimeoutError' ? 'Timed out after 10 seconds' : err.message; }
  }
  const ok = code !== null && code >= 200 && code < 300;
  const attempts = d.attempts + 1;
  const wait = BACKOFF_MINUTES[attempts - 1];
  const status = ok ? 'succeeded' : wait === undefined ? 'failed' : 'pending';
  await query(
    `UPDATE webhook_deliveries SET attempts = $2, status = $3, last_status_code = $4, last_response = $5, last_error = $6,
            delivered_at = CASE WHEN $3 = 'succeeded' THEN now() ELSE delivered_at END,
            next_attempt_at = now() + make_interval(mins => $7)
      WHERE id = $1`, [d.id, attempts, status, code, text, error, wait ?? 0]);
  return { id: d.id, status, code, error };
}

/** The worker's loop body: fan out, then send what is due. */
export async function runWebhooks({ limit = 50 } = {}) {
  if (isStaging()) return { fanned: 0, delivered: 0, retrying: 0, failed: 0, skipped: 'staging' };
  const fanned = await fanOut();
  const { rows } = await query(`SELECT id FROM webhook_deliveries WHERE status = 'pending' AND next_attempt_at <= now() ORDER BY next_attempt_at LIMIT $1`, [limit]);
  const results = [];
  for (const { id } of rows) results.push(await deliverOne(id));
  return { fanned, delivered: results.filter((r) => r?.status === 'succeeded').length, retrying: results.filter((r) => r?.status === 'pending').length, failed: results.filter((r) => r?.status === 'failed').length };
}

/** Reactivating an endpoint releases what was held for it. */
export async function releaseHeld(endpointId) {
  const { rowCount } = await query(`UPDATE webhook_deliveries SET status = 'pending', next_attempt_at = now() WHERE endpoint_id = $1 AND status = 'held'`, [endpointId]);
  return rowCount;
}
