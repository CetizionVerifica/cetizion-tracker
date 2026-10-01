# Follow-up reminders and escalation: test plan

How to prove that the feature in
[follow-up-escalation-plan.md](follow-up-escalation-plan.md) does what it
says, and how a reviewer walks the whole workflow before it goes live.

The plan has two readers:

- **Claude Code or a developer writing the tests.** Sections 3 to 9 list every
  automated test, with its ID, the file it goes in, its setup and the result
  it expects.
- **A reviewer, the lead or a manager checking the workflow.** Section 10 is
  a script to follow day by day in a QA copy of the app, with the emails each
  person should receive. Section 12 is the checklist for reviewing the PR.

Section numbers in brackets, such as (§4.3), refer to the implementation plan.

---

## 1. What has to be true

These are the promises the feature makes. Every test below traces back to one
of them (section 13 has the matrix).

| # | Promise |
| --- | --- |
| P1 | An owner is emailed once per working day about every enquiry, quotation and overdue invoice of theirs that needs a follow-up. |
| P2 | Records that are closed, won, lost, paid, on hold or have a promise to pay are never chased. |
| P3 | Real activity logged on the record by any person after the reminder stops the escalation. |
| P4 | Activity by an automated job, and edits that only change the record, are not counted as following up. |
| P5 | If nothing is logged by the respond-by date, management gets one daily digest naming the record and the owner. |
| P6 | Nobody is escalated over a reminder they never received. |
| P7 | A record with no reachable owner goes to management instead of being dropped. |
| P8 | No email is ever sent twice for the same thing, whether the job runs twice, overlaps or crashes halfway. |
| P9 | Every day count uses working days and the business date (time zone and holidays respected). |
| P10 | The feature does nothing until it is switched on, and stops at once when switched off. |
| P11 | A sales user sees only their own follow-ups. Management sees all of them. |
| P12 | Existing behaviour does not change: client payment reminders, the notification bell, digests and the "No contact" list. |

---

## 2. Test levels

| Level | Where | Runs in CI | Needs a database |
| --- | --- | --- | --- |
| **Unit (rules)** | `server/test/followUps.test.js` | Yes | No |
| **Email templates** | `server/test/followUpEmails.test.js` | Yes | No |
| **Integration (runner and SQL)** | `server/test/followUpsRun.test.js` | Yes (DB job) | Yes, `TEST_DATABASE_URL` |
| **Migration** | `scripts/ci/check-migrations.sh`, `server/test/migrations.test.js` | Yes | Yes |
| **Authorization** | `server/test/authorization.test.js` + new cases | Yes | Yes |
| **API** | `server/test/followUpsRoutes.test.js` | Yes | Yes |
| **Web unit** | `web/test/followUps.test.js` (banner and `?log=1` helpers) | Yes | No |
| **Browser (Playwright)** | `web/e2e/followUps.spec.js` | Yes | Seeded QA database |
| **Workflow walkthrough (manual UAT)** | Section 10 of this file, QA database, `EMAIL_MODE=sandbox` | No | QA copy |
| **Go-live smoke** | Section 11 | No | Production, with the feature off and then on |

Conventions to follow, matching the existing suites:

- Use `node:test` and `node:assert/strict`, in the same style as
  `server/test/reminders.test.js`.
- Write DB suites as `describe(..., { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' })`,
  in the same style as `server/test/activityLog.test.js`. Each suite creates
  its own throwaway database, so suites never share rows.
- **Never use the real clock.** Pass `today` (and `now`) into every rule and
  runner. Inject `send` so a test decides whether a message counts as `sent`,
  `suppressed` or `failed` without needing SMTP.
- Use the `/test-app` skill (`.claude/skills/test-app/SKILL.md`) to run the
  whole suite against the isolated QA database before opening the PR.

---

## 3. Fixtures

### 3.1 The reference calendar

Every dated test uses this calendar, so expected dates can be checked by hand.

```
          Sep 2026                       Oct 2026
Mo Tu We Th Fr Sa Su            Mo Tu We Th Fr Sa Su
28 29 30                                 1  2  3  4
                                 5  6  7  8  9 10 11
                                12 13 14 15 16 17 18
```

- **Holiday:** `2026-10-02` (Gandhi Jayanti), added to `holidays` in the
  tests that say "with holiday". Without it, Friday 2 October is a normal
  working day.
- `addWorkingDays(d, n)` does not count the start date
  (`server/src/lib/businessDate.ts`). So `addWorkingDays('2026-10-05', 2)`
  is `2026-10-07`.
- Default settings (§4.5): enquiry idle 3, quotation idle 5, invoice overdue
  1, invoice idle 5, grace 2, re-escalate 5.

### 3.2 People

| Key | `users` row | Role | Use |
| --- | --- | --- | --- |
| `asha` | Asha, `asha@qa.example` | sales | Owner of most records |
| `ben` | Ben, `ben@qa.example` | sales | Second owner; checks digests are split per owner and scoping |
| `meera` | Meera, `meera@qa.example` | admin | Management recipient |
| `old` | Ravi, `ravi@qa.example`, `active = false` | sales | Owner who has left |
| setting | `followup_escalation_emails = 'md@qa.example, Meera@QA.example'` | — | Extra recipient. Includes a case-duplicate of Meera's address. |

### 3.3 Record builders (pure tests)

Write small builders, like `stage()` in `reminders.test.js`, so each test only
states what differs:

```js
const enquiry = (x = {}) => ({ entity: 'enquiry', entity_id: 'ENQ-1', status: 'Contacted', next_follow_up_at: '2026-10-05',
  enquiry_date: '2026-09-20', created_at: '2026-09-20T05:00:00Z', owner_user_id: 1, owner_email: 'asha@qa.example', owner_name: 'Asha', owner_active: true, ...x });
const quotation = (x = {}) => ({ entity: 'quotation', entity_id: 'Q-1', status: 'Submitted', sent_at: '2026-09-28T06:00:00Z',
  accepted_at: null, closed_at: null, owner_user_id: 1, owner_email: 'asha@qa.example', ...x });
const invoice = (x = {}) => ({ entity: 'payment_stage', entity_id: '7', invoice_no: 'CVPL/26-27/40', stage_status: 'Overdue',
  invoice_due_date: '2026-09-20', days_overdue: 15, on_hold: false, promise_to_pay_date: null, owner_user_id: 1, owner_email: 'asha@qa.example', ...x });
const cycle = (x = {}) => ({ id: 1, entity: 'enquiry', entity_id: 'ENQ-1', due_on: '2026-10-05', owner_user_id: 1,
  reminded_at: '2026-10-05T03:45:00Z', respond_by: '2026-10-07', escalated_at: null, last_escalated_on: null, escalation_count: 0, ...x });
```

Shape these to match whatever the real query returns. If the builders and the
query disagree, the builders are wrong.

---

## 4. Unit tests: when a record is due (§4.1)

File: `server/test/followUps.test.js`. Pure functions, no database.

| ID | Case | Expected |
| --- | --- | --- |
| U-D01 | Enquiry `Contacted`, `next_follow_up_at = 2026-10-05`, today `2026-10-05`, no activity | Due, `due_on = 2026-10-05` |
| U-D02 | Same, today `2026-10-02` (before the date) | Not due |
| U-D03 | Same, but a touch was logged at `2026-10-05T02:00` (before the 09:15 run) | Not due. The follow-up happened on the day. |
| U-D04 | Each open status: `New`, `Contacted`, `Qualified`, `Nurture` | Due |
| U-D05 | Closed statuses: `Converted`, `Unqualified` | Never due |
| U-D06 | Enquiry with no follow-up date, created `2026-09-30`, no activity, today `2026-10-05` | Due. Working days since 30 Sep are 1, 2 and 5 Oct, which is 3. |
| U-D07 | Same, with the holiday on 2 October | Not due on 5 October (2 working days); due on 6 October |
| U-D08 | No follow-up date, last activity `2026-10-01`, today `2026-10-05` | Not due (2 working days) |
| U-Q01 | Quotation `Submitted`, sent `2026-09-28`, no activity, today `2026-10-05` | Due (5 working days) |
| U-Q02 | Same, with the holiday on 2 October | Due on `2026-10-06`, not on 5 October |
| U-Q03 | `Under Negotiation`, last touch `2026-10-01` | Not due until `2026-10-08` (`2026-10-09` with the holiday) |
| U-Q04 | `sent_at` is null (typed in or imported, never sent) | Counted from `quotation_date` (else the day it was entered): due on 5 Oct for a quotation dated 28 Sep. The email says "dated". A Draft is never due. (As built; the plan first said never due.) |
| U-Q05 | `accepted_at` set, `closed_at` set, or status `Won - PO Received`, `Lost`, `On Hold` or `Draft` | Never due |
| U-I01 | Invoice `Overdue`, 15 days overdue, no chase ever | Due |
| U-I02 | `Overdue`, last human chase 2 working days ago | Not due |
| U-I03 | `Partially Paid`, past due, with an amount outstanding | Due |
| U-I04 | `on_hold = true` | Never due |
| U-I05 | `promise_to_pay_date = today` and `= tomorrow` | Not due. On `promise_to_pay_date = yesterday`, due. |
| U-I06 | `invoice_no` null (stage `To Invoice`) | Never due (decision D3) |
| U-I07 | `days_overdue = 0` with `followup_invoice_overdue_days = 1` | Not due |
| U-I08 | Stage `Paid` | Never due |
| U-S01 | A setting that is blank, `'abc'` or negative | The default is used, and the test documents which one |
| U-S02 | Today is Saturday `2026-10-03`, or the holiday `2026-10-02` | `planFollowUps` returns nothing to do and gives the reason `not a working day` |

### Tasks as follow-up dates (as built, plan §4.1)

| ID | Case | Expected |
| --- | --- | --- |
| T-01 | Quotation sent 1 Oct (inside the quiet period), open task due 5 Oct, today 5 Oct | Due on 5 Oct, reason `task`, the task's title in the email |
| T-02 | Quotation or invoice quiet for weeks, open task due 12 Oct, today 5 Oct | Not due: the follow-up is planned |
| T-03 | Task due 1 Oct, a touch on 2 Oct | Not due on 5 Oct; due on the quiet rule from 2 Oct (9 Oct) |
| T-04 | Enquiry date 12 Oct and a task due 1 Oct; and the reverse | Due on the earliest missed date, with its reason |
| T-05 | Invoice 0 days overdue with a task due 1 Oct | Not due until it is overdue enough |
| T-06 | Open cycle, task moved to a later date with no contact | Resolved as `rescheduled`; a task still overdue escalates as usual |
| T-07 | Two open tasks, one done task, one task attached through `task_targets` | The earliest open dated task counts, on every record it stands on; a done task does not |
| T-08 | `GET /api/follow-ups/record` on a record with a planned task | `next_task` gives its date and title, with or without an open cycle |

## 5. Unit tests: the cycle (§4.3)

Same file. Input: due candidates, open cycles, the activity map and today.
Output: `remind`, `escalate`, `reescalate`, `resolve` and `skipped`.

| ID | Case | Expected |
| --- | --- | --- |
| U-C01 | Due, no open cycle, owner active with an email | `remind` |
| U-C02 | Due, open cycle reminded 5 Oct, today 6 Oct, no activity | Nothing: still inside the grace period |
| U-C03 | Same, today 7 Oct (= `respond_by`) | Nothing: the last day is still allowed |
| U-C04 | Same, today 8 Oct | `escalate` |
| U-C05 | Reminded 1 Oct with the holiday | `respond_by = 2026-10-06`. Escalates on 7 Oct, not before. |
| U-C06 | Activity at `2026-10-06T11:00`, after the reminder | `resolve` with reason `activity`. No escalation. |
| U-C07 | Activity at `2026-10-05T03:00`, before `reminded_at` | Does not resolve. The reminder already accounted for it. |
| U-C08 | Activity by a different user (Ben on Asha's record) | Resolves with reason `activity` (decision D4) |
| U-C09 | Escalated on 8 Oct, no activity, today 14 Oct (4 working days) | Nothing |
| U-C10 | Same, today 15 Oct (5 working days) | `reescalate`, with `escalation_count` going from 1 to 2 |
| U-C11 | Escalated, then a touch is logged | `resolve` with reason `activity`. The escalation history stays on the row. |
| U-C12 | Open cycle, and the enquiry becomes `Converted` | `resolve` with reason `closed` |
| U-C13 | Open cycle, and the invoice is paid | `resolve` with reason `paid` |
| U-C14 | Open cycle, and the stage is put on hold | `resolve` with reason `on_hold` |
| U-C15 | Open cycle, and a promise to pay is recorded | `resolve` with reason `promised` |
| U-C16 | Open cycle, and the enquiry's `next_follow_up_at` is moved later with no touch | `resolve` with reason `rescheduled` (decision D2) |
| U-C17 | Open cycle for Asha, and the record is reassigned to Ben | Old cycle resolves as `reassigned`. Ben gets a reminder on the same run. |
| U-C18 | Due, owner null | Listed under **unowned**. The cycle is recorded with `reminded_at = null` and `escalated_at` set. |
| U-C19 | Due, owner inactive (Ravi) or with no email | Same as U-C18 |
| U-C20 | Unowned cycle already recorded, run again the next day | Not listed again until the re-escalation interval passes |
| U-C21 | Open cycle older than `respond_by + reescalate_days`, after the feature was switched off and on again | `resolve` with reason `disabled`, not a burst of escalations |
| U-C22 | Two due records for Asha and one for Ben | `remind` is grouped by owner: Asha has two items, Ben has one |
| U-C23 | Due and already has an open, un-escalated cycle | No second `remind`. The item appears in Asha's "Still waiting" section. |
| U-C24 | Every output is deterministic | The same input gives the same output, sorted by owner and then by record |

## 6. Unit tests: activity counting (§4.2)

These test the SQL in `lastActivity()`, so they live in the **DB** suite
(`followUpsRun.test.js`). They are listed here because they are rules. Seed
one record of each kind, insert a single source row, and assert the value of
`last_activity_at`.

| ID | Source row | Counts? |
| --- | --- | --- |
| U-A01 | `communications` on the record, outcome `connected` | Yes |
| U-A02 | `communications` with outcome `no_answer` | Yes (decision D7) |
| U-A03 | `communications` on a **different** record of the same company | No |
| U-A04 | `collection_log` on the stage, `automated = false` | Yes |
| U-A05 | `collection_log` written by `runPaymentReminders` | No (`automated = true`) |
| U-A06 | `collection_log` written by `runPaymentReminders` started by an admin's **Run now** (`startedBy` is their username) | No. This is the reason the column exists. |
| U-A07 | Outbound `email_messages` on a thread linked to the record | Yes |
| U-A08 | Inbound `email_messages` on the same thread | No |
| U-A09 | `notes` on the record | Yes |
| U-A10 | A task on the record marked done | Yes, at `completed_at`. An open task does not count. |
| U-A11 | Quotation stage change in `quotation_stage_history` | Yes |
| U-A12 | New quotation revision | Yes |
| U-A13 | Only `updated_at` changed on the record | No |
| U-A14 | Several sources | Returns the **latest** timestamp |
| U-A15 | 500 keys requested | One query, completed in under 200 ms on the seeded database |

---

## 7. Email tests

File: `server/test/followUpEmails.test.js`. Pure, using the templates only.

| ID | Case | Expected |
| --- | --- | --- |
| E-01 | Reminder with 2 enquiries, 1 quotation and 1 invoice | Subject reads `Follow up today: 2 enquiries, 1 quotation, 1 invoice`. The singular and plural forms are right. |
| E-02 | Reminder rows | Each row has the record number, client, the reason it is due, the respond-by date (`07 Oct 2026` format, like the other templates) and a link |
| E-03 | Links | `public_app_url` + path + `?log=1`. A trailing slash on the setting does not produce `//`. |
| E-04 | "Still waiting" section | Present only when there are waiting items |
| E-05 | Escalation grouped by owner, with new, still-open and no-owner sections | Each section appears only when it has items. The counts in the subject match the rows. |
| E-06 | Escalation rows | Show the owner, reminded on, respond by, working days without activity and the value in the right currency (`₹1,20,000`, `$5,000`) |
| E-07 | `<script>` or `&` in a client name, owner name or quotation number | Escaped in the HTML. Plain in the text version. |
| E-08 | Owner digest with 60 items | Capped at 50, followed by "and 10 more in the tracker" (implementation plan, pitfall 6) |
| E-09 | Escalated notice to the owner | Lists only **that owner's** items |
| E-10 | Text and HTML versions | Carry the same facts. Snapshot both so wording changes show up in review. |

---

## 8. Integration tests: the runner

File: `server/test/followUpsRun.test.js`, DB-backed. Seed the people in §3.2,
then for each test seed only the records it needs. Use an injected `send`
that records each call and returns a configurable status.

| ID | Steps | Expected |
| --- | --- | --- |
| I-01 | `followup_enabled = false`, due records exist, run | Result says `followup_enabled is false`. No `send` calls and no cycles. |
| I-02 | Enabled, Saturday or holiday, run | Skipped with a reason. Nothing sent. |
| I-03 | One due record of each kind for Asha and one enquiry for Ben, run on 5 Oct | Two `send` calls (one per owner) with template `follow_up_reminder`. Four cycles with `respond_by = 2026-10-07` and `reminder_email_id` set. |
| I-04 | Run again on 5 Oct | No new sends and no new cycles (P8) |
| I-05 | `send` returns `suppressed` for Asha | No cycle for Asha's items, and the result lists them as not reminded. On the next run with `sent`, the cycles are created. Never escalated without a sent reminder (P6). |
| I-06 | `send` returns `failed` | Same as I-05 |
| I-07 | After I-03, run on 6 Oct and 7 Oct | No escalation |
| I-08 | Run on 8 Oct with no activity | One escalation `send` to each of `meera@qa.example` and `md@qa.example`. Meera gets **one** email, not two, despite the case-duplicate. Cycles have `escalated_at`, `last_escalated_on = 2026-10-08` and `escalation_count = 1`. One `follow_up_escalated` notification per cycle. One `follow_up.escalated` webhook event per cycle. |
| I-09 | Same as I-08, with `followup_cc_owner_on_escalation = true` | Asha and Ben each get a notice listing only their own items |
| I-10 | After I-03, `POST /api/communications` on ENQ-1 on 6 Oct, then run on 8 Oct | ENQ-1 resolves with reason `activity`. The other items escalate. |
| I-11 | Escalation recipients are empty (no admin with an email, and the setting is blank) | An ops alert is raised. Cycles are **not** marked escalated. They escalate once a recipient exists. |
| I-12 | Escalation `send` returns `failed` for every recipient | Not marked. Retried on the next run. |
| I-13 | Escalation `sent` to one recipient and `failed` to the other | Marked escalated. The failure is visible in `email_log`. |
| I-14 | Two runs started at the same moment (`Promise.all`) | One run does the work. The other returns `already running`. No duplicate emails or cycles (P8). |
| I-15 | `send` throws on the second owner | The first owner's cycle stays written. Rerunning sends only to the second owner. |
| I-16 | An unowned quotation and one owned by inactive Ravi | Both appear under "No owner" in the escalation on the **first** run, with no reminder (P7) |
| I-17 | `runJob('followups.daily', { startedBy: 'meera@qa.example' })` | A `job_runs` row with the summary JSON (counts, sent, skipped, escalated, resolved, unowned) |
| I-18 | `AUTH_MODE=shared` with no `users` rows | No owner emails. Everything appears under "No owner". The escalation goes to `followup_escalation_emails`, or to `digest_email` when that is blank. |
| I-19 | Run 30 days through the calendar on one record with no activity | Exactly 1 reminder, 1 escalation and re-escalations every 5 working days. Count every send. |
| I-20 | `EMAIL_MODE=log` with the real `sendMail` | Rows in `email_log` with `suppressed`. No cycles reminded. This documents why local testing needs sandbox mode. |

## 9. Migration, authorization, API and browser tests

### Migration

| ID | Case | Expected |
| --- | --- | --- |
| M-01 | `scripts/ci/check-migrations.sh origin/main` | Passes. The upgraded schema matches `schema.sql`. |
| M-02 | Apply 063 to a database holding `collection_log` rows written by the old reminder job | Those rows get `automated = true`. Rows typed by a person stay `false`. |
| M-03 | Apply 063 twice (`IF NOT EXISTS`) and to an empty database | No error |
| M-04 | Insert two open cycles for the same record | Rejected by `follow_up_cycles_open_key`. A second cycle after the first is resolved is allowed. |
| M-05 | Delete a user who owns cycles | Cycles stay, `reminded_user_id` becomes null and `owner_name` is kept |
| M-06 | `v_enquiries` and every other view | Unchanged (no column added to `enquiries`) |

### Authorization and API

| ID | Case | Expected |
| --- | --- | --- |
| A-01 | Route inventory test | Passes: all three routes are declared in `policy.js` |
| A-02 | Asha `GET /api/follow-ups` | Only cycles on records Asha owns |
| A-03 | Meera `GET /api/follow-ups` | All cycles, including unowned ones |
| A-04 | Asha `GET /api/follow-ups/summary` | 403 |
| A-05 | Asha `GET /api/follow-ups/record?entity=quotation&id=<Ben's>` | Refused, the same way the timeline refuses it |
| A-06 | Not signed in | 401 on all three routes |
| A-07 | Filters `status=open/escalated/resolved`, `entity` and `owner` | Correct rows. The derived status matches the timestamps. |
| A-08 | `GET /record` after a touch logged since the reminder | Reports no outstanding follow-up before the job has run, so the banner hides at once |
| A-09 | Unknown `entity` or a missing `id` | 422 |

### Browser (Playwright)

| ID | Case | Expected |
| --- | --- | --- |
| W-01 | Admin opens `/follow-ups` with seeded waiting, escalated and resolved cycles | Three tabs with the right rows. The summary strip is visible. |
| W-02 | Sales user opens `/follow-ups` | Only their rows. No owner filter or summary strip. |
| W-03 | Open `/quotations/Q-1?log=1` | The "Log a touch" dialog opens on load |
| W-04 | Banner on a record with an open cycle → **Log a touch** → save | The dialog closes and the banner disappears without a reload |
| W-05 | A payment stage on Collections with an open cycle | The banner or marker appears, and **Log a chase** opens `LogDialog` |
| W-06 | Settings → Follow-ups section | All nine settings render, save and reload. The on/off control works. |
| W-07 | Light and dark mode, and a 375 px wide screen | Page and banner are readable. No horizontal scroll. |
| W-08 | Command palette "Follow-ups" | Navigates to the page |
| W-09 | `/test-app` smoke test of every screen | Passes, including the new route |

---

## 10. Workflow walkthrough (manual UAT)

This is for the reviewer: the lead, a manager and one salesperson. It walks
the real workflow in a QA copy over a simulated fortnight. It takes about
45 minutes.

### 10.1 Setup

1. Use the QA database the `/test-app` skill creates
   (`cetizion_tracker_qa`) or staging. **Never production.**
2. Set `EMAIL_MODE=sandbox` and put on `EMAIL_ALLOWLIST` the inboxes the
   reviewers can read (for example `@yourcompany.com`).
3. Create users: **Asha** (sales), **Ben** (sales) and **Meera** (admin),
   with real reviewer inboxes. In Settings, set
   `followup_escalation_emails` to a manager's inbox.
4. Seed the records below and set their dates as shown. Use the QA date
   override, a database clock or the job's `today` option from an admin
   script. The reviewer then **runs the job from Emails & jobs → Run now**
   for each simulated day, passing that day.

| Record | Owner | State |
| --- | --- | --- |
| ENQ-A1 | Asha | `Contacted`, follow-up date = Day 1 |
| ENQ-A2 | Asha | `New`, no follow-up date, created 4 working days before Day 1 |
| Q-A1 | Asha | `Submitted`, sent 6 working days before Day 1 |
| INV-A1 | Asha | Invoiced, 12 days overdue, never chased |
| ENQ-B1 | Ben | `Qualified`, follow-up date = Day 1 |
| Q-X1 | nobody | `Under Negotiation`, sent 8 working days ago |
| INV-H1 | Asha | Overdue, **on hold** |
| ENQ-C1 | Ben | `Converted` |

> Day 1 = Monday 5 Oct 2026 in the reference calendar. Grace is 2 working
> days, so respond-by is Wednesday 7 Oct and escalation is on Thursday 8 Oct.

### 10.2 Script

Tick each line. **Expected** is what each person sees in their inbox and in
the app.

| Step | Day | Action | Expected | ✓ |
| --- | --- | --- | --- | --- |
| 1 | Before | `followup_enabled` off. Run the job. | Job result says it is switched off. No email to anyone. | ☐ |
| 2 | Mon 5 | Switch on. Run the job. | **Asha:** one email listing ENQ-A1, ENQ-A2, Q-A1 and INV-A1, each with a reason, "respond by 07 Oct 2026" and a link. **Ben:** one email with ENQ-B1. **Management:** one escalation with Q-X1 under "No owner". INV-H1 and ENQ-C1 appear nowhere. | ☐ |
| 3 | Mon 5 | Run the job again. | No new email. | ☐ |
| 4 | Mon 5 | Asha opens the Q-A1 link from her email. | The quotation opens with the "Log a touch" dialog. A banner says a reminder was sent and gives the respond-by date. | ☐ |
| 5 | Tue 6 | Asha logs a call on Q-A1 and a chase on INV-A1 (Collections → Log a chase). | Banners disappear straight away. | ☐ |
| 6 | Tue 6 | Ben moves ENQ-B1's follow-up date to Fri 9 without logging anything. | Ben's banner goes. The follow-up resolves as **rescheduled** on the next run. | ☐ |
| 7 | Tue 6 | Run the job. | Q-A1 and INV-A1 resolve (activity). ENQ-B1 resolves (rescheduled). No emails apart from a "Still waiting" list if anything new became due. | ☐ |
| 8 | Wed 7 | Run the job. | Nothing escalates: Wednesday is the last allowed day. | ☐ |
| 9 | Thu 8 | Run the job. | **Management:** one escalation listing ENQ-A1 and ENQ-A2 under Asha, with "reminded 05 Oct, respond by 07 Oct, 3 working days with no activity". **Asha:** a short notice that two items went to management. The bell shows the escalations to Meera. | ☐ |
| 10 | Thu 8 | Meera opens Follow-ups. | **Escalated** tab: ENQ-A1, ENQ-A2 and Q-X1. **Resolved** tab: Q-A1, INV-A1 (activity) and ENQ-B1 (rescheduled). The summary strip shows Ben with 1 rescheduled. | ☐ |
| 11 | Thu 8 | Asha opens Follow-ups. | Only her own items. Ben's and the unowned item are not visible. | ☐ |
| 12 | Thu 8 | Meera assigns Q-X1 to Ben. | On the next run, Ben gets a reminder for Q-X1 and the unowned cycle resolves as `reassigned`. | ☐ |
| 13 | Fri 9 | Run the job. | ENQ-B1 is due again (its new date). Ben is reminded. ENQ-A1 and ENQ-A2 do not escalate again yet. | ☐ |
| 14 | Fri 9 | Asha logs a note on ENQ-A1. | ENQ-A1 resolves on the next run, and stays escalated in the history. | ☐ |
| 15 | Thu 15 | Run the job. | ENQ-A2 is listed under **still open** in the management digest (5 working days after the 8 Oct escalation). | ☐ |
| 16 | any | Put INV-A1 on hold, or record a promise to pay for a future date. | It is never chased while that holds. | ☐ |
| 17 | any | Switch `emails_enabled` off (the kill switch). Run the job. | Every email is logged as suppressed. No cycle is reminded or escalated. | ☐ |
| 18 | any | Switch `followup_enabled` off. Run the job. | Nothing happens. Switch it on 3 weeks later: old cycles resolve as `disabled`, with no burst of escalations. | ☐ |
| 19 | any | Check client payment reminders and the 08:30 digest. | Clients get the same reminders as before. The digest and bell are unchanged apart from the new escalation kind. | ☐ |
| 20 | any | Open Emails & jobs. | Every email above is in the log with template `follow_up_reminder`, `follow_up_escalation` or `follow_up_escalated_notice`. Each run is in the job history with a readable summary. | ☐ |

### 10.3 Things to judge, not just tick

The reviewer should note opinions on these. They are not pass/fail:

- Is the reminder email clear enough to act on from a phone?
- Is the escalation fair? Would a manager know whom to ask and about what?
- Are the defaults right for the team (decisions D1 to D7 in the
  implementation plan)?
- Is one email a day enough, or too many?

---

## 11. Go-live smoke (production)

The lead runs this. It does not need test data.

1. Deploy with `followup_enabled = false` (the default). Check `/api/health`.
   Check that the job is listed in Emails & jobs and that its first run says
   it is switched off.
2. Set `followup_escalation_emails`.
3. Temporarily set `EMAIL_MODE=sandbox`, with only the lead on the allowlist.
   Switch the feature on and click **Run now**. Read the result: are the
   counts of due items per owner plausible? The first run catches up on every
   stale record, so expect large numbers (implementation plan, pitfall 6).
4. Return to `EMAIL_MODE=live`. Tell the sales team the reminders start
   tomorrow, then leave the feature on.
5. After a week, check the Follow-ups summary: reminded, resolved by
   activity, rescheduled and escalated per owner.

**Rollback:** switch `followup_enabled` off. Nothing else is needed. Leave the
migration in place.

---

## 12. PR review checklist

For the code reviewer. Each item should be checked against the diff, not
assumed.

- [ ] No real clock in rules or runner. `today` and `now` are parameters, and every date comes from `businessToday()`.
- [ ] All day counts use `addWorkingDays` or `workingDaysBetween` with holidays.
- [ ] Ownership comes from `owner_user_id` through `auth/ownership.js`. `sales_person` is not used for anything.
- [ ] A cycle is only reminded after `status = 'sent'`, and only escalated after at least one recipient got `sent`.
- [ ] Each cycle row is written right after its send. The partial unique index is the guard. The advisory lock is taken.
- [ ] `runPaymentReminders` writes `automated = true`. The migration backfills old rows.
- [ ] `lastActivity()` reads every source in §4.2, excludes inbound mail and automated rows, and is parameterised (no string interpolation of ids).
- [ ] Escalation recipients are de-duplicated case-insensitively. Owners cannot opt out of escalation.
- [ ] Every template value goes through `esc()`.
- [ ] The three routes are declared in `policy.js`, and sales scoping is tested.
- [ ] Derived status is not stored. No column was added to `enquiries`, `quotations` or `payment_stages`.
- [ ] `schema.sql` matches the migration. The migration has no `BEGIN`/`COMMIT`.
- [ ] Webhook payloads carry ids and counts only.
- [ ] README job table, `PROGRESS.md` and `ISSUE-PLAN.md` are updated, and the decisions are listed in the PR.
- [ ] Every test ID in this plan exists, or the PR says why it was dropped.

---

## 13. Traceability

| Promise | Tests |
| --- | --- |
| P1 Owner emailed daily | U-D01, U-D04, U-D06, U-Q01, U-I01, U-I03, U-C01, U-C22, U-C23, E-01–E-04, I-03, UAT 2 |
| P2 Closed records never chased | U-D05, U-Q04, U-Q05, U-I04–U-I08, U-C12–U-C15, UAT 2, 16 |
| P3 Activity stops escalation | U-C06, U-C08, U-C11, U-A01–U-A14, I-10, A-08, W-04, UAT 5, 14 |
| P4 Automation and edits do not count | U-A05, U-A06, U-A08, U-A13, M-02, U-C16, UAT 6 |
| P5 Management digest | U-C04, U-C10, E-05, E-06, I-08, I-09, I-19, UAT 9, 15 |
| P6 No escalation without a delivered reminder | I-05, I-06, I-20, UAT 17 |
| P7 Unowned records reach management | U-C18–U-C20, I-16, I-18, UAT 2, 12 |
| P8 No duplicates | I-04, I-14, I-15, M-04, UAT 3 |
| P9 Working days and business date | U-D07, U-Q02, U-C03, U-C05, U-S02, I-02 |
| P10 Off by default, kill switches | I-01, U-C21, UAT 1, 17, 18, go-live 1 |
| P11 Scoping | A-02–A-06, W-02, UAT 11 |
| P12 No regressions | Existing suites unchanged and green, U-A06, UAT 19 |

## 14. Entry and exit criteria

**Ready for review when:**

- every automated test above exists and passes locally under `/test-app full`
- CI is green: Types, Server tests and migrations, Web build, Playwright and
  Docker

**Ready for go-live when:**

- the UAT script in §10 has been completed and signed off by the lead and one
  salesperson, with every line ticked or a defect raised
- no open defect of severity 1 or 2

| Severity | Meaning | Example |
| --- | --- | --- |
| 1 | Wrong person emailed, a duplicate email, or private data leaked | Ben sees Asha's records, or a client receives an internal reminder |
| 2 | Escalation wrong or missed | Escalated despite activity, or never escalated |
| 3 | Wrong date or count, but the right people | Respond-by off by one working day |
| 4 | Wording or layout | Plural "1 enquiries" |
