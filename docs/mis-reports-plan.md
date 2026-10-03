# Daily sales briefing and weekly MIS from the tracker: implementation plan

Today two Claude routines on the account run these reports from outside the
tracker:

- **Daily Sales Briefing:** every day at 08:56 IST. It reads yesterday's
  sales@ mail through the Microsoft 365 connector, builds a PDF, uploads it
  to SharePoint, and emails management a link.
- **Weekly Sales MIS Report:** every Monday at 08:54 IST. It does the same
  over the previous 7 days, and answers 8 management questions.

Both count things by reading raw email again. That means their numbers can
disagree with the tracker. It also means a slow, separate AI session runs
every morning, and the PDF is reached through a SharePoint link.

This plan moves both reports **into the tracker**:

- the numbers come from the records the email readers have already
  created (enquiries, quotations, POs, invoices, payments);
- the AI writes only the commentary and the "highlights" of yesterday's
  mail;
- the email is sent from **sales@** with the **PDF attached**.

This file is written for the person (or Claude Code session) who builds it.
Read [PROJECT-CONTEXT.md](../PROJECT-CONTEXT.md),
[sales-report-rework-plan.md](sales-report-rework-plan.md) (the report
definitions this reuses) and [email-po-plan.md](email-po-plan.md) first.
It follows the two design rules: nothing derived is stored, and each fact
is typed in one place. It was written against commit `d764c56`. **Plan
only; no code in this step.**

---

## 0. Decisions made by the product owner

| Question | Decision |
| --- | --- |
| Where the numbers come from | **The tracker's records.** These are the enquiries, quotations, POs, invoices and payments the email readers and people have entered, so the reports match the Reports page. The AI only writes the highlights and the commentary. |
| How the reports are delivered | **An email from the connected sales@ mailbox (Microsoft Graph), with the PDF attached.** There is no SharePoint step. |
| Receivables and currencies | **The tracker's own invoice ageing** (plus Zoho or Tally entries if connected), and **the real exchange rate on each record's date**, as the Reports page uses. The fixed USD 88 and EUR 103 rates are dropped, and the email says so once. |

---

## 1. What already exists, and what is missing

| Need | Already in the tracker | Missing |
| --- | --- | --- |
| Enquiries per day, status %, sector-wise POs, service-wise sales, new vs repeat, revenue | `server/src/lib/reportDefinitions.js` `salesReport(period, { grain })`. A 7-day period is daily by default. It has `narrate()` for one sentence per section. | An **enquiry table** with client, country, sector, service, source and first-response TAT (`outcomeRows` does not select these). **Weekly** invoiced and received totals (`billingRows` buckets by month only). |
| Receivables > 90 days, pending follow-ups, POs in the pipeline, enquiries at risk | `server/src/lib/insights.js`: `receivablesSection` (ageing up to "90+"), `overdueFollowUps`, `poPipelineSection`, `enquiriesAtRisk`. | A "days pending" figure for stages **to invoice**, counted from their trigger date. A **pending-PO** list (awaiting PO, won without PO, POs in the review queue). |
| What the email readers did yesterday | `email_enquiry_decisions`, `email_po_decisions`, `email_invoice_decisions` (outcome, kind, record, review reason, `received_at`). | — |
| Text of yesterday's emails, for highlights | `email_messages.subject`, `snippet`, `body_html`, **only if** the mailbox's visibility is `share_everything`. | An "Open in Outlook" link: Graph's `webLink` is not stored. |
| PDF building | `reportPdf.js`, `pdfBlocks.js` (`tile`, `reportTable`, `section`), `pdfCharts.js` (`horizontalBars`, `stackedColumns`, `donut`), all with pdfmake and no browser. | A compact **2-page** layout. The current report PDF is many pages. |
| Scheduled jobs | `server/src/jobs.js` registry; `worker.js` schedules in `Asia/Kolkata`; "Run now" on the Emails page; history in `job_runs`. | The two jobs. |
| Sending | `mail.js` `sendMail` (SMTP; attachments; `EMAIL_MODE` log, sandbox or live; the `emails_enabled` switch; `email_log`). `microsoft.js` `provider.send` (Graph; **no attachments**). | Graph send **with attachments**, through the same safety switches. Several recipients in sandbox mode (sandbox compares the whole `to` string today). |
| AI | `lib/ai.js` `chatJSON`, the shared daily ceiling, and `email_ai_calls` for counting extra calls. | The two prompts. |

---

## 2. Scope

### In scope

1. **Daily Sales Briefing** at 08:56 IST every day, covering the previous
   IST calendar day.
2. **Weekly Sales MIS** at 08:54 IST every Monday, covering the previous
   Monday to Sunday.
3. **The data** for both, built from tracker records by pure,
   tested functions.
4. **AI-written highlights** for the daily briefing, from yesterday's
   stored mail in shared mailboxes. **AI commentary** for both reports,
   built from the computed figures only.
5. **A 2-page PDF** for each, and an HTML email with the PDF attached,
   sent from sales@.
6. **A record of every run** (`report_runs`), with **Preview**, **Send
   now** and **Resend** on a new Reports → "Scheduled reports" page.
7. **Settings:** recipients, sender mailbox, on and off switches, and the
   overdue threshold.
8. **Cut-over:** a week of running in parallel with the Claude routines,
   then those routines are switched off.

### Out of scope

- SharePoint or OneDrive upload. The PDF is attached, and kept in the
  tracker (§3.6).
- Reading finance's "Sundry Debtors Pending Amount List" email. Tracker
  ageing replaces it (§0).
- Reports for other audiences (per salesperson, per client). The building
  blocks allow them later.

---

## 3. How it works

### 3.1 Daily Sales Briefing: data (`server/src/lib/misReports.js` `dailyBriefing(day)`)

The period is **yesterday, 00:00 to 23:59 IST**, from `businessToday()`
minus one day. All queries are **unrestricted**: this is a management
report.

**At a glance** (counts, each one a link into the tracker):

| Figure | Definition |
| --- | --- |
| New enquiries | Enquiries whose `enquiry_date` is yesterday (or `created_at` if it has none), the same as `enquiriesReceived`. |
| Quotations sent | Quotations whose `sent_at` is yesterday, plus quotations read from our emails yesterday (`email_enquiry_decisions.kind = 'quotation_sent'`, outcome created or linked). Each is counted once. |
| POs received | Counting POs (`poCountsAsSale`) whose `po_date` is yesterday. POs **registered** yesterday with an older PO date are counted separately, as "registered yesterday". |
| Invoices raised | Payment stages whose `invoice_date` is yesterday. |
| Payments received | `payments.received_on` yesterday: count and INR total. |
| Pending invoices, POs and quotations | The counts of the three tables below. |
| Overdue | Rows in those tables pending for more than `mis_overdue_days` (default **7**). |

**Pending tables.** Each row has client, reference, amount (INR, at the
record-date rate), date of last activity, days pending, owner, next action
and a tracker link. Rows over the threshold are marked **Overdue**.

1. **Pending invoices:**
   - stages **To Invoice**, with days pending counted from the trigger
     date (`po_date`, `actual_delivery_date` or `milestone_reached_on`);
   - plus invoices **Due** or **Overdue**, with days since the invoice due
     date, from `v_payment_stages`;
   - plus open items in the **invoice review queue**.
2. **Pending POs:**
   - quotations on the "Verbal yes / awaiting PO" stage;
   - quotations Won with no PO (from the report definitions' won-without-PO
     note);
   - POs in the **PO review queue** (outcome `review`): "PO received, not
     registered".
3. **Pending quotations:**
   - open enquiries with no quotation, with days since the enquiry date;
   - quotations Submitted or Under Negotiation with no client activity
     since they were sent, with days since `sent_at` or the last activity
     (`followUps.js` `lastActivity`).

**Top 5 actions for today** are picked **in code**: the pending rows
ranked by days overdue × INR value, at most one per client. The AI only
words them (§3.4), so it cannot pick different rows.

**Highlights of yesterday** are AI-written (§3.4), from:

- threads with activity yesterday in **shared** mailboxes whose visibility
  is `share_everything`;
- the records the email readers created or changed yesterday.

Each highlight links to the **tracker conversation or record**, and to
the email in Outlook once `web_link` is stored (§4).

**Related earlier emails** are found by SQL, not by AI: earlier messages in
the same thread, and other threads linked to the same record
(`email_threads.entity`/`entity_id`), up to 3, newest first.

### 3.2 Weekly Sales MIS: data (`misReports.js` `weeklyMis(weekStart)`)

The period is the **previous Monday to Sunday**. This is the same window
the routine uses (run on Mon 5 Oct, it covers 28 Sep to 4 Oct). A
month-to-date figure is added where the routine had one.

| # | Management question | Source |
| --- | --- | --- |
| 1 | Total enquiries per day and for the week, plus month to date; a table of date, client, country, sector, service, source and first-response TAT | `salesReport(...).enquiries` (daily grain). **New** `enquiryRows(period)` adds country, sector, service and source, and the TAT (below). |
| 2 | Enquiry status in numbers and %: converted to PO, under pipeline, lost, with account names and values | `outcomeSummary` (converted, pipeline, quoted not won, lost; the percentages sum to 100). |
| 3 | Sector-wise POs: count and value | `sectorSection`, using the `report_sectors` and `sector_aliases` settings (Metal Industry, Agriculture, Pharmaceutical, Other). |
| 4 | Service-wise sales | `serviceSection`, with value split by `po_services`, then quotation lines, then keywords. |
| 5 | Customer analysis: POs with date, client, country, service, value, new or repeat | `customerSection` (repeat means an earlier PO exists for the company). |
| 6 | Revenue: invoices raised and payments received in the week | **New** `billingTotals(period)` over `billingRows`, giving period totals instead of monthly buckets. The monthly figure comes from the same function for month to date. |
| 7 | Pending and overdue follow-ups | `receivablesSection` (the **90+ bucket**: total, count, oldest, largest); the pending POs and invoices to raise from §3.1; pending quotations from §3.1; overdue quotation follow-ups from `overdueFollowUps`. |
| 8 | Conversion and speed | Enquiry → PO % (from #2). Quote → contract % (won ÷ won + lost in the period, as `reports/conversion` counts). Average PO ticket (PO value ÷ POs). Average open-quote ticket and open pipeline value (open quotations, unweighted and weighted, from the pipeline aggregation in `insights.js`). Median enquiry-response TAT. Median quote-to-PO TAT (`po_date − sent_at`). |

**The quotation and contract details** the routine also listed (quotations
sent in the week with service, sector, country, value and TAT; POs split by
service, sector and country) come from the same report rows, filtered to
the week.

**First-response TAT** is defined once in `misReports.js`:

- for an enquiry created from an inbox conversation, use
  `inbox_conversations.first_response_at − ` the first inbound message
  time;
- otherwise use `enquiries.first_responded_at − enquiry_date`;
- **exclude** enquiries the readers created from **our** quotation or PO
  email (decision kind `quotation_sent`, or created by the PO reader).
  Their `first_responded_at` is stamped artificially (the quotation's sent
  time, or noon on the PO date), so they would show a false TAT.

The PDF footnote states the rule and how many enquiries had no TAT.

### 3.3 Money

- **Every amount in INR**, converted at the rate on the record's own date
  (`RATES` / `rateOn`), as the Reports page does.
- Amounts with no rate are listed as "not converted" and are never
  guessed.
- Stale rates are flagged (`staleAmong`).
- INR is shown in lakh ("12.4 L") using `reportFormat.js`.
- The email says once: "Converted at the exchange rate on each record's
  date (ECB). Earlier reports used fixed rates of USD 88 and EUR 103."

### 3.4 AI's part, and its limits

There is one AI call per report, through `chatJSON`. It is counted in
`email_ai_calls` with purpose `mis_daily` or `mis_weekly`, and it respects
the shared daily ceiling.

**Daily, highlights.**

- **Input:** for each candidate thread from yesterday, the subject, the new
  part of each message (`splitQuoted().main`), the sender's company, and
  the linked record's number and status. In total this is at most 40
  threads and 30,000 characters, chosen by:
  1. a linked record;
  2. external sender;
  3. most recent.

  The candidates are only threads in **shared** mailboxes with
  `share_everything`; personal mailboxes are never used.
- **Output:**

  ```jsonc
  { "highlights": [ { "thread_id": 123, "client": "...", "summary": "one or two lines", "action": "...", "owner": "..." } ],
    "actions_wording": [ { "row_key": "...", "text": "..." } ] }
  ```

- **Checks in code:**
  - a `thread_id` must be one of the inputs;
  - every number or amount in a summary must appear in that thread's text
    or record;
  - at most 8 highlights;
  - `actions_wording` can reword only the five rows chosen in §3.1.

  Anything that fails a check is dropped.
- **No AI, or the ceiling is reached:** the highlights become a list built
  from records ("New enquiry ENQ/… from X", "PO 4500… registered for Y",
  and so on), and the briefing still goes out.

**Weekly, commentary.**

- **Input:** only the computed figures (the JSON of §3.2), never email
  text.
- **Output:** 4 headline bullets and one short paragraph per section.
- **Check in code:** every number in the text must equal (after rounding)
  a number in the input; otherwise that sentence is replaced by
  `narrate()`'s sentence for the section.
- **No AI:** `narrate()` is used throughout.

So the AI can **word** the reports but cannot **change** a figure.

### 3.5 PDF (2 pages, A4)

`server/src/lib/misPdf.js` builds both reports with pdfmake, reusing
`pdfBlocks.js` and `pdfCharts.js`. Helvetica (the standard font), no
images, navy `#0F3D5E` headers. The target is under 150 KB.

- **Daily**, `Daily_Sales_Briefing_YYYY-MM-DD.pdf`:
  1. header;
  2. at-a-glance tiles;
  3. highlights (each with a tracker link and an Outlook link);
  4. the three pending tables, with Overdue rows shaded;
  5. top 5 actions.

  On a day with no activity it says so plainly and keeps the pending
  tables.
- **Weekly**, `Sales_MIS_Report_<DDMon>-<DDMon><YYYY>.pdf`:
  - **page 1:** KPI strip (enquiries, POs and value, conversion %,
    receivables and the 90+ amount), headline bullets, sections 1–3, and
    **one bar chart** (`horizontalBars`) of PO value by service;
  - **page 2:** sections 4–8.

  Tables are compact, capped at 12 rows with "+N more in the tracker".

### 3.6 Sending

1. **Sender:** the mailbox in `mis_sender_account_id`, which is sales@.
   Extend `microsoft.js` `send()` to take
   `attachments: [{ name, contentType, content }]`. Graph's `sendMail`
   accepts file attachments inline up to 3 MB, which is plenty for these
   PDFs. The mail lands in sales@'s Sent Items like any sent mail.
2. **The same safety switches as all outgoing mail.** Add
   `sendViaMailbox()` to `mail.js`:
   - `emails_enabled` and `EMAIL_MODE` decide as for SMTP (log, sandbox or
     live);
   - staging never sends;
   - the message is written to `email_log` (template `mis_daily` or
     `mis_weekly`).
   - Sandbox mode is fixed to check **each** recipient against
     `EMAIL_ALLOWLIST`, not the joined string.
3. **Fallback:** if the Graph send fails (the mailbox needs reconnecting,
   or Graph errors), send through SMTP with the same attachment, and tell
   admins once.
4. **Recipients:** settings `mis_to` and `mis_cc`, comma-separated, edited
   in Settings → Scheduled reports. Enter the same To and CC as the current
   routines.
5. **Email body:** HTML, built from allow-listed tags in
   `emailTemplates.js` `dailyBriefing()` / `weeklyMis()`:
   - the greeting the routines use;
   - the headline figures, the top 5 highlights or actions, and the
     Overdue list;
   - a line saying the PDF is attached;
   - the sign-off.

   Links in the email go to tracker pages, which need a sign-in.
6. **Keeping a copy:** the PDF is stored with `uploadDocument({ owner:
   'reports' })` (add `reports` to the document owners). The run is
   recorded in `report_runs` (§4), so a report can be re-opened and
   re-sent from the tracker.

### 3.7 Jobs

| Job | Cron (IST, set in `worker.js`) | Run |
| --- | --- | --- |
| `reports.daily_briefing` | `56 8 * * *` | `runDailyBriefing()` |
| `reports.weekly_mis` | `54 8 * * 1` | `runWeeklyMis()` |

- Both show on the Emails page with **Run now**.
- A run is **idempotent per period**: if `report_runs` already holds a
  `sent` run for that kind and period, the scheduled run does nothing.
  **Resend** is an explicit action.
- If either report fails, admins are notified and the run is recorded as
  `failed` with the error.

---

## 4. Data

Migration `074_mis_reports.sql`. If the per-user mailbox plan's
`074_mailbox_owner.sql` merges first, take the next free number.

```sql
-- One scheduled report that was generated: an event, so it is stored.
CREATE TABLE IF NOT EXISTS report_runs (
  id            serial PRIMARY KEY,
  kind          text NOT NULL CHECK (kind IN ('daily_briefing','weekly_mis')),
  period_from   date NOT NULL,
  period_to     date NOT NULL,
  status        text NOT NULL CHECK (status IN ('sent','preview','failed','skipped')),
  sent_via      text CHECK (sent_via IN ('graph','smtp','log')),
  recipients    text[],
  document_id   int REFERENCES documents(id),
  email_log_id  int REFERENCES email_log(id) ON DELETE SET NULL,
  ai_used       boolean NOT NULL DEFAULT false,
  error         text,
  triggered_by  text NOT NULL DEFAULT 'schedule',   -- or a username
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS report_runs_sent_once
  ON report_runs (kind, period_from) WHERE status = 'sent' AND triggered_by = 'schedule';

-- The Outlook link of a stored message: a fact from the provider.
ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS web_link text;

INSERT INTO settings (key, value, notes) VALUES
  ('mis_daily_enabled', 'false', 'Send the Daily Sales Briefing at 08:56 IST.'),
  ('mis_weekly_enabled', 'false', 'Send the Weekly Sales MIS every Monday at 08:54 IST.'),
  ('mis_to', '', 'Recipients of both reports, comma-separated.'),
  ('mis_cc', '', 'Copied on both reports, comma-separated.'),
  ('mis_sender_account_id', '', 'The connected mailbox the reports are sent from (sales@).'),
  ('mis_overdue_days', '7', 'Days after which a pending item is marked Overdue.')
ON CONFLICT (key) DO NOTHING;
```

- Both reports start **off**. They are switched on at cut-over (§6).
- Add `webLink` to `microsoft.js`'s `$select` and store it at ingest, so
  the Inbox can also offer "Open in Outlook"
  ([inbox-outlook-plan.md](inbox-outlook-plan.md)). Older messages get it
  from `refreshBodies` or the next re-read.

---

## 5. Files

| File | Change |
| --- | --- |
| `server/src/lib/misReports.js` | **New.** `dailyBriefing(day)`, `weeklyMis(weekStart)`, `pendingInvoices`, `pendingPos`, `pendingQuotations`, `topActions`, `enquiryRows`, `firstResponseTat`, `billingTotals`. They are pure where possible, and take `today` for tests. |
| `server/src/lib/misAi.js` | **New.** `highlightsPrompt`, `commentaryPrompt`, `checkHighlights`, `checkCommentary` (numbers must come from the input), and the record-based fallback. |
| `server/src/lib/misPdf.js` | **New.** The two 2-page document definitions. |
| `server/src/lib/emailTemplates.js` | `dailyBriefing()` and `weeklyMis()` HTML. |
| `server/src/lib/mail.js` | `sendViaMailbox()` (Graph with attachments, through `decideDelivery`), and the per-recipient sandbox check. |
| `server/src/lib/mailbox/microsoft.js` | `send()` with attachments; `webLink` in `$select`. |
| `server/src/lib/mailbox/sync.js` | Store `web_link`. |
| `server/src/lib/documents.js` | Add the owner `reports`. |
| `server/src/jobs.js` | The two jobs. |
| `server/src/routes/misReports.js` | Admin only: `GET /api/mis-reports/runs`; `POST /api/mis-reports/:kind/preview` (returns the PDF, nothing sent); `POST /api/mis-reports/:kind/send` (send now, or resend a period); `GET /api/mis-reports/runs/:id/pdf`. |
| `server/src/lib/authz/policy.js` | The four routes, `mustBeAdmin`. |
| `web/src/pages/ScheduledReports.jsx` | **New**, under Reports. It has two cards (daily and weekly) with the on/off switch, recipients, sender mailbox, next run, **Preview**, **Send now**, and the run history with PDF and Resend. |
| `docs/mis-reports.md` | **New** user doc. Add a line to `docs/security.md`: the daily highlights send shared-mailbox email text to the AI provider (already the case for the readers). |

---

## 6. Cut-over from the Claude routines

1. Build and deploy with both reports **off**.
2. For one week, set `mis_to` to Shyam only and switch both on. The
   routines keep running as they do now. Compare the two each morning.
3. The tracker's figures will differ from the routines' where the routines
   counted from raw email, or used fixed exchange rates. Each difference
   should be explainable from the tracker's records. If one is not, it is
   a bug in the readers or the reports, so fix it before switching over.
4. Set the real recipients.
5. **Switch off the two routines**, "Daily Sales Briefing" and "Weekly
   Sales MIS Report", on the claude.ai account. This step is done by the
   account owner, or by Claude when asked; it is not part of the code.
6. The SharePoint folders keep the old reports. New ones are kept in the
   tracker.

---

## 7. Build order (one PR each, each shippable)

1. **Data:** `misReports.js`, with pure and database-backed tests.
   Includes `billingTotals`, `enquiryRows` and the TAT rule.
2. **PDF and email:**
   - `misPdf.js` and the templates;
   - the preview route and the Scheduled reports page (preview only).
3. **Sending:**
   - Graph send with attachments, and `sendViaMailbox` with the switches
     and sandbox fix;
   - `report_runs`, the jobs, send now and resend;
   - `web_link`.
4. **AI:** highlights and commentary, their checks and the fallback.
5. **Cut-over** (§6).

---

## 8. Tests

- **Pure:**
  - the period helpers (yesterday in IST at 00:30 IST; Monday-to-Sunday
    weeks across a month end);
  - `topActions` ranking and one row per client;
  - the TAT rule, which excludes reader-stamped enquiries;
  - `checkHighlights`, which drops an invented `thread_id` and a summary
    with an amount not in its thread;
  - `checkCommentary`, which replaces a sentence carrying a figure not in
    the input.
- **Database-backed** (`server/test/misReports.test.js`), with a seeded
  week of enquiries, quotations, POs (one in USD), stages, invoices,
  payments and review-queue items:
  - every at-a-glance count and every pending row, including Overdue at
    more than 7 days;
  - the weekly sections match `salesReport` for the same period;
  - the 90+ receivables match Insights;
  - USD is converted at the PO-date rate;
  - "not converted" appears when a rate is missing.
- **PDF:** each report is **2 pages** for the seeded week (daily: 2 at
  most), and has the right file name and sections.
- **Sending:**
  - `EMAIL_MODE=log` writes `email_log` and `report_runs` and sends
    nothing;
  - sandbox mode checks each recipient;
  - a Graph failure falls back to SMTP and notifies admins;
  - a second scheduled run for the same period is skipped;
  - resend works.
- **AI:** a fake `chat` is used. With the ceiling reached, the record-based
  highlights are used and the briefing still sends.
- **Authz:** the routes are admin only.

---

## 9. Still open (defaults given; the build can start with them)

1. **Daily briefing on Sundays and holidays.** Default: **every day**, as
   the routine does now. The alternative is working days only.
2. **Links in the email.** Default: tracker links, which need a sign-in,
   plus "Open in Outlook" for the source email. The alternative is no
   links in the email, only in the PDF.
3. **Who can see Scheduled reports.** Default: **admins only**.
