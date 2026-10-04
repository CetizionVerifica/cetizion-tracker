# Daily Sales Briefing: why it does not go on its own, the wrong mail in it, and the format

Plan only; nothing here is built yet. Three problems reported from
production on 04 Oct 2026:

1. The briefing goes when **Send now** is pressed, but never on its own.
2. Its highlights include mail that has nothing to do with sales
   (marketing mail and the like).
3. Its layout should follow the reference briefing of 03 Oct 2026
   (`Daily_Sales_Briefing_2026-10-03.pdf`, four pages).

---

## 1. The briefing is not sent on schedule

### How the scheduled send works today

```
worker.js (pg-boss)  ── cron '56 8 * * *', Asia/Kolkata ──▶ runJob('reports.daily_briefing')
   └─ runDailyBriefing() ─▶ runReport(kind, { guarded: true })
         ├─ mis_daily_enabled must be 'true'            else: skipped, NO report_runs row
         ├─ period not already 'sent' (any trigger)    else: skipped, NO report_runs row
         ├─ build + AI + PDF
         └─ sendViaMailbox()  ─ EMAIL_MODE / emails_enabled / sandbox allowlist
                                 log  ⇒ report_runs 'skipped' + alert "composed but not delivered"
```

**Send now** (`POST /api/mis-reports/daily_briefing/send`) runs inside the
**API** process with `guarded: false`. So it skips both guards and uses the
API's environment. The schedule runs inside the **worker**, a separate
Dokploy application, with its own environment. That is why the button can
work while the schedule does not.

### Likely causes, most likely first

| # | Cause | Why it fits | How to confirm |
|---|---|---|---|
| A | **The worker is not running, or is still on an image from before PR #185.** In Dokploy the worker is a second application, so it has to be redeployed separately. pg-boss only adds a schedule for the jobs it knows about when the worker starts. | Nothing in the API depends on the worker, so if it is missing nothing complains (README, "The worker"). | `SELECT name, cron, timezone, updated_on FROM pgboss.schedule WHERE name LIKE 'reports.%';`. No rows means the worker never registered the job. Also look at the worker container's start log for `[worker] reports.daily_briefing at "56 8 * * *"`, and at the image tag / `SOURCE_COMMIT` on the worker compared with the API. |
| B | **`mis_daily_enabled` is still `false`.** Migration 075 ships both reports switched off. Send now ignores the switch. | A guarded skip writes **no** `report_runs` row, so the run history only ever shows the manual sends, which looks exactly like "never ran". | `SELECT key, value FROM settings WHERE key LIKE 'mis_%';` and `SELECT started_at, status, result FROM job_runs WHERE name = 'reports.daily_briefing' ORDER BY started_at DESC LIMIT 10;`. A `result` of `{"status":"skipped","skipped":"daily_briefing is switched off"}` confirms it. |
| C | **The worker's environment differs from the API's.** `EMAIL_MODE` falls back to `log` when unset (`config.js:84`). Missing Graph or token-encryption secrets break the sales@ send, and missing SMTP leaves no fallback. A missing AI key means no highlights. | In this case the scheduled run *is* recorded: `report_runs` has status `skipped` ("Composed and logged only…") or `failed`, `email_log` has status `suppressed` and `sent_by = 'schedule'`, and the ops alerts show "was composed but not delivered" or "not sent". | `SELECT created_at, status, sent_via, error, triggered_by FROM report_runs ORDER BY created_at DESC LIMIT 20;` and `SELECT created_at, status, mode, reason, error FROM email_log WHERE template = 'mis_daily' ORDER BY created_at DESC LIMIT 20;`. Compare the worker's env with the API's in Dokploy, key by key. |
| D | **A manual send took the period first.** The "already sent" guard counts any `sent` run for the period, including one started by a person. If Send now was pressed for yesterday before 08:56, the schedule skips that day. | This only explains individual days, not "never". | `job_runs.result` shows `already sent for … (run N)`. |
| E | **pg-boss timing or time zone.** `BUSINESS_TIME_ZONE` is wrong on the worker, or the cron fired while the worker was restarting. | Unlikely to explain every day being missed. | Look at `pgboss.schedule.timezone` and the `job_runs.started_at` times. |

### Debugging steps, in order

1. **Read-only checks on production** (admin, psql or Settings → Emails & jobs):
   the five queries above, plus whether the worker container exists and
   whether it has restarted. Together these pick between A, B, C and D
   without changing anything.
2. **Run the job the way the schedule does.** Use Settings → Emails & jobs →
   `reports.daily_briefing` → **Run now**. This runs the guarded path, but
   **in the API process**:
   - it sends → the code and settings are fine, so the worker is the
     problem (A or C);
   - it says "switched off" → B;
   - it says "already sent" → D. Pass a date (`today`) that has not been
     sent yet to test it again.
3. **Fix the cause found**: redeploy the worker from the current image and
   copy the API's environment to it (A or C), or switch the report on under
   Reports → Scheduled reports (B). Then watch the next 08:56 run in
   `job_runs`, `report_runs` and `email_log`.

### Code changes that would make this visible next time (after the cause is confirmed)

- **Record guarded skips.** Write a `report_runs` row with status
  `skipped` and the reason (switched off, already sent), so the run history
  on Scheduled reports shows every scheduled attempt, not only the manual
  sends.
- **Show the worker's state on the Scheduled reports page:** the next run
  time from `pgboss.schedule`, the last `job_runs` row for each report,
  and a warning when the report is switched off but has recipients.
- **Alert on a missed run.** Add a check to `ops.watch`: the daily briefing
  is switched on, it is past 09:30 IST, and there is no `report_runs` row
  for yesterday → raise an alert. Add a worker heartbeat: if no
  `job_runs` row has been written by the worker in the last 20 minutes,
  the worker is down.
- **Worker start-up line:** log `EMAIL_MODE`, whether the AI is
  configured, whether Graph and SMTP are configured, and the time zone. A
  missing setting then shows in the worker's log on the first start.
- Tests: a guarded skip writes a row, and the missed-run check alerts.

---

## 2. Irrelevant mail in the highlights

### What happens today

`candidateThreads()` (`server/src/lib/misAi.js`) gives the AI **every
thread** in a shared `share_everything` mailbox that had a message
yesterday. It ranks them but filters nothing out. Since 073 (read
everything), the shared mailboxes also store:

- newsletters and marketing mail, and automatic senders (no-reply@,
  notifications@) kept for the readers;
- internal-only mail, including **our own previous briefing**, which is
  sent from sales@ and so lands in its Sent Items (the reference briefing
  skips it on purpose);
- vendor pitches, job applications and spam.

The AI is only asked to pick "the most important", and the check in
`checkHighlights()` only tests the numbers, not whether the thread has
anything to do with sales. So a marketing thread can, and does, become a
highlight.

There is a second, smaller way in: when the enquiry reader wrongly makes
an enquiry from a marketing mail, that enquiry counts in "New enquiries"
and in `readerEvents`.

### What the readers already know

`email_enquiry_decisions.kind` (`enquiryDetect.js` `KINDS`) already holds
a decision for each message the readers read: `new_enquiry`,
`quotation_sent`, `purchase_order`, `reply_or_followup`, `billing`,
`vendor_or_sales_pitch`, `marketing`, `job_application`, `spam` or
`other`. The PO and invoice readers record their own decisions too. The
briefing ignores all of this.

### Fix plan

1. **Confirm it with the real report.** For the report that carried the
   marketing mail, find which section showed it (the highlights, the "New
   enquiries" count, or a pending row) and which `thread_id` it came from.
   Then look up that thread's `email_enquiry_decisions.kind`.
2. **Filter threads in SQL before the AI sees them** (in
   `candidateThreads`). Drop a thread when **all** of its messages from
   yesterday match one of these:
   - reader kind `marketing`, `vendor_or_sales_pitch`, `job_application` or
     `spam`;
   - sender matches `BULK_SENDER` or the robots rule (`isBlocked`), or the
     text matches `BULK` (unsubscribe, "view in browser");
   - our own reports: `email_log.template IN ('mis_daily','mis_weekly')`,
     matched on subject or message id, or the subject starts with
     "Daily Sales Briefing" or "Weekly Sales MIS";
   - internal-only, with no linked record (`t.entity IS NULL`) and no
     external participant. Internal mail **with** a linked record stays:
     the Coreal reminder in the reference is internal (Deepak → Burcu) but
     is about a client.

   Keep a thread that has a linked record, or a reader kind of
   `new_enquiry`, `quotation_sent`, `purchase_order`, `billing` or
   `reply_or_followup`.
3. **Tighten the prompt and the check.** Tell the AI to leave out
   anything that is not client or sales business, and let it return
   `"skip": true` for a thread. In `checkHighlights`, drop any highlight
   whose thread a filter would have dropped, as a second line of defence.
4. **Report what was left out.** Add a count of the excluded threads,
   for the footnote line ("2 emails in the window; 1 skipped: our own
   briefing").
5. **"New enquiries" in At a glance:** count only enquiries whose decision
   kind is `new_enquiry`. That is already true for reader-made enquiries.
   Check whether the marketing case came through another source (an n8n or
   webhook enquiry, or an AI misclassification) and, if so, fix it in the
   reader rather than in the report.
6. Tests in `misAi.test.js` with fixtures for a newsletter, our own
   briefing, an internal mail on a record, and a vendor pitch. Each must be
   in or out as described above.

---

## 3. Matching the reference format

What the reference has that the tracker's PDF (`misPdf.js`, capped at two
pages with `MAX_ROWS`) does not:

| Reference | Tracker today | Change |
|---|---|---|
| Header line: report date with weekday, generated time, **source mailbox and window** ("sales@…, Inbox + Sent Items, 00:00–23:59 IST") | Title and date | Add the source line from `mis_sender_account_id` and the business time zone |
| **1. At a glance** as a Metric / Count / Detail table: new enquiries, quotations, POs, invoices, payments, **other sales activity**, pending invoices / POs / quotations, **overdue with a breakdown** | Number tiles | Change to the three-column table. Add "Other sales activity" (highlights not tied to a new record) and the overdue breakdown by type |
| A short **day paragraph** (how many emails, what was skipped, "no pending item was closed") | none | Build it in code from the thread counts and filter counts; the AI may only reword it |
| **2. Key highlights**, numbered, each with Action / owner, **Source email (open in Outlook)**, **Related earlier emails** and **Reminders carried forward** | Highlights, one line each | Add `web_link` (already stored) and up to three earlier messages on the same thread or record. Carried-forward reminders come from upcoming visits/meetings in the next 3 days and from POs that are still not acknowledged |
| **3. Pending tasks** with a note on how days are counted and what "Overdue" means; red rows for overdue | Three tables, capped | Add the note, colour overdue rows red, **remove the two-page cap** (list every row, as the reference does over four pages) |
| (a) Invoices in **three sub-tables**: invoice actions; pending for invoicing; **receivables (sundry debtors)** with a grand total | One pending-invoices table | Split `pendingInvoices` by type (to raise / awaiting payment). Receivables from the tracker, reconciled with Finance's emailed list: see §3a |
| Columns: Client, Reference, Amount, **Last activity**, Days, Owner, Next action, **Email** link | Client, Reference, Amount, Days, Next action | Add `last_activity` (the latest message on the thread or record), owner, and an email link (thread `web_link`) |
| "Amount: **not stated**" where no figure exists | blank / "not converted" | Print "not stated" when the amount is null |
| Closing line per table ("No PO received or closed on 3 Oct") | none | Generate it from the at-a-glance counts |
| **4. Action items for today (top 5)** with owner and link | Top 5 | Keep the picking in code; add owner and link to each line |
| Footer: "Prepared automatically from the sales@ mailbox…", report name and page on every page | Page number | Add the text |

The email body follows the same section order, in shortened form: at a
glance, highlights and top 5. The full tables stay in the PDF.

Changes: `misReports.js` (sub-tables, last activity, other activity,
carried-forward reminders, closing lines), `misPdf.js` (layout, no page
cap, red rows), `emailTemplates.js` (`dailyBriefing`), and the PDF fixture
and tests (`misPdf.test.js`, `misPdfFixture.mjs`). Update
`docs/mis-reports.md` to drop "two A4 pages".

---

## Order of work

1. Production checks for §1 (no code). Fix the deployment or the setting.
   Confirm the next 08:56 run.
2. §1 visibility changes (skip rows, missed-run alert, worker start-up
   line). Small, one PR.
3. §2 relevance filter. One PR, with tests built from the real offending
   thread.
4. §3 format, with the mailbox list in the header and the decisions
   below. One PR, with the sample PDF regenerated and checked against the
   reference before merging.
5. §3a receivables: the debtors-list reader, its table and the
   reconciliation. A migration and one PR.

## Decisions (04 Oct 2026)

1. **Receivables: the tracker plus the emails.** The tracker's outstanding
   payment stages are the base. Finance's emailed Sundry Debtors list is
   read alongside them and the two are reconciled (§3a below).
2. **Every day, weekends and holidays included.** The cron is already
   `56 8 * * *` and `runDailyBriefing` does not check holidays, so nothing
   needs to change. Add a test that pins this, so that a later "skip
   holidays" change (as `followups.daily` has) cannot quietly apply to the
   briefing. A quiet day still goes, with the at-a-glance zeros and the
   carried-forward items, as in the reference (a Saturday).
3. **Every shared mailbox.** `candidateThreads` already reads every
   shared mailbox with `share_everything`. Changes:
   - the header's source line lists every mailbox read ("sales@, info@, …
     — Inbox + Sent Items, 00:00–23:59 IST"), not only the sender;
   - a shared mailbox shared as `subject` or `metadata` cannot give the
     AI any text. List it in the footnote as "not read (shared as subject
     only)" so the gap is visible, rather than dropping it silently;
   - if one email reached two shared mailboxes (sales@ cc'd on info@), it
     appears once: group threads by `internet_message_id`/`conversation_id`
     across accounts before ranking;
   - the cap (`MAX_THREADS` 40, `MAX_CHARS` 30,000) now applies across more
     mailboxes. Raise the cap only if the relevance filter (§2) does not
     leave enough room, and say in the footnote when threads were cut.
   Personal mailboxes are still never read.

## 3a. Receivables from the tracker and the emails

**Tracker (base).** Every payment stage that is invoiced and not fully
paid: client, invoice no., amount outstanding in INR (at the rate on the
record's date), days since the invoice date, the last chase or payment
note, and the email link from the stage's thread. Then the "pending for
invoicing" table: stages due to be invoiced but not yet raised, with days
waited.

**Emails.** The readers look for Finance's latest Sundry Debtors /
pending-for-invoicing list in any shared mailbox:
- **Find it:** the subject or attachment name contains "sundry debtors",
  "debtors", "outstanding" or "receivable", it comes from an internal
  sender, and it is the newest one within the last 14 days. The phrases
  and sender list are settings, not hard-coded.
- **Read it:** for an Excel attachment, use `xlsx`, which is already a
  dependency. For a PDF, use the same PDF text path as the invoice
  reader, and the AI pulls out the rows (client, amount, days, and
  whether it is "pending for invoicing"). The checks are the same as
  elsewhere: every amount must be in the file, and the grand total must
  equal the sum of the rows, or the list is not used.
- **Store it:** one row per list (`receivable_lists`: message, date, grand
  total) and its lines. Each list is read only once and does not use up
  the AI ceiling again on the next day's run.

**Reconcile.** Match the list lines to the tracker by client (company
match, the same as the readers use), then by amount:
- matched → one row, showing the tracker figure, and the list figure if
  they differ ("list: 2,44,530; tracker: 2,10,000");
- on the list only → shown with the source "list" (as in the reference),
  and as a Finance action: "record in tracker";
- in the tracker only → shown with the source "tracker", plus a note
  "not on Finance's list of 1 Oct".
Grand totals from both sources, and the date of the list. When no list
has arrived in 14 days, the table is built from the tracker alone and the
note says so.

The "Email" column then shows `open` (thread link) or `list` (the
debtors-list email), as in the reference.
