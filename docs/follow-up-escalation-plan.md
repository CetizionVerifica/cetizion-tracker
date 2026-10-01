# Follow-up reminders and escalation: implementation plan

The owner of an open **enquiry**, a sent **quotation** or an **unpaid invoice**
gets an email when that record needs a follow-up. If nobody logs any activity
on the record within a grace period after the reminder, the **management
team** gets an email naming the record, the owner and how long it has gone
untouched.

This file is written for the person (or Claude Code session) who builds it.
Read [PROJECT-CONTEXT.md](../PROJECT-CONTEXT.md) first; this plan assumes its
two design rules and its workflow. Written against commit `07b058b`.

---

## 1. What already exists, and why it is not this

Read these before writing anything. Most of the plumbing is already built, and
the feature must reuse it, not duplicate it.

| Existing piece | File | What it does | Why it is not this feature |
| --- | --- | --- | --- |
| Notification sweep | `server/src/lib/notify.js` `collectNotifications()` | Raises an in-app `follow_up` notification for each open enquiry whose `next_follow_up_at` has come, daily at 08:00 | In-app only (email only if the person opted in). No quotations or invoices for the owner. Nobody checks whether the follow-up then happened. No escalation. |
| Daily digest | `notify.js` `runDigests()` | 08:30 email of everything unread in the bell | A person can switch it off. It lists, it does not escalate. |
| Payment reminders | `server/src/lib/reminders.js` | Emails the **client** about overdue invoices at 3/14/30 days | Goes to the client, not to our salesperson. |
| Finance digest | `reminders.js` `runFinanceDigest()` | Morning summary to `finance_email` | One shared address, no owner, no accountability. |
| "No contact" list | `GET /api/communications/no-contact` (`server/src/routes/communications.js`), Worklist tab | Deals and overdue invoices with no touch for `no_contact_days` | A screen somebody has to open. No email, no escalation. |
| Touch log | `communications` table, `POST /api/communications`, "Log a touch" dialog in `web/src/components/Timeline.jsx` | Records a call, email, WhatsApp or meeting on a record; a trigger stamps `last_contacted_at` | This is the main **activity** the new feature checks for. |
| Chasing log | `collection_log` table, `POST /api/collections/log`, `LogDialog` in `web/src/pages/Collections.jsx` | Records a chase on a payment stage | Second source of activity, for invoices. **Pitfall:** `runPaymentReminders` also writes rows here (see §6.3). |

**Summary:** the tracker can already tell a person something is due. What is
missing is (a) an email that always reaches the record's owner for all three
kinds, (b) a check afterwards that something was actually done, and (c) an
email to management when it was not.

---

## 2. Scope

### In scope

1. A daily job that finds every enquiry, quotation and unpaid invoice that
   needs a follow-up and emails **one reminder digest per owner**.
2. A ledger recording each reminder: what, to whom, when, and the date by
   which activity is expected.
3. On each later run, a check for activity logged on the record since the
   reminder. None by the deadline: the item is **escalated**.
4. **One escalation digest per day** to the management team listing every
   newly escalated item.
5. Settings to switch the feature on and tune the intervals (off by default).
6. An admin screen listing open, escalated and resolved follow-ups, and a
   small banner on the record pages.
7. Tests (pure rules, database-backed runner, emails, authorization).

### Out of scope (say so in the PR)

- SMS, WhatsApp or push delivery. Email and the in-app bell only.
- A new `manager` role. "Management" is the existing `admin` role plus a
  configurable address list (§4.4).
- Changing the client-facing payment reminders in `reminders.js`.
- Escalating beyond one level (e.g. to a director after management). The
  ledger is shaped so a second level can be added later (§10).

---

## 3. Vocabulary

| Term | Meaning |
| --- | --- |
| **Record** | One enquiry (`enquiries.enquiry_no`), one quotation (`quotations.quotation_no`) or one payment stage (`payment_stages.id`). These are the `(entity, entity_id)` pairs used everywhere else in the tracker. |
| **Owner** | The user in `owner_user_id` on the enquiry, the quotation, or the **project** above the payment stage (stage → `purchase_orders` → `projects`). This is the one ownership truth (`server/src/auth/ownership.js`). Do **not** match on the free-text `sales_person`; `server/src/lib/scope.js` explains why that path was removed. |
| **Due** | The record needs a follow-up today (rules in §4.1). |
| **Activity** | Something a person did on the record that counts as following up (§4.2). |
| **Reminder** | The email to the owner. |
| **Grace** | Working days the owner has after the reminder to log activity. |
| **Escalation** | The email to management when the grace runs out with no activity. |
| **Cycle** | One due → reminded → (resolved \| escalated) sequence for one record. A record can have several cycles over its life, one at a time. |

---

## 4. The rules

All rules are pure functions over plain rows in a new module
`server/src/lib/followUps.js`, tested without a database, in the same style as
`planReminders()` in `reminders.js`. The runner (§5.3) only reads rows, calls
the rules and writes the results.

All dates are **business dates** (`businessToday()` from
`server/src/lib/businessDate.ts`). All day counts are **working days**
(`isWorkingDay`, `addWorkingDays`, `workingDaysBetween` from the same file,
with the `holidays` table passed in).

### 4.1 When a record is due

| Kind | Open when | Due when | Due since (the cycle's `due_on`) |
| --- | --- | --- | --- |
| **Enquiry** | `status IN ('New','Contacted','Qualified','Nurture')` | (a) `next_follow_up_at <= today`, **or** (b) `next_follow_up_at IS NULL` and no activity for `followup_enquiry_idle_days` working days since the later of `enquiry_date`/`created_at` and the last activity | (a) `next_follow_up_at`; (b) the day the idle limit was reached |
| **Quotation** | `status IN ('Submitted','Under Negotiation')`, `sent_at IS NOT NULL`, `accepted_at IS NULL`, `closed_at IS NULL` | No activity for `followup_quotation_idle_days` working days since the later of `sent_at` and the last activity | The day the idle limit was reached |
| **Invoice** (payment stage) | From `v_payment_stages`: `invoice_no IS NOT NULL`, `stage_status IN ('Overdue','Partially Paid')` with an outstanding amount and a due date in the past, `NOT on_hold`, and no `promise_to_pay_date >= today` | `days_overdue >= followup_invoice_overdue_days` **and** no activity for `followup_invoice_idle_days` working days | The day both conditions became true |

Notes:

- A record that is **not open** (converted, lost, won, paid, on hold,
  promised) is never due, and any open cycle on it is resolved (§4.3).
- Check the exact column names of `v_payment_stages` in
  `server/db/views.sql` before writing the query (`stage_status`,
  `invoice_due_date`, `days_overdue`, `amount_received`, `stage_amount`).
  Do not recompute any of them; read the view (design rule 1).
- Whether stages still in **To Invoice** (not yet raised) should also be
  chased is a decision for the lead (§11, D3). The plan assumes **no**: raising
  an invoice is finance's job, and My Today already lists them.

### 4.2 What counts as activity

Activity on a record is any of these, made by a **person** (not a job), on
that record:

| Source | Row counts when | Timestamp |
| --- | --- | --- |
| `communications` (touch log) | `entity, entity_id` match. Any outcome, including `no_answer`: a call nobody picked up is still an attempt to follow up. | `started_at` |
| `collection_log` (payment stages only) | `stage_id` matches **and** `automated = false` (new column, §6.3) | `happened_at` |
| `email_messages` | `direction = 'outbound'` on an `email_threads` row whose `entity, entity_id` match (mail sent from the tracker or synced from Outlook) | `sent_at` |
| `notes` | `entity, entity_id` match | `created_at` |
| `tasks` | `entity, entity_id` match and `completed_at` is set | `completed_at` |
| `quotation_stage_history` (quotations only) | A stage change on the quotation | its timestamp column (check the table) |
| `quotation_revisions` (quotations only) | A new revision | its timestamp column |

Write this as **one SQL function or CTE** (see §5.2) returning
`last_activity_at` per `(entity, entity_id)`. Do not store it on the record
(design rule 1).

**Does not count:**

- Automated rows: payment reminders to clients (`collection_log.automated`),
  anything with `sent_by`/`by_whom` = `'schedule'` or `'system'`.
- Merely editing the record (`updated_at`), including moving
  `next_follow_up_at` to a later date. Moving the date *does* make the enquiry
  no longer due, so the cycle resolves as `rescheduled` (§4.3), and the
  management weekly view counts those separately so repeated rescheduling
  without contact is visible. Whether rescheduling alone should be allowed to
  resolve a cycle is decision D2.
- Activity by **anyone** counts, not only the owner: a colleague covering a
  call has followed up. (Decision D4 if management wants owner-only.)

### 4.3 The cycle

```
            due today, no open cycle
                     │
                     ▼
        ┌──────── REMINDED ────────┐   reminder email status = 'sent'
        │  respond_by = reminded_on │   respond_by = addWorkingDays(reminded_on, grace)
        │             + grace       │
        └───┬──────────────┬────────┘
            │              │
 activity after reminded_at│   today > respond_by and no activity
 or record no longer due   │
            ▼              ▼
        RESOLVED       ESCALATED ──── activity later, or record closes ──▶ RESOLVED
                          │                                              (resolved_after_escalation)
                          └── still nothing after followup_reescalate_days ──▶ listed again
                              in the escalation digest as "still open"
```

A **pure** function decides each transition:

```js
// server/src/lib/followUps.js
export function planFollowUps({ due, open, activity, today, settings, holidays })
// due:      [{ entity, entity_id, due_on, owner_user_id, owner_email, owner_name, title, client, amount, currency, link }]
// open:     ledger rows with resolved_at IS NULL
// activity: Map key `${entity}:${entity_id}` → last_activity_at (ISO)
// returns { remind: [...], escalate: [...], resolve: [{ id, reason }], reescalate: [...], skipped: [{ key, reason }] }
```

Rules, in order, for each record:

1. **Open cycle, record no longer due** → `resolve` with reason
   `closed` (status left the open set), `paid`, `on_hold`, `promised`,
   `rescheduled` (enquiry date moved forward) or `activity`.
2. **Open cycle, activity after `reminded_at`** → `resolve`, reason
   `activity`.
3. **Open cycle, not escalated, `today > respond_by`** → `escalate`.
4. **Open cycle, escalated, still nothing, and
   `workingDaysBetween(escalated_on, today) >= followup_reescalate_days`**
   → `reescalate` (listed again under "still open, escalated N days ago";
   updates `last_escalated_on`, increments `escalation_count`).
5. **No open cycle, due** → `remind`.
6. **Due, but owner unknown** (`owner_user_id` null, inactive user, or no
   email) → no reminder can be sent; it goes **straight into the escalation
   digest** under "No owner" so management can assign it. Record a cycle with
   `reminded_at = NULL` and `escalated_at = today` so it is not repeated
   daily.
7. **Today is not a working day** → the runner does nothing (the cron is
   weekdays only, but a holiday on a weekday must also be skipped).

Only a reminder whose `sendMail` result has `status = 'sent'` starts the
grace clock. A suppressed or failed email leaves the cycle un-reminded and is
retried next run. This mirrors `runPaymentReminders` exactly: an owner must
not be escalated for a reminder they never received.

### 4.4 Who gets what

| Email | To | Cc | Frequency |
| --- | --- | --- | --- |
| **Reminder digest** | The owner's `users.email` | — | Once per working day, only if they have at least one new reminder. Items already reminded and still inside grace are listed in a second section "Still waiting (respond by …)" so the email is the owner's full list. |
| **Escalation digest** | Every active `users` row with `role = 'admin'` and an email, **plus** each address in the `followup_escalation_emails` setting (comma-separated), de-duplicated, case-insensitive | The owner of each escalated item **only if** `followup_cc_owner_on_escalation = true` (one email per owner would leak other people's items, so if on, send each owner a short "your items were escalated" email instead of a Cc) | Once per working day, only if something was escalated, re-escalated, or is unowned |

The escalation recipients must **not** be able to opt out through
`users.notify` (that is the point of escalation). The owner reminder **does**
respect the kill switch `emails_enabled` and `EMAIL_MODE`, like every email,
through `sendMail()`.

**Shared sign-in mode** (`AUTH_MODE=shared`, no `users` rows): there are no
owners. The job sends nothing to owners, records every due item as "No
owner", and sends the escalation digest to `followup_escalation_emails`
(falling back to `digest_email`). Document this in the Settings hint.

### 4.5 Settings (new rows in `settings`)

| Key | Default | Meaning |
| --- | --- | --- |
| `followup_enabled` | `false` | Master switch. Off until the lead turns it on, so deploying does not email anyone. |
| `followup_enquiry_idle_days` | `3` | Working days with no activity before an enquiry without a follow-up date is due |
| `followup_quotation_idle_days` | `5` | Working days after sending, or after the last activity, before a quotation is due |
| `followup_invoice_overdue_days` | `1` | Days overdue before an invoice can be due for the owner |
| `followup_invoice_idle_days` | `5` | Working days with no chase before an overdue invoice is due |
| `followup_grace_days` | `2` | Working days after a reminder before escalation |
| `followup_reescalate_days` | `5` | Working days before an escalated, untouched item is listed again |
| `followup_escalation_emails` | `''` | Extra management addresses, comma-separated |
| `followup_cc_owner_on_escalation` | `true` | Tell the owner when their item is escalated |

Read them with the same `setting(db, key, fallback)` helper pattern
`reminders.js` uses, and parse numbers defensively (a blank or non-number
falls back to the default).

---

## 5. Server

### 5.1 Migration `server/db/migrations/063_follow_up_reminders.sql`

Check the latest number first (`ls server/db/migrations | tail -1`); the plan
assumes `062` is the latest. No `BEGIN`/`COMMIT`. Additive only. Make the
**same** change in `server/db/schema.sql`.

```sql
-- A follow-up cycle: one record, one reminder, at most one open at a time.
-- These are events that happened (an email went, a deadline passed), not
-- values derived from other columns, so they are stored, the same way
-- payment_stages.reminder_sent_on is.
CREATE TABLE IF NOT EXISTS follow_up_cycles (
  id                   serial PRIMARY KEY,
  entity               text NOT NULL CHECK (entity IN ('enquiry','quotation','payment_stage')),
  entity_id            text NOT NULL,
  due_on               date NOT NULL,
  reminded_user_id     int REFERENCES users(id) ON DELETE SET NULL,  -- see the note below
  owner_name           text,              -- snapshot, survives the user's deletion
  reminded_at          timestamptz,
  reminder_email_id    int REFERENCES email_log(id) ON DELETE SET NULL,
  respond_by           date,
  escalated_at         timestamptz,
  last_escalated_on    date,
  escalation_count     int NOT NULL DEFAULT 0,
  escalation_email_id  int REFERENCES email_log(id) ON DELETE SET NULL,
  resolved_at          timestamptz,
  resolved_reason      text CHECK (resolved_reason IN
                         ('activity','closed','paid','on_hold','promised','rescheduled','reassigned','disabled')),
  created_at           timestamptz NOT NULL DEFAULT now()
);

-- One open cycle per record.
CREATE UNIQUE INDEX IF NOT EXISTS follow_up_cycles_open_key
  ON follow_up_cycles (entity, entity_id) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS follow_up_cycles_reminded_user_idx
  ON follow_up_cycles (reminded_user_id, resolved_at);

-- Chasing rows written by the payment-reminder job are not a person
-- following up. Existing ones are recognised by the summary that job writes.
ALTER TABLE collection_log ADD COLUMN IF NOT EXISTS automated boolean NOT NULL DEFAULT false;
UPDATE collection_log SET automated = true
 WHERE automated = false AND channel = 'email' AND summary LIKE 'Reminder level % emailed to %';

INSERT INTO settings (key, value, notes) VALUES
  ('followup_enabled', 'false', 'Email owners about due follow-ups and escalate to management when nothing is logged.'),
  ('followup_enquiry_idle_days', '3', 'Working days an enquiry with no follow-up date may go untouched.'),
  ('followup_quotation_idle_days', '5', 'Working days a sent quotation may go untouched.'),
  ('followup_invoice_overdue_days', '1', 'Days overdue before the owner is asked to follow up an invoice.'),
  ('followup_invoice_idle_days', '5', 'Working days an overdue invoice may go unchased.'),
  ('followup_grace_days', '2', 'Working days after a reminder before management is told.'),
  ('followup_reescalate_days', '5', 'Working days before an escalated item is listed again.'),
  ('followup_escalation_emails', '', 'Management addresses for escalations, besides admin accounts. Comma-separated.'),
  ('followup_cc_owner_on_escalation', 'true', 'Tell the owner when one of their follow-ups is escalated.')
ON CONFLICT (key) DO NOTHING;
```

**As built:** the ledger's user column is `reminded_user_id`, not
`owner_user_id`. That name marks the three ownership-scoped tables
(`server/test/ownership.test.js` asserts exactly those three carry it), and
the person reminded stops being the record's owner once it is reassigned.

Then:

- `server/src/lib/reminders.js` `runPaymentReminders`: write
  `automated = true` in its `INSERT INTO collection_log`. Also the hold/unhold
  note in `routes/collections.js` is a person's act and stays `false`.
- Run `TEST_DATABASE_URL=... scripts/ci/check-migrations.sh origin/main` to
  prove `schema.sql` and the migrations agree.
- **Pitfall:** `v_enquiries` is `SELECT e.*`. This plan adds **no** column to
  `enquiries`, `quotations` or `payment_stages`, on purpose. If you find you
  need one, read the comment above `owner_user_id` in `schema.sql` first.

### 5.2 The activity query: `server/src/lib/followUps.js` → `lastActivity(db, keys)`

One parameterised query, taking an array of `entity:entity_id` keys and
returning `{ key, last_activity_at }`. Build it as a `UNION ALL` of the
sources in §4.2, each filtered to the requested keys, then `GROUP BY key` with
`max(ts)`. Rough shape:

```sql
WITH k AS (SELECT split_part(x, ':', 1) AS entity, split_part(x, ':', 2) AS entity_id
             FROM unnest($1::text[]) AS x),
acts AS (
  SELECT c.entity, c.entity_id, c.started_at AS ts FROM communications c JOIN k USING (entity, entity_id)
  UNION ALL
  SELECT 'payment_stage', l.stage_id::text, l.happened_at FROM collection_log l
    JOIN k ON k.entity = 'payment_stage' AND k.entity_id = l.stage_id::text WHERE NOT l.automated
  UNION ALL
  SELECT t.entity, t.entity_id, m.sent_at FROM email_messages m JOIN email_threads t ON t.id = m.thread_id
    JOIN k ON k.entity = t.entity AND k.entity_id = t.entity_id WHERE m.direction = 'outbound'
  UNION ALL
  SELECT n.entity, n.entity_id, n.created_at FROM notes n JOIN k USING (entity, entity_id)
  UNION ALL
  SELECT t.entity, t.entity_id, t.completed_at FROM tasks t JOIN k USING (entity, entity_id) WHERE t.completed_at IS NOT NULL
  -- + quotation_stage_history, quotation_revisions (check their key and timestamp columns)
)
SELECT entity || ':' || entity_id AS key, max(ts) AS last_activity_at FROM acts GROUP BY 1;
```

Check every column name against `schema.sql` before running it (in particular
`notes`, `quotation_stage_history` and `quotation_revisions`, which this plan
did not read in full). Payment-stage entity ids are the serial id as text,
matching `resolveParties()` in `routes/communications.js`.

### 5.3 The runner: `runFollowUps()` in `server/src/lib/followUps.js`

```js
export async function runFollowUps({ db = { query }, today = businessToday(), startedBy = 'schedule', send = sendMail } = {})
```

Steps:

1. Read settings. If `followup_enabled` is not `'true'`, return
   `{ today, skipped: 'followup_enabled is false' }`.
2. Read holidays; if `!isWorkingDay(today, holidays)` return
   `{ today, skipped: 'not a working day' }`.
3. Load the three candidate sets (open records per §4.1) with their owner
   (`LEFT JOIN users u ON u.id = owner_user_id AND u.active`), title, client,
   amount, currency, and the link path (`/enquiries?q=…`,
   `/quotations/<no>`, `/collections`, matching the links `notify.js`
   already builds).
4. Load open cycles (`resolved_at IS NULL`).
5. Load `lastActivity()` for the union of candidate and open-cycle keys.
6. Call `planFollowUps()` (pure). It decides `due` itself from the candidate
   rows, settings and activity.
7. Apply **resolve** first (`UPDATE … SET resolved_at = now(), resolved_reason`).
8. **Remind**: group by owner, render `followUpReminder()` (§5.4), call
   `send(...)` with `template: 'follow_up_reminder'`, `entity: 'user'`,
   `entityId: owner id`. If `status = 'sent'`, insert the cycles with
   `reminded_at = now()`, `respond_by = addWorkingDays(today, grace, holidays)`,
   `reminder_email_id`. Otherwise insert nothing (retry tomorrow) and report
   it in the result.
9. **Escalate / re-escalate / unowned**: render one `followUpEscalation()`
   digest, send to each recipient (§4.4), then set `escalated_at`,
   `last_escalated_on = today`, `escalation_count = escalation_count + 1`,
   `escalation_email_id`. Mark escalated only if **at least one** recipient
   got `status = 'sent'`; if there are **no recipients at all**, raise an ops
   alert (`raiseAlert` from `lib/ops/alerts.js`) and do not mark, so the
   misconfiguration is visible instead of silent.
10. If `followup_cc_owner_on_escalation`, send each affected owner a short
    `followUpEscalatedNotice()`.
11. Also raise an in-app notification for each escalation with
    `notify({ kind: 'follow_up_escalated', username: null, … dedupeKey: 'fu-esc:<cycle id>:<today>' })`
    so admins see it in the bell, and emit webhook `follow_up.escalated`
    (add it to the event list in `server/src/lib/webhooks.js`) for n8n.
12. Return a summary for `job_runs`: counts per kind, `sent`, `skipped`
    (with reasons), `escalated`, `resolved`, `unowned`.

Run steps 7–9 so that a crash between sending and writing cannot email twice
on the next run: write the cycle row **inside the same loop iteration**
straight after the send result, and rely on the partial unique index to
reject a second open cycle. Use the `db` handle throughout so tests can pass
a transaction client.

Concurrency: only one worker runs (PROJECT-CONTEXT §2), and pg-boss
schedules are singleton, but the admin "Run now" button can overlap a
scheduled run. Take a transaction-scoped advisory lock at the start
(`SELECT pg_try_advisory_xact_lock(hashtext('followups.daily'))` inside a
transaction, or a session lock released in `finally`) and return
`{ skipped: 'already running' }` if not acquired.

### 5.4 Email templates: `server/src/lib/emailTemplates.js`

Add three functions in the existing style (plain HTML via `layout()` and
`table()`, text version first, `esc()` on every value):

- `followUpReminder({ ownerName, today, items, waiting, appUrl })` → subject
  `Follow up today: 2 enquiries, 1 quotation, 1 invoice`. Sections per kind.
  Each row: record number, client, why it is due ("follow-up date 28 Sep",
  "sent 6 working days ago, no contact since", "₹1,20,000 overdue 12 days"),
  **respond by** date, and a link to the record. Footer line: "Log a call,
  email, meeting or note on the record by <respond by> or this goes to
  management."
- `followUpEscalation({ today, escalated, stillOpen, unowned, appUrl })` →
  subject `Follow-ups missed: 3 new, 2 still open, 1 with no owner`. Grouped
  by owner. Each row: record, client, value, reminded on, respond by, working
  days with no activity, link.
- `followUpEscalatedNotice({ ownerName, items, appUrl })` → short note to the
  owner.

Links use `public_app_url` from settings, exactly as
`sendNotificationEmails()` in `notify.js` does. Add `?log=1` to record links
so the record page opens the "Log a touch" dialog (§7.3).

### 5.5 Job registration: `server/src/jobs.js`

```js
'followups.daily': {
  description: 'Email owners about enquiries, quotations and invoices due a follow-up; tell management about the ones nobody acted on',
  // After reminders.payment (09:00) so today's client reminders are already
  // marked automated, and after the 08:00 notification sweep.
  cron: '15 9 * * 1-5',
  run: (opts) => runFollowUps(opts),
},
```

Add it to the job table in `README.md`.

### 5.6 Routes: `server/src/routes/followUps.js`, mounted at `/api/follow-ups`

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| GET | `/api/follow-ups` | signed in | Cycles with record title, owner, dates, status. Filters: `status=open\|escalated\|resolved`, `owner`, `entity`. A **sales** user sees only cycles on records they own; an admin sees all. Use the ownership helpers in `server/src/auth/ownership.js` (`scopeOf(req)`, `scopedSources`), not a hand-written `WHERE owner_user_id = …`. |
| GET | `/api/follow-ups/record?entity=&id=` | signed in, record reachable | The open cycle for one record (for the banner). Gate with `assertRecordReachable(scopeOf(req), entity, id)`. |
| GET | `/api/follow-ups/summary` | admin | Counts for the last 30 days: reminded, resolved by activity, rescheduled, escalated, per owner. |

Status is **derived in the query**, not stored: `resolved` when
`resolved_at` is set, `escalated` when `escalated_at` is set, else `waiting`.

Then:

- Mount in `server/src/app.js` next to `/api/notifications`.
- Declare all three in `server/src/lib/authz/policy.js`. The route inventory
  test (`server/test/authorization.test.js`, #89) fails for any mounted
  route that is not declared.
- Add the new `follow_up_escalated` kind to `GROUPS` in
  `server/src/lib/notificationPrefs.js` under a new group
  `follow_up_escalations` (label "Follow-ups escalated to management") so
  admins can choose in-app vs email for the **bell** copy. The escalation
  digest email itself is not governed by this.

---

## 6. Pitfalls

1. **Do not double-email the owner.** `notify.js` already raises an in-app
   `follow_up` notification for enquiries, and a user who set that group to
   `email` already gets one email per item. Leave that in place (it is the
   bell), but in the reminder email's footer say what it is, and in the
   Settings hint say the new email is separate from the bell preference.
   Do **not** call `notify()` for each reminder; the bell already has them.
2. **Ownership is `owner_user_id`.** Some old records may still have a null
   owner after the #18 backfill (migration 060 left uncertain ones null on
   purpose). Those go to management under "No owner", which is the right
   pressure to get them assigned.
3. **Automated chasing is not activity.** Without the `automated` column, the
   09:00 client reminder would count as the salesperson following up and
   nothing would ever escalate. When `runJob` is started from the admin
   button, `startedBy` is a username, not `'schedule'`, so filtering on
   `by_whom` is not enough. That is why the column exists.
4. **Only `sent` starts the clock.** In `EMAIL_MODE=log` nothing is sent, so
   locally nothing ever escalates. Tests inject `send` (as
   `reminders.test.js` does). To try it by hand, use `EMAIL_MODE=sandbox`
   with your address on `EMAIL_ALLOWLIST`.
5. **Business dates, working days.** Never `new Date().toISOString().slice(0,10)`
   (that is UTC); use `businessToday()`. Never count calendar days for grace.
6. **First run after deploy.** Every stale record becomes due at once. The
   owner gets one digest (fine), but nothing escalates until the grace has
   passed, because escalation needs a sent reminder first. Say this in the
   PR. Consider capping each owner digest at 50 rows with "and N more in the
   tracker" to keep the email readable.
7. **Reassignment.** If `owner_user_id` changes while a cycle is open,
   resolve the old cycle with reason `reassigned`; the new owner gets a
   fresh reminder on the next run. Detect it by comparing the cycle's
   `owner_user_id` with the record's current owner in `planFollowUps()`.
8. **Switching the feature off** (`followup_enabled = false`) stops all
   email. Open cycles are left as they are; when it is switched back on,
   resolve any open cycle whose `reminded_at` is older than
   `respond_by + reescalate_days` with reason `disabled` rather than
   escalating weeks-old items in one burst. Put this in `planFollowUps()`
   and test it.
9. **Do not put personal data in webhook payloads** beyond what
   `lib/webhooks.js` already strips; pass record ids, owner id and counts.
10. **TypeScript.** New server files may be `.ts` (see
    [typescript.md](typescript.md)); `followUps.js` as `.js` is also fine,
    matching `reminders.js`. No `enum`.

---

## 7. Web

### 7.1 Settings: `web/src/pages/Settings.jsx`

Add a section after "Getting paid":

```js
{
  title: 'Follow-ups',
  hint: 'reminders to the owner, then management if nothing is logged',
  items: [
    { key: 'followup_enabled', label: 'Send follow-up reminders and escalations', type: 'boolean' },
    { key: 'followup_enquiry_idle_days', label: 'Enquiry untouched for', unit: 'working days' },
    { key: 'followup_quotation_idle_days', label: 'Sent quotation untouched for', unit: 'working days' },
    { key: 'followup_invoice_overdue_days', label: 'Invoice overdue by', unit: 'days' },
    { key: 'followup_invoice_idle_days', label: 'Overdue invoice unchased for', unit: 'working days' },
    { key: 'followup_grace_days', label: 'Then tell management after', unit: 'working days' },
    { key: 'followup_reescalate_days', label: 'Remind management again every', unit: 'working days' },
    { key: 'followup_escalation_emails', label: 'Management addresses', type: 'list' },
    { key: 'followup_cc_owner_on_escalation', label: 'Tell the owner when escalated', type: 'boolean' },
  ],
},
```

Check which `type` values the Settings renderer supports (look at how
existing items render) and add `boolean` if it does not exist.

### 7.2 Follow-ups page: `web/src/pages/FollowUps.jsx`, route `/follow-ups`

Built from the existing `ListPage` / shadcn components, like `Collections.jsx`.

- Tabs: **Waiting** (reminded, inside grace), **Escalated**, **Resolved**
  (last 30 days).
- Columns: record (link), kind, client, owner, due on, reminded, respond by,
  working days without activity, status / resolved reason.
- Filters: owner (admins only), kind.
- Admins: a summary strip from `/api/follow-ups/summary` (per owner:
  reminded, resolved by activity, escalated, rescheduled).
- Sidebar entry for everyone (sales see their own), under the same group as
  Tasks. Add a command-palette entry in `web/src/lib/commands.js`.
- Light and dark mode via the existing tokens in `styles/globals.css`.

### 7.3 Record banner and `?log=1`

On the enquiry list detail, `QuotationDetail.jsx`, and the payment-stage row
in `Collections.jsx`: when `/api/follow-ups/record` returns an open cycle,
show a slim banner: "Follow-up due since 28 Sep. Reminder sent 30 Sep. Log
activity by 2 Oct or it goes to management." with a **Log a touch** button
that opens the existing dialog in `Timeline.jsx` (or `LogDialog` in
`Collections.jsx` for a stage).

When the page URL has `?log=1`, open that dialog on load. That is where the
email links land.

After logging, invalidate the follow-up query so the banner disappears (the
cycle itself resolves on the next job run; the banner should hide as soon as
activity exists after `reminded_at`, so compute "activity since reminder" in
the `/record` endpoint with `lastActivity()` rather than waiting for the
job).

---

## 8. Tests

Follow the existing split: pure tests always run; database tests run when
`TEST_DATABASE_URL` is set.

| File | What it proves |
| --- | --- |
| `server/test/followUps.test.js` (pure) | Due rules per kind (§4.1) incl. boundaries (exactly N working days, a holiday in between, a weekend); closed/paid/on-hold/promised never due; every transition in §4.3 including reassignment, rescheduling, unowned, re-escalation timing, the `disabled` sweep; activity before the reminder does not resolve, activity after it does; activity by a colleague counts. |
| `server/test/followUpsRun.test.js` (DB) | Seed one of each kind with an owner; run with an injected `send` returning `sent` → reminder cycles written with the right `respond_by`. Advance `today` past grace → escalation sent to admins + `followup_escalation_emails`, cycle marked. Log a touch → next run resolves `activity`. Injected `send` returning `suppressed` → no cycle, retried next run. No recipients → ops alert raised, nothing marked. Running twice the same day sends nothing the second time. `followup_enabled=false` sends nothing. Automated `collection_log` row does not count. |
| `server/test/emailTemplates…` (extend the existing template tests if any, else new) | Subjects and counts; every value escaped (put `<script>` in a client name); links use `public_app_url`. |
| `server/test/authorization.test.js` | Passes with the new routes declared. Add cases: a sales user sees only their own cycles; `/summary` is admin-only; `/record` on another user's record is refused. |
| `server/test/migrations.test.js` / `check-migrations.sh` | Migration applies on an upgraded database and matches `schema.sql`. |
| `web/e2e` (Playwright) | Optional: admin opens `/follow-ups` and sees a seeded escalated item; clicking it with `?log=1` opens the touch dialog. Add seed rows in the e2e seed, not in `seed.sql`. |

---

## 9. Order of work

Each step leaves `main`-mergeable code with tests green.

1. **Migration 063** + `schema.sql` + `automated = true` in
   `runPaymentReminders`. Run `check-migrations.sh`.
2. **`followUps.js` pure rules** (`planFollowUps`, due rules) with
   `followUps.test.js`. No database yet.
3. **`lastActivity()`** query + the runner + templates + `jobs.js` entry;
   DB-backed tests. Feature still off by default.
4. **Routes** + authz policy + notification group; authorization tests.
5. **Web**: Settings section, Follow-ups page, banner, `?log=1`.
6. **Docs**: README job table and settings, `PROGRESS.md` (plain language,
   no code), `ISSUE-PLAN.md` row, a short section in
   [operations.md](operations.md) ("an owner says they were escalated
   unfairly": check `email_log` for their reminder and the cycle row).
7. Run every check in PROJECT-CONTEXT §4.5, then open the PR with
   `Fixes #<issue>`.

Go-live (the lead's call): set `followup_escalation_emails`, run the job once
by hand from the Emails & jobs page in `EMAIL_MODE=sandbox`, read the
digests, then switch `followup_enabled` on in production.

---

## 10. Later (not in this PR)

- Second escalation level (e.g. director after N re-escalations):
  `escalation_count` already records the level.
- Per-kind owners: invoices to the project manager or finance rather than
  the salesperson.
- A "snooze with reason" button that resolves a cycle as `snoozed` with a
  note visible to management.
- Follow-up response-time KPI per salesperson in the sales reports.

---

## 11. Decisions needed from the lead

Build with the **recommended** answer; list the decisions in the PR so they
can be changed through Settings or a small follow-up.

| # | Question | Recommended |
| --- | --- | --- |
| D1 | Who is "management"? | All active `admin` users plus `followup_escalation_emails`. |
| D2 | Does moving an enquiry's follow-up date count as following up? | It stops the cycle (`rescheduled`) but is counted and shown to management. |
| D3 | Should stages waiting to be invoiced (To Invoice) be chased by the owner? | No; finance and My Today cover them. |
| D4 | Does activity by someone other than the owner count? | Yes. |
| D5 | Grace and idle defaults (§4.5) | 2 working days grace; 3 / 5 / 5 idle. |
| D6 | Should the owner be told when escalated? | Yes, a short separate email. |
| D7 | Does a "no answer" call count as activity? | Yes: it is an attempt, and it is logged. |

---

## 12. Definition of done

- With `followup_enabled = true` and `EMAIL_MODE=sandbox`, a seeded overdue
  enquiry, idle quotation and overdue invoice each produce one reminder
  digest to their owner on the first working-day run, and none on a second
  run the same day.
- With no activity, the run after `respond_by` sends one escalation digest
  to every admin and each `followup_escalation_emails` address, naming the
  owner and the record.
- Logging a touch, chase, outbound email, note or completed task on the
  record before `respond_by` prevents the escalation; the banner disappears
  at once and the cycle resolves on the next run.
- Every email is in `email_log`; every run is in `job_runs` with a readable
  summary.
- A sales user sees only their own cycles; admins see all.
- Every test in [follow-up-escalation-test-plan.md](follow-up-escalation-test-plan.md)
  exists and passes, and its workflow walkthrough (§10) is signed off.
- All CI checks in PROJECT-CONTEXT §4.5 pass; README, PROGRESS.md and
  ISSUE-PLAN.md are updated.
