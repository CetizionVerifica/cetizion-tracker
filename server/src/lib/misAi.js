/**
 * The AI's part in the scheduled reports, and its limits
 * (docs/mis-reports-plan.md §3.4).
 *
 * One call per report, through lib/ai.js chatJSON, counted in email_ai_calls
 * (purpose mis_daily / mis_weekly) against the readers' shared daily ceiling.
 *
 *   Daily    highlights of yesterday's mail in the SHARED mailboxes that
 *            store everything, and the wording of the five actions the code
 *            already picked. Personal mailboxes are not read for it.
 *   Personal every sentence of one person's daily MIS, from the facts
 *            misPersonal.js gathers, their own mailbox included: a personal
 *            mailbox is read only for its owner's own report. Counted as
 *            mis_personal against its own ceiling (personal_mis_ai_limit).
 *   Weekly   four headline bullets and a short paragraph per section, from
 *            the computed figures only — never email text.
 *
 * Everything the model returns is checked in code before it is used:
 *   - a highlight's thread_id must be one of the inputs;
 *   - every number in a summary must appear in that thread's text or record;
 *   - at most eight highlights; the wording may touch only the chosen rows;
 *   - every number in a commentary sentence must be a figure in the input,
 *     else that sentence gives way to narrate()'s own.
 * Anything that fails is dropped. With no AI, or the ceiling reached, the
 * record-based highlights and the narrative stand, and the report still goes.
 */
import { query } from '../db.js';
import { aiConfig, chatJSON } from './ai.js';
import { aiCallsToday, enquirySettings } from './mailbox/autoEnquiry.js';
import { BULK, BULK_SENDER, isBlocked, snippet } from './mailbox/rules.js';
import { linkFor, threadLink } from './misReports.js';
import { r2 } from './reportMath.ts';
import { config } from '../config.js';

/** Replaceable in tests: `chat(system, user)` stands in for the model. */
export const deps = { chat: null };

export const MAX_THREADS = 40;
export const MAX_CHARS = 30_000;
export const MAX_HIGHLIGHTS = 8;
const MESSAGE_CHARS = 1_500;

const chatFn = (maxTokens = 3000) => deps.chat || (aiConfig.enabled ? (system, user) => chatJSON(system, user, { title: 'Cetizion Tracker sales reports', maxTokens }) : null);

/** Whether the model may be asked today: configured, and under the readers' shared ceiling. */
export async function aiAvailable(db = { query }) {
  if (!chatFn()) return { ok: false, why: 'no AI configured' };
  const settings = await enquirySettings(db);
  const used = await aiCallsToday(db);
  if (used >= settings.dailyAiLimit) return { ok: false, why: `the daily AI ceiling (${settings.dailyAiLimit}) is reached` };
  return { ok: true };
}

// ---------------------------------------------------------------------
// Number checks
// ---------------------------------------------------------------------

/** The numbers in a piece of text, as plain digit strings without separators. */
export function numbersOf(text) {
  return [...String(text ?? '').matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => m[0].replace(/,/g, '')).map((n) => n.replace(/\.0+$/, ''));
}

/**
 * Every figure in a value: the numbers themselves, rounded forms, and the
 * lakh and crore spellings a sentence may use for an INR amount.
 */
export function figuresIn(value) {
  const out = new Set();
  const add = (n) => {
    if (!Number.isFinite(n)) return;
    out.add(String(n)); out.add(String(Math.round(n))); out.add(String(r2(n)));
    out.add(String(Math.round(n * 10) / 10));
    // Lakh and crore spellings as the reports print them (one and two
    // decimals); no coarser rounding, which would let "5" stand for 4,50,000.
    if (Math.abs(n) >= 1e5) { out.add((n / 1e5).toFixed(1).replace(/\.0$/, '')); out.add((n / 1e5).toFixed(2).replace(/\.?0+$/, '')); }
    if (Math.abs(n) >= 1e7) { out.add((n / 1e7).toFixed(2).replace(/\.?0+$/, '')); out.add((n / 1e7).toFixed(1).replace(/\.0$/, '')); }
  };
  const walk = (v) => {
    if (v === null || v === undefined) return;
    if (typeof v === 'number') add(v);
    else if (typeof v === 'string') { for (const n of numbersOf(v)) { out.add(n); add(Number(n)); } }
    else if (Array.isArray(v)) v.forEach(walk);
    else if (typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(value);
  return out;
}

/** True when every number in `text` is among `allowed` (a Set of digit strings). */
export function numbersAllowed(text, allowed) {
  return numbersOf(text).every((n) => allowed.has(n) || allowed.has(String(Number(n))) || allowed.has(String(Math.round(Number(n)))));
}

// ---------------------------------------------------------------------
// Daily highlights
// ---------------------------------------------------------------------

// ---------------------------------------------------------------------
// Which mail may become a highlight (docs/mis-briefing-fix-plan.md §2)
// ---------------------------------------------------------------------

/** What the readers decided a message was, and whether that is sales business. */
export const SALES_KINDS = ['new_enquiry', 'quotation_sent', 'purchase_order', 'billing', 'reply_or_followup'];
export const NOT_SALES_KINDS = { marketing: 'marketing mail', vendor_or_sales_pitch: 'a vendor\'s pitch', job_application: 'a job application', spam: 'spam' };
/** Our own scheduled reports land in the sales mailbox's Sent Items; they are never news. */
export const OWN_REPORT_SUBJECT = /^\s*((re|fw|fwd)\s*:\s*)*(daily sales briefing|weekly sales mis)\b/i;

/**
 * Why one message is not sales business, or null when it may be. A message
 * the readers decided is sales business (SALES_KINDS) is always kept.
 */
export function messageVerdict(m) {
  if (SALES_KINDS.includes(m.kind)) return null;
  if (m.own_report || OWN_REPORT_SUBJECT.test(m.subject || '')) return 'our own report';
  if (NOT_SALES_KINDS[m.kind]) return NOT_SALES_KINDS[m.kind];
  const from = String(m.from_email || '');
  if (from && (isBlocked(from) || BULK_SENDER.test(from))) return 'an automatic or bulk sender';
  if (BULK.test(m.body || '')) return 'bulk mail';
  if (m.filtered_as === 'internal only') return 'internal only';
  return null;
}

/**
 * Whether a thread may become a highlight. Kept: a thread on a record (the
 * Coreal reminder in the reference is internal but about a client), or one
 * with any message the readers called sales business. Dropped: a thread
 * whose every message from the window has a reason above; the reason given
 * is the commonest. Our own report is dropped even on a record.
 */
export function threadVerdict(t) {
  const reasons = (t.messages || []).map(messageVerdict);
  if (reasons.length && reasons.every((r) => r === 'our own report')) return 'our own report';
  if (t.entity) return null;
  if ((t.messages || []).some((m) => SALES_KINDS.includes(m.kind))) return null;
  if (!reasons.length || reasons.some((r) => r === null)) return null;
  const count = reasons.reduce((n, r) => n.set(r, (n.get(r) || 0) + 1), new Map());
  return [...count.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

/**
 * Yesterday's threads in every shared mailbox that stores everything, with
 * the new part of each message, the sender's company and the linked record,
 * and what was left out and why (§2, decision 3):
 *   - mail that is not sales business is dropped before the AI sees it;
 *   - one email that reached two shared mailboxes (sales@ cc'd on info@)
 *     is one thread, not two;
 *   - a shared mailbox shared as subject or metadata gives the AI no text:
 *     it is named, not silently skipped.
 * Ranked: a linked record first, then an external sender, then the most
 * recent; at most MAX_THREADS threads and MAX_CHARS characters in all.
 */
export async function selectThreads(db, { from, to }) {
  const tz = config.businessTimeZone;
  const { rows: boxes } = await db.query(
    `SELECT email, visibility FROM connected_accounts WHERE is_shared AND status <> 'disconnected' ORDER BY email`);
  const { rows } = await db.query(
    `SELECT t.id AS thread_id, t.account_id, t.subject, t.entity, t.entity_id, co.name AS company, t.last_message_at, a.email AS mailbox,
            EXISTS (SELECT 1 FROM email_messages x WHERE x.thread_id = t.id AND x.direction = 'inbound'
                      AND (x.sent_at AT TIME ZONE $3)::date BETWEEN $1 AND $2) AS external_yesterday,
            (SELECT json_agg(json_build_object('direction', m.direction, 'from', COALESCE(m.from_name, m.from_email), 'from_email', m.from_email,
                      'at', m.sent_at, 'body', m.body_html, 'web_link', m.web_link, 'folder_id', m.folder_id, 'subject', m.subject, 'filtered_as', m.filtered_as,
                      'internet_message_id', m.internet_message_id,
                      'kind', (SELECT d.kind FROM email_enquiry_decisions d WHERE d.account_id = m.account_id AND d.provider_id = m.provider_id),
                      'own_report', EXISTS (SELECT 1 FROM email_log l WHERE l.template IN ('mis_daily','mis_weekly') AND l.subject = m.subject))
                    ORDER BY m.sent_at)
               FROM (SELECT * FROM email_messages m WHERE m.thread_id = t.id AND (m.sent_at AT TIME ZONE $3)::date BETWEEN $1 AND $2 ORDER BY m.sent_at DESC LIMIT 5) m) AS messages,
            CASE t.entity WHEN 'enquiry' THEN (SELECT e.status FROM enquiries e WHERE e.enquiry_no = t.entity_id)
                          WHEN 'quotation' THEN (SELECT q.status FROM quotations q WHERE q.quotation_no = t.entity_id)
                          WHEN 'purchase_order' THEN 'registered' ELSE NULL END AS record_status
       FROM email_threads t
       JOIN connected_accounts a ON a.id = t.account_id
       LEFT JOIN companies co ON co.id = t.company_id
      WHERE a.is_shared AND a.visibility = 'share_everything' AND a.status <> 'disconnected'
        AND EXISTS (SELECT 1 FROM email_messages m WHERE m.thread_id = t.id AND (m.sent_at AT TIME ZONE $3)::date BETWEEN $1 AND $2)
      ORDER BY (t.entity IS NOT NULL) DESC, external_yesterday DESC, t.last_message_at DESC, t.id
      LIMIT $4`, [from, to, tz, MAX_THREADS * 5]);

  const threads = [];
  const excluded = new Map();
  const leave = (why) => excluded.set(why, (excluded.get(why) || 0) + 1);
  const seenMessages = new Set();
  let chars = 0;
  let cut = 0;
  for (const r of rows) {
    const raw = r.messages || [];
    const why = threadVerdict({ entity: r.entity, messages: raw });
    if (why) { leave(why); continue; }
    // The same email in two shared mailboxes: keep the first copy (the best ranked).
    const ids = raw.map((m) => m.internet_message_id).filter(Boolean);
    if (ids.length && ids.every((id) => seenMessages.has(id))) { leave('the same email in another shared mailbox'); continue; }
    if (threads.length >= MAX_THREADS) { cut += 1; continue; }
    const messages = raw.map((m) => ({ direction: m.direction, from: m.from, at: m.at, web_link: m.web_link, text: snippet(m.body || '', MESSAGE_CHARS) }));
    const text = messages.map((m) => `${m.direction === 'inbound' ? 'From' : 'To'} ${m.from}: ${m.text}`).join('\n');
    if (chars + text.length > MAX_CHARS) { cut += 1; continue; }
    chars += text.length;
    ids.forEach((id) => seenMessages.add(id));
    threads.push({
      thread_id: r.thread_id, subject: r.subject, company: r.company, entity: r.entity, entity_id: r.entity_id, record_status: r.record_status,
      mailbox: r.mailbox, messages, text, web_link: messages.find((m) => m.web_link)?.web_link || null,
      // Where the thread opens in the Inbox: its mailbox and the folder of its latest message.
      account_id: r.account_id, folder_id: raw.at(-1)?.folder_id ?? null,
      // What threadVerdict needs to look again at a highlight the model picks (checkHighlights).
      verdictInput: { entity: r.entity, messages: raw.map(({ kind, subject, own_report: ownReport, from_email: fromEmail, filtered_as: filteredAs }) => ({ kind, subject, own_report: ownReport, from_email: fromEmail, filtered_as: filteredAs })) },
    });
  }
  return {
    threads,
    window: {
      mailboxes: boxes.filter((b) => b.visibility === 'share_everything').map((b) => b.email),
      not_read: boxes.filter((b) => b.visibility !== 'share_everything').map((b) => ({ email: b.email, shared_as: b.visibility })),
      threads: rows.length, kept: threads.length, cut,
      excluded: [...excluded.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
    },
  };
}

/** The threads alone, as before §2. */
export async function candidateThreads(db, period) {
  return (await selectThreads(db, period)).threads;
}

export { windowNote } from './misWindow.js';

export function highlightsPrompt(threads, actions, { day }) {
  const system = `You write the "Highlights of yesterday" for a sales team's morning briefing, from yesterday's client email threads, and word five actions the team has already chosen.
Answer in JSON only: {"highlights":[{"thread_id":123,"client":"...","summary":"one or two lines","action":"what to do next, or null","owner":"who, or null"}],"skip":[456],"actions_wording":[{"row_key":"...","text":"one line"}]}.
Rules: use only the thread_ids given; at most ${MAX_HIGHLIGHTS} highlights, the most important first; never invent a number, amount or date — use only figures that appear in the thread; keep each summary to two short sentences; plain English, no marketing tone.
Only client or sales business is a highlight: an enquiry, a quotation, an order, an invoice or payment, a client's question, a visit or audit. Leave out newsletters and marketing, a vendor selling to us, job applications, internal chatter that is not about a client, automatic notifications and our own reports, and put their thread_ids in "skip".
actions_wording may reword only the rows given, keeping their meaning.`;
  const user = JSON.stringify({
    day,
    threads: threads.map((t) => ({ thread_id: t.thread_id, subject: t.subject, client: t.company, record: t.entity ? `${t.entity} ${t.entity_id} (${t.record_status || 'open'})` : null, text: t.text })),
    actions: actions.map((a) => ({ row_key: a.key, client: a.client, reference: a.reference, days_pending: a.days, amount_inr: a.amount_inr, next_action: a.next_action, owner: a.owner })),
  });
  return { system, user };
}

/** What the model said about the highlights, checked (§3.4). */
export function checkHighlights(raw, threads, actions) {
  const byId = new Map(threads.map((t) => [t.thread_id, t]));
  // The model's own "not sales business", and the code's (§2): a highlight on either is dropped.
  const skipped = new Set((Array.isArray(raw?.skip) ? raw.skip : []).map(Number));
  const highlights = [];
  for (const h of Array.isArray(raw?.highlights) ? raw.highlights : []) {
    const t = byId.get(Number(h?.thread_id));
    if (!t || highlights.length >= MAX_HIGHLIGHTS) continue;
    if (h.skip === true || skipped.has(t.thread_id) || (t.verdictInput && threadVerdict(t.verdictInput))) continue;
    const allowed = figuresIn([t.subject, t.text, t.entity_id, t.record_status, t.company]);
    const summary = String(h.summary || '').trim();
    if (!summary || !numbersAllowed(summary, allowed)) continue;
    const action = h.action ? String(h.action).trim() : null;
    if (action && !numbersAllowed(action, allowed)) continue;
    highlights.push({
      thread_id: t.thread_id, client: String(h.client || t.company || 'a client').trim(), summary, action, owner: h.owner ? String(h.owner).trim() : null,
      link: t.entity ? linkFor(t.entity, t.entity_id) : threadLink(t), web_link: t.web_link || threadLink(t), source: 'ai',
    });
  }
  const byKey = new Map(actions.map((a) => [a.key, a]));
  const wording = new Map();
  for (const w of Array.isArray(raw?.actions_wording) ? raw.actions_wording : []) {
    const a = byKey.get(w?.row_key);
    const text = String(w?.text || '').trim();
    if (!a || !text) continue;
    if (!numbersAllowed(text, figuresIn([a.reference, a.days, a.amount_inr, a.amount, a.client, a.next_action]))) continue;
    wording.set(a.key, text);
  }
  return { highlights, wording };
}

// ---------------------------------------------------------------------
// Weekly commentary
// ---------------------------------------------------------------------

export const COMMENTARY_SECTIONS = ['enquiries', 'outcomes', 'sectors', 'services', 'customers', 'revenue', 'pending', 'speed'];

/** The figures the weekly commentary may speak from: never email text. */
export function commentaryInput(data) {
  const slim = (rows, n) => (rows || []).slice(0, n);
  return {
    period: data.period, month_to_date: data.month_to_date,
    enquiries: { total: data.enquiries.total, per_day: data.enquiries.per_day, month_to_date: data.enquiries.month_to_date, sources: data.enquiries.sources, tat: data.enquiries.tat, rows: slim(data.enquiries.rows, 20).map((r) => ({ client: r.client, country: r.country, sector: r.sector, service: r.service, source: r.source, first_response_hours: r.first_response_hours })) },
    outcomes: { total: data.outcomes.total, slices: data.outcomes.slices, quoted_not_won_reasons: data.outcomes.quoted_not_won_reasons },
    sectors: data.sectors.rows, services: data.services.rows, customers: data.customers.tiles,
    pos: slim(data.pos, 20).map((p) => ({ client: p.client || p.customer, country: p.country, service: p.service, value_inr: p.po_value_inr, repeat: p.repeat })),
    revenue: data.revenue.total, billing: data.billing,
    receivables: { outstanding_inr: data.receivables.outstanding_inr, overdue_inr: data.receivables.overdue_inr, over_90: data.receivables.over_90, oldest_days: data.receivables.oldest_days },
    pending: { invoices: { count: data.pending.invoices.count, overdue: data.pending.invoices.overdue, value_inr: data.pending.invoices.value_inr }, pos: { count: data.pending.pos.count, overdue: data.pending.pos.overdue, value_inr: data.pending.pos.value_inr }, quotations: { count: data.pending.quotations.count, overdue: data.pending.quotations.overdue, value_inr: data.pending.quotations.value_inr }, follow_ups_overdue: data.follow_ups_overdue.count },
    speed: { ...data.speed, pipeline: data.speed.pipeline },
    narrative: data.narrative,
  };
}

export function commentaryPrompt(data) {
  const system = `You write the commentary of a weekly sales MIS for a certification and audit company's management, from the figures given — only those figures. Answer in JSON only:
{"headline":["four short bullets, the week in one glance"],"sections":{"enquiries":"one short paragraph","outcomes":"...","sectors":"...","services":"...","customers":"...","revenue":"...","pending":"...","speed":"..."}}.
Rules: every number you write must be a figure in the input (amounts in rupees may be written in lakh with one decimal, e.g. 12.4 L); never estimate, extrapolate or compare with weeks not given; two sentences per section at most; plain English for a managing director, no marketing tone.`;
  return { system, user: JSON.stringify(commentaryInput(data)) };
}

/** What the model said about the week, checked: a sentence with a figure not in the input gives way to the narrative. */
export function checkCommentary(raw, data) {
  const allowed = figuresIn(commentaryInput(data));
  const sentences = (text) => String(text || '').split(/(?<=[.!?])\s+/).filter(Boolean);
  const sections = {};
  for (const key of COMMENTARY_SECTIONS) {
    const text = raw?.sections?.[key];
    if (!text) continue;
    const kept = sentences(text).filter((s) => numbersAllowed(s, allowed));
    sections[key] = kept.length ? kept.join(' ') : (data.narrative?.[key] || null);
    if (!sections[key]) delete sections[key];
  }
  const headline = (Array.isArray(raw?.headline) ? raw.headline : []).map((b) => String(b || '').trim()).filter((b) => b && numbersAllowed(b, allowed)).slice(0, 4);
  return { headline, sections };
}

// ---------------------------------------------------------------------
// Putting it on the report
// ---------------------------------------------------------------------

async function countCall(db, purpose) {
  await db.query('INSERT INTO email_ai_calls (purpose) VALUES ($1)', [purpose]);
}

/**
 * Word a built report with the AI where it may: highlights and action
 * wording on the daily briefing, headline and sections on the weekly MIS.
 * Changes `data` in place and says whether the AI was used, and why not.
 */
export async function wordReport(data, { db = { query } } = {}) {
  const available = await aiAvailable(db);
  if (!available.ok) return { used: false, why: available.why };
  const chat = chatFn();
  try {
    if (data.kind === 'daily_briefing') {
      const { threads, window } = await selectThreads(db, data.period);
      data.mail_window = window;
      if (!threads.length && !data.top_actions.length) return { used: false, why: 'nothing to word' };
      const { system, user } = highlightsPrompt(threads, data.top_actions, { day: data.period.from });
      await countCall(db, 'mis_daily');
      const raw = await chat(system, user);
      const { highlights, wording } = checkHighlights(raw, threads, data.top_actions);
      if (highlights.length) data.highlights = highlights;
      data.top_actions = data.top_actions.map((a) => (wording.has(a.key) ? { ...a, wording: wording.get(a.key) } : a));
      return { used: true, highlights: highlights.length, worded: wording.size, threads: threads.length, left_out: window.excluded };
    }
    const { system, user } = commentaryPrompt(data);
    await countCall(db, 'mis_weekly');
    const raw = await chat(system, user);
    data.commentary = checkCommentary(raw, data);
    return { used: true, headline: data.commentary.headline.length, sections: Object.keys(data.commentary.sections).length };
  } catch (err) {
    // The report goes without the AI's words; the figures were never its to change.
    console.error('[mis] AI wording failed:', err.message);
    return { used: false, why: `AI failed: ${err.message}` };
  }
}

// ---------------------------------------------------------------------
// The personal daily MIS (mis-report-sender-plan.md §B4.2, §B4.3)
// ---------------------------------------------------------------------

export const PERSONAL_LIMITS = { highlights: 8, list: 10, for_management: 3 };
export const NOT_IN_TRACKER_KINDS = ['po', 'quotation', 'enquiry', 'payment', 'meeting'];
const COUNT_KEYS = ['emails_sent', 'emails_received', 'calls', 'records_created', 'tasks_done', 'overdue'];

/**
 * Whether the model may be asked for a personal report today: configured,
 * and under the personal reports' own ceiling, apart from the readers'
 * (personal_mis_ai_limit). Ten people's reports must not stop the readers.
 */
export async function personalAiAvailable(db = { query }) {
  if (!chatFn()) return { ok: false, why: 'no AI configured' };
  const { rows: [s] } = await db.query(`SELECT value FROM settings WHERE key = 'personal_mis_ai_limit'`);
  const limit = Math.max(0, Math.trunc(Number(s?.value ?? 30)) || 0);
  const { rows: [r] } = await db.query(
    `SELECT count(*)::int AS n FROM email_ai_calls
      WHERE purpose = 'mis_personal' AND made_at >= date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1`, [config.businessTimeZone]);
  if (r.n >= limit) return { ok: false, why: `the personal reports' daily AI ceiling (${limit}) is reached` };
  return { ok: true };
}

/** What the model is given: every fact with its id, nothing it may not cite. */
export function personalInput(facts) {
  return {
    person: facts.person.name, day: facts.day, today: facts.today,
    counts: facts.counts,
    acts: facts.acts.map(({ id, time, kind, entity, entity_id: entityId, detail }) => ({ id, time, kind, record: entity ? `${entity} ${entityId ?? ''}`.trim() : null, detail })),
    sent: facts.sent.map(({ id, time, to, company, subject, text, record, from_tracker: fromTracker }) => ({ id, time, to, company, subject, text, record: record ? `${record.entity} ${record.id}` : null, from_tracker: fromTracker })),
    threads: facts.threads.map(({ thread_id: threadId, subject, company, record, messages, waiting_on: waitingOn }) => ({
      thread_id: threadId, subject, company, record: record ? `${record.entity} ${record.id}` : null, next_reply_from: waitingOn,
      messages: messages.map(({ id, direction, from, to, time, text }) => ({ id, direction, from, to, time, text })),
    })),
    waiting: facts.waiting.map(({ key, kind, client, reference, days, amount, currency, next_action: nextAction, no_action_yesterday: idle }) => ({ key, kind, client, reference, days, amount, currency, next_action: nextAction, no_action_yesterday: idle })),
    today: facts.today_items.map(({ ref, kind, title, type, due, overdue, time, company }) => ({ ref, kind, title, type, due, overdue, time, company })),
  };
}

export function personalPrompt(facts, { missed = null } = {}) {
  const system = `You write one salesperson's daily MIS for their management, from the facts given: what they did on ${facts.day}, their email that day, what is waiting on them, and their day ahead. Every sentence in the report is yours; every one must rest on the facts you cite.
Answer in JSON only:
{"summary":{"text":"a short paragraph","counts":{"emails_sent":0,"emails_received":0,"calls":0,"records_created":0,"tasks_done":0,"overdue":0}},
 "actions":[{"at":"HH:MM","text":"one line","refs":["act:…","msg:…"]}],
 "mailbox":{"highlights":[{"thread_id":1,"text":"..."}],"commitments":[{"thread_id":1,"text":"...","due":"YYYY-MM-DD or null"}],"owed_replies":[{"thread_id":1,"text":"..."}],"awaiting":[{"thread_id":1,"text":"..."}]},
 "not_in_tracker":[{"thread_id":1,"kind":"po|quotation|enquiry|payment|meeting","ref":"the PO or quotation number, or null","client":"...","text":"..."}],
 "waiting":[{"key":"...","text":"the next step, one line","no_action_yesterday":true}],
 "today":[{"ref":"task:1","text":"one line"}],
 "for_management":["two or three lines"]}
Rules:
- actions: every act and every sent email must be cited by at least one line, in time order; "at" is the time of the first act or email the line cites. Small acts on one record may share a line. Name the client and the record number, e.g. "Moved Honor Labs' quotation CTZ/QT/2026/118 to Negotiation", "Emailed Mr Shah (Infra Ltd) the revised quotation".
- summary.counts: copy the counts given, exactly.
- mailbox: highlights are what mattered (at most ${PERSONAL_LIMITS.highlights}); commitments are what the person promised; owed_replies are threads whose next_reply_from is "them"; awaiting are threads whose next_reply_from is "client". At most ${PERSONAL_LIMITS.list} in each.
- not_in_tracker: only what an email shows that the tracker does not: a PO received but not entered, a quotation sent but not recorded, a call or meeting agreed with no task. Give the number in "ref" when the email has one.
- waiting: one line for every row given, with its key; keep no_action_yesterday as given.
- today: one line per item given.
- for_management: at most ${PERSONAL_LIMITS.for_management} lines: what went well, what is slipping, what needs a manager's word.
- Use only the ids, keys, refs and thread_ids given. Never invent a number, amount, date or time: write only figures that appear in the facts you cite. Plain English for a managing director, no marketing tone.
- A day with no acts and no email gets a one-line summary saying so, and empty lists.`;
  const input = personalInput(facts);
  const user = JSON.stringify(missed ? { ...input, previous_answer_missed: missed, instruction: 'Your previous answer left these out. Answer again, in full, covering every one of them.' } : input);
  return { system, user };
}

/**
 * Whether a thing the mail suggests is missing from the tracker is really
 * missing: a reference that is a PO, quotation or enquiry number on record
 * is not; nor is a client with a record of that kind made in the week
 * around the day.
 */
async function foundInTracker(db, item, day) {
  const ref = String(item.ref || '').trim();
  if (ref) {
    const { rowCount } = await db.query(
      `SELECT 1 FROM purchase_orders WHERE lower(btrim(po_number)) = lower($1)
       UNION ALL SELECT 1 FROM quotations WHERE lower(btrim(quotation_no)) = lower($1) OR lower(btrim(printed_no)) = lower($1)
       UNION ALL SELECT 1 FROM enquiries WHERE lower(btrim(enquiry_no)) = lower($1)
       UNION ALL SELECT 1 FROM payment_stages WHERE lower(btrim(invoice_no)) = lower($1)
       LIMIT 1`, [ref]);
    if (rowCount) return true;
  }
  const client = String(item.client || '').trim();
  if (!client) return false;
  const near = `BETWEEN $2::date - 7 AND $2::date + 1`;
  const sql = {
    po: `SELECT 1 FROM purchase_orders po JOIN projects p ON p.project_id = po.project_id WHERE name_key(p.client_name) = name_key($1) AND (po.created_at AT TIME ZONE $3)::date ${near}`,
    quotation: `SELECT 1 FROM quotations WHERE name_key(client_name) = name_key($1) AND (created_at AT TIME ZONE $3)::date ${near}`,
    enquiry: `SELECT 1 FROM enquiries WHERE name_key(client_name) = name_key($1) AND (created_at AT TIME ZONE $3)::date ${near}`,
    payment: `SELECT 1 FROM payments pm JOIN v_payment_stages ps ON ps.id = pm.stage_id WHERE name_key(ps.client_name) = name_key($1) AND (pm.created_at AT TIME ZONE $3)::date ${near}`,
    meeting: `SELECT 1 FROM tasks t JOIN companies c ON t.entity = 'company' AND t.entity_id = c.id::text WHERE name_key(c.name) = name_key($1) AND (t.created_at AT TIME ZONE $3)::date ${near}
              UNION ALL SELECT 1 FROM visits v JOIN companies c ON c.id = v.company_id WHERE name_key(c.name) = name_key($1) AND (v.created_at AT TIME ZONE $3)::date ${near}`,
  }[item.kind];
  if (!sql) return false;
  const { rowCount } = await db.query(`${sql} LIMIT 1`, [client, day, config.businessTimeZone]);
  return rowCount > 0;
}

/**
 * What the model wrote, checked against the facts (§B4.3). Lines citing
 * what is not in the facts, or carrying a number the cited facts do not,
 * are dropped and listed; nothing is repaired but the two things code
 * decides (no_action_yesterday, and which threads owe or await a reply).
 * `missing` lists what must be covered and is not; `failed` says why the
 * report cannot go.
 */
export async function checkPersonal(raw, facts, { db = { query } } = {}) {
  const dropped = [];
  const drop = (section, item, why) => dropped.push({ section, item, why });
  const list = (v) => (Array.isArray(v) ? v : []);
  const line = (v) => String(v ?? '').trim();

  const cited = new Map([...facts.acts, ...facts.sent].map((f) => [f.id, f]));
  const threads = new Map(facts.threads.map((t) => [t.thread_id, t]));
  const waiting = new Map(facts.waiting.map((w) => [w.key, w]));
  const ahead = new Map(facts.today_items.map((t) => [t.ref, t]));
  const allowedFor = (...values) => figuresIn([facts.day, facts.today, ...values]);

  if (!raw || typeof raw !== 'object') return { report: null, dropped, missing: [], failed: 'the AI gave no report' };

  // 1. Summary, and code's counts.
  const summaryText = line(raw.summary?.text);
  const wrongCounts = COUNT_KEYS.filter((k) => Number(raw.summary?.counts?.[k]) !== facts.counts[k]);
  let failed = null;
  if (!summaryText) failed = 'the AI wrote no summary';
  else if (wrongCounts.length) failed = `the AI's counts do not match: ${wrongCounts.join(', ')}`;
  else if (!numbersAllowed(summaryText, allowedFor(facts.counts, facts.person.name))) failed = 'the summary has a number not in the facts';

  // 2. Actions taken: every line cites real acts or emails, at the time of one of them.
  const actions = [];
  for (const a of list(raw.actions)) {
    const text = line(a?.text);
    const refs = list(a?.refs).map(String);
    const facts_ = refs.map((r) => cited.get(r));
    if (!text || !refs.length) { drop('actions', a, 'no text or no reference'); continue; }
    if (facts_.some((f) => !f)) { drop('actions', a, 'cites an act or email that is not in the facts'); continue; }
    if (a.at && !facts_.some((f) => f.time === line(a.at))) { drop('actions', a, 'its time is not the time of what it cites'); continue; }
    if (!numbersAllowed(text, allowedFor(facts_, facts_.map((f) => f.time)))) { drop('actions', a, 'a number not in what it cites'); continue; }
    actions.push({ at: line(a.at) || facts_[0].time, text, refs, link: facts_.find((f) => f.link)?.link || null });
  }
  actions.sort((x, y) => x.at.localeCompare(y.at));
  const coveredActs = new Set(actions.flatMap((a) => a.refs));

  // 3. From the mailbox. Who owes a reply is code's, from the messages.
  const threadLine = (section, item, extra = {}) => {
    const t = threads.get(Number(item?.thread_id));
    const text = line(item?.text);
    if (!t || !text) { drop(section, item, t ? 'no text' : 'a thread that is not in the facts'); return null; }
    if (!numbersAllowed(text, allowedFor(t))) { drop(section, item, 'a number not in the thread'); return null; }
    return { thread_id: t.thread_id, text, link: t.link, ...extra };
  };
  const mailbox = {};
  for (const [section, max, only] of [
    ['highlights', PERSONAL_LIMITS.highlights, null], ['commitments', PERSONAL_LIMITS.list, null],
    ['owed_replies', PERSONAL_LIMITS.list, 'them'], ['awaiting', PERSONAL_LIMITS.list, 'client'],
  ]) {
    const out = [];
    for (const item of list(raw.mailbox?.[section])) {
      const t = threads.get(Number(item?.thread_id));
      if (only && t && t.waiting_on !== only) { drop(section, item, `the thread's next reply is not from ${only === 'them' ? 'the person' : 'the client'}`); continue; }
      const kept = threadLine(section, item, section === 'commitments' ? { due: /^\d{4}-\d{2}-\d{2}$/.test(line(item?.due)) ? line(item.due) : null } : {});
      if (kept && out.some((o) => o.thread_id === kept.thread_id)) continue;
      if (kept) out.push(kept);
    }
    if (out.length > max) { out.slice(max).forEach((o) => drop(section, o, 'over the limit')); out.length = max; }
    mailbox[section] = out;
  }
  // A due date the model gives must appear in the thread.
  mailbox.commitments = mailbox.commitments.filter((c) => {
    if (!c.due || numbersAllowed(c.due, allowedFor(threads.get(c.thread_id)))) return true;
    drop('commitments', c, 'a due date not in the thread');
    return false;
  });

  // 4. In email, not in the tracker: only what the tracker really lacks.
  const notInTracker = [];
  for (const item of list(raw.not_in_tracker)) {
    if (!NOT_IN_TRACKER_KINDS.includes(item?.kind)) { drop('not_in_tracker', item, 'an unknown kind'); continue; }
    const kept = threadLine('not_in_tracker', item, { kind: item.kind, ref: line(item.ref) || null, client: line(item.client) || threads.get(Number(item?.thread_id))?.company || null });
    if (!kept) continue;
    if (kept.ref && !numbersAllowed(kept.ref, allowedFor(threads.get(kept.thread_id)))) { drop('not_in_tracker', item, 'a reference not in the thread'); continue; }
    if (await foundInTracker(db, kept, facts.day)) { drop('not_in_tracker', item, 'it is in the tracker'); continue; }
    notInTracker.push(kept);
  }
  if (notInTracker.length > PERSONAL_LIMITS.list) { notInTracker.slice(PERSONAL_LIMITS.list).forEach((o) => drop('not_in_tracker', o, 'over the limit')); notInTracker.length = PERSONAL_LIMITS.list; }

  // 5. Waiting on them: every row, with code's "no action yesterday".
  const waitingOut = [];
  for (const item of list(raw.waiting)) {
    const w = waiting.get(line(item?.key));
    const text = line(item?.text);
    if (!w || !text) { drop('waiting', item, w ? 'no text' : 'a row that is not waiting on them'); continue; }
    if (waitingOut.some((o) => o.key === w.key)) continue;
    if (!numbersAllowed(text, allowedFor(w))) { drop('waiting', item, 'a number not in the row'); continue; }
    waitingOut.push({ key: w.key, text, no_action_yesterday: w.no_action_yesterday, link: w.link });
  }

  // 6. Today.
  const todayOut = [];
  for (const item of list(raw.today)) {
    const t = ahead.get(line(item?.ref));
    const text = line(item?.text);
    if (!t || !text) { drop('today', item, t ? 'no text' : 'an item that is not on their day'); continue; }
    if (!numbersAllowed(text, allowedFor(t))) { drop('today', item, 'a number not in the item'); continue; }
    if (!todayOut.some((o) => o.ref === t.ref)) todayOut.push({ ref: t.ref, text, link: t.link });
  }

  // 7. For management: may speak from anything in the facts.
  const everything = allowedFor(personalInput(facts));
  const forManagement = [];
  for (const text of list(raw.for_management).map(line).filter(Boolean)) {
    if (!numbersAllowed(text, everything)) { drop('for_management', text, 'a number not in the facts'); continue; }
    if (forManagement.length < PERSONAL_LIMITS.for_management) forManagement.push(text);
  }

  // Nothing left out.
  const missing = [
    ...[...cited.keys()].filter((id) => !coveredActs.has(id)),
    ...facts.waiting.map((w) => w.key).filter((k) => !waitingOut.some((o) => o.key === k)),
    ...facts.threads.filter((t) => t.waiting_on === 'them').map((t) => `thread:${t.thread_id}`).filter((k) => !mailbox.owed_replies.some((o) => `thread:${o.thread_id}` === k)),
  ];

  return {
    report: {
      summary: { text: summaryText, counts: { ...facts.counts } },
      actions, mailbox, not_in_tracker: notInTracker, waiting: waitingOut, today: todayOut, for_management: forManagement,
    },
    dropped, missing, failed,
  };
}

/**
 * The personal report, written by the model and checked (§B4.2, §B4.3).
 * One call, and one more when the first left something out. Returns
 * { ok, report, checks, why }: a report that fails is not used.
 */
export async function writePersonal(facts, { db = { query } } = {}) {
  const available = await personalAiAvailable(db);
  if (!available.ok) return { ok: false, report: null, checks: null, why: available.why };
  // The whole report in one answer: more room than the briefing's highlights.
  const chat = chatFn(8000);
  const ask = async (missed) => {
    const { system, user } = personalPrompt(facts, { missed });
    await countCall(db, 'mis_personal');
    return chat(system, user);
  };
  try {
    let checked = await checkPersonal(await ask(null), facts, { db });
    let asked = 1;
    if (!checked.failed && checked.missing.length) {
      const again = await personalAiAvailable(db);
      if (again.ok) {
        checked = await checkPersonal(await ask(checked.missing), facts, { db });
        asked = 2;
      }
    }
    const checks = { asked, dropped: checked.dropped, missing: checked.missing };
    if (checked.failed) return { ok: false, report: null, checks, why: checked.failed };
    if (checked.missing.length) return { ok: false, report: null, checks, why: `the AI left out ${checked.missing.length} required item${checked.missing.length === 1 ? '' : 's'}` };
    return { ok: true, report: checked.report, checks, why: null };
  } catch (err) {
    console.error('[mis] personal report AI failed:', err.message);
    return { ok: false, report: null, checks: null, why: `AI failed: ${err.message}` };
  }
}
