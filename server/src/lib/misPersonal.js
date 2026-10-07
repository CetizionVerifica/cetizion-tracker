/**
 * The facts of one person's day, for their personal daily MIS
 * (/mnt/project-files/plans/mis-report-sender-plan.md §B3, §B4.1).
 *
 * Code gathers; the AI words (misAi.js writePersonal); code checks what the
 * AI wrote against these facts. Nothing here writes a sentence. Every fact
 * carries an id the report must cite:
 *
 *   act:<source>:<id>   something the person did in the tracker
 *   msg:<id>            an email in their mailbox (email_messages.id)
 *   thread_id           a thread of that mail
 *   key                 a pending row waiting on them (misReports pendingRow)
 *   task:<id>, visit:<id>   their day ahead
 *
 * The person's own mailbox is read for their own report only. A body the
 * mailbox does not store (its owner shares less than everything) is read
 * live from the provider, used here and never written back.
 */
import { config } from '../config.js';
import { query } from '../db.js';
import { businessToday } from './businessDate.ts';
import { BULK, BULK_SENDER, PUBLIC_DOMAINS, addr, domainOf, isBlocked, snippet } from './mailbox/rules.js';
import { providerFor, saveTokens } from './mailbox/sync.js';
import { linkFor, misSettings, pendingInvoices, pendingPos, pendingQuotations, threadLink, yesterdayOf } from './misReports.js';

/** Replaceable in tests. */
export const deps = { providerFor };

export const MAX_THREADS = 40;
export const MAX_CHARS = 30_000;
const MESSAGE_CHARS = 1_200;
const NOTE_CHARS = 300;

/** An out-of-office or other automatic reply, by its subject. */
export const AUTO_REPLY = /^\s*(automatic reply|auto(matic)?[- ]?reply|autoreply|out of (the )?office)\b/i;

/** Where a record opens in the app. */
export function recordHref(entity, id) {
  if (!entity || id === null || id === undefined) return null;
  if (entity === 'company') return `/companies/${encodeURIComponent(String(id))}`;
  if (entity === 'payment_stage') return `/collections?stage=${encodeURIComponent(String(id))}`;
  if (['enquiry', 'quotation', 'purchase_order', 'project'].includes(entity)) return linkFor(entity, id);
  return null;
}

/** HH:MM in the business time zone. */
export function timeOf(at) {
  if (!at) return null;
  return new Date(at).toLocaleTimeString('en-GB', { timeZone: config.businessTimeZone, hour: '2-digit', minute: '2-digit', hour12: false });
}

/** "stage:12", "quotation:CTZ/QT/2026/118": the key a pending row and an act share. */
export function touchKey(entity, id) {
  if (!entity || id === null || id === undefined || id === '') return null;
  const prefix = { payment_stage: 'stage', purchase_order: 'purchase_order', quotation: 'quotation', enquiry: 'enquiry', project: 'project', company: 'company' }[entity];
  return prefix ? `${prefix}:${id}` : null;
}

const strip = ({ actor_name: _a, ...rest } = {}) => rest;

/**
 * What the person did in the tracker on `day`, oldest first. Acts by a job
 * or an email reader are nobody's and are not here (recordActs.js).
 */
async function actsOf(db, { user, who, day, tz }) {
  const on = (col) => `(${col} AT TIME ZONE $3)::date = $2::date`;
  const [log, notes, tasksMade, tasksDone, comms, collections, visits, owners] = await Promise.all([
    db.query(
      `SELECT id, created_at AS at, action, entity_type, entity_id, metadata FROM activity_log
        WHERE actor_user_id = $1 AND ${on('created_at')} AND action <> 'job.run'`, [user.id, day, tz]),
    db.query(
      `SELECT id, created_at AS at, entity, entity_id, body FROM notes WHERE lower(btrim(author)) = ANY($1::text[]) AND ${on('created_at')}`, [who, day, tz]),
    db.query(
      `SELECT id, created_at AS at, entity, entity_id, title, due_at, assignee FROM tasks
        WHERE lower(btrim(regexp_replace(created_by, '\\s*\\(via MCP\\)$', '', 'i'))) = ANY($1::text[]) AND ${on('created_at')}`, [who, day, tz]),
    db.query(
      `SELECT id, completed_at AS at, entity, entity_id, title FROM tasks
        WHERE status = 'done' AND lower(btrim(regexp_replace(completed_by, '\\s*\\(via MCP\\)$', '', 'i'))) = ANY($1::text[]) AND ${on('completed_at')}`, [who, day, tz]),
    db.query(
      `SELECT c.id, c.started_at AS at, c.channel, c.direction, c.outcome, c.entity, c.entity_id, c.summary, c.duration_seconds, co.name AS company
         FROM communications c LEFT JOIN companies co ON co.id = c.company_id
        WHERE lower(btrim(c.username)) = ANY($1::text[]) AND ${on('c.started_at')}`, [who, day, tz]),
    db.query(
      `SELECT l.id, l.happened_at AS at, l.channel, l.summary, l.stage_id, l.promise_to_pay_date, ps.po_number, co.name AS company
         FROM collection_log l LEFT JOIN payment_stages ps ON ps.id = l.stage_id LEFT JOIN companies co ON co.id = l.company_id
        WHERE NOT l.automated AND lower(btrim(l.by_whom)) = ANY($1::text[]) AND ${on('l.happened_at')}`, [who, day, tz]),
    db.query(
      `SELECT v.id, v.created_at AS at, v.title, v.type, v.starts_at, v.status, v.po_number, co.name AS company
         FROM visits v LEFT JOIN companies co ON co.id = v.company_id
        WHERE lower(btrim(v.created_by)) = ANY($1::text[]) AND ${on('v.created_at')}`, [who, day, tz]),
    db.query(
      `SELECT id, created_at AS at, entity_type, entity_id, previous_owner_name, new_owner_name, reason FROM ownership_history
        WHERE changed_by_user_id = $1 AND ${on('created_at')}`, [user.id, day, tz]),
  ]);

  const singular = { enquiries: 'enquiry', quotations: 'quotation', projects: 'project' };
  const acts = [
    ...log.rows.map((r) => ({ id: `act:activity_log:${r.id}`, at: r.at, kind: r.action, entity: r.entity_type, entity_id: r.entity_id, detail: strip(r.metadata) })),
    ...notes.rows.map((r) => ({ id: `act:notes:${r.id}`, at: r.at, kind: 'note.added', entity: r.entity, entity_id: r.entity_id, detail: { text: snippet(r.body, NOTE_CHARS) } })),
    ...tasksMade.rows.map((r) => ({ id: `act:task_created:${r.id}`, at: r.at, kind: 'task.created', entity: r.entity, entity_id: r.entity_id, detail: { title: r.title, due: r.due_at, assignee: r.assignee } })),
    ...tasksDone.rows.map((r) => ({ id: `act:task_done:${r.id}`, at: r.at, kind: 'task.completed', entity: r.entity, entity_id: r.entity_id, detail: { title: r.title } })),
    ...comms.rows.map((r) => ({ id: `act:communications:${r.id}`, at: r.at, kind: `${r.channel}.logged`, entity: r.entity, entity_id: r.entity_id, detail: { channel: r.channel, direction: r.direction, outcome: r.outcome, company: r.company, summary: r.summary ? snippet(r.summary, NOTE_CHARS) : null, minutes: r.duration_seconds ? Math.round(r.duration_seconds / 60) : null } })),
    ...collections.rows.map((r) => ({ id: `act:collection_log:${r.id}`, at: r.at, kind: 'collection.followed_up', entity: r.stage_id ? 'payment_stage' : null, entity_id: r.stage_id ? String(r.stage_id) : null, detail: { channel: r.channel, company: r.company, po_number: r.po_number, summary: snippet(r.summary, NOTE_CHARS), promise_to_pay_date: r.promise_to_pay_date } })),
    ...visits.rows.map((r) => ({ id: `act:visits:${r.id}`, at: r.at, kind: 'visit.planned', entity: r.po_number ? 'purchase_order' : null, entity_id: r.po_number, detail: { title: r.title, type: r.type, company: r.company, starts_on: businessToday(new Date(r.starts_at)), status: r.status } })),
    ...owners.rows.map((r) => ({ id: `act:ownership_history:${r.id}`, at: r.at, kind: 'record.reassigned', entity: singular[r.entity_type] || r.entity_type, entity_id: String(r.entity_id), detail: { from: r.previous_owner_name, to: r.new_owner_name, reason: r.reason } })),
  ];
  return acts
    .map((a) => ({ ...a, at: new Date(a.at).toISOString(), time: timeOf(a.at), link: recordHref(a.entity, a.entity_id) }))
    .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}

/**
 * Why a message is left out of the report, or null to keep it: an
 * automatic reply, a robot or bulk sender, mail with nobody outside the
 * company (unless its thread is on a record).
 */
export function leaveOut(m, { mine, internal, blocklist }) {
  if (AUTO_REPLY.test(m.subject || '')) return 'automatic reply';
  const people = [m.from_email, ...(m.to_emails || []), ...(m.cc_emails || [])].map(addr).filter(Boolean);
  const outside = [...new Set(people)].filter((e) => !mine.has(e) && !internal.has(domainOf(e)));
  if (!outside.length) return m.entity ? null : 'internal only';
  if (outside.every((e) => isBlocked(e, blocklist))) return 'blocked or automatic sender';
  if (m.direction === 'inbound' && (BULK_SENDER.test(m.from_email || '') || BULK.test(m.body_html || ''))) return 'bulk mail';
  return null;
}

/**
 * The person's mail on `day`: everything in their own personal mailboxes,
 * and what they sent from the tracker through a shared one. One email in
 * two mailboxes is one message.
 */
async function mailOf(db, { user, who, day, tz, live }) {
  const { rows: s } = await db.query(`SELECT key, value FROM settings WHERE key = 'internal_email_domains'`);
  const internal = new Set(String(s[0]?.value || '').split(',').map((d) => addr(d)).filter(Boolean));
  // No domains set: the person's own company domain is the company's, unless it is a public one.
  if (!internal.size && domainOf(user.email) && !PUBLIC_DOMAINS.has(domainOf(user.email))) internal.add(domainOf(user.email));
  const blocklist = (await db.query('SELECT pattern FROM email_blocklist')).rows.map((r) => r.pattern);
  const { rows: boxes } = await db.query(
    `SELECT * FROM connected_accounts WHERE user_id = $1 AND NOT is_shared AND status <> 'disconnected' ORDER BY id`, [user.id]);
  const mine = new Set([addr(user.email), ...boxes.map((b) => addr(b.email))].filter(Boolean));

  const { rows } = await db.query(
    `SELECT m.id, m.account_id, m.thread_id, m.provider_id, m.internet_message_id, m.direction, m.from_email, m.from_name,
            m.to_emails, m.cc_emails, m.subject, m.body_html, m.sent_at, m.web_link, m.folder_id, m.sent_from_tracker_by, m.removed_at,
            t.subject AS thread_subject, t.entity, t.entity_id, co.name AS company,
            a.user_id AS owner_id, a.is_shared, a.visibility, a.status AS account_status
       FROM email_messages m
       JOIN email_threads t ON t.id = m.thread_id
       JOIN connected_accounts a ON a.id = m.account_id
       LEFT JOIN companies co ON co.id = COALESCE(m.company_id, t.company_id)
      WHERE (m.sent_at AT TIME ZONE $3)::date = $2::date AND a.status <> 'disconnected'
        AND ((a.user_id = $1 AND NOT a.is_shared)
             OR (m.direction = 'outbound' AND lower(btrim(m.sent_from_tracker_by)) = ANY($4::text[])))
      ORDER BY (a.user_id = $1) DESC, m.sent_at, m.id`, [user.id, day, tz, who]);

  const leftOut = new Map();
  const leave = (why) => leftOut.set(why, (leftOut.get(why) || 0) + 1);
  const seen = new Set();
  const kept = [];
  for (const m of rows) {
    if (m.internet_message_id && seen.has(m.internet_message_id)) continue;
    if (m.internet_message_id) seen.add(m.internet_message_id);
    const why = leaveOut(m, { mine, internal, blocklist });
    if (why) { leave(why); continue; }
    kept.push(m);
  }

  // Threads on a record first, then the newest; at most MAX_THREADS.
  const byThread = new Map();
  for (const m of kept) {
    if (!byThread.has(m.thread_id)) byThread.set(m.thread_id, []);
    byThread.get(m.thread_id).push(m);
  }
  const order = [...byThread.entries()]
    .sort(([, a], [, b]) => Number(Boolean(b[0].entity)) - Number(Boolean(a[0].entity)) || String(b.at(-1).sent_at).localeCompare(String(a.at(-1).sent_at)));
  const chosen = new Set(order.slice(0, MAX_THREADS).map(([id]) => id));
  if (order.length > MAX_THREADS) leftOut.set('over the thread limit', order.length - MAX_THREADS);

  // The text of each message: stored when the mailbox shares everything,
  // else read live from the person's own mailbox, never written back.
  const providers = new Map();
  const providerOf = (accountId) => {
    if (!providers.has(accountId)) {
      const account = boxes.find((b) => b.id === accountId);
      providers.set(accountId, account && account.status === 'active' ? { account, provider: deps.providerFor(account) } : null);
    }
    return providers.get(accountId);
  };
  let chars = 0;
  let unread = 0;
  const messages = [];
  for (const m of kept) {
    if (!chosen.has(m.thread_id) && m.direction !== 'outbound') continue;
    let subject = m.subject;
    let html = m.body_html;
    if (!html && live && m.owner_id === user.id && !m.is_shared && !m.removed_at && chars < MAX_CHARS) {
      try {
        const p = providerOf(m.account_id);
        if (p) {
          const fresh = await p.provider.message(m.provider_id);
          html = fresh.body_html || null;
          subject = subject ?? fresh.subject ?? null;
        }
      } catch {
        unread += 1;
      }
    }
    let text = html ? snippet(html, MESSAGE_CHARS) : null;
    if (text && chars + text.length > MAX_CHARS) { text = null; unread += 1; }
    if (text) chars += text.length;
    messages.push({
      id: `msg:${m.id}`, thread_id: m.thread_id, direction: m.direction, at: new Date(m.sent_at).toISOString(), time: timeOf(m.sent_at),
      from: m.from_name || m.from_email, from_email: m.from_email,
      to: [...(m.to_emails || []), ...(m.cc_emails || [])].filter((e) => !mine.has(addr(e)) && !internal.has(domainOf(e))),
      subject: subject ?? m.thread_subject ?? null, text, company: m.company,
      record: m.entity ? { entity: m.entity, id: m.entity_id } : null,
      from_tracker: Boolean(m.sent_from_tracker_by),
      link: m.web_link || threadLink({ account_id: m.account_id, folder_id: m.folder_id, thread_id: m.thread_id }),
    });
  }
  for (const { account, provider } of [...providers.values()].filter(Boolean)) {
    try { await saveTokens(account, provider); } catch { /* the tokens are refreshed again next time */ }
  }
  if (unread) leftOut.set('text could not be read', unread);

  const threads = order.filter(([id]) => chosen.has(id)).map(([id, ms]) => {
    const own = messages.filter((x) => x.thread_id === id);
    const last = own.at(-1);
    return {
      thread_id: id, subject: ms[0].thread_subject || ms[0].subject, company: ms.find((x) => x.company)?.company || null,
      record: ms[0].entity ? { entity: ms[0].entity, id: ms[0].entity_id } : null,
      link: recordHref(ms[0].entity, ms[0].entity_id) || own[0]?.link || null,
      messages: own.map(({ id: mid, direction, from, to, at, time, text }) => ({ id: mid, direction, from, to, at, time, text })),
      // Who owes the next reply, from the order of the day's messages (§B4.3): never the model's guess.
      waiting_on: last ? (last.direction === 'inbound' ? 'them' : 'client') : null,
    };
  });

  return {
    mailboxes: boxes.map((b) => ({ id: b.id, email: b.email, status: b.status, visibility: b.visibility })),
    sent: messages.filter((x) => x.direction === 'outbound'),
    received: messages.filter((x) => x.direction === 'inbound'),
    threads,
    left_out: [...leftOut.entries()].map(([reason, count]) => ({ reason, count })),
  };
}

/** The overdue rows waiting on the person: their own records, with whether they acted on each yesterday. */
async function waitingOn(db, { user, today, touched, overdueDays }) {
  const rows = (await Promise.all([
    pendingInvoices(db, { today, overdueDays }), pendingPos(db, { today, overdueDays }), pendingQuotations(db, { today, overdueDays }),
  ])).flat();
  const seen = new Set();
  return rows
    .filter((r) => r.overdue && r.owner_user_id === user.id)
    .filter((r) => (seen.has(r.key) ? false : seen.add(r.key)))
    .sort((a, b) => b.score - a.score || b.days - a.days)
    .map((r) => ({
      key: r.key, kind: r.kind, client: r.client, reference: r.reference, days: r.days, since: r.since,
      amount: r.amount, currency: r.currency, amount_inr: r.amount_inr, next_action: r.next_action, link: r.link,
      no_action_yesterday: !(touched.has(r.key) || (r.mail?.entity && touched.has(touchKey(r.mail.entity, r.mail.id)))),
    }));
}

/** Their day ahead: open tasks due by today, and visits starting today. */
async function dayAhead(db, { user, who, today, tz }) {
  const [tasks, visits] = await Promise.all([
    db.query(
      `SELECT id, title, type, entity, entity_id, due_at, priority FROM tasks
        WHERE status <> 'done' AND due_at IS NOT NULL AND due_at <= $2::date AND lower(btrim(assignee)) = ANY($1::text[])
        ORDER BY due_at, id LIMIT 30`, [who, today]),
    db.query(
      `SELECT DISTINCT v.id, v.title, v.type, v.starts_at, v.status, v.city, co.name AS company
         FROM visits v
         LEFT JOIN companies co ON co.id = v.company_id
         LEFT JOIN visit_assignees va ON va.visit_id = v.id
         LEFT JOIN staff st ON st.id = va.staff_id
        WHERE (v.starts_at AT TIME ZONE $3)::date = $2::date AND v.status NOT IN ('cancelled')
          AND (lower(btrim(v.created_by)) = ANY($1::text[]) OR lower(btrim(st.email)) = ANY($1::text[]))
        ORDER BY v.starts_at, v.id`, [who, today, tz]),
  ]);
  return [
    ...tasks.rows.map((t) => ({ ref: `task:${t.id}`, kind: 'task', title: t.title, type: t.type, due: t.due_at, overdue: t.due_at < today, priority: t.priority, link: recordHref(t.entity, t.entity_id) })),
    ...visits.rows.map((v) => ({ ref: `visit:${v.id}`, kind: 'visit', title: v.title, type: v.type, time: timeOf(v.starts_at), status: v.status, company: v.company, city: v.city, link: '/visits' })),
  ];
}

/**
 * Every fact of `userId`'s previous business day, for the report `today`
 * (IST). `live: false` reads no mailbox, for a preview that must not touch
 * the provider.
 */
export async function personalFacts({ userId, today = businessToday(), db = { query }, live = true, settings = null } = {}) {
  const tz = config.businessTimeZone;
  const { rows: [user] } = await db.query('SELECT id, name, email, role, active FROM users WHERE id = $1', [userId]);
  if (!user) return null;
  const day = yesterdayOf(today).from;
  const s = settings || await misSettings(db);
  const who = [...new Set([user.name, user.email].map((x) => String(x || '').trim().toLowerCase()).filter(Boolean))];

  const [acts, mail] = await Promise.all([actsOf(db, { user, who, day, tz }), mailOf(db, { user, who, day, tz, live })]);

  // What the person touched yesterday, for "no action yesterday" on what waits on them.
  const touched = new Set();
  for (const a of acts) {
    touched.add(touchKey(a.entity, a.entity_id));
    if (a.detail?.quotation_no) touched.add(touchKey('quotation', a.detail.quotation_no));
    if (a.detail?.po_number) touched.add(touchKey('purchase_order', a.detail.po_number));
  }
  for (const m of mail.sent) if (m.record) touched.add(touchKey(m.record.entity, m.record.id));
  touched.delete(null);

  const [waiting, ahead] = await Promise.all([
    waitingOn(db, { user, today, touched, overdueDays: s.overdueDays }),
    dayAhead(db, { user, who, today, tz }),
  ]);

  const counts = {
    emails_sent: mail.sent.length,
    emails_received: mail.received.length,
    calls: acts.filter((a) => (a.kind === 'call.logged' || a.kind === 'meeting.logged') || (a.kind === 'collection.followed_up' && ['call', 'meeting'].includes(a.detail.channel))).length,
    records_created: acts.filter((a) => a.kind === 'record.created').length,
    tasks_done: acts.filter((a) => a.kind === 'task.completed').length,
    overdue: waiting.length,
  };

  return {
    person: { id: user.id, name: user.name, email: user.email, role: user.role, active: user.active },
    day, today,
    mailboxes: mail.mailboxes,
    acts, sent: mail.sent, threads: mail.threads, waiting, today_items: ahead,
    counts,
    left_out: mail.left_out,
  };
}

/**
 * The people a personal daily MIS is for (§B2): active sales and admin
 * users, not HR, each with the state of their personal mailbox.
 */
export async function personalPeople(db = { query }) {
  const { rows } = await db.query(
    `SELECT u.id, u.name, u.email, u.role,
            (SELECT json_build_object('id', a.id, 'email', a.email, 'status', a.status, 'visibility', a.visibility)
               FROM connected_accounts a WHERE a.user_id = u.id AND NOT a.is_shared AND a.status <> 'disconnected'
              ORDER BY (a.status = 'active') DESC, a.id LIMIT 1) AS mailbox
       FROM users u
      WHERE u.active AND u.role IN ('sales', 'admin')
      ORDER BY lower(u.name), u.id`);
  return rows.map((r) => ({
    ...r,
    state: !r.mailbox ? 'no_mailbox' : r.mailbox.status === 'active' ? 'ready' : 'mailbox_needs_reconnect',
  }));
}

/**
 * The facts as someone other than the mailbox's owner may see them (the
 * preview): the AI reads the owner's mail for their own report, but the
 * text of it is theirs. What a mailbox does not share with the team stays
 * hidden: the text unless it shares everything, the subject too when it
 * shares only metadata.
 */
export function redactFacts(facts, viewerId) {
  if (!facts || viewerId === facts.person.id) return facts;
  const shares = new Map(facts.mailboxes.map((b) => [b.email, b.visibility]));
  const everything = [...shares.values()].every((v) => v === 'share_everything');
  const subjects = [...shares.values()].every((v) => v !== 'metadata');
  const hide = (m) => ({ ...m, text: everything ? m.text : null, subject: subjects ? m.subject : null });
  return {
    ...facts,
    sent: facts.sent.map(hide),
    threads: facts.threads.map((t) => ({ ...hide(t), messages: t.messages.map(hide) })),
    redacted: !everything,
  };
}
